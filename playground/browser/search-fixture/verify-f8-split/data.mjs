// Independent F8 verification fixture data. No shared renderer, no family-A/B/C
// data and no training artifact is read or referenced here.
export const family = Object.freeze({
  id: 'BF_VERIFY_F8_split_panel',
  sourceFamily: 'verify-f8-split',
  documentRef: 'verify-f8-split-doc',
  scopeRef: 'verify-f8-split-scope',
  resultScopeRef: 'split-main',
  inputRef: 'query',
  submitRef: 'submit',
  collectionRef: 'split-main-list',
  query: '星空',
  containsText: '银河',
});

// A six-item initial batch is required so that the real #result-scroll-box has
// scrollHeight > clientHeight at scrollTop = 0 (atGeometryBoundary === false).
const batchOneItems = Object.freeze([
  '星团编目：按亮度整理目标。',
  '光谱记录：记录恒星分类。',
  '曝光日志：记录观测器材。',
  '月相记录：记录观测窗口。',
  '光害测量：记录背景亮度。',
  '深空目录：记录星系位置。',
]);

const batchTwoItems = Object.freeze([
  '观测补充：记录夜间云量。',
  '校准补充：记录暗场帧数。',
  '器材补充：记录镜筒温度。',
  '站点补充：记录海拔与湿度。',
  '时序补充：记录曝光序列。',
  '银河结构补充目录：记录银河与暗带。',
]);

const asideItems = Object.freeze([
  '星空资料旁注：先核对观测时间。',
  '银河摄影提示：避开月光与城市灯光。',
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
    placeholder: '旧推荐词：星团编目',
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
  items: {main: [], aside: []},
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
      aside: [...(overrides.items.aside ?? [])],
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
  items: {main: batchOneItems, aside: []},
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
  'input-disabled': make({input: {value: '旧星图', disabled: true}}),
  'flow-unsubmitted': make({
    input: {value: family.query},
    submitted: {query: '行星', requestRef: 'f8-request-0'},
  }),
  'flow-submitted': associated('f8-request-1'),
  'flow-old-results': make({
    input: {value: family.query},
    submitted: {query: '行星', requestRef: 'f8-old-request'},
    request: {
      status: 'settled',
      display: 'old',
      access: 'available',
      resultsFor: '行星',
      resultsRef: 'f8-old-request',
      batchRef: 'f8-old-request:batch-1',
    },
    items: {main: ['行星观测：旧结果。'], aside: []},
    range: {
      atGeometryBoundary: observed(false),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
  }),
  'flow-aside-match': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-2'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-2',
      batchRef: 'f8-request-2:batch-1',
    },
    items: {main: batchOneItems, aside: asideItems},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'flow-empty': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-3'},
    request: {
      status: 'settled',
      display: 'empty',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-3',
      batchRef: 'f8-request-3:batch-1',
    },
    items: {main: [], aside: []},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'flow-blocked': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-4'},
    request: {
      status: 'settled',
      display: 'empty',
      access: 'login_required',
      resultsFor: family.query,
      resultsRef: 'f8-request-4',
      batchRef: 'f8-request-4:batch-1',
    },
    items: {main: [], aside: []},
  }),
  'range-expand': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-5'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-5',
      batchRef: 'f8-request-5:batch-1',
    },
    items: {main: batchOneItems, aside: []},
    range: {
      actionMechanicalEffect: 'not_attempted',
      atGeometryBoundary: observed(false),
      requestState: observed('settled'),
      hasMore: observed(true),
    },
    render: {loadMore: true, batchDelayMs: 90},
    nextBatch: batchTwoItems,
  }),
  'range-6a-loading': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-6'},
    request: {
      status: 'loading',
      display: 'partial',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-6',
      batchRef: 'f8-request-6:batch-1',
    },
    items: {main: batchOneItems, aside: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: observed('loading'),
      hasMore: observed(true),
    },
    render: {loadMore: true, batchDelayMs: 220},
    nextBatch: batchTwoItems,
  }),
  'range-6a-hasmore': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-7'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-7',
      batchRef: 'f8-request-7:batch-1',
    },
    items: {main: batchOneItems, aside: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(true),
    },
    render: {loadMore: true, batchDelayMs: 90},
    nextBatch: batchTwoItems,
  }),
  'range-6a-unknown': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-8'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-8',
      batchRef: 'f8-request-8:batch-1',
    },
    items: {main: batchOneItems, aside: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: unknown('no_positive_request_state_source'),
      hasMore: unknown('no_positive_terminal_control_source'),
    },
  }),
  'range-6b-bottom': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-9'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-9',
      batchRef: 'f8-request-9:batch-1',
    },
    items: {main: batchOneItems, aside: []},
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
    submitted: {query: family.query, requestRef: 'f8-request-10'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-10',
      batchRef: 'f8-request-10:batch-1',
    },
    items: {main: batchOneItems, aside: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(false),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true, longFooter: true},
  }),
  'probe-bp01': make({input: {placeholder: family.query}}),
  'probe-bp02': make({input: {value: '旧星图'}}),
  // The page script resets the field on input, so the probe's post-action
  // projection carries the observed reset value.
  'probe-bp03': make({input: {value: ''}}),
  'probe-bp04a': make({input: {value: family.query, disabled: true, occluded: true}}),
  'probe-bp04b': make({input: {value: '旧星图', disabled: true, occluded: true}}),
  'probe-bp05': make({
    input: {value: family.query},
    submitted: {query: '行星', requestRef: 'f8-old-request'},
    request: {
      status: 'settled',
      display: 'old',
      access: 'available',
      resultsFor: '行星',
      resultsRef: 'f8-old-request',
      batchRef: 'f8-old-request:batch-1',
    },
  }),
  'probe-bp06': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-race-b'},
    request: {
      status: 'loading',
      display: 'old',
      access: 'available',
      resultsFor: '近岸旧查询A',
      resultsRef: 'f8-race-a',
      batchRef: 'f8-race-a:batch-1',
    },
    items: {main: ['近岸旧查询A：旧结果仍在显示。'], aside: []},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('loading'),
      hasMore: observed(false),
    },
  }),
  'probe-bp06-positive': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-race-b'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-race-b',
      batchRef: 'f8-race-b:batch-1',
    },
    items: {main: batchOneItems, aside: []},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'probe-bp07': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-11'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-11',
      batchRef: 'f8-request-11:batch-1',
    },
    items: {main: batchOneItems, aside: ['银河资料旁注：这里包含银河。']},
    range: {
      atGeometryBoundary: observed(true),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true},
  }),
  'probe-bp08': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-12'},
    request: {
      status: 'settled',
      display: 'empty',
      access: 'login_required',
      resultsFor: family.query,
      resultsRef: 'f8-request-12',
      batchRef: 'f8-request-12:batch-1',
    },
    items: {main: [], aside: []},
  }),
  'probe-bp09': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-13'},
    request: {
      status: 'loading',
      display: 'partial',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-13',
      batchRef: 'f8-request-13:batch-1',
    },
    items: {main: batchOneItems, aside: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: observed('loading'),
      hasMore: observed(true),
    },
    render: {loadMore: true, batchDelayMs: 220},
    nextBatch: batchTwoItems,
  }),
  'probe-bp10': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-14'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-14',
      batchRef: 'f8-request-14:batch-1',
    },
    items: {main: batchOneItems, aside: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(true),
      requestState: unknown('no_positive_request_state_source'),
      hasMore: unknown('no_positive_terminal_control_source'),
    },
  }),
  'probe-bp11': make({
    input: {value: family.query},
    submitted: {query: family.query, requestRef: 'f8-request-15'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-15',
      batchRef: 'f8-request-15:batch-1',
    },
    items: {main: batchOneItems, aside: []},
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
    submitted: {query: family.query, requestRef: 'f8-request-16'},
    request: {
      status: 'settled',
      display: 'current',
      access: 'available',
      resultsFor: family.query,
      resultsRef: 'f8-request-16',
      batchRef: 'f8-request-16:batch-1',
    },
    items: {main: batchOneItems, aside: []},
    range: {
      actionMechanicalEffect: 'displaced_or_triggered',
      atGeometryBoundary: observed(false),
      requestState: observed('settled'),
      hasMore: observed(false),
    },
    render: {terminalBanner: true, longFooter: true},
  }),
  'probe-bp12': make({input: {value: family.query}}),
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
  if (!fixture) throw new TypeError(`Unknown F8 scenario: ${scenario}`);
  return fixture;
}

export function mainContent() {
  return [...batchOneItems];
}

export function nextBatchContent() {
  return [...batchTwoItems];
}

export function asideContent() {
  return [...asideItems];
}
