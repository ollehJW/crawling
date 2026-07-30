import express from 'express';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'web');
const ARTIFACT_DIR = path.join(ROOT_DIR, 'artifacts');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');
const LOGIN_URL = 'https://autoway.hyundai.net/login/';
const HYUNDAI_WIA_BOARD_NAME = 'H103';
const DEFAULT_VAATZ_URL = process.env.VAATZ_URL || 'https://wia.vaatz.com/';
const PORT = Number(process.env.PORT || 9717);

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

let browser;
let context;
let page;
const pagesWithDownloadHandler = new WeakSet();
let lastError = null;
let lastAutomation = null;
let downloadOverrideDepth = 0;

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function normalizeCell(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim();
}

function normalizeOrderDate(value) {
  const text = normalizeCell(value);
  const matchedDate = text.match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/);
  if (!matchedDate) return text;
  const [year, month, day] = matchedDate[0].split(/[-/.]/);
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function parseApprovalCsv(buffer) {
  const text = buffer.toString('utf8');
  const rows = parseCsvRows(text).filter((row) => row.some((cell) => normalizeCell(cell)));
  if (!rows.length) return [];
  const headers = rows[0].map(normalizeCell);
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, normalizeCell(row[index])])));
}

function parseApprovalXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { defval: '', raw: false })
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeCell(key), normalizeCell(value)])));
}

function parseApprovalListFile(buffer, filename) {
  const extension = path.extname(filename || '').toLowerCase();
  if (!['.csv', '.xlsx', '.xls'].includes(extension)) {
    throw new Error('csv, xlsx, xls 파일만 업로드할 수 있습니다.');
  }

  const rows = extension === '.csv' ? parseApprovalCsv(buffer) : parseApprovalXlsx(buffer);
  const headers = new Set(rows.flatMap((row) => Object.keys(row).map(normalizeCell)));
  const requiredColumns = ['품의번호', '발주일'];
  const missingColumns = requiredColumns.filter((column) => !headers.has(column));
  if (missingColumns.length) {
    throw new Error(`필수 컬럼이 없습니다: ${missingColumns.join(', ')}`);
  }

  const items = rows
    .map((row) => ({ approvalNumber: normalizeCell(row['품의번호']), orderDate: normalizeOrderDate(row['발주일']) }))
    .filter((item) => item.approvalNumber || item.orderDate);

  return { filename, total: items.length, items };
}

function isVaatzPage(candidate, title = '') {
  const haystack = `${candidate.url()} ${title}`.toLowerCase();
  return haystack.includes('vaatz') || haystack.includes('wia.vaatz.com') || haystack.includes('giam.wia.co.kr');
}

function attachPageHandlers(activePage) {
  if (pagesWithDownloadHandler.has(activePage)) return;
  pagesWithDownloadHandler.add(activePage);
  activePage.on('download', async (download) => {
    if (downloadOverrideDepth > 0) return;
    const suggested = download.suggestedFilename();
    await download.saveAs(path.join(ARTIFACT_DIR, suggested));
  });
}

async function maybeActivateVaatzPage(candidate) {
  attachPageHandlers(candidate);
  await candidate.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await candidate.waitForTimeout(1500).catch(() => {});
  const title = await candidate.title().catch(() => '');
  if (!candidate.isClosed() && isVaatzPage(candidate, title)) {
    await setActivePage(candidate);
  }
}

async function setActivePage(activePage) {
  page = activePage;
  attachPageHandlers(page);
  await page.bringToFront().catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  return page;
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1365, height: 900 }
  });

  context.on('page', (newPage) => {
    attachPageHandlers(newPage);
    maybeActivateVaatzPage(newPage).catch((error) => {
      lastError = error.message;
    });
  });

  const firstPage = await context.newPage();
  await setActivePage(firstPage);

  await page.route('**/Login/GLogin.aspx/Get_GroupCopNoticeItems', async (route) => {
    const request = route.request();
    let payload = { nBoardName: HYUNDAI_WIA_BOARD_NAME, language: 'ko-kr' };
    try {
      payload = { ...(JSON.parse(request.postData() || '{}')), ...payload };
    } catch {
      // Keep fixed Hyundai Wia payload.
    }
    await route.continue({
      postData: JSON.stringify(payload),
      headers: { ...request.headers(), 'content-type': 'application/json; charset=UTF-8' }
    });
  });


  return page;
}

async function saveSession() {
  if (!context) throw new Error('Browser is not started');
  const savedTo = path.join(ARTIFACT_DIR, 'autoway-storage-state.json');
  await context.storageState({ path: savedTo });
  return savedTo;
}

async function dumpOpenPages() {
  await ensurePage();
  await Promise.all(context.pages().map(async (candidate) => {
    if (candidate.isClosed()) return;
    if (candidate.url() === 'about:blank') {
      await candidate.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await candidate.waitForTimeout(1500).catch(() => {});
    }
  }));

  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  const items = [];

  for (const candidate of pages) {
    const title = await candidate.title().catch(() => '');
    items.push({
      index: items.length,
      active: candidate === page,
      vaatzCandidate: isVaatzPage(candidate, title),
      url: candidate.url(),
      title,
      frameCount: candidate.frames().length,
      frames: candidate.frames().map((frame) => frame.url())
    });
  }

  const savedTo = path.join(ARTIFACT_DIR, 'open-pages.json');
  const payload = { at: new Date().toISOString(), pages: items };
  fs.writeFileSync(savedTo, JSON.stringify(payload, null, 2));
  return { savedTo, pages: items };
}

async function dumpPageElements() {
  const activePage = await ensurePage();
  const frames = [];
  const htmlFrames = [];

  for (const [index, frame] of activePage.frames().entries()) {
    const data = await frame.evaluate(() => {
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      };
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const pick = (element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id || '',
        className: typeof element.className === 'string' ? element.className : '',
        name: element.getAttribute('name') || '',
        text: (element.innerText || element.textContent || '').trim().slice(0, 200),
        href: element.getAttribute('href') || '',
        onclick: element.getAttribute('onclick') || '',
        type: element.getAttribute('type') || '',
        value: element.getAttribute('value') || '',
        placeholder: element.getAttribute('placeholder') || '',
        title: element.getAttribute('title') || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        rect: rectOf(element)
      });
      const hasUsefulText = (element) => {
        const text = (element.innerText || element.textContent || '').trim();
        return text && text.length <= 300 && isVisible(element);
      };
      const isNexacroCell = (element) => {
        const id = element.id || '';
        const className = typeof element.className === 'string' ? element.className : '';
        return id.includes('gridrow_') || id.includes('.cell_') || className.includes('nexacontentsbox');
      };

      return {
        title: document.title,
        url: location.href,
        links: [...document.querySelectorAll('a')].map(pick),
        buttons: [...document.querySelectorAll('button, input[type="button"], input[type="submit"]')].map(pick),
        inputs: [...document.querySelectorAll('input, textarea')].map(pick),
        selects: [...document.querySelectorAll('select')].map((select) => ({
          ...pick(select),
          options: [...select.options].map((option, index) => ({ index, text: option.textContent.trim(), value: option.value }))
        })),
        textElements: [...document.querySelectorAll('div, span, td, th, label, p')]
          .filter(hasUsefulText)
          .slice(0, 3000)
          .map(pick),
        nexacroCells: [...document.querySelectorAll('div, span, td')]
          .filter((element) => isNexacroCell(element) && hasUsefulText(element))
          .slice(0, 3000)
          .map(pick)
      };
    }).catch((error) => ({ error: error.message, url: frame.url() }));

    frames.push({ frameUrl: frame.url(), ...data });

    const htmlResult = await frame.evaluate(() => ({
      title: document.title,
      url: location.href,
      html: document.documentElement ? document.documentElement.outerHTML : ''
    })).catch((error) => ({
      title: '',
      url: frame.url(),
      html: '',
      error: error.message
    }));

    const htmlFileName = `page-frame-${String(index).padStart(2, '0')}.html`;
    const htmlPath = path.join(ARTIFACT_DIR, htmlFileName);
    fs.writeFileSync(htmlPath, htmlResult.html || '', 'utf8');
    htmlFrames.push({
      index,
      frameUrl: frame.url(),
      title: htmlResult.title || '',
      url: htmlResult.url || frame.url(),
      savedTo: htmlPath,
      bytes: Buffer.byteLength(htmlResult.html || '', 'utf8'),
      error: htmlResult.error || null
    });
  }

  const savedTo = path.join(ARTIFACT_DIR, 'page-dump.json');
  const htmlSavedTo = path.join(ARTIFACT_DIR, 'page-html-dump.json');
  const at = new Date().toISOString();
  fs.writeFileSync(htmlSavedTo, JSON.stringify({ at, frames: htmlFrames }, null, 2));
  fs.writeFileSync(savedTo, JSON.stringify({ at, htmlSavedTo, frames }, null, 2));
  return { savedTo, htmlSavedTo, htmlFrames };
}



async function searchApprovalNumber({ approvalNumber, orderStartDate, orderEndDate } = {}) {
  const value = String(approvalNumber || '').trim();
  const startDate = String(orderStartDate || '').trim();
  const endDate = String(orderEndDate || '').trim();
  if (!value && !startDate && !endDate) throw new Error('조회 조건을 입력하세요.');

  const activePage = await ensurePage();
  const attempts = [];

  const fillInput = async (frame, selector, nextValue, label) => {
    const locator = frame.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) return null;

    const readValue = async () => locator.inputValue().catch(async () => locator.evaluate((element) => element.value || '').catch(() => ''));
    const modifier = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
    let actualValue = '';
    let method = '';

    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click({ timeout: 3000, force: true });
      await activePage.waitForTimeout(120).catch(() => {});
      await activePage.keyboard.press(modifier);
      await activePage.waitForTimeout(50).catch(() => {});
      await activePage.keyboard.press('Backspace').catch(() => {});
      await activePage.waitForTimeout(80).catch(() => {});

      if (attemptIndex === 1) {
        await locator.fill(nextValue, { timeout: 3000 }).catch(async () => {
          await activePage.keyboard.type(nextValue, { delay: 25 });
        });
        method = 'locator.fill';
      } else {
        await activePage.keyboard.type(nextValue, { delay: 25 });
        method = 'keyboard.type';
      }

      await locator.evaluate((element) => {
        const options = { bubbles: true, cancelable: true, composed: true };
        element.dispatchEvent(new Event('input', options));
        element.dispatchEvent(new Event('change', options));
        element.dispatchEvent(new KeyboardEvent('keyup', { ...options, key: 'Tab' }));
      }).catch(() => {});
      await activePage.keyboard.press('Tab').catch(() => {});
      await activePage.waitForTimeout(250).catch(() => {});

      actualValue = await readValue();
      if (actualValue === nextValue) break;
    }

    const id = await locator.evaluate((element) => element.id || '').catch(() => '');
    if (actualValue !== nextValue) {
      throw new Error(`${label} 입력값 불일치: requested=${nextValue}, actual=${actualValue}, id=${id}`);
    }

    return {
      label,
      selector,
      id,
      requestedValue: nextValue,
      actualValue,
      method
    };
  };

  const clickVisibleTarget = async (candidates, { pressEnter = true } = {}) => {
    for (const locator of candidates) {
      if (!(await locator.count().catch(() => 0))) continue;

      const target = await locator.evaluateHandle((element) => {
        const id = element.id || '';
        return id.includes(':icontext') ? element.parentElement || element : element;
      }).catch(() => null);
      if (!target) continue;

      const info = await target.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.id || '',
          text: (element.innerText || element.textContent || '').trim(),
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        };
      }).catch(() => null);
      if (!info || info.width <= 0 || info.height <= 0) continue;

      await target.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
      const box = await target.boundingBox().catch(() => null);
      const x = box ? box.x + box.width / 2 : info.left + info.width / 2;
      const y = box ? box.y + box.height / 2 : info.top + info.height / 2;

      await activePage.mouse.move(x, y);
      await activePage.waitForTimeout(100).catch(() => {});
      await activePage.mouse.down({ button: 'left' });
      await activePage.waitForTimeout(120).catch(() => {});
      await activePage.mouse.up({ button: 'left' });
      await activePage.waitForTimeout(250).catch(() => {});

      const dispatched = await target.evaluate((element) => {
        const options = { bubbles: true, cancelable: true, composed: true, view: window };
        const pointerOptions = { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
        for (const eventName of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          if (eventName.startsWith('pointer') && typeof PointerEvent === 'function') {
            element.dispatchEvent(new PointerEvent(eventName, pointerOptions));
          } else {
            element.dispatchEvent(new MouseEvent(eventName, options));
          }
        }
        const icon = element.querySelector('[id$=":icontext"], .nexacontentsbox, .nexatextitem');
        if (icon) icon.dispatchEvent(new MouseEvent('click', options));
        return true;
      }).catch(() => false);

      if (pressEnter) await activePage.keyboard.press('Enter').catch(() => {});
      await activePage.waitForTimeout(500).catch(() => {});
      return { id: info.id, text: info.text, x: Math.round(x), y: Math.round(y), dispatched };
    }

    return null;
  };

  const clickSearchButton = async (frame) => clickVisibleTarget([
    frame.locator('[id$="btn_query"]').first(),
    frame.locator('[id*="btn_query"]').filter({ hasNot: frame.locator('[id$=":icontext"]') }).first(),
    frame.locator('[id*="btn_query:icontext"]').first(),
    frame.locator('[id$="btnSearch"]').first(),
    frame.locator('[id*="btnSearch"]').filter({ hasNot: frame.locator('[id$=":icontext"]') }).first(),
    frame.locator('[id*="btnSearch:icontext"]').first(),
    frame.getByText('조회', { exact: true }).first()
  ]);

  const clickNoResultAlertIfPresent = async ({ timeout = 6000 } = {}) => {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      for (const frame of activePage.frames()) {
        const hasNoResult = await frame.evaluate(() => {
          const text = document.body ? document.body.innerText || document.body.textContent || '' : '';
          return text.includes('조회된 정보가 없습니다');
        }).catch(() => false);
        if (!hasNoResult) continue;

        const clicked = await clickVisibleTarget([
          frame.locator('[id*="Alert_"][id$="btnOk"]').first(),
          frame.locator('[id*="Alert_"][id*="btnOk:icontext"]').first(),
          frame.getByText('확인', { exact: true }).first()
        ], { pressEnter: false });
        const fallbackClicked = clicked ? null : await clickFixedCoordinate('no-result-alert-ok', 684, 504);
        return { found: true, clicked: clicked || fallbackClicked, usedFallbackCoordinate: !clicked, frameUrl: frame.url() };
      }
      await activePage.waitForTimeout(500).catch(() => {});
    }

    return null;
  };

  const clickApprovalLink = async () => {
    const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linkTextPattern = value ? new RegExp(escapedValue) : /^A\d{8,}/;
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      for (const frame of activePage.frames()) {
        const candidates = [
          frame.getByText(linkTextPattern).first(),
          frame.locator('[class*="cell_GPOS_WF_Link"]').first(),
          frame.locator('[id*="grd_list.body.gridrow_0"][id*="cell_0_"]').filter({ hasText: /^A\d{8,}/ }).first(),
          frame.locator('[id*="grd_list.body.gridrow_0"][id*=":text"]').filter({ hasText: /^A\d{8,}/ }).first()
        ];
        const clicked = await clickVisibleTarget(candidates);
        if (clicked) return { frameUrl: frame.url(), ...clicked };
      }
      await activePage.waitForTimeout(500).catch(() => {});
    }

    return null;
  };

  const clickAttachmentButton = async () => {
    const deadline = Date.now() + 3000;

    while (Date.now() < deadline) {
      for (const frame of activePage.frames()) {
        const candidates = [
          frame.locator('[id$="btn_attach"]').first(),
          frame.locator('[id*="btn_attach"]').filter({ hasNot: frame.locator('[id$=":icontext"]') }).first(),
          frame.locator('[id*="btn_attach:icontext"]').first(),
          frame.locator('[class*="btn_GPOS_WF_Search"]').filter({ has: frame.locator('[id*="btn_attach"]') }).first()
        ];
        const clicked = await clickVisibleTarget(candidates);
        if (clicked) return { method: 'dom', frameUrl: frame.url(), ...clicked };
      }
      await activePage.waitForTimeout(500).catch(() => {});
    }

    const viewport = activePage.viewportSize() || { width: 1365, height: 900 };
    const x = Math.round(viewport.width * (1197 / 1365));
    const y = Math.round(viewport.height * (572 / 900));
    await activePage.mouse.move(x, y);
    await activePage.waitForTimeout(100).catch(() => {});
    await activePage.mouse.down({ button: 'left' });
    await activePage.waitForTimeout(120).catch(() => {});
    await activePage.mouse.up({ button: 'left' });
    await activePage.waitForTimeout(500).catch(() => {});
    return { method: 'fixed-coordinate', id: 'attachment-magnifier-fallback', text: '첨부 돋보기', x, y, dispatched: false };
  };

  const clickFixedCoordinate = async (name, baseX, baseY) => {
    const viewport = activePage.viewportSize() || { width: 1365, height: 900 };
    const x = Math.round(viewport.width * (baseX / 1365));
    const y = Math.round(viewport.height * (baseY / 900));
    await activePage.mouse.move(x, y);
    await activePage.waitForTimeout(100).catch(() => {});
    await activePage.mouse.down({ button: 'left' });
    await activePage.waitForTimeout(120).catch(() => {});
    await activePage.mouse.up({ button: 'left' });
    await activePage.waitForTimeout(500).catch(() => {});
    return { method: 'fixed-coordinate', id: name, x, y };
  };

  const clickAttachmentPopupCheckbox = async () => clickFixedCoordinate('attachment-select-all-checkbox', 384, 315);

  const clickAttachmentPopupDownload = async () => clickFixedCoordinate('attachment-download-button', 920, 284);

  const clickVisibleTopRightClose = async () => {
    for (const frame of activePage.frames()) {
      const result = await frame.evaluate(() => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const candidates = [...document.querySelectorAll('[id*="close" i], [class*="close" i], [title*="close" i], [title*="닫"], button[value="닫기"]')]
          .map((element) => ({ element, rect: element.getBoundingClientRect() }))
          .filter(({ element, rect }) => isVisible(element) && rect.left > 1100 && rect.top < 80)
          .sort((a, b) => b.rect.left - a.rect.left);
        const selected = candidates[0];
        if (!selected) return null;
        const options = { bubbles: true, cancelable: true, composed: true, view: window };
        selected.element.dispatchEvent(new MouseEvent('mousedown', options));
        selected.element.dispatchEvent(new MouseEvent('mouseup', options));
        selected.element.dispatchEvent(new MouseEvent('click', options));
        return {
          id: selected.element.id || '',
          className: selected.element.className || '',
          text: (selected.element.innerText || selected.element.textContent || selected.element.value || '').trim(),
          x: Math.round(selected.rect.left + selected.rect.width / 2),
          y: Math.round(selected.rect.top + selected.rect.height / 2)
        };
      }).catch(() => null);
      if (result) return { method: 'dom-top-right-close', frameUrl: frame.url(), ...result };
    }
    return null;
  };

  const closeApprovalWindow = async () => {
    const attempts = [];
    for (const [x, y] of [[1212, 25], [1215, 25], [1212, 28], [1218, 24]]) {
      attempts.push(await clickFixedCoordinate('approval-window-close', x, y));
      await activePage.waitForTimeout(800).catch(() => {});
    }
    return { method: 'fixed-coordinate-sequence', attempts };
  };

  const closeAttachmentAndApprovalWindows = async () => {
    const attachmentPopupClose = await clickFixedCoordinate('attachment-popup-close', 968, 234);
    await activePage.waitForTimeout(1500).catch(() => {});
    const approvalWindowClose = await closeApprovalWindow();
    await activePage.waitForTimeout(1000).catch(() => {});
    return { attachmentPopupClose, approvalWindowClose };
  };

  const getAttachmentPopupFileCount = async () => {
    for (const frame of activePage.frames()) {
      const count = await frame.evaluate(() => {
        const text = document.body ? document.body.innerText || document.body.textContent || '' : '';
        const summaryMatch = text.match(/(\d+)\s*개/);
        if (summaryMatch) return Number(summaryMatch[1]);
        const fileMatches = text.match(/\.(?:pdf|zip|xlsx?|docx?|pptx?|hwp)\b/gi);
        return fileMatches ? fileMatches.length : 0;
      }).catch(() => 0);
      if (count > 0) return count;
    }
    return 1;
  };

  const waitForFileStable = async (filePath, { timeout = 60000, stableMs = 3000 } = {}) => {
    const deadline = Date.now() + timeout;
    let previousSize = -1;
    let stableSince = 0;

    while (Date.now() < deadline) {
      const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
      const nextSize = stats ? stats.size : -1;

      if (nextSize > 0 && nextSize === previousSize) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return nextSize;
      } else {
        stableSince = 0;
        previousSize = nextSize;
      }

      await activePage.waitForTimeout(500).catch(() => {});
    }

    throw new Error(`다운로드 파일 안정화 시간 초과: ${path.basename(filePath)}`);
  };

  const waitForDownloadsToFinish = async (downloadRecords, expectedCount = 1) => {
    const minimumCount = Math.max(1, expectedCount);
    const deadline = Date.now() + 600000;
    let quietSince = 0;

    while (Date.now() < deadline) {
      const settled = downloadRecords.filter((record) => record.done);
      const completed = settled.filter((record) => record.savedTo && record.stable && !record.error);
      const hasEnoughEvents = downloadRecords.length >= minimumCount;
      const allObservedFinished = downloadRecords.length > 0 && settled.length === downloadRecords.length;

      if (hasEnoughEvents && allObservedFinished && completed.length >= minimumCount) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= 5000) return completed;
      } else {
        quietSince = 0;
      }

      await activePage.waitForTimeout(500).catch(() => {});
    }

    await Promise.allSettled(downloadRecords.map((record) => record.promise).filter(Boolean));
    return downloadRecords.filter((record) => record.savedTo && record.stable && !record.error);
  };

  const downloadAttachmentFiles = async (approvalText) => {
    const safeApproval = String(approvalText || value || 'unknown-approval').replace(/[^A-Za-z0-9._-]+/g, '_');
    const targetDir = path.join(DOWNLOAD_DIR, safeApproval);
    fs.mkdirSync(targetDir, { recursive: true });

    const downloadRecords = [];
    const onDownload = (download) => {
      const suggested = download.suggestedFilename();
      const targetPath = path.join(targetDir, suggested);
      const record = { suggested, targetPath, done: false, stable: false };
      downloadRecords.push(record);
      record.promise = (async () => {
        try {
          await download.saveAs(targetPath);
          record.savedTo = targetPath;
          record.bytes = await waitForFileStable(targetPath);
          record.stable = true;
          record.completedAt = new Date().toISOString();
        } catch (error) {
          record.error = error.message;
        } finally {
          record.done = true;
        }
      })();
    };

    downloadOverrideDepth += 1;
    activePage.on('download', onDownload);
    try {
      await activePage.waitForTimeout(5000).catch(() => {});
      const expectedCount = await getAttachmentPopupFileCount();
      const checkbox = await clickAttachmentPopupCheckbox();
      await activePage.waitForTimeout(500).catch(() => {});
      const downloadButton = await clickAttachmentPopupDownload();
      const files = await waitForDownloadsToFinish(downloadRecords, Math.max(1, expectedCount));
      const completed = files.length >= Math.max(1, expectedCount);
      const closedWindows = completed ? await closeAttachmentAndApprovalWindows() : null;
      return {
        targetDir,
        expectedCount,
        checkbox,
        downloadButton,
        files,
        downloadCount: files.length,
        observedDownloadCount: downloadRecords.length,
        pendingDownloadCount: downloadRecords.filter((record) => !record.done).length,
        completed,
        closedWindows
      };
    } finally {
      activePage.off('download', onDownload);
      downloadOverrideDepth = Math.max(0, downloadOverrideDepth - 1);
    }
  };

  for (const frame of activePage.frames()) {
    const attempt = { frameUrl: frame.url(), filled: [] };

    try {
      if (value) {
        const filled = await fillInput(frame, 'input[id*="edt_prNo:input"], input[id*="prNo"]', value, 'approvalNumber');
        if (!filled) {
          attempts.push({ ...attempt, ok: false, step: 'approval-input-not-found' });
          continue;
        }
        attempt.filled.push(filled);
      }

      if (startDate) {
        const filled = await fillInput(frame, 'input[id*="calFrom.calendaredit:input"], input[id*="calFrom"]', startDate, 'orderStartDate');
        if (!filled) {
          attempts.push({ ...attempt, ok: false, step: 'start-date-input-not-found' });
          continue;
        }
        attempt.filled.push(filled);
      }

      if (endDate) {
        const filled = await fillInput(frame, 'input[id*="calTo.calendaredit:input"], input[id*="calTo"]', endDate, 'orderEndDate');
        if (!filled) {
          attempts.push({ ...attempt, ok: false, step: 'end-date-input-not-found' });
          continue;
        }
        attempt.filled.push(filled);
      }

      const searchButton = await clickSearchButton(frame);
      if (!searchButton) {
        attempts.push({ ...attempt, ok: false, step: 'search-button-not-found' });
        continue;
      }

      const noResultAlert = await clickNoResultAlertIfPresent({ timeout: 6000 });
      if (noResultAlert) {
        const savedTo = path.join(ARTIFACT_DIR, 'approval-search-result.json');
        const result = {
          ok: true,
          noResult: true,
          value,
          startDateValue: startDate,
          endDateValue: endDate,
          searchButton,
          noResultAlert,
          filled: attempt.filled,
          savedTo
        };
        attempts.push({ ...attempt, ...result });
        fs.writeFileSync(savedTo, JSON.stringify({ at: new Date().toISOString(), approvalNumber: value, orderStartDate: startDate, orderEndDate: endDate, attempts }, null, 2));
        return result;
      }

      const approvalLink = await clickApprovalLink();
      if (!approvalLink) {
        attempts.push({ ...attempt, ok: false, step: 'approval-link-not-found', searchButton });
        continue;
      }

      await activePage.waitForTimeout(2000).catch(() => {});
      const attachmentButton = await clickAttachmentButton();
      if (!attachmentButton) {
        attempts.push({ ...attempt, ok: false, step: 'attachment-button-not-found', searchButton, approvalLink });
        continue;
      }

      const attachmentDownloads = await downloadAttachmentFiles(approvalLink.text || value);
      const savedTo = path.join(ARTIFACT_DIR, 'approval-search-result.json');
      const result = {
        ok: true,
        value,
        startDateValue: startDate,
        endDateValue: endDate,
        searchButton,
        approvalLink,
        attachmentButton,
        attachmentDownloads,
        filled: attempt.filled,
        savedTo
      };
      attempts.push({ ...attempt, ...result });
      fs.writeFileSync(savedTo, JSON.stringify({ at: new Date().toISOString(), approvalNumber: value, orderStartDate: startDate, orderEndDate: endDate, attempts }, null, 2));
      return result;
    } catch (error) {
      attempts.push({ ...attempt, ok: false, step: 'playwright-error', error: error.message });
    }
  }

  const savedTo = path.join(ARTIFACT_DIR, 'approval-search-result.json');
  fs.writeFileSync(savedTo, JSON.stringify({ at: new Date().toISOString(), approvalNumber: value, orderStartDate: startDate, orderEndDate: endDate, attempts }, null, 2));
  throw new Error('조회 조건 입력 또는 조회 버튼 클릭에 실패했습니다: ' + savedTo);
}

async function clickFirstApprovalNumber() {
  const activePage = await ensurePage();
  const attempts = [];

  for (const frame of activePage.frames()) {
    const result = await frame.evaluate(() => {
      const numberPattern = /A\d{8,}/;
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (element) => (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
      const clickableAncestor = (element) => element.closest('a, button, [onclick], [role="button"], td, div, span') || element;

      const candidates = [...document.querySelectorAll('a, [onclick], td, span, div')]
        .map((element) => {
          const text = textOf(element);
          const match = text.match(numberPattern);
          if (!match || text.length > 80 || !isVisible(element)) return null;
          const target = clickableAncestor(element);
          const rect = target.getBoundingClientRect();
          if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return null;
          return {
            text: match[0],
            tag: target.tagName.toLowerCase(),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            href: target.getAttribute('href') || '',
            onclick: target.getAttribute('onclick') || '',
            target
          };
        })
        .filter(Boolean)
        .sort((a, b) => (a.top - b.top) || (a.left - b.left));

      const selected = candidates[0];
      if (!selected) return { ok: false, reason: 'approval-number-not-found' };

      selected.target.scrollIntoView({ block: 'center', inline: 'center' });
      selected.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      selected.target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      selected.target.click();

      return {
        ok: true,
        text: selected.text,
        tag: selected.tag,
        top: selected.top,
        left: selected.left,
        href: selected.href,
        onclick: selected.onclick
      };
    }).catch((error) => ({ ok: false, reason: error.message }));

    attempts.push({ frameUrl: frame.url(), ...result });
    if (result.ok) {
      const savedTo = path.join(ARTIFACT_DIR, 'approval-click-result.json');
      fs.writeFileSync(savedTo, JSON.stringify({ at: new Date().toISOString(), attempts }, null, 2));
      await activePage.waitForTimeout(1000).catch(() => {});
      return { ...result, savedTo };
    }
  }

  const savedTo = path.join(ARTIFACT_DIR, 'approval-click-result.json');
  fs.writeFileSync(savedTo, JSON.stringify({ at: new Date().toISOString(), attempts }, null, 2));
  throw new Error('화면에서 품의번호(A로 시작하는 번호)를 찾지 못했습니다: ' + savedTo);
}

async function getStatus() {
  return {
    ready: !!page && !page.isClosed(),
    url: page && !page.isClosed() ? page.url() : null,
    title: page && !page.isClosed() ? await page.title().catch(() => '') : '',
    lastError,
    lastAutomation
  };
}

async function clickByTextOrAttribute(activePage, labels, { timeout = 5000 } = {}) {
  const normalizedLabels = labels.map((label) => String(label).toLowerCase());
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const frame of activePage.frames()) {
      for (const label of labels) {
        const exact = typeof label === 'string' ? label : undefined;
        const pattern = label instanceof RegExp ? label : new RegExp(String(label), 'i');

        for (const locator of [
          frame.getByRole('link', { name: pattern }).first(),
          frame.getByRole('button', { name: pattern }).first(),
          exact ? frame.getByText(exact, { exact: true }).first() : frame.getByText(pattern).first()
        ]) {
          if (await locator.count().catch(() => 0)) {
            await locator.click({ timeout: 2000 }).catch(async () => {
              await locator.evaluate((element) => element.click());
            });
            return true;
          }
        }
      }

      const clicked = await frame.evaluate((wanted) => {
        const normalize = (value) => (value || '').toLowerCase().replace(/\s+/g, '');
        const elements = [...document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [onclick], [role="button"], [title], img')];
        const target = elements.find((element) => {
          const haystack = [
            element.innerText,
            element.textContent,
            element.value,
            element.alt,
            element.title,
            element.getAttribute('aria-label'),
            element.getAttribute('href'),
            element.getAttribute('onclick'),
            element.id,
            element.className
          ].map(normalize).join(' ');

          return wanted.some((label) => haystack.includes(normalize(label)));
        });
        if (!target) return false;
        target.click();
        return true;
      }, normalizedLabels).catch(() => false);

      if (clicked) return true;
    }

    await activePage.waitForTimeout(500);
  }

  return false;
}

async function openVaatzFromAutoway() {
  await ensurePage();
  const appId = 'H103_SL_K_VAATZP';
  const url = 'https://giam.wia.co.kr/im/wia/profile/extlink/vaatzlink/';
  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  const autowayPage = pages.find((candidate) => candidate.url().includes('autoway.hyundai.net/main')) || page;
  const attempts = [];

  for (const frame of autowayPage.frames()) {
    const result = await frame.evaluate(({ appId, url }) => {
      const locations = [
        ['window.fn_MyworkSystem', () => window.fn_MyworkSystem],
        ['parent.fn_MyworkSystem', () => parent?.fn_MyworkSystem],
        ['parent.parent.fn_MyworkSystem', () => parent?.parent?.fn_MyworkSystem],
        ['top.fn_MyworkSystem', () => top?.fn_MyworkSystem]
      ];

      for (const [name, getter] of locations) {
        try {
          const fn = getter();
          if (typeof fn === 'function') {
            fn(appId, 'AP', 'Y', 'P', '', url);
            return { ok: true, method: name };
          }
        } catch (error) {
          return { ok: false, method: name, error: error.message };
        }
      }

      const target = [...document.querySelectorAll('a, button, input, [onclick]')].find((element) =>
        String(element.getAttribute('onclick') || '').includes('fn_MyworkSystem') &&
        String(element.getAttribute('onclick') || '').includes(appId)
      );
      if (target) {
        target.click();
        return { ok: true, method: 'target.click', onclick: target.getAttribute('onclick') || '' };
      }

      return { ok: false, method: 'not-found' };
    }, { appId, url }).catch((error) => ({ ok: false, method: 'evaluate', error: error.message }));

    attempts.push({ frameUrl: frame.url(), ...result });
    if (result.ok) {
      const savedTo = path.join(ARTIFACT_DIR, 'vaatz-open-result.json');
      fs.writeFileSync(savedTo, JSON.stringify({ at: new Date().toISOString(), attempts }, null, 2));
      return { ok: true, method: result.method, savedTo };
    }
  }

  const savedTo = path.join(ARTIFACT_DIR, 'vaatz-open-result.json');
  fs.writeFileSync(savedTo, JSON.stringify({ at: new Date().toISOString(), attempts }, null, 2));
  return { ok: false, method: 'all-frames-failed', savedTo };
}

async function openGiamVaatzDirect() {
  await ensurePage();
  const giamPage = await context.newPage();
  await setActivePage(giamPage);
  await page.goto('https://giam.wia.co.kr/im/wia/profile/extlink/vaatzlink/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  return page.url();
}

async function openGlobalVaatzDirect() {
  await ensurePage();
  const globalPage = await context.newPage();
  await setActivePage(globalPage);
  await page.goto('https://wia.vaatz.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  return page.url();
}

async function expandVaatzPurchaseManagementSideMenu() {
  const activePage = await ensurePage();
  const deadline = Date.now() + 15000;
  const attempts = [];

  const clickLocator = async (locator, frame) => {
    if (!(await locator.count().catch(() => 0))) return null;
    const box = await locator.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await activePage.mouse.move(x, y);
    await activePage.waitForTimeout(100).catch(() => {});
    await activePage.mouse.down({ button: 'left' });
    await activePage.waitForTimeout(120).catch(() => {});
    await activePage.mouse.up({ button: 'left' });
    await activePage.waitForTimeout(800).catch(() => {});
    return {
      method: 'dom',
      frameUrl: frame.url(),
      id: await locator.evaluate((element) => element.id || '').catch(() => ''),
      userstatus: await locator.evaluate((element) => element.getAttribute('userstatus') || '').catch(() => ''),
      x: Math.round(x),
      y: Math.round(y)
    };
  };

  while (Date.now() < deadline) {
    for (const frame of activePage.frames()) {
      const candidates = [
        frame.locator('[id$="grdTree.body.gridrow_5.cell_5_0.celltreeitem.treeitembutton"]').first(),
        frame.locator('[id*="grdTree.body.gridrow_5"][id*="treeitembutton"]').first(),
        frame.locator('[class*="treeitembutton"][userstatus="collapse"]').filter({ hasNotText: '' }).first()
      ];
      for (const locator of candidates) {
        const clicked = await clickLocator(locator, frame);
        if (clicked) {
          const result = { ok: true, ...clicked };
          await activePage.waitForTimeout(1000).catch(() => {});
          result.purchaseSubMenu = await expandVaatzPurchaseSideSubMenu();
          fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-purchase-side-menu-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts: [...attempts, result] }, null, 2));
          return result;
        }
      }
    }
    await activePage.waitForTimeout(500).catch(() => {});
  }

  const viewport = activePage.viewportSize() || { width: 1365, height: 900 };
  const x = Math.round(viewport.width * (15 / 1365));
  const y = Math.round(viewport.height * (367 / 900));
  await activePage.mouse.click(x, y);
  await activePage.waitForTimeout(800).catch(() => {});
  const result = { ok: true, method: 'fixed-coordinate', id: 'purchase-side-menu-plus-fallback', x, y };
  await activePage.waitForTimeout(1000).catch(() => {});
  result.purchaseSubMenu = await expandVaatzPurchaseSideSubMenu();
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-purchase-side-menu-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts: [...attempts, result] }, null, 2));
  return result;
}

async function expandVaatzPurchaseSideSubMenu() {
  const activePage = await ensurePage();
  const deadline = Date.now() + 15000;
  const attempts = [];

  const clickLocator = async (locator, frame) => {
    if (!(await locator.count().catch(() => 0))) return null;
    const box = await locator.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await activePage.mouse.move(x, y);
    await activePage.waitForTimeout(100).catch(() => {});
    await activePage.mouse.down({ button: 'left' });
    await activePage.waitForTimeout(120).catch(() => {});
    await activePage.mouse.up({ button: 'left' });
    await activePage.waitForTimeout(800).catch(() => {});
    return {
      method: 'dom',
      frameUrl: frame.url(),
      id: await locator.evaluate((element) => element.id || '').catch(() => ''),
      userstatus: await locator.evaluate((element) => element.getAttribute('userstatus') || '').catch(() => ''),
      x: Math.round(x),
      y: Math.round(y)
    };
  };

  while (Date.now() < deadline) {
    for (const frame of activePage.frames()) {
      const candidates = [
        frame.locator('[id$="grdTree.body.gridrow_6.cell_6_0.celltreeitem.treeitembutton"]').first(),
        frame.locator('[id*="grdTree.body.gridrow_6"][id*="treeitembutton"]').first()
      ];
      for (const locator of candidates) {
        const clicked = await clickLocator(locator, frame);
        if (clicked) {
          const result = { ok: true, ...clicked };
          await activePage.waitForTimeout(1000).catch(() => {});
          result.partOrderProgressMenu = await clickVaatzPartOrderProgressMenu();
          fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-purchase-sub-menu-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts: [...attempts, result] }, null, 2));
          return result;
        }
      }
    }
    await activePage.waitForTimeout(500).catch(() => {});
  }

  const viewport = activePage.viewportSize() || { width: 1365, height: 900 };
  const x = Math.round(viewport.width * (23 / 1365));
  const y = Math.round(viewport.height * (402 / 900));
  await activePage.mouse.click(x, y);
  await activePage.waitForTimeout(800).catch(() => {});
  const result = { ok: true, method: 'fixed-coordinate', id: 'purchase-sub-menu-plus-fallback', x, y };
  await activePage.waitForTimeout(1000).catch(() => {});
  result.partOrderProgressMenu = await clickVaatzPartOrderProgressMenu();
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-purchase-sub-menu-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts: [...attempts, result] }, null, 2));
  return result;
}

async function clickVaatzPartOrderProgressMenu() {
  const activePage = await ensurePage();
  const deadline = Date.now() + 15000;
  const attempts = [];

  const clickLocator = async (locator, frame) => {
    if (!(await locator.count().catch(() => 0))) return null;
    const box = await locator.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await activePage.mouse.move(x, y);
    await activePage.waitForTimeout(100).catch(() => {});
    await activePage.mouse.down({ button: 'left' });
    await activePage.waitForTimeout(120).catch(() => {});
    await activePage.mouse.up({ button: 'left' });
    await activePage.waitForTimeout(1200).catch(() => {});
    return {
      method: 'dom',
      frameUrl: frame.url(),
      id: await locator.evaluate((element) => element.id || '').catch(() => ''),
      text: await locator.evaluate((element) => (element.innerText || element.textContent || '').trim()).catch(() => ''),
      x: Math.round(x),
      y: Math.round(y)
    };
  };

  while (Date.now() < deadline) {
    for (const frame of activePage.frames()) {
      const candidates = [
        frame.locator('[id$="grdTree.body.gridrow_10.cell_10_0.celltreeitem.treeitemtext"]').first(),
        frame.locator('[id$="grdTree.body.gridrow_10.cell_10_0.celltreeitem"]').first(),
        frame.locator('[id*="grdTree.body.gridrow_10"]').filter({ hasText: '품번별 발주 진행현황' }).first(),
        frame.getByText('품번별 발주 진행현황', { exact: true }).first()
      ];
      for (const locator of candidates) {
        const clicked = await clickLocator(locator, frame);
        if (clicked) {
          const result = { ok: true, ...clicked };
          result.clearedDefaults = await clearPartOrderProgressDefaultFields();
          fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-part-order-progress-menu-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts: [...attempts, result] }, null, 2));
          return result;
        }
      }
    }
    await activePage.waitForTimeout(500).catch(() => {});
  }

  const viewport = activePage.viewportSize() || { width: 1365, height: 900 };
  const x = Math.round(viewport.width * (141 / 1365));
  const y = Math.round(viewport.height * (542 / 900));
  await activePage.mouse.click(x, y);
  await activePage.waitForTimeout(1200).catch(() => {});
  const result = { ok: true, method: 'fixed-coordinate', id: 'part-order-progress-menu-fallback', text: '품번별 발주 진행현황', x, y };
  result.clearedDefaults = await clearPartOrderProgressDefaultFields();
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-part-order-progress-menu-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts: [...attempts, result] }, null, 2));
  return result;
}

async function clearPartOrderProgressDefaultFields() {
  const activePage = await ensurePage();
  const attempts = [];
  const selectAllShortcut = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';

  const waitForProgressScreenReady = async ({ timeout = 45000, settleDelay = 2000 } = {}) => {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      for (const frame of activePage.frames()) {
        const fieldReady = await frame.evaluate(() => {
          const isVisible = (element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const fields = [...document.querySelectorAll('input[id*="edt_userDept:input"], input[id*="edt_userId:input"]')];
          return fields.some(isVisible);
        }).catch(() => false);
        if (fieldReady) {
          await activePage.waitForTimeout(settleDelay).catch(() => {});
          return { ok: true, trigger: 'default-field-visible', frameUrl: frame.url(), settleDelay };
        }

        const titleReady = await frame.evaluate(() => {
          const text = document.body ? document.body.innerText || document.body.textContent || '' : '';
          return text.includes('품번별 발주 진행현황');
        }).catch(() => false);
        if (titleReady) {
          await activePage.waitForTimeout(settleDelay).catch(() => {});
          return { ok: true, trigger: 'screen-title-visible', frameUrl: frame.url(), settleDelay };
        }
      }

      await activePage.waitForTimeout(500).catch(() => {});
    }

    return { ok: false, reason: 'progress-screen-not-ready', timeout };
  };

  const clearLocator = async (locator, frame, fieldName) => {
    const box = await locator.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const before = await locator.inputValue().catch(() => '');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await activePage.mouse.click(x, y);
    await activePage.waitForTimeout(100).catch(() => {});
    await activePage.keyboard.press(selectAllShortcut).catch(() => {});
    await activePage.keyboard.press('Backspace').catch(() => {});
    await locator.evaluate((element) => {
      element.value = '';
      const options = { bubbles: true, cancelable: true, composed: true };
      element.dispatchEvent(new Event('input', options));
      element.dispatchEvent(new Event('change', options));
      element.dispatchEvent(new KeyboardEvent('keydown', { ...options, key: 'Backspace' }));
      element.dispatchEvent(new KeyboardEvent('keyup', { ...options, key: 'Backspace' }));
      element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    }).catch(() => {});
    await activePage.waitForTimeout(150).catch(() => {});
    const after = await locator.inputValue().catch(() => '');
    return {
      fieldName,
      method: 'visible-dom-and-keyboard',
      frameUrl: frame.url(),
      id: await locator.evaluate((element) => element.id || '').catch(() => ''),
      before,
      after,
      x: Math.round(x),
      y: Math.round(y)
    };
  };

  const clearField = async (frame, fieldName) => {
    const locators = frame.locator(`input[id$="${fieldName}:input"], input[id*="${fieldName}:input"]`);
    const count = await locators.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const cleared = await clearLocator(locators.nth(index), frame, fieldName);
      if (cleared) return cleared;
    }
    return null;
  };

  const clearAtCoordinate = async (fieldName, baseX, baseY) => {
    const viewport = activePage.viewportSize() || { width: 1365, height: 900 };
    const x = Math.round(viewport.width * (baseX / 1365));
    const y = Math.round(viewport.height * (baseY / 900));
    await activePage.mouse.click(x, y);
    await activePage.waitForTimeout(120).catch(() => {});
    await activePage.keyboard.press(selectAllShortcut).catch(() => {});
    await activePage.keyboard.press('Backspace').catch(() => {});
    await activePage.keyboard.press('Tab').catch(() => {});
    await activePage.waitForTimeout(150).catch(() => {});
    return { fieldName, method: 'fixed-coordinate-keyboard', x, y };
  };

  const screenReady = await waitForProgressScreenReady();
  attempts.push({ screenReady });
  if (!screenReady.ok) {
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-part-order-progress-clear-defaults-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts }, null, 2));
    return { ok: false, reason: screenReady.reason, screenReady };
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const fields = [];
    for (const frame of activePage.frames()) {
      const userDept = await clearField(frame, 'edt_userDept');
      const userId = await clearField(frame, 'edt_userId');
      if (userDept) fields.push(userDept);
      if (userId) fields.push(userId);
    }

    // Nexacro can display component state even when the backing input value is empty.
    // Clear the visible boxes by coordinates as a final, deterministic pass.
    fields.push(await clearAtCoordinate('edt_userDept', 681, 160));
    fields.push(await clearAtCoordinate('edt_userId', 797, 160));

    const result = { ok: true, fields };
    attempts.push(result);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-part-order-progress-clear-defaults-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts }, null, 2));
    return result;
  }

  const result = { ok: false, reason: 'fields-not-found' };
  attempts.push(result);
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-part-order-progress-clear-defaults-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts }, null, 2));
  return result;
}

async function clickVaatzPurchaseManagement() {
  const activePage = await ensurePage();
  const deadline = Date.now() + 30000;
  const attempts = [];

  const clickCandidate = async (locator) => {
    if (!(await locator.count().catch(() => 0))) return null;
    const target = await locator.evaluateHandle((element) => {
      const id = element.id || '';
      return id.includes(':icontext') ? element.parentElement || element : element;
    }).catch(() => null);
    if (!target) return null;
    const box = await target.asElement().boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) return null;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await activePage.mouse.move(x, y);
    await activePage.waitForTimeout(100).catch(() => {});
    await activePage.mouse.down({ button: 'left' });
    await activePage.waitForTimeout(120).catch(() => {});
    await activePage.mouse.up({ button: 'left' });
    await activePage.waitForTimeout(800).catch(() => {});
    return {
      id: await target.evaluate((element) => element.id || '').catch(() => ''),
      text: await target.evaluate((element) => (element.innerText || element.textContent || '').trim()).catch(() => ''),
      x: Math.round(x),
      y: Math.round(y)
    };
  };

  while (Date.now() < deadline) {
    for (const frame of activePage.frames()) {
      const candidates = [
        frame.locator('[id$="TOP_GPMS_D"]').first(),
        frame.locator('[id*="TOP_GPMS_D"]').filter({ hasNot: frame.locator('[id$=":icontext"]') }).first(),
        frame.locator('[id*="TOP_GPMS_D:icontext"]').first(),
        frame.getByText(/발주\s*관리/).first()
      ];
      for (const locator of candidates) {
        const clicked = await clickCandidate(locator);
        if (clicked) {
          const result = { ok: true, method: 'dom', frameUrl: frame.url(), ...clicked };
          await activePage.waitForTimeout(1000).catch(() => {});
          result.sideMenu = await expandVaatzPurchaseManagementSideMenu();
          fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-purchase-menu-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts: [...attempts, result] }, null, 2));
          return result;
        }
      }
    }
    await activePage.waitForTimeout(750).catch(() => {});
  }

  const viewport = activePage.viewportSize() || { width: 1365, height: 900 };
  const x = Math.round(viewport.width * (421 / 1365));
  const y = Math.round(viewport.height * (72 / 900));
  await activePage.mouse.click(x, y);
  const result = { ok: true, method: 'fixed-coordinate', id: 'TOP_GPMS_D-fallback', text: '발주 관리', x, y };
  await activePage.waitForTimeout(1000).catch(() => {});
  result.sideMenu = await expandVaatzPurchaseManagementSideMenu();
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-purchase-menu-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts: [...attempts, result] }, null, 2));
  return result;
}

async function loginVaatzIfLoginScreen({ vaatzId, vaatzPassword } = {}) {
  const idValue = String(vaatzId || '').trim();
  const passwordValue = String(vaatzPassword || '');
  if (!idValue || !passwordValue) return null;

  const activePage = await ensurePage();
  const deadline = Date.now() + 45000;
  const attempts = [];

  const fillLoginInput = async (locator, nextValue, label) => {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 3000, force: true });
    await activePage.waitForTimeout(100).catch(() => {});
    await activePage.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await activePage.keyboard.press('Backspace').catch(() => {});
    await activePage.keyboard.type(nextValue, { delay: 25 });
    await locator.evaluate((element) => {
      const options = { bubbles: true, cancelable: true, composed: true };
      element.dispatchEvent(new Event('input', options));
      element.dispatchEvent(new Event('change', options));
    }).catch(() => {});
    await activePage.waitForTimeout(150).catch(() => {});
    return {
      label,
      id: await locator.evaluate((element) => element.id || '').catch(() => ''),
      actualValue: await locator.inputValue().catch(() => '')
    };
  };

  const clickLoginButton = async (frame) => {
    const candidates = [
      frame.locator('[id$="btnLogin"]').first(),
      frame.locator('[id*="btnLogin"]').filter({ hasNot: frame.locator('[id$=":icontext"]') }).first(),
      frame.locator('[id*="btnLogin:icontext"]').first(),
      frame.getByText('Login', { exact: true }).first()
    ];

    for (const locator of candidates) {
      if (!(await locator.count().catch(() => 0))) continue;
      const target = await locator.evaluateHandle((element) => {
        const id = element.id || '';
        return id.includes(':icontext') ? element.parentElement || element : element;
      }).catch(() => null);
      if (!target) continue;
      const box = await target.asElement().boundingBox().catch(() => null);
      if (!box || box.width <= 0 || box.height <= 0) continue;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await activePage.mouse.move(x, y);
      await activePage.waitForTimeout(100).catch(() => {});
      await activePage.mouse.down({ button: 'left' });
      await activePage.waitForTimeout(120).catch(() => {});
      await activePage.mouse.up({ button: 'left' });
      await activePage.waitForTimeout(500).catch(() => {});
      return { id: await target.evaluate((element) => element.id || '').catch(() => ''), x: Math.round(x), y: Math.round(y) };
    }
    return null;
  };

  while (Date.now() < deadline) {
    for (const frame of activePage.frames()) {
      const idInput = frame.locator('input[id$="edtId:input"], input[id*="edtId:input"]').first();
      const passwordInput = frame.locator('input[id$="edtPwd:input"], input[id*="edtPwd:input"], input[type="password"]').first();
      const hasId = await idInput.count().catch(() => 0);
      const hasPassword = await passwordInput.count().catch(() => 0);
      if (!hasId || !hasPassword) continue;

      const idFilled = await fillLoginInput(idInput, idValue, 'vaatzId');
      await activePage.keyboard.press('Tab').catch(() => {});
      const passwordFilled = await fillLoginInput(passwordInput, passwordValue, 'vaatzPassword');
      const loginButton = await clickLoginButton(frame);
      const result = { ok: !!loginButton, frameUrl: frame.url(), idFilled, passwordFilled: { ...passwordFilled, actualValue: passwordFilled.actualValue ? '********' : '' }, loginButton };
      attempts.push(result);
      fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-login-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts }, null, 2));
      await activePage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      if (result.ok) result.purchaseManagement = await clickVaatzPurchaseManagement();
      return result;
    }

    await activePage.waitForTimeout(750).catch(() => {});
  }

  fs.writeFileSync(path.join(ARTIFACT_DIR, 'vaatz-login-result.json'), JSON.stringify({ at: new Date().toISOString(), attempts, skipped: true, reason: 'login-screen-not-found' }, null, 2));
  return { ok: false, skipped: true, reason: 'login-screen-not-found' };
}

async function goToVaatz() {
  await ensurePage();
  let attemptedOpen = false;
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const pages = context.pages().filter((candidate) => !candidate.isClosed());

    for (const candidate of pages) {
      await candidate.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
      const title = await candidate.title().catch(() => '');
      if (isVaatzPage(candidate, title)) {
        await setActivePage(candidate);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        return page.url();
      }
    }

    if (!attemptedOpen) {
      const openResult = await openVaatzFromAutoway();
      attemptedOpen = !!openResult.ok;
      if (!attemptedOpen) lastError = 'VAATZ 실행 실패: ' + JSON.stringify(openResult);
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  const openPages = context.pages()
    .filter((candidate) => !candidate.isClosed())
    .map((candidate, index) => ({ index, url: candidate.url() }));
  throw new Error('열려 있는 Playwright 창 중 VAATZ 창을 찾지 못했습니다: ' + JSON.stringify(openPages));
}

async function runAutomation({ vaatzUrl } = {}) {
  const activePage = await ensurePage();
  const steps = [];
  const currentUrl = activePage.url();

  if (!currentUrl || currentUrl.includes('/login/') || currentUrl.includes('/Login/')) {
    throw new Error('Autoway login is not complete yet. Log in manually first, then start automation.');
  }

  const sessionPath = await saveSession();
  steps.push({ name: '세션 저장', ok: true, detail: sessionPath });

  const movedTo = await goToVaatz();
  steps.push({ name: 'Vaatz 이동', ok: true, detail: movedTo });

  lastAutomation = {
    at: new Date().toISOString(),
    steps
  };
  return lastAutomation;
}

const app = express();
app.use((req, res, next) => {
  res.setHeader('cache-control', 'no-store');
  next();
});
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.type('html').send(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
});

app.get('/app.js', (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.type('text/javascript').send(fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8'));
});

app.get('/styles.css', (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.type('text/css').send(fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8'));
});

app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res) => res.setHeader('cache-control', 'no-store')
}));

app.post('/api/start', async (_req, res) => {
  try {
    lastError = null;
    const activePage = await ensurePage();
    await activePage.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await activePage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    res.json(await getStatus());
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.get('/api/status', async (_req, res) => {
  res.json(await getStatus());
});

app.get('/api/screenshot', async (_req, res) => {
  try {
    const activePage = await ensurePage();
    const image = await activePage.screenshot({ type: 'jpeg', quality: 75 });
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('cache-control', 'no-store');
    res.end(image);
  } catch (error) {
    lastError = error.message;
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/click', async (req, res) => {
  try {
    const activePage = await ensurePage();
    const button = req.body.button === 'right' ? 'right' : 'left';
    await activePage.mouse.click(Number(req.body.x), Number(req.body.y), { button });
    res.json(await getStatus());
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/key', async (req, res) => {
  try {
    const activePage = await ensurePage();
    const { key, text } = req.body;
    if (text) await activePage.keyboard.type(text);
    else if (key) await activePage.keyboard.press(key);
    res.json(await getStatus());
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/paste', async (req, res) => {
  try {
    const activePage = await ensurePage();
    await activePage.keyboard.insertText(String(req.body.text || ''));
    res.json(await getStatus());
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/save-session', async (_req, res) => {
  try {
    const savedTo = await saveSession();
    res.json({ savedTo, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/dump-open-pages', async (_req, res) => {
  try {
    lastError = null;
    const result = await dumpOpenPages();
    res.json({ ...result, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/dump-page', async (_req, res) => {
  try {
    lastError = null;
    const result = await dumpPageElements();
    res.json({ ...result, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/upload-approval-list', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  try {
    lastError = null;
    const filename = decodeURIComponent(String(req.get('x-filename') || ''));
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!buffer.length) throw new Error('업로드된 파일이 비어 있습니다.');
    res.json(parseApprovalListFile(buffer, filename));
  } catch (error) {
    lastError = error.message;
    res.status(400).json({ error: error.message, lastError });
  }
});

app.post('/api/wia-vaatz-direct', async (req, res) => {
  try {
    lastError = null;
    const movedTo = await openGlobalVaatzDirect();
    const vaatzLogin = await loginVaatzIfLoginScreen(req.body || {});
    res.json({ movedTo, vaatzLogin, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});



app.post('/api/search-approval-number', async (req, res) => {
  try {
    lastError = null;
    const searched = await searchApprovalNumber(req.body);
    res.json({ searched, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/click-first-approval-number', async (_req, res) => {
  try {
    lastError = null;
    const clicked = await clickFirstApprovalNumber();
    res.json({ clicked, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/global-vaatz-direct', async (_req, res) => {
  try {
    lastError = null;
    const movedTo = await openGlobalVaatzDirect();
    res.json({ movedTo, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/giam-vaatz-direct', async (_req, res) => {
  try {
    lastError = null;
    const movedTo = await openGiamVaatzDirect();
    res.json({ movedTo, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/go-vaatz', async (req, res) => {
  try {
    lastError = null;
    const movedTo = await goToVaatz();
    res.json({ movedTo, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/automation/start', async (req, res) => {
  try {
    lastError = null;
    const automation = await runAutomation({ vaatzUrl: req.body?.vaatzUrl });
    res.json({ automation, ...(await getStatus()) });
  } catch (error) {
    lastError = error.message;
    res.status(500).json(await getStatus());
  }
});

app.post('/api/stop', async (_req, res) => {
  await browser?.close().catch(() => {});
  browser = null;
  context = null;
  page = null;
  lastAutomation = null;
  res.json(await getStatus());
});

const keepAlive = setInterval(() => {}, 2147483647);
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Manual Autoway app: http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  await browser?.close().catch(() => {});
  clearInterval(keepAlive);
  server.close(() => process.exit(0));
});
