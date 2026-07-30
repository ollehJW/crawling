const screen = document.querySelector('#screen');
const viewport = document.querySelector('#viewport');
const interactionLock = document.querySelector('#interactionLock');
const urlEl = document.querySelector('#url');
const stateEl = document.querySelector('#state');
const stopAutomationButton = document.querySelector('#stopAutomation');
const vaatzLoginModal = document.querySelector('#vaatzLoginModal');
const vaatzLoginForm = document.querySelector('#vaatzLoginForm');
const vaatzLoginCancel = document.querySelector('#vaatzLoginCancel');
const vaatzIdInput = document.querySelector('#vaatzIdInput');
const vaatzPasswordInput = document.querySelector('#vaatzPasswordInput');
const downloadedApprovalsButton = document.querySelector('#downloadedApprovalsButton');
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
const downloadedApprovalsModal = document.querySelector('#downloadedApprovalsModal');
const downloadedApprovalsClose = document.querySelector('#downloadedApprovalsClose');
const downloadedApprovalsOk = document.querySelector('#downloadedApprovalsOk');
const downloadedApprovalsClear = document.querySelector('#downloadedApprovalsClear');
const downloadedApprovalsTotal = document.querySelector('#downloadedApprovalsTotal');
const downloadedApprovalsRows = document.querySelector('#downloadedApprovalsRows');
const completionModal = document.querySelector('#completionModal');
const completionTitle = document.querySelector('#completionTitle');
const completionMessage = document.querySelector('#completionMessage');
const completionOk = document.querySelector('#completionOk');
const completionDownloads = document.querySelector('#completionDownloads');
const downloadResultCsvButton = document.querySelector('#downloadResultCsv');
const downloadQuotesZipButton = document.querySelector('#downloadQuotesZip');

let imageWidth = 1365;
let imageHeight = 900;
let refreshTimer;
let pendingApprovalList = null;
let confirmedApprovalList = [];
let automationInputLocked = false;
let automationStopRequested = false;
let lastDownloadResultRows = [];

function setAutomationInputLocked(locked) {
  automationInputLocked = locked;
  viewport.classList.toggle('locked', locked);
  interactionLock.hidden = !locked;
  stopAutomationButton.hidden = !locked;
  stopAutomationButton.disabled = !locked;
  document.querySelector('#wiaDirect').disabled = locked;
  document.querySelector('#clickApprovalNumber').disabled = locked;
}

function beginAutomationLock() {
  automationStopRequested = false;
  setAutomationInputLocked(true);
}

function endAutomationLock() {
  setAutomationInputLocked(false);
}

async function requestAutomationStop() {
  if (!automationInputLocked || automationStopRequested) return;
  automationStopRequested = true;
  stopAutomationButton.disabled = true;
  stateEl.textContent = '중단 요청 중';

  try {
    await fetch('/api/stop', { method: 'POST' });
    stateEl.textContent = '중단 요청 완료';
  } catch (error) {
    stateEl.textContent = `중단 요청 실패: ${error.message}`;
  }
}

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

function closeDownloadedApprovalsModal() {
  downloadedApprovalsModal.hidden = true;
}

function closeCompletionModal() {
  completionModal.hidden = true;
}

function showCompletionModal(message, title = '완료', { showDownloads = false } = {}) {
  completionTitle.textContent = title;
  completionMessage.textContent = message;
  completionDownloads.hidden = !showDownloads;
  completionModal.hidden = false;
  completionOk.focus();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadResultCsv() {
  const rows = [['품의번호', '발주일', '처리여부'], ...lastDownloadResultRows.map((item) => [
    item.approvalNumber || '',
    item.orderDate || '',
    item.progress === 'ok' ? 'O' : 'X'
  ])];
  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  downloadBlob('result.csv', new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
}

async function downloadQuotesZip() {
  const approvalNumbers = lastDownloadResultRows.map((item) => item.approvalNumber).filter(Boolean);
  if (!approvalNumbers.length) {
    stateEl.textContent = '압축할 품의번호가 없습니다';
    return;
  }

  stateEl.textContent = '견적서 압축 다운로드 준비 중';
  const response = await fetch('/api/downloaded-approvals/archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approvalNumbers })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.lastError || result.error || response.statusText);
  }
  downloadBlob('quotes.zip', await response.blob());
  stateEl.textContent = '견적서 압축 다운로드 완료';
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function renderDownloadedApprovals(result) {
  downloadedApprovalsTotal.textContent = String(result.total || 0);
  downloadedApprovalsRows.replaceChildren();

  for (const item of result.items || []) {
    const row = document.createElement('tr');
    const approvalNumberCell = document.createElement('td');
    const fileCountCell = document.createElement('td');
    const sizeCell = document.createElement('td');
    approvalNumberCell.textContent = item.approvalNumber || '';
    fileCountCell.textContent = String(item.fileCount || 0);
    sizeCell.textContent = formatBytes(item.bytes);
    row.append(approvalNumberCell, fileCountCell, sizeCell);
    downloadedApprovalsRows.append(row);
  }

  downloadedApprovalsModal.hidden = false;
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

async function loadDownloadedApprovals() {
  stateEl.textContent = '보유 품의서 확인 중';
  const result = await api('/api/downloaded-approvals');
  renderDownloadedApprovals(result);
  stateEl.textContent = `보유 품의서 ${result.total || 0}건`;
  return result;
}

stopAutomationButton.addEventListener('click', requestAutomationStop);

downloadedApprovalsButton.addEventListener('click', async () => {
  try {
    await loadDownloadedApprovals();
  } catch (error) {
    stateEl.textContent = error.message;
  }
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
downloadedApprovalsClose.addEventListener('click', closeDownloadedApprovalsModal);
downloadedApprovalsOk.addEventListener('click', closeDownloadedApprovalsModal);
downloadedApprovalsClear.addEventListener('click', async () => {
  if (!window.confirm('downloads 폴더의 보유 품의서를 모두 삭제할까요?')) return;

  try {
    stateEl.textContent = '보유 품의서 초기화 중';
    const result = await api('/api/downloaded-approvals/clear', { method: 'POST' });
    renderDownloadedApprovals(result);
    stateEl.textContent = `보유 품의서 초기화 완료: ${result.clearedCount || 0}건 삭제`;
    showCompletionModal(`보유 품의서 초기화가 완료되었습니다. ${result.clearedCount || 0}건을 삭제했습니다.`);
  } catch (error) {
    stateEl.textContent = error.message;
  }
});
completionOk.addEventListener('click', closeCompletionModal);
downloadResultCsvButton.addEventListener('click', downloadResultCsv);
downloadQuotesZipButton.addEventListener('click', async () => {
  try {
    await downloadQuotesZip();
  } catch (error) {
    stateEl.textContent = error.message;
  }
});

approvalListModal.addEventListener('click', (event) => {
  if (event.target === approvalListModal) closeApprovalListModal();
});

downloadedApprovalsModal.addEventListener('click', (event) => {
  if (event.target === downloadedApprovalsModal) closeDownloadedApprovalsModal();
});

completionModal.addEventListener('click', (event) => {
  if (event.target === completionModal) closeCompletionModal();
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
  beginAutomationLock();

  try {
    stateEl.textContent = 'WIA Vaatz 이동 중';
    const result = await api('/api/wia-vaatz-direct', {
      method: 'POST',
      body: JSON.stringify({ vaatzId, vaatzPassword })
    });
    const message = result.vaatzLogin && result.vaatzLogin.ok ? 'WIA Vaatz 접속 및 로그인 후 발주 화면 이동이 완료되었습니다.' : 'WIA Vaatz 이동이 완료되었습니다.';
    stateEl.textContent = result.vaatzLogin && result.vaatzLogin.ok ? 'Vaatz 로그인 완료' : 'WIA Vaatz 이동 완료';
    startRefresh();
    showCompletionModal(message);
  } catch (error) {
    stateEl.textContent = automationStopRequested ? 'WIA Vaatz 이동 중단됨' : error.message;
  } finally {
    endAutomationLock();
  }
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

  beginAutomationLock();

  try {
    for (let index = 0; index < confirmedApprovalList.length; index += 1) {
      if (automationStopRequested) break;

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
        if (automationStopRequested) {
          setApprovalProgress(index, 'fail');
          stateEl.textContent = '견적서 다운로드 중단됨';
          startRefresh();
          break;
        }
        setApprovalProgress(index, 'fail');
        stateEl.textContent = `${item.approvalNumber || index + 1} 실패: ${error.message}`;
        startRefresh();
      }
    }

    if (automationStopRequested) {
      showCompletionModal('견적서 다운로드가 중단되었습니다.', '중단');
      return;
    }

    lastDownloadResultRows = confirmedApprovalList.map((item) => ({
      approvalNumber: item.approvalNumber || '',
      orderDate: item.orderDate || '',
      progress: item.progress === 'ok' ? 'ok' : 'fail'
    }));
    const successCount = confirmedApprovalList.filter((item) => item.progress === 'ok').length;
    const failCount = confirmedApprovalList.length - successCount;
    const message = failCount > 0
      ? `견적서 다운로드가 완료되었습니다. 성공 ${successCount}건, 실패 ${failCount}건입니다.`
      : `견적서 다운로드가 완료되었습니다. 총 ${successCount}건 모두 성공했습니다.`;
    stateEl.textContent = `품의서 리스트 진행 완료: ${successCount}/${confirmedApprovalList.length}`;
    showCompletionModal(message, '완료', { showDownloads: true });
  } finally {
    endAutomationLock();
  }
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
  if (automationInputLocked) return;

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

  if (event.key === 'Escape' && !downloadedApprovalsModal.hidden) {
    closeDownloadedApprovalsModal();
    return;
  }

  if (event.key === 'Escape' && !completionModal.hidden) {
    closeCompletionModal();
    return;
  }

  if (automationInputLocked) return;

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
