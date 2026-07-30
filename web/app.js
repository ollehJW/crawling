const screen = document.querySelector('#screen');
const urlEl = document.querySelector('#url');
const stateEl = document.querySelector('#state');
const vaatzLoginModal = document.querySelector('#vaatzLoginModal');
const vaatzLoginForm = document.querySelector('#vaatzLoginForm');
const vaatzLoginCancel = document.querySelector('#vaatzLoginCancel');
const vaatzIdInput = document.querySelector('#vaatzIdInput');
const vaatzPasswordInput = document.querySelector('#vaatzPasswordInput');
const approvalListUploadButton = document.querySelector('#approvalListUploadButton');
const approvalListFileInput = document.querySelector('#approvalListFileInput');
const approvalListModal = document.querySelector('#approvalListModal');
const approvalListClose = document.querySelector('#approvalListClose');
const approvalListTotal = document.querySelector('#approvalListTotal');
const approvalListFileName = document.querySelector('#approvalListFileName');
const approvalListRows = document.querySelector('#approvalListRows');
const approvalListCancel = document.querySelector('#approvalListCancel');
const approvalListConfirm = document.querySelector('#approvalListConfirm');
const sidebarApprovalList = document.querySelector('#sidebarApprovalList');
const sidebarApprovalTotal = document.querySelector('#sidebarApprovalTotal');
const sidebarApprovalRows = document.querySelector('#sidebarApprovalRows');

let imageWidth = 1365;
let imageHeight = 900;
let refreshTimer;
let pendingApprovalList = null;
let confirmedApprovalList = [];

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

function openVaatzLoginModal() {
  vaatzLoginModal.hidden = false;
  vaatzIdInput.focus();
}

function closeVaatzLoginModal() {
  vaatzLoginModal.hidden = true;
  vaatzPasswordInput.value = '';
}

function closeApprovalListModal() {
  approvalListModal.hidden = true;
}

function getProgressText(progress) {
  if (progress === 'ok') return 'O';
  if (progress === 'fail') return 'X';
  return '-';
}

function renderSidebarApprovalList(items) {
  confirmedApprovalList = items.map((item) => ({ ...item, progress: item.progress || 'pending' }));
  sidebarApprovalTotal.textContent = String(confirmedApprovalList.length);
  sidebarApprovalRows.replaceChildren();

  for (const item of confirmedApprovalList) {
    const row = document.createElement('div');
    row.className = 'sidebar-list-row';

    const approvalNumber = document.createElement('span');
    approvalNumber.className = 'sidebar-approval-number';
    approvalNumber.textContent = item.approvalNumber || '';

    const status = document.createElement('span');
    const progress = item.progress || 'pending';
    status.className = `progress-mark ${progress}`;
    status.textContent = getProgressText(progress);
    status.dataset.approvalNumber = item.approvalNumber || '';

    row.append(approvalNumber, status);
    sidebarApprovalRows.append(row);
  }

  sidebarApprovalList.hidden = confirmedApprovalList.length === 0;
}

function confirmApprovalList() {
  if (!pendingApprovalList) return;
  renderSidebarApprovalList(pendingApprovalList.items || []);
  stateEl.textContent = `품의서 리스트 확인 완료: ${pendingApprovalList.total || 0}건`;
  closeApprovalListModal();
}

function renderApprovalList(result) {
  pendingApprovalList = result;
  approvalListTotal.textContent = String(result.total || 0);
  approvalListFileName.textContent = result.filename || '';
  approvalListRows.replaceChildren();

  for (const item of result.items || []) {
    const row = document.createElement('tr');
    const approvalNumberCell = document.createElement('td');
    const orderDateCell = document.createElement('td');
    approvalNumberCell.textContent = item.approvalNumber || '';
    orderDateCell.textContent = item.orderDate || '';
    row.append(approvalNumberCell, orderDateCell);
    approvalListRows.append(row);
  }

  approvalListModal.hidden = false;
}

async function uploadApprovalList(file) {
  stateEl.textContent = '품의서 리스트 업로드 중';
  const response = await fetch('/api/upload-approval-list', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name)
    },
    body: await file.arrayBuffer()
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.lastError || result.error || response.statusText);
  renderApprovalList(result);
  stateEl.textContent = `품의서 리스트 업로드 완료: ${result.total || 0}건`;
}

document.querySelector('#wiaDirect').addEventListener('click', () => {
  openVaatzLoginModal();
});

approvalListUploadButton.addEventListener('click', () => {
  approvalListFileInput.click();
});

approvalListFileInput.addEventListener('change', async () => {
  const [file] = approvalListFileInput.files || [];
  approvalListFileInput.value = '';
  if (!file) return;

  try {
    await uploadApprovalList(file);
  } catch (error) {
    stateEl.textContent = error.message;
  }
});

approvalListClose.addEventListener('click', closeApprovalListModal);
approvalListCancel.addEventListener('click', closeApprovalListModal);
approvalListConfirm.addEventListener('click', confirmApprovalList);

approvalListModal.addEventListener('click', (event) => {
  if (event.target === approvalListModal) closeApprovalListModal();
});

vaatzLoginCancel.addEventListener('click', () => {
  closeVaatzLoginModal();
});

vaatzLoginModal.addEventListener('click', (event) => {
  if (event.target === vaatzLoginModal) closeVaatzLoginModal();
});

vaatzLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const vaatzId = vaatzIdInput.value.trim();
  const vaatzPassword = vaatzPasswordInput.value;
  if (!vaatzId || !vaatzPassword) {
    stateEl.textContent = 'Vaatz ID/PW를 입력하세요';
    (!vaatzId ? vaatzIdInput : vaatzPasswordInput).focus();
    return;
  }

  closeVaatzLoginModal();
  stateEl.textContent = 'WIA Vaatz 이동 중';
  const result = await api('/api/wia-vaatz-direct', {
    method: 'POST',
    body: JSON.stringify({ vaatzId, vaatzPassword })
  });
  stateEl.textContent = result.vaatzLogin && result.vaatzLogin.ok ? 'Vaatz 로그인 완료' : 'WIA Vaatz 이동 완료';
  startRefresh();
});

function getOrderDateRange(orderDateValue) {
  const date = new Date(`${orderDateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`발주일 형식 오류: ${orderDateValue}`);

  const startDate = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const endDate = new Date(date.getFullYear(), date.getMonth() + 2, 0);
  const formatDate = (targetDate) => {
    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, '0');
    const day = String(targetDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  return {
    orderStartDate: formatDate(startDate),
    orderEndDate: formatDate(endDate)
  };
}

function setApprovalProgress(index, progress) {
  if (!confirmedApprovalList[index]) return;
  confirmedApprovalList[index].progress = progress;

  const mark = sidebarApprovalRows.children[index]?.querySelector('.progress-mark');
  if (!mark) return;
  mark.className = `progress-mark ${progress}`;
  mark.textContent = getProgressText(progress);
}

function isSearchDownloadSuccessful(result) {
  const downloads = result?.searched?.attachmentDownloads;
  return Boolean(
    result?.searched?.ok
      && !result.searched.noResult
      && downloads?.completed
      && downloads.downloadCount > 0
  );
}

document.querySelector('#clickApprovalNumber').addEventListener('click', async () => {
  if (!confirmedApprovalList.length) {
    stateEl.textContent = '품의서 리스트를 업로드하고 확인하세요';
    return;
  }

  for (let index = 0; index < confirmedApprovalList.length; index += 1) {
    const item = confirmedApprovalList[index];
    setApprovalProgress(index, 'pending');

    try {
      const { orderStartDate, orderEndDate } = getOrderDateRange(item.orderDate);
      stateEl.textContent = `진행 중: ${item.approvalNumber} (${index + 1}/${confirmedApprovalList.length})`;
      const result = await api('/api/search-approval-number', {
        method: 'POST',
        body: JSON.stringify({
          approvalNumber: item.approvalNumber,
          orderStartDate,
          orderEndDate
        })
      });
      setApprovalProgress(index, isSearchDownloadSuccessful(result) ? 'ok' : 'fail');
      startRefresh();
    } catch (error) {
      setApprovalProgress(index, 'fail');
      stateEl.textContent = `${item.approvalNumber || index + 1} 실패: ${error.message}`;
      startRefresh();
    }
  }

  const successCount = confirmedApprovalList.filter((item) => item.progress === 'ok').length;
  stateEl.textContent = `품의서 리스트 진행 완료: ${successCount}/${confirmedApprovalList.length}`;
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
  await sendMouseClick(event, 'left');
});

screen.addEventListener('contextmenu', async (event) => {
  event.preventDefault();
  await sendMouseClick(event, 'right');
});

window.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape' && !vaatzLoginModal.hidden) {
    closeVaatzLoginModal();
    return;
  }

  if (event.key === 'Escape' && !approvalListModal.hidden) {
    closeApprovalListModal();
    return;
  }

  const target = event.target;
  if (target && target.closest && target.closest('.panel input, .panel textarea, .panel select, .modal input')) {
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
