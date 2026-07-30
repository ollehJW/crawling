import { chromium } from 'playwright';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';

const LOGIN_URL = 'https://autoway.hyundai.net/login/';
const ARTIFACT_DIR = 'artifacts';
const HYUNDAI_WIA_BOARD_NAME = 'H103';

function loadDotEnv() {
  try {
    if (!fs.existsSync('.env')) return;
    const body = fs.readFileSync('.env', 'utf8');
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const raw = trimmed.slice(idx + 1).trim();
      const value = raw.replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env is optional.
  }
}

async function question(prompt, { secret = false } = {}) {
  if (!secret) {
    const rl = readline.createInterface({ input, output });
    const answer = await new Promise((resolve) => rl.question(prompt, resolve));
    rl.close();
    return answer.trim();
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    const onData = (char) => {
      char = char.toString();
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          input.off('data', onData);
          break;
        default:
          output.clearLine?.(0);
          output.cursorTo?.(0);
          output.write(prompt + '*'.repeat(rl.line.length));
          break;
      }
    };
    input.on('data', onData);
    rl.question(prompt, (value) => {
      rl.close();
      output.write('\n');
      resolve(value.trim());
    });
  });
}

async function firstVisible(locators, timeout = 1500) {
  for (const locator of locators) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout });
      return locator.first();
    } catch {
      // Try the next locator.
    }
  }
  return null;
}

async function clickTextOrRole(page, text) {
  const locator = await firstVisible([
    page.getByRole('button', { name: text }),
    page.getByRole('link', { name: text }),
    page.getByText(text, { exact: true }),
    page.locator(`text=${text}`)
  ]);
  if (!locator) throw new Error(`Could not find clickable text: ${text}`);
  await locator.click();
}

async function selectByText(page, texts) {
  const wanted = (Array.isArray(texts) ? texts : [texts]).map((text) => text.replace(/\s+/g, ""));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      const count = await page.locator("select").count();

      for (let i = 0; i < count; i += 1) {
        const select = page.locator("select").nth(i);
        const options = await select.locator("option").evaluateAll((nodes) =>
          nodes.map((option) => ({
            label: option.textContent?.trim() || "",
            value: option.value
          }))
        );
        const option = options.find((item) => wanted.includes(item.label.replace(/\s+/g, "")));
        if (!option) continue;

        await select.selectOption({ value: option.value });
        return true;
      }

      return false;
    } catch (error) {
      if (!String(error.message || error).includes("Execution context was destroyed")) throw error;
      await page.waitForTimeout(1000);
    }
  }

  return false;
}

async function selectHyundaiWiaCompany(page) {
  await page.waitForTimeout(1000);
  const result = await page.evaluate((boardName) => {
    const normalize = (value) => (value || '').replace(/\s+/g, '');
    const selects = [...document.querySelectorAll('select')];
    const snapshots = selects.map((select, index) => ({
      index,
      id: select.id,
      name: select.name,
      selectedIndex: select.selectedIndex,
      selectedText: select.options[select.selectedIndex]?.textContent?.trim() || '',
      selectedValue: select.value,
      options: [...select.options].map((option, optionIndex) => ({
        optionIndex,
        text: option.textContent?.trim() || '',
        value: option.value
      }))
    }));

    const byValue = selects.find((select) => [...select.options].some((option) => option.value === boardName));
    const byText = selects.find((select) => [...select.options].some((option) => normalize(option.textContent).includes('현대위아')));
    const bySelectedCompany = selects.find((select) => normalize(select.options[select.selectedIndex]?.textContent).includes('현대트랜시스'));
    const target = byValue || byText || bySelectedCompany;

    if (!target) return { changed: false, reason: 'company select not found', snapshots };

    const targetOption =
      [...target.options].find((option) => option.value === boardName) ||
      [...target.options].find((option) => normalize(option.textContent).includes('현대위아')) ||
      target.options[1];

    if (!targetOption) return { changed: false, reason: 'hyundai wia option not found', snapshots };

    target.value = targetOption.value;
    target.selectedIndex = targetOption.index;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      changed: true,
      boardName,
      selectIndex: selects.indexOf(target),
      optionIndex: target.selectedIndex,
      selectedText: target.options[target.selectedIndex]?.textContent?.trim() || '',
      selectedValue: target.value,
      snapshots
    };
  }, HYUNDAI_WIA_BOARD_NAME);

  console.log(JSON.stringify({ companySelect: result }, null, 2));
  await page.waitForTimeout(500);
}

async function fillByCandidates(page, value, candidates) {
  const locators = [];
  for (const candidate of candidates) {
    locators.push(page.getByLabel(candidate, { exact: false }));
    locators.push(page.getByPlaceholder(candidate, { exact: false }));
  }
  locators.push(page.locator('input[type="text"]').first());

  const locator = await firstVisible(locators);
  if (!locator) throw new Error(`Could not find input for ${candidates.join('/')}`);
  await locator.fill(value);
}

async function fillPassword(page, value) {
  const locator = await firstVisible([
    page.getByLabel(/password|비밀번호|패스워드/i),
    page.getByPlaceholder(/password|비밀번호|패스워드/i),
    page.locator('input[type="password"]').first()
  ]);
  if (!locator) throw new Error('Could not find password input');
  await locator.fill(value);
}

async function fillOtp(page, value) {
  const locator = await firstVisible([
    page.getByLabel(/otp|인증|보안/i),
    page.getByPlaceholder(/otp|인증|보안/i),
    page.locator('input:not([type="hidden"])').nth(2)
  ]);
  if (!locator) throw new Error('Could not find OTP input');
  await locator.fill(value);
}

async function main() {
  loadDotEnv();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const userId = process.env.AUTOWAY_ID || await question('Autoway ID: ');
  const password = process.env.AUTOWAY_PASSWORD || await question('Autoway password: ', { secret: true });
  const otp = process.env.AUTOWAY_OTP || await question('OTP: ');

  const browser = await chromium.launch({
    headless: true,
    slowMo: Number(process.env.SLOWMO_MS || 80)
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 }
  });
  const page = await context.newPage();

  await page.route("**/Login/GLogin.aspx/Get_GroupCopNoticeItems", async (route) => {
    const request = route.request();
    let payload = { nBoardName: HYUNDAI_WIA_BOARD_NAME, language: "ko-kr" };
    try {
      payload = { ...(JSON.parse(request.postData() || "{}")), ...payload };
    } catch {
      // Keep the fixed payload.
    }
    console.log(JSON.stringify({ groupCompanyRequest: payload }, null, 2));
    await route.continue({
      postData: JSON.stringify(payload),
      headers: { ...request.headers(), "content-type": "application/json; charset=UTF-8" }
    });
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("Get_GroupCopNoticeItems")) return;
    try {
      const body = await response.text();
      const savedTo = ARTIFACT_DIR + "/group-company-response.json";
      fs.writeFileSync(savedTo, body);
      console.log(JSON.stringify({ groupCompanyEndpoint: { url, status: response.status(), savedTo } }, null, 2));
    } catch (error) {
      console.log(JSON.stringify({ groupCompanyEndpoint: { url, status: response.status(), error: error.message } }, null, 2));
    }
  });

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

    if (!(await selectByText(page, '부품'))) {
      await clickTextOrRole(page, '부품');
    }

    await selectHyundaiWiaCompany(page);

    await fillByCandidates(page, userId, ['아이디', 'ID', 'User ID', '사번']);
    await fillPassword(page, password);
    await fillOtp(page, otp);

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      clickTextOrRole(page, '로그인')
    ]);

    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    const title = await page.title().catch(() => '');
    console.log(JSON.stringify({ ok: !currentUrl.includes('/login'), currentUrl, title }, null, 2));

    await context.storageState({ path: `${ARTIFACT_DIR}/autoway-storage-state.json` });
    await page.screenshot({ path: `${ARTIFACT_DIR}/autoway-after-login.png`, fullPage: true });
  } catch (error) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: `${ARTIFACT_DIR}/autoway-login-error.png`, fullPage: true }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
