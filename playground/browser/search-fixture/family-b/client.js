// Independent family B client. It uses a native form submit and an async local
// request; the runner never calls these functions directly.
const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'normal';
const queryInput = document.getElementById('query');
const form = document.getElementById('search-form');
const submitButton = document.getElementById('submit');
const submissionState = document.getElementById('submission-state');
const requestState = document.getElementById('request-state');
const lateState = document.getElementById('late-state');
const mainState = document.getElementById('main-state');
const mainResults = document.getElementById('main-results');
const asideResults = document.getElementById('aside-results');
const initialQuery = params.get('q') ?? '';

let generation = 0;
let requestCount = 0;
let submittedRequestRef = '';
let submittedQuery = '';
let shownRequestRef = '';
let shownQuery = '';
let shownBatch = '';
let suggestionPending = false;

if ((scenario === 'same-word' || scenario === 'same-word-stalled') && initialQuery) {
  requestCount = 1;
  submittedRequestRef = 'fb-request-1';
  submittedQuery = initialQuery;
  shownRequestRef = 'fb-request-1';
  shownQuery = initialQuery;
  shownBatch = 'fb-request-1:batch-1';
  setSubmission();
  renderMain(['露营装备清单：按睡眠、饮水和照明分组准备。']);
  renderAside(['露营装备推荐：睡袋、饮水、照明和天气防护。']);
  setOwnership(shownRequestRef, shownQuery, shownBatch);
  setRequest('settled', 'current', 'available');
  mainState.textContent = '已显示旧查询结果';
}

function setSubmission() {
  if (submittedRequestRef) {
    submissionState.dataset.submittedRequestRef = submittedRequestRef;
    submissionState.dataset.submittedQuery = submittedQuery;
    submissionState.textContent = `已提交请求 ${submittedRequestRef}：${submittedQuery}`;
  } else {
    delete submissionState.dataset.submittedRequestRef;
    delete submissionState.dataset.submittedQuery;
    submissionState.textContent = '尚未提交查询';
  }
}

function setRequest(request, display, access) {
  requestState.dataset.requestStatus = request;
  requestState.dataset.display = display;
  requestState.dataset.access = access;
}

function setOwnership(requestRef, forQuery, batch) {
  requestState.dataset.resultsRequestRef = requestRef;
  requestState.dataset.resultsQuery = forQuery;
  requestState.dataset.batchRef = batch;
}

function renderMain(items) {
  mainResults.replaceChildren(...items.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

function renderAside(items) {
  asideResults.replaceChildren(...items.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

async function submit() {
  const value = queryInput.value.trim();
  if (!value) {
    mainState.textContent = '请输入查询';
    return;
  }
  const token = ++generation;
  requestCount += 1;
  submittedRequestRef = `fb-request-${requestCount}`;
  submittedQuery = value;
  const myRequestRef = submittedRequestRef;
  setSubmission();
  setRequest('loading', shownRequestRef ? 'old' : 'partial', 'available');
  mainState.textContent = '主结果加载中';

  if (scenario === 'title-only') {
    document.title = `独立搜索页 B · ${value}`;
    history.replaceState({}, '', `${location.pathname}?title-only=1`);
    setRequest('settled', 'none', 'available');
    mainState.textContent = '当前结果关系不可辨';
    return;
  }
  if (scenario === 'ai-first') {
    renderAside(['AI 摘要：露营准备可先按睡眠、饮水和照明分组。']);
    setRequest('loading', 'partial', 'available');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (token !== generation) {
      lateState.dataset.lateRequestRef = myRequestRef;
      return;
    }
    shownRequestRef = myRequestRef;
    shownQuery = value;
    shownBatch = `${myRequestRef}:batch-1`;
    renderMain(['露营装备清单：按睡眠、饮水和照明分组准备。', '营地准备记录：出发前整理装备。']);
    setOwnership(shownRequestRef, shownQuery, shownBatch);
    setRequest('settled', 'current', 'available');
    mainState.textContent = '主结果已显示';
    return;
  }

  const response = await fetch(`/family-b/api/search?q=${encodeURIComponent(value)}&request=${encodeURIComponent(myRequestRef)}&scenario=${encodeURIComponent(scenario)}`);
  const payload = await response.json();
  if (token !== generation) {
    lateState.dataset.lateRequestRef = myRequestRef;
    return;
  }
  if (payload.status === 'error') {
    setRequest('error', 'old', 'available');
    mainState.textContent = payload.message;
    return;
  }
  if (payload.status === 'blocked') {
    setRequest('settled', payload.empty ? 'empty' : 'none', payload.access);
    mainState.textContent = payload.empty ? '结果被登录阻断，当前为空文案' : '需要登录，当前查询未取得结果';
    renderMain([]);
    return;
  }
  if (payload.status === 'empty') {
    shownRequestRef = payload.requestRef;
    shownQuery = payload.query;
    shownBatch = payload.batchRef;
    setOwnership(shownRequestRef, shownQuery, shownBatch);
    setRequest('settled', 'empty', 'available');
    renderMain([]);
    mainState.textContent = '明确返回空结果';
    return;
  }
  shownRequestRef = payload.requestRef;
  shownQuery = payload.query;
  shownBatch = payload.batchRef;
  renderMain(payload.items);
  renderAside(payload.aside);
  setOwnership(shownRequestRef, shownQuery, shownBatch);
  setRequest('settled', 'current', 'available');
  mainState.textContent = '主结果已显示';
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (scenario !== 'ineffective') submit();
});

queryInput.addEventListener('input', () => {
  if (scenario === 'invalid' && queryInput.value && !suggestionPending) {
    suggestionPending = true;
    queryInput.value = '';
    mainState.textContent = '输入被重置；请重新输入后再提交';
    return;
  }
  if (scenario === 'suggestion' && !suggestionPending && queryInput.value) {
    suggestionPending = true;
    setTimeout(() => {
      if (queryInput.value) {
        queryInput.value = '城市散步路线';
        mainState.textContent = '已选择建议词；当前值与查询不同';
      }
    }, 60);
  }
});
