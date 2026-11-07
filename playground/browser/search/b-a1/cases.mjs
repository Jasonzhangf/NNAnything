const QUERY = '露营';
const CONTAINS = '装备';
const NEIGHBOR = '保持原值';

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
    params: options.params ?? {},
    profile: 'search-cases',
    scenario: options.scenario ?? 'normal',
    submitMode: 'enter',
    projection: {
      throwAfterDispatch: options.throwAfterDispatch ?? false,
      observeFailAfterDispatch: options.observeFailAfterDispatch ?? false,
    },
    neighborSelector: '#notes',
    neighborExpected: NEIGHBOR,
    bindings: isA
      ? {
          documentRef: 'b-a1-family-a-doc',
          scopeRef: 'b-a1-family-a-scope',
          inputRef: 'query',
          submitRef: 'submit',
          resultScopeRef: 'results',
          collectionRef: 'main',
        }
      : {
          documentRef: 'b-a1-family-b-doc',
          scopeRef: 'b-a1-family-b-scope',
          inputRef: 'query',
          submitRef: 'submit',
          resultScopeRef: 'main-results',
          collectionRef: 'main',
        },
    selectors: isA
      ? {
          input: '#query',
          submit: '#submit',
          collection: '#results',
          waitRoot: '#results',
          mainItems: '#results > section article.result-item',
          submittedState: '#submission-state',
          requestState: '#request-state',
        }
      : {
          input: '#query',
          submit: '#submit',
          collection: '#main-results',
          waitRoot: 'main',
          mainItems: '#main-results > li',
          submittedState: '#submission-state',
          requestState: '#request-state',
        },
  };
}

function expected(overrides = {}) {
  return {
    inputFact: ['satisfied'],
    rootFact: ['satisfied'],
    control: ['completed'],
    inputCount: 1,
    submitCount: 1,
    executionErrors: false,
    observationErrors: false,
    neighborUnchanged: true,
    inputValue: QUERY,
    initialPlaceholderIsQuery: false,
    failureEpisode: null,
    ...overrides,
  };
}

function row(id, label, familyOptions, expectation) {
  return { id, label, page: familyOptions, expect: expectation };
}

export const B_A1_CASE_ROWS = [
  row(
    'B-A1-01',
    '正常写入且相邻输入不变',
    { scenario: 'normal' },
    expected(),
  ),
  row(
    'B-A1-02',
    'placeholder 等于 query 且 value 为空时仍实际输入',
    { scenario: 'normal', params: { q: '', placeholder: QUERY } },
    expected({ initialPlaceholderIsQuery: true }),
  ),
  row(
    'B-A1-03',
    'input 后页面重置则未达标且不提交',
    { scenario: 'invalid' },
    expected({
      inputFact: ['unsatisfied'],
      rootFact: ['unknown', 'unsatisfied'],
      control: ['error'],
      inputCount: 1,
      submitCount: 0,
      executionErrors: false,
      observationErrors: false,
      inputValue: null,
      initialPlaceholderIsQuery: false,
    }),
  ),
  row(
    'B-A1-04',
    'readonly 时零派发并拒绝',
    { scenario: 'normal', params: { readonly: 'true' } },
    expected({
      inputFact: ['unknown', 'unsatisfied'],
      rootFact: ['unknown', 'unsatisfied'],
      control: ['error'],
      inputCount: 0,
      submitCount: 0,
      executionErrors: true,
      observationErrors: false,
      inputValue: null,
      initialPlaceholderIsQuery: false,
    }),
  ),
  row(
    'B-A1-05',
    '派发后执行器抛错仍安全读回且执行/观察错误分开',
    { scenario: 'normal', throwAfterDispatch: true },
    expected({
      inputFact: ['satisfied'],
      rootFact: ['unknown'],
      control: ['error'],
      inputCount: 1,
      submitCount: 0,
      executionErrors: true,
      observationErrors: false,
      inputValue: QUERY,
      initialPlaceholderIsQuery: false,
    }),
  ),
  row(
    'B-A1-06',
    '读回失败保持 unknown 且不继续提交',
    { scenario: 'normal', observeFailAfterDispatch: true },
    expected({
      inputFact: ['unknown', 'unsatisfied'],
      rootFact: ['unknown'],
      control: ['error'],
      inputCount: 1,
      submitCount: 0,
      executionErrors: false,
      observationErrors: true,
      inputValue: QUERY,
      initialPlaceholderIsQuery: false,
      failureEpisode: {
        stateNull: true,
        checkedObservationIdNull: true,
        effectKnowledge: 'unknown',
        observationStatus: 'failed',
        unmetFacts: ['value', 'editable'],
        freshness: 'after_action',
      },
    }),
  ),
];

export function materializeConfig(family, specification) {
  const page = familyPage(family, specification.page);
  return {
    family,
    caseId: specification.id,
    label: specification.label,
    query: QUERY,
    containsText: CONTAINS,
    goal: goal(),
    ...page,
    params: family === 'A'
      ? { ...page.params, scenario: page.scenario, profile: page.profile }
      : { ...page.params, scenario: page.scenario },
  };
}

export function materializeExpected(family, specification) {
  return {
    family,
    caseId: specification.id,
    label: specification.label,
    ...specification.expect,
  };
}
