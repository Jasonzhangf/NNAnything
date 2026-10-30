const scenario = new URLSearchParams(location.search).get('scenario') ?? 'input-normal';
const fixture = window.__F7_FIXTURE__ ?? {};
const form = document.getElementById('search-form');
const input = document.getElementById('query');
const submission = document.getElementById('submission-state');
const requestState = document.getElementById('request-state');
const scrollBox = document.getElementById('result-scroll-box');
const tableHost = document.getElementById('catalog-table-host');
const catalog = document.getElementById('catalog');
let generation = 0;
let requestCount = Number(fixture.submitted?.requestRef?.match(/(\d+)$/)?.[1] ?? 0);
let rows = [...(fixture.items?.main ?? [])];
let batchIndex = 1;
let batchLoading = false;
const raceScenario = scenario === 'probe-bp06';
let hasLiveResults = Boolean(fixture.request?.resultsRef);
const liveRows = [
  '潮间带记录：按潮位整理沿岸观察。',
  '近岸礁盘记录：记录潮池生物分布。',
  '海藻带记录：记录潮下带群落。',
  '沙滩剖面记录：记录沉积层结构。',
  '河口观测记录：记录盐度变化。',
  '远洋航线资料：记录海流与航行条件。',
];

function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

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

function renderRows(nextRows) {
  rows = [...nextRows];
  tableHost.innerHTML = rows.length
    ? `<table id="catalog-table" data-collection-ref="catalog-table"><caption>海洋资料目录</caption><thead><tr><th>目录条目</th></tr></thead><tbody>${rows.map((text) => `<tr><td>${escape(text)}</td></tr>`).join('')}</tbody></table>`
    : '<p id="catalog-empty" class="empty-state">没有主集合目录条目</p>';
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

// Batch progression is driven by the page's own scroll/click handling. Tests
// reach the bottom with native wheel or keyboard events; the page then updates
// the real business DOM (batch reference, request status and row list).
function triggerBatch(delayMs) {
  if (batchLoading || batchIndex > 1) return;
  batchLoading = true;
  setRequest({requestStatus: 'loading'});
  requestState.textContent = '正在加载下一批目录条目';
  setTimeout(() => {
    const next = fixture.nextBatch ?? [];
    renderRows([...rows, ...next]);
    batchIndex = 2;
    const requestRef = submission.dataset.submittedRequestRef ?? '';
    setRequest({
      requestStatus: 'settled',
      resultsRequestRef: requestRef,
      batchRef: `${requestRef}:batch-${batchIndex}`,
    });
    ensureTerminalBanner();
    removeLoadMore();
    requestState.textContent = '目录条目加载完成';
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
  const requestRef = `f7-live-${requestCount}`;
  const preserveOldResults = raceScenario && hasLiveResults;
  setSubmission(query, requestRef);
  setRequest({
    requestStatus: 'loading',
    display: preserveOldResults ? 'old' : 'partial',
    access: 'available',
    ...(preserveOldResults ? {} : {resultsQuery: '', resultsRequestRef: '', batchRef: ''}),
  });
  requestState.textContent = '正在读取海洋资料目录';
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
    renderRows(liveRows);
    ensureTerminalBanner();
    removeLoadMore();
    requestState.textContent = '海洋资料目录读取完成';
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

void catalog;
