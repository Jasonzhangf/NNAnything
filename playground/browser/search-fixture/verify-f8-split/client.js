const scenario = new URLSearchParams(location.search).get('scenario') ?? 'input-normal';
const fixture = window.__F8_FIXTURE__ ?? {};
const form = document.getElementById('search-form');
const input = document.getElementById('query');
const submission = document.getElementById('submission-state');
const requestState = document.getElementById('request-state');
const scrollBox = document.getElementById('result-scroll-box');
const listHost = document.getElementById('split-main-list-host');
const asidePanel = document.getElementById('split-aside');
let generation = 0;
let requestCount = Number(fixture.submitted?.requestRef?.match(/(\d+)$/)?.[1] ?? 0);
let rows = [...(fixture.items?.main ?? [])];
let batchIndex = 1;
let batchLoading = false;
const raceScenario = scenario === 'probe-bp06';
let hasLiveResults = Boolean(fixture.request?.resultsRef);
const liveRows = [
  '星团编目：按亮度整理目标。',
  '光谱记录：记录恒星分类。',
  '曝光日志：记录观测器材。',
  '月相记录：记录观测窗口。',
  '光害测量：记录背景亮度。',
  '深空目录：记录星系位置。',
];
const liveAside = [
  '星空资料旁注：先核对观测时间。',
  '银河摄影提示：避开月光与城市灯光。',
];

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function setSubmission(query, requestRef) {
  if (!requestRef || !query) {
    delete submission.dataset.submittedQuery;
    delete submission.dataset.submittedRequestRef;
    submission.textContent = '尚未提交查询';
    return;
  }
  submission.dataset.submittedQuery = query;
  submission.dataset.submittedRequestRef = requestRef;
  submission.textContent = `已提交请求 ${requestRef}：${query}`;
}

function setRequest(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === '' || value === null || value === undefined) delete requestState.dataset[key];
    else requestState.dataset[key] = String(value);
  }
}

function renderMain(nextRows) {
  rows = [...nextRows];
  listHost.innerHTML = rows.length
    ? `<ul id="split-main-list" data-collection-ref="split-main-list">${rows.map((text) => `<li>${escape(text)}</li>`).join('')}</ul>`
    : '<p id="split-empty" class="empty-state">没有主集合条目</p>';
}

function renderAside(nextRows) {
  if (!asidePanel) return;
  if (!nextRows.length) {
    asidePanel.remove();
    return;
  }
  asidePanel.innerHTML = `<h2>星空资料旁注</h2><ul>${nextRows.map((text) => `<li>${escape(text)}</li>`).join('')}</ul>`;
}

function ensureTerminalBanner() {
  if (document.getElementById('collection-terminal-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'collection-terminal-banner';
  banner.dataset.hasMore = 'false';
  banner.dataset.requestStatus = 'settled';
  banner.textContent = '已加载全部条目';
  scrollBox.appendChild(banner);
}

function removeLoadMore() {
  document.getElementById('load-more')?.remove();
}

function atBottom() {
  if (!scrollBox) return false;
  return scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 2;
}

// Batch progression follows the page's own scroll/click handling. Native tests
// reach the bottom with real wheel or keyboard input; only this page handler
// then updates the business DOM (batch reference, request status, row list).
function triggerBatch(delayMs) {
  if (batchLoading || batchIndex > 1) return;
  batchLoading = true;
  setRequest({requestStatus: 'loading'});
  requestState.textContent = '正在加载下一批主集合条目';
  setTimeout(() => {
    const next = fixture.nextBatch ?? [];
    renderMain([...rows, ...next]);
    batchIndex = 2;
    const requestRef = submission.dataset.submittedRequestRef ?? '';
    setRequest({
      requestStatus: 'settled',
      resultsRequestRef: requestRef,
      batchRef: `${requestRef}:batch-${batchIndex}`,
    });
    ensureTerminalBanner();
    removeLoadMore();
    requestState.textContent = '主集合条目加载完成';
    batchLoading = false;
  }, delayMs);
}

function submit() {
  const query = input.value.trim();
  if (!query) {
    requestState.textContent = '请输入查询';
    return;
  }
  const token = ++generation;
  requestCount += 1;
  const requestRef = `f8-live-${requestCount}`;
  const preserveOldResults = raceScenario && hasLiveResults;
  setSubmission(query, requestRef);
  setRequest({
    requestStatus: 'loading',
    display: preserveOldResults ? 'old' : 'partial',
    access: 'available',
    ...(preserveOldResults ? {} : {resultsQuery: '', resultsRequestRef: '', batchRef: ''}),
  });
  requestState.textContent = '正在读取星空观测面板';
  const delayMs = raceScenario ? (hasLiveResults ? 900 : 60) : 120;
  setTimeout(() => {
    if (token !== generation) {
      requestState.dataset.lateRequestRef = requestRef;
      return;
    }
    hasLiveResults = true;
    setRequest({
      requestStatus: 'settled',
      display: 'current',
      access: 'available',
      resultsQuery: query,
      resultsRequestRef: requestRef,
      batchRef: `${requestRef}:batch-1`,
    });
    renderMain(liveRows);
    renderAside(liveAside);
    ensureTerminalBanner();
    removeLoadMore();
    requestState.textContent = '星空观测面板读取完成';
  }, delayMs);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});

input.addEventListener('input', () => {
  if (scenario === 'probe-bp03' && input.value) {
    input.value = '';
    requestState.textContent = '输入被重置；请重新输入后再提交';
  }
});

scrollBox?.addEventListener('scroll', () => {
  if (!fixture.render?.loadMore || !atBottom()) return;
  triggerBatch(fixture.render.batchDelayMs ?? 90);
});

document.getElementById('load-more')?.addEventListener('click', () => {
  if (!fixture.render?.loadMore) return;
  triggerBatch(fixture.render.batchDelayMs ?? 90);
});
