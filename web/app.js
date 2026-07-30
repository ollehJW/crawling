const screen = document.querySelector('#screen');
const urlEl = document.querySelector('#url');
const stateEl = document.querySelector('#state');
const rightMouseMode = document.querySelector('#rightMouseMode');
const approvalNumberInput = document.querySelector('#approvalNumberInput');
const orderStartDateInput = document.querySelector('#orderStartDateInput');
const orderEndDateInput = document.querySelector('#orderEndDateInput');

let imageWidth = 1365;
let imageHeight = 900;
let refreshTimer;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  updateStatus(body);
  if (!response.ok) throw new Error(body.lastError || body.error || response.statusText);
  return body;
}

function updateStatus(status) {
  if (!status) return;
  urlEl.textContent = status.url || '-';
  stateEl.textContent = status.lastError || (status.ready ? '실행 중' : '대기');
}

function refreshScreen() {
  const image = new Image();
  image.onload = () => {
    imageWidth = image.naturalWidth;
    imageHeight = image.naturalHeight;
    screen.src = image.src;
  };
  image.src = `/api/screenshot?t=${Date.now()}`;
}

function startRefresh() {
  clearInterval(refreshTimer);
  refreshScreen();
  refreshTimer = setInterval(refreshScreen, 700);
}

document.querySelector('#wiaDirect').addEventListener('click', async () => {
  stateEl.textContent = 'WIA Vaatz 이동 중';
  await api('/api/wia-vaatz-direct', { method: 'POST' });
  startRefresh();
});

document.querySelector('#clickApprovalNumber').addEventListener('click', async () => {
  const approvalNumber = approvalNumberInput.value.trim();
  const orderStartDate = orderStartDateInput.value.trim();
  const orderEndDate = orderEndDateInput.value.trim();

  if (!approvalNumber && !orderStartDate && !orderEndDate) {
    stateEl.textContent = '조회 조건을 입력하세요';
    approvalNumberInput.focus();
    return;
  }

  stateEl.textContent = '조회 조건 반영 중';
  const result = await api('/api/search-approval-number', {
    method: 'POST',
    body: JSON.stringify({ approvalNumber, orderStartDate, orderEndDate })
  });
  const searchedValue = result.searched && result.searched.value ? result.searched.value : approvalNumber || '날짜 조건';
  stateEl.textContent = `조회 완료: ${searchedValue}`;
  startRefresh();
});

document.querySelector('#dumpOpenPages').addEventListener('click', async () => {
  stateEl.textContent = '열린 창 저장 중';
  const result = await api('/api/dump-open-pages', { method: 'POST' });
  stateEl.textContent = result.savedTo ? `저장 완료: ${result.savedTo}` : '저장 완료';
});

document.querySelector('#dumpPage').addEventListener('click', async () => {
  stateEl.textContent = '화면 분석 저장 중';
  const result = await api('/api/dump-page', { method: 'POST' });
  stateEl.textContent = result.savedTo ? `저장 완료: ${result.savedTo}` : '저장 완료';
});

async function sendMouseClick(event, button = 'left') {
  const rect = screen.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * imageWidth);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * imageHeight);
  await api('/api/click', {
    method: 'POST',
    body: JSON.stringify({ x, y, button })
  });
}

screen.addEventListener('click', async (event) => {
  const button = rightMouseMode.checked ? 'right' : 'left';
  await sendMouseClick(event, button);
});

screen.addEventListener('contextmenu', async (event) => {
  event.preventDefault();
  await sendMouseClick(event, 'right');
});

window.addEventListener('keydown', async (event) => {
  const target = event.target;
  if (target && target.closest && target.closest('.panel input, .panel textarea, .panel select')) {
    return;
  }

  event.preventDefault();

  const special = {
    Backspace: 'Backspace',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Escape',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    Delete: 'Delete'
  };

  if (special[event.key]) {
    await api('/api/key', {
      method: 'POST',
      body: JSON.stringify({ key: special[event.key] })
    });
    return;
  }

  if (event.key.length === 1) {
    await api('/api/key', {
      method: 'POST',
      body: JSON.stringify({ text: event.key })
    });
  }
});

api('/api/status').then((status) => {
  if (status.ready) startRefresh();
}).catch(() => {});
