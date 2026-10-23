/**
 * B-Feedback plan §8 search-contract migration. Eight stop-behavior
 * obligations run once per independent family (A and B), for 16 trajectories.
 * Each item names its obligation, its existing or injected source, the
 * concrete stop reason it must prove, and the obligation it replaces inside
 * the B-Search matrix when the plan §8 wording has no dedicated row.
 */

export const MIGRATION_FAMILIES = Object.freeze(["A", "B"]);

export const SEARCH_MIGRATION_CASES = Object.freeze([
  {
    id: "SM01",
    obligation: "输入成功但搜索根未达成",
    minimalUseCase: "draft 正确，未提交或结果不归属当前查询",
    conclusion: "子条件通过不等于根成功",
    familyIndependent: true,
    source: "existing",
    coveredBy: "C09 已输入、未提交（有效点击未提交）",
    scenario: "ineffective",
    submitMode: "click",
    expectedRoot: "unknown",
    expectedStopReason: "root_unknown_subcondition_only",
  },
  {
    id: "SM02",
    obligation: "明确输入拒绝且无正文",
    minimalUseCase: "typed 拒绝，保留原值",
    conclusion: "不补写、不提交",
    familyIndependent: true,
    source: "injected",
    injection: "injected:typed-input-rejection-no-body",
    coveredBy: "现有 44 行无 typed 输入拒绝；C20 关联缺测不能顶替",
    scenario: "normal",
    rejectInputWithoutBody: true,
    originalInputValue: "",
    expectedRoot: "unknown",
    expectedStopReason: "rejection_no_body",
  },
  {
    id: "SM03",
    obligation: "输入后 throw",
    minimalUseCase: "实际值可达标，执行错误保留",
    conclusion: "不因值正确而继续提交",
    familyIndependent: true,
    source: "existing",
    coveredBy: "C17 已派发后执行异常（throwAfterDispatch）",
    scenario: "normal",
    throwAfterDispatch: true,
    expectedRoot: "unknown",
    expectedStopReason: "input_throw_error_preserved",
  },
  {
    id: "SM04",
    obligation: "提交后 throw",
    minimalUseCase: "可能已提交，effects unknown",
    conclusion: "不重复提交",
    familyIndependent: true,
    source: "injected",
    injection: "injected:throw-after-submit-dispatch",
    coveredBy: "C17 已派发后执行异常（throwAfterDispatch 只作用于输入，不能顶替）",
    scenario: "normal",
    throwAfterSubmit: true,
    expectedRoot: "unknown",
    expectedStopReason: "submit_throw_no_resubmit",
  },
  {
    id: "SM05",
    obligation: "后验缺失",
    minimalUseCase: "无可用当前结果",
    conclusion: "根 unknown，停止",
    familyIndependent: true,
    source: "injected",
    injection: "injected:post-submit-read-failure",
    coveredBy: "C18 observe-error 只注入在输入后，不能顶替提交后验缺失",
    scenario: "normal",
    observeFailAfterSubmit: true,
    expectedRoot: "unknown",
    expectedStopReason: "posterior_missing_stop",
  },
  {
    id: "SM06",
    obligation: "后验过期",
    minimalUseCase: "旧 query、旧 batch 或旧 observation",
    conclusion: "不报根成功",
    familyIndependent: true,
    source: "existing",
    coveredBy: "C02 同词旧结果、当前响应未到（旧 batch/requestRef）",
    scenario: "same-word-stalled",
    pageQuery: "露营",
    goalQuery: "露营",
    expectedRoot: "unknown",
    expectedStopReason: "posterior_stale_stop",
  },
  {
    id: "SM07",
    obligation: "其他效果／错误归属",
    minimalUseCase: "有结果但 resultsFor 不匹配",
    conclusion: "不计本次根达成",
    familyIndependent: true,
    source: "existing",
    coveredBy: "C11 当前查询已提交、结果仍旧（resultsFor 仍为旧查询）",
    scenario: "same-word-stalled",
    pageQuery: "露营",
    goalQuery: "登山",
    expectedRoot: "unknown",
    expectedStopReason: "results_attribution_mismatch",
  },
  {
    id: "SM08",
    obligation: "已满足",
    minimalUseCase: "当前查询、归属和结果条件均有证据",
    conclusion: "零额外 mutation",
    familyIndependent: true,
    source: "existing",
    coveredBy: "C01 普通成功、旧 placeholder",
    scenario: "normal",
    expectedRoot: "satisfied",
    expectedStopReason: "root_satisfied_no_extra_mutation",
  },
]);

function familyPage(family, item) {
  const isA = family === "A";
  const scenario = item.scenario ?? "normal";
  return {
    family,
    path: isA ? "/" : "/family-b/",
    params: isA
      ? { profile: "search-cases", scenario, ...(item.pageQuery ? { q: item.pageQuery } : {}) }
      : { scenario, ...(item.pageQuery ? { q: item.pageQuery } : {}) },
    profile: "search-cases",
    scenario,
    submitMode: item.submitMode ?? "enter",
    prelude: null,
    neighborSelector: "#notes",
    neighborExpected: "保持原值",
    projection: {
      unreadItemIndexes: [],
      omitRequestRefs: item.omitRequestRefs ?? false,
      stalePost: item.stalePost ?? false,
      observeFailAfterDispatch: false,
      throwAfterDispatch: item.throwAfterDispatch ?? false,
      rejectInputWithoutBody: item.rejectInputWithoutBody ?? false,
      throwAfterSubmit: item.throwAfterSubmit ?? false,
      observeFailAfterSubmit: item.observeFailAfterSubmit ?? false,
    },
    bindings: isA
      ? {
          documentRef: "family-a-search-doc",
          scopeRef: "family-a-search-scope",
          inputRef: "query",
          submitRef: "submit",
          resultScopeRef: "results",
          collectionRef: "main",
        }
      : {
          documentRef: "family-b-search-doc",
          scopeRef: "family-b-search-scope",
          inputRef: "query",
          submitRef: "submit",
          resultScopeRef: "main-results",
          collectionRef: "main",
        },
    selectors: isA
      ? {
          input: "#query",
          submit: "#submit",
          collection: "#results",
          waitRoot: "#results",
          mainItems: "#results > section article.result-item",
          submittedState: "#submission-state",
          requestState: "#request-state",
        }
      : {
          input: "#query",
          submit: "#submit",
          collection: "#main-results",
          waitRoot: "main",
          mainItems: "#main-results > li",
          submittedState: "#submission-state",
          requestState: "#request-state",
        },
  };
}

export function materializeMigrationCase(family, item) {
  if (!MIGRATION_FAMILIES.includes(family)) {
    throw new TypeError(`Search migration family must be A or B, got ${family}`);
  }
  const page = familyPage(family, item);
  return {
    family,
    caseId: item.id,
    migrationId: item.id,
    variant: "main",
    label: item.obligation,
    obligation: item.obligation,
    source: item.source,
    injection: item.injection ?? null,
    query: item.goalQuery ?? item.pageQuery ?? "露营",
    goal: {
      kind: "BrowserSearch",
      query: item.goalQuery ?? item.pageQuery ?? "露营",
      collectionRef: "main",
      containsText: "装备",
      minimumMatches: 1,
      coverage: "visible_batch",
    },
    ...page,
  };
}

export function materializeMigrationExpected(family, item) {
  return {
    family,
    caseId: item.id,
    variant: "main",
    label: item.obligation,
    source: item.source,
    injection: item.injection ?? null,
    root: item.expectedRoot,
    stopReason: item.expectedStopReason,
    originalInputValue: item.originalInputValue ?? null,
    migrationId: item.id,
  };
}
