// Independent F7 verification fixture data. No shared renderer, no family-A/B/C
// data and no training artifact is read or referenced here.
export const family = Object.freeze({
  id: 'BF_VERIFY_F7_table_catalog',
  sourceFamily: 'verify-f7-table',
  documentRef: 'verify-f7-table-doc',
  scopeRef: 'verify-f7-table-scope',
  resultScopeRef: 'catalog-panel',
  inputRef: 'query',
  submitRef: 'submit',
  collectionRef: 'catalog-table',
  query: '海洋',
  containsText: '珊瑚',
});

// A six-row initial batch is required so that the real #result-scroll-box has
// scrollHeight > clientHeight at scrollTop = 0 (atGeometryBoundary === false).
const batchOneRows = Object.freeze([
  '潮间带记录：按潮位整理沿岸观察。',
  '近岸礁盘记录：记录潮池生物分布。',
  '海藻带记录：记录潮下带群落。',
  '沙滩剖面记录：记录沉积层结构。',
  '河口观测记录：记录盐度变化。',
  '远洋航线资料：记录海流与航行条件。',
]);

const batchTwoRows = Object.freeze([
  '近海观测补充：记录冬季水色。',
  '岛礁调查补充：记录岸线变化。',
  '潮汐站补充：记录潮差数据。',
  '浮标记录补充：记录表层温度。',
  '海草床补充：记录覆盖范围。',
  '珊瑚礁补充目录：记录浅海珊瑚与共生生物。',
]);

const auxiliaryRows = Object.freeze([
  '海洋资料旁注：先核对观察日期。',
  '珊瑚保护提示：不要触碰活体珊瑚。',
]);

const observed = (value) => ({status: 'observed', value});
const unknown = (reason) => ({status: 'unknown', reason});

const renderBase = Object.freeze({
  loadMore: false,
  terminalBanner: false,
  longFooter: false,
  batchDelayMs: 90,
});

const base = Object.freeze({
  input: {
    value: '',
    placeholder: '旧推荐词：潮间带观察',
    type: 'text',
    disabled: false,
    readonly: false,
    occluded: false,
    valueUnknown: false,
    editableUnprobed: false,
  },
  submitted: {query: '', requestRef: ''},
  request: {
    status: 'unknown',
    display: 'none',
    access: 'available',
    resultsFor: '',
    resultsRef: '',
    batchRef: '',
    range: {
      actionMechanicalEffect: 'not_attempted',
      atGeometryBoundary: unknown('not_measured'),
      requestState: unknown('no_positive_request_state_source'),
      hasMore: unknown('no_positive_terminal_control_source'),
    },
  },
  items: {main: [], auxiliary: []},
  render: renderBase,
  nextBatch: [],
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function make(overrides = {}) {
  const fixture = clone(base);
  if (overrides.input) fixture.input = {...fixture.input, ...overrides.input};
  if (overrides.submitted) fixture.submitted = {...fixture.submitted, ...overrides.submitted};
  if (overrides.items) {
    fixture.items = {
      main: [...(overrides.items.main ?? [])],
      auxiliary: [...(overrides.items.auxiliary ?? [])],
    };
  }
  if (overrides.request) fixture.request = {...fixture.request, ...overrides.request};
  if (overrides.range) fixture.request.range = {...fixture.request.range, ...overrides.range};
  if (overrides.render) fixture.render = {...fixture.render, ...overrides.render};
  if (overrides.nextBatch) fixture.nextBatch = [...overrides.nextBatch];
  return fixture;
}

const associated = (ref) => make({
  input: {value: family.query},
  submitted: {query: family.query, requestRef: ref},
  request: {
    status: 'settled',
    display: 'current',
    access: 'available',
    resultsFor: family.query,
    resultsRef: ref,
    batchRef: `${ref}:batch-1`,
  },
  items: {main: batchOneRows, auxiliary: []},
  range: {
    atGeometryBoundary: observed(true),
    requestState: observed('settled'),
    hasMore: observed(false),
  },
  render: {terminalBanner: true},
});

export const scenarios = Object.freeze({
  'input-normal': make(),
  'input-equal': make(),
  'input-placeholder': make({input: {placeholder: family.query}}),
  'input-readonly': make({input: {value: '旧海图', readonly: true}}),
  'flow-unsubmitted': make({
    input: {value: family.query},
    submitted: {query: '潮间带', requestRef: 'f7-request-0'},
  }),
  'flow-submitted': associated('f7-request-1'),
  'flow-old-results': make({
    input: {value: family.query},
    submitted: {query: '潮间带', requestRef: 'f7-old-request'},
    request: {
      status: 'settled',
      display: 'old',
      access: 'available',
      resultsFor: '潮间带',
      resultsRef: 'f7-old-request',
      batchRef: 'f7-old-request:batch-1',
    },
    items: {main: ['潮间带记录：仍旧结果。'], auxiliary: []},
    range: {
      atGeometryBoundary: observed(false),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
  }),
  'flow-aside-match': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-2'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-2',
      batchRef: 'f7-request-2:batch-1',
    },
    items: {main: batchOneRows, auxiliary: auxiliaryRows},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'flow-empty': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-3'},
    request: {
      status: 'settled',
      display: 'empty',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-3',
      batchRef: 'f7-request-3:batch-1',
    },
    items: {main: [], auxiliary: []},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'flow-blocked': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-4'},
    request: {
      status: 'settled',
      display: 'empty',
      access: 'login_required',
      resultsFor: family.query,
      resultsRef: 'f7-request-4',
      batchRef: 'f7-request-4:batch-1',
    },
    items: {main: [], auxiliary: []},
  }),
  'range-expand': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-5'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-5',
      batchRef: 'f7-request-5:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'not_attempted',
      atGeometryBoundary: observed(false),
      requestState: observed('settled'),
      hasMore: observed(true),
    },
    render: {loadMore: true, batchDelayMs: 90},
    nextBatch: batchTwoRows,
  }),
  'range-6a-loading': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-6'},
    request: {
      status: 'loading',
      display: 'partial',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-6',
      batchRef: 'f7-request-6:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: observed('loading'),
      hasMore: observed(true),
    },
    render: {loadMore: true, batchDelayMs: 220},
    nextBatch: batchTwoRows,
  }),
  'range-6a-hasmore': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-7'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-7',
      batchRef: 'f7-request-7:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(true),
    },
    render: {loadMore: true, batchDelayMs: 90},
    nextBatch: batchTwoRows,
  }),
  'range-6a-unknown': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-8'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-8',
      batchRef: 'f7-request-8:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: unknown('no_positive_request_state_source'),
      hasMore: unknown('no_positive_terminal_control_source'),
    },
  }),
  'range-6b-bottom': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-9'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-9',
      batchRef: 'f7-request-9:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'range-6b-nonbottom': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-10'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-10',
      batchRef: 'f7-request-10:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(false),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true, longFooter: true},
  }),
  'probe-bp01': make({input: {placeholder: family.query}}),
  'probe-bp02': make({input: {value: '旧词'}}),
  // The page script resets the field on input, so the probe's post-action
  // projection carries the observed reset value.
  'probe-bp03': make({input: {value: ''}}),
  'probe-bp04a': make({input: {value: family.query, readonly: true, occluded: true}}),
  'probe-bp04b': make({input: {value: '旧词', readonly: true, occluded: true}}),
  'probe-bp05': make({
    input: {value: family.query},
    submitted: {query: '潮间带', requestRef: 'f7-old-request'},
    request: {
      status: 'settled',
      display: 'old',
      access: 'available',
      resultsFor: '潮间带',
      resultsRef: 'f7-old-request',
      batchRef: 'f7-old-request:batch-1',
    },
  }),
  // Real race: old request A settled and rendered, then request B submitted and
  // still loading. One observation therefore carries submitted=B with the
  // still-visible results of A, and both reference sets are complete.
  'probe-bp06': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-race-b'},
    request: {
      status: 'loading',
      display: 'old',
      access: 'available',
      resultsFor: '近岸旧查询A',
      resultsRef: 'f7-race-a',
      batchRef: 'f7-race-a:batch-1',
    },
    items: {main: ['近岸旧查询A：旧结果仍在显示。'], auxiliary: []},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('loading'),
      hasMore: observed(false),
    },
  }),
  // Positive control: B has really been associated, so results=B.
  'probe-bp06-positive': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-race-b'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-race-b',
      batchRef: 'f7-race-b:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'probe-bp07': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-11'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-11',
      batchRef: 'f7-request-11:batch-1',
    },
    items: {main: batchOneRows, auxiliary: ['珊瑚资料旁注：这里包含珊瑚。']},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'probe-bp08': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-12'},
    request: {
      status: 'settled',
      display: 'empty',
      access: 'login_required',
      resultsFor: family.query,
      resultsRef: 'f7-request-12',
      batchRef: 'f7-request-12:batch-1',
    },
    items: {main: [], auxiliary: []},
  }),
  'probe-bp09': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-13'},
    request: {
      status: 'loading',
      display: 'partial',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-13',
      batchRef: 'f7-request-13:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: observed('loading'),
      hasMore: observed(true),
    },
    render: {loadMore: true, batchDelayMs: 220},
    nextBatch: batchTwoRows,
  }),
  'probe-bp10': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-14'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-14',
      batchRef: 'f7-request-14:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: unknown('no_positive_request_state_source'),
      hasMore: unknown('no_positive_terminal_control_source'),
    },
  }),
  'probe-bp11': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-15'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-15',
      batchRef: 'f7-request-15:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'probe-bp11b': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f7-request-16'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f7-request-16',
      batchRef: 'f7-request-16:batch-1',
    },
    items: {main: batchOneRows, auxiliary: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(false),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true, longFooter: true},
  }),
  'probe-bp12': make({input: {value: '旧海图'}}),
});

const flowScenarios = new Set([
  'flow-unsubmitted',
  'flow-submitted',
  'flow-old-results',
  'flow-aside-match',
  'flow-empty',
  'flow-blocked',
  'range-expand',
  'range-6a-loading',
  'range-6a-hasmore',
  'range-6a-unknown',
  'range-6b-bottom',
  'range-6b-nonbottom',
  'probe-bp05',
  'probe-bp06',
  'probe-bp07',
  'probe-bp08',
  'probe-bp09',
  'probe-bp10',
  'probe-bp11',
  'probe-bp11b',
]);
for (const name of flowScenarios) {
  scenarios[name].input.value = family.query;
}

export function fixtureFor(scenario) {
  const fixture = scenarios[scenario];
  if (!fixture) throw new TypeError(`Unknown F7 scenario: ${scenario}`);
  return fixture;
}

export function mainContent() {
  return [...batchOneRows];
}

export function nextBatchContent() {
  return [...batchTwoRows];
}

export function auxiliaryContent() {
  return [...auxiliaryRows];
}
