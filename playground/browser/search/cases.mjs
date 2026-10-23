const QUERY = '露营';
const CONTAINS = '装备';

function goal(overrides = {}) {
  return {
    kind: 'BrowserSearch',
    query: QUERY,
    collectionRef: 'main',
    containsText: CONTAINS,
    minimumMatches: 1,
    coverage: 'visible_batch',
    ...overrides,
  };
}

function familyPage(family, options = {}) {
  const isA = family === 'A';
  return {
    family,
    path: isA ? '/' : '/family-b/',
    params: isA
      ? { profile: options.profile ?? 'search-cases', scenario: options.scenario ?? 'normal', ...(options.q ? { q: options.q } : {}) }
      : { scenario: options.scenario ?? 'normal', ...(options.q ? { q: options.q } : {}) },
    profile: options.profile ?? 'search-cases',
    scenario: options.scenario ?? 'normal',
    submitMode: options.submitMode ?? 'enter',
    prelude: options.prelude ?? null,
    neighborSelector: '#notes',
    neighborExpected: '保持原值',
    projection: {
      unreadItemIndexes: options.unreadItemIndexes ?? [],
      omitRequestRefs: options.omitRequestRefs ?? false,
      stalePost: options.stalePost ?? false,
      observeFailAfterDispatch: options.observeFailAfterDispatch ?? false,
      throwAfterDispatch: options.throwAfterDispatch ?? false,
    },
    bindings: isA
      ? { documentRef: 'family-a-search-doc', scopeRef: 'family-a-search-scope', inputRef: 'query', submitRef: 'submit', resultScopeRef: 'results', collectionRef: 'main' }
      : { documentRef: 'family-b-search-doc', scopeRef: 'family-b-search-scope', inputRef: 'query', submitRef: 'submit', resultScopeRef: 'main-results', collectionRef: 'main' },
    selectors: isA
      ? { input: '#query', submit: '#submit', collection: '#results', waitRoot: '#results', mainItems: '#results > section article.result-item', submittedState: '#submission-state', requestState: '#request-state' }
      : { input: '#query', submit: '#submit', collection: '#main-results', waitRoot: 'main', mainItems: '#main-results > li', submittedState: '#submission-state', requestState: '#request-state' },
  };
}

function expected(overrides = {}) {
  return {
    input: ['satisfied'],
    submitted: ['satisfied'],
    results: ['satisfied'],
    root: ['satisfied'],
    control: ['completed'],
    exit: [0],
    inputCount: 1,
    submitCount: 1,
    executionErrors: false,
    observationErrors: false,
    requireAssociation: true,
    mainMatches: { min: 1 },
    neighborUnchanged: true,
    ...overrides,
  };
}

function row(caseId, variant, label, familyPageOptions, expectation) {
  return { caseId, variant, label, page: familyPageOptions, expect: expectation };
}

export const CASE_ROWS = [
  row('C01', '', '普通成功、旧 placeholder', { scenario: 'normal' }, expected()),
  row('C02', '', '同词旧结果、当前响应未到', { scenario: 'same-word-stalled', q: QUERY },
    expected({ results: ['unknown'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: null })),
  row('C03', '', '同词重提取得新结果', { scenario: 'same-word', q: QUERY }, expected()),
  row('C04', '', 'A 慢 B 快、迟到 A', { scenario: 'race', prelude: { query: 'slow-A', submitMode: 'enter' } },
    expected({ latePreserved: true })),
  row('C05', '', '加载后空结果', { scenario: 'empty' },
    expected({ results: ['unsatisfied'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: null, requestStatus: ['settled'], display: ['empty'] })),
  row('C06', '', '加载后请求错误', { scenario: 'error' },
    expected({ results: ['unknown'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: null, requestStatus: ['error'] })),
  row('C07', '', '加载后登录阻断', { scenario: 'blocked' },
    expected({ results: ['unknown'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: null, access: ['login_required'] })),
  row('C08', '', '登录阻断与空文案并存', { scenario: 'blocked-empty' },
    expected({ results: ['unknown'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: null, access: ['login_required'], display: ['empty'] })),
  row('C09', '', '已输入、未提交', { scenario: 'ineffective', submitMode: 'click' },
    expected({ submitted: ['unknown', 'unsatisfied'], results: ['not_evaluated'], root: ['unknown'], control: ['error'], exit: [1], submitCount: 1, requireAssociation: false, mainMatches: null })),
  row('C10', '', '建议词替换输入', { scenario: 'suggestion' },
    expected({ input: ['unsatisfied'], submitted: ['not_evaluated'], results: ['not_evaluated'], root: ['unknown'], control: ['error'], exit: [1], submitCount: 0, requireAssociation: false, mainMatches: null })),
  row('C11', '', '当前查询已提交、结果仍旧', { scenario: 'same-word-stalled', q: QUERY, query: '登山' },
    expected({ results: ['unknown'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: null })),
  row('C12', '', 'AI 先到、主集合后到', { scenario: 'ai-first' }, expected()),
  row('C13', '', '旁栏匹配、主集合不匹配', { profile: 'aside-match', scenario: 'normal' },
    expected({ results: ['unsatisfied'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: { min: 0, max: 0 } })),
  row('C14', '', '两个独立主条目', { profile: 'search-cases', scenario: 'normal', submitMode: 'click' },
    expected({ mainMatches: { min: 2 } })),
  row('C15', '', '仅标题/URL 改变', { scenario: 'title-only' },
    expected({ results: ['unknown'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: null, requestStatus: ['settled'], display: ['none'] })),
  row('C16', '', '输入被重置', { scenario: 'invalid' },
    expected({ input: ['unknown'], submitted: ['not_evaluated'], results: ['not_evaluated'], root: ['unknown'], control: ['error'], exit: [1], submitCount: 0, requireAssociation: false, mainMatches: null })),
  row('C17', '', '已派发后执行异常', { scenario: 'normal', throwAfterDispatch: true },
    expected({ submitted: ['not_evaluated'], results: ['not_evaluated'], root: ['unknown'], control: ['error'], exit: [1], submitCount: 0, requireAssociation: false, mainMatches: null, executionErrors: true })),
  row('C18', 'stale', '陈旧后验', { scenario: 'normal', stalePost: true },
    expected({ input: ['unknown', 'unsatisfied'], submitted: ['not_evaluated'], results: ['not_evaluated'], root: ['unknown'], control: ['error'], exit: [1], submitCount: 0, requireAssociation: false, mainMatches: null, observationErrors: true })),
  row('C18', 'observe-error', '观察异常', { scenario: 'normal', observeFailAfterDispatch: true },
    expected({ input: ['unknown', 'unsatisfied'], submitted: ['not_evaluated'], results: ['not_evaluated'], root: ['unknown'], control: ['error'], exit: [1], submitCount: 0, requireAssociation: false, mainMatches: null, observationErrors: true })),
  row('C19', 'matched_items', '主集合有未读内容（matched_items）', { scenario: 'normal', unreadItemIndexes: [1] },
    expected({ coverage: 'matched_items' })),
  row('C19', 'visible_batch', '主集合有未读内容（visible_batch）', { scenario: 'normal', unreadItemIndexes: [1] },
    expected({ results: ['unknown'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: null })),
  row('C20', '', '提交/响应关联缺测', { scenario: 'normal', omitRequestRefs: true },
    expected({ submitted: ['unknown'], results: ['not_evaluated'], root: ['unknown'], control: ['error'], exit: [1], requireAssociation: false, mainMatches: null })),
];

export function materializeConfig(family, row) {
  const page = familyPage(family, row.page);
  if (family === 'B' && row.caseId === 'C13') page.scenario = 'aside-match';
  if (family === 'B' && row.caseId === 'C14') page.scenario = 'two-matches';
  page.params = {...page.params, scenario: page.scenario};
  return {
    family,
    caseId: row.caseId,
    variant: row.variant,
    label: row.label,
    query: row.page.query ?? QUERY,
    goal: goal({ query: row.page.query ?? QUERY, coverage: row.expect.coverage ?? 'visible_batch', minimumMatches: row.caseId === 'C14' ? 2 : 1 }),
    ...page,
  };
}

export function materializeExpected(family, row) {
  return { family, caseId: row.caseId, variant: row.variant, label: row.label, ...row.expect };
}
