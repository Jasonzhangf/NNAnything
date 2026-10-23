const TEXT = {
  goal: "目标文本",
  familyA: {
    primary: "旧值",
    neighbor: "保持原值",
    duplicate: "旧值",
  },
  familyB: {
    primary: "资料草稿",
    neighbor: "原备注",
    duplicate: "资料草稿",
  },
};

const A_SELECTORS = {
  primary: "#query",
  secondary: "#notes",
  duplicate: "#query-duplicate",
};

const B_SELECTORS = {
  primary: "#display-name",
  secondary: "#memo",
  duplicate: "#display-name-duplicate",
};

function expected(id) {
  const unknown = new Set(["I06", "I13", "I14", "I17", "I18", "I19", "I21", "I24a", "I24b", "I24c"]);
  const unsatisfied = new Set(["I03", "I04", "I07", "I08", "I09", "I10", "I11", "I15", "I16", "I22", "I23"]);
  const zeroWrite = new Set(["I04", "I07", "I08", "I09", "I10", "I11", "I13", "I16", "I17", "I18", "I19", "I20", "I22", "I23", "I24a", "I24b", "I24c"]);
  const noContinue = new Set(["I05", "I06", "I13", "I14", "I17", "I18", "I19", "I21", "I22", "I23", "I24a", "I24b", "I24c"]);
  const executionError = new Set(["I04", "I07", "I08", "I09", "I10", "I11", "I13", "I16", "I17", "I18", "I19", "I22", "I23", "I24a", "I24b", "I24c", "I05"]);
  const observationError = new Set(["I06", "I14", "I21"]);
  const fact = unknown.has(id) ? "unknown" : unsatisfied.has(id) ? "unsatisfied" : "satisfied";
  const satisfaction = fact === "satisfied" ? 100 : fact === "unsatisfied" ? 0 : null;
  const write = zeroWrite.has(id) ? 0 : 1;
  const dispatch = write === 0 && id === "I22" ? "dispatched" : write === 0 ? "not_dispatched" : "dispatched";
  const refusal = new Map([
    ["I04", "precondition_unsatisfied"],
    ["I07", "precondition_unsatisfied"],
    ["I08", "precondition_unsatisfied"],
    ["I09", "precondition_unsatisfied"],
    ["I10", "precondition_unsatisfied"],
    ["I11", "precondition_unsatisfied"],
    ["I13", "stale_binding"],
    ["I16", "permission_denied"],
    ["I17", "permission_denied"],
    ["I18", "unsupported_host"],
    ["I19", "sensitive_host_denied"],
    ["I22", "focus_not_on_target"],
    ["I23", "precondition_unsatisfied"],
    ["I24a", "unsupported_host"],
    ["I24b", "unsupported_host"],
    ["I24c", "unsupported_host"],
  ]);
  return {
    goalFact: fact,
    satisfaction,
    textWriteCount: write,
    dispatchState: dispatch,
    canContinue: fact === "satisfied" && !noContinue.has(id),
    refusal: refusal.get(id) ?? null,
    executionErrors: executionError.has(id),
    observationErrors: observationError.has(id),
    neighborUnchanged: true,
    noSubmit: true,
    noEnter: true,
  };
}

function baseCase(id, setup) {
  return {
    id,
    setup: {
      targetKey: "primary",
      neighborKey: "secondary",
      behavior: "none",
      ...setup,
    },
    expected: expected(id),
  };
}

export const CASES = [
  baseCase("I01", { targetKey: "primary", neighborKey: "secondary" }),
  baseCase("I02", { placeholder: "goal", initialValue: "placeholder-mismatch" }),
  baseCase("I03", { behavior: "reset", resetValue: "旧值" }),
  baseCase("I04", { readonly: true }),
  baseCase("I05", { throwAfterDispatch: true }),
  baseCase("I06", { observeFailAfterDispatch: true }),
  baseCase("I07", { disabled: true }),
  baseCase("I08", { readonly: true, ariaReadonly: false }),
  baseCase("I09", { ariaReadonly: true }),
  baseCase("I10", { ariaDisabled: true }),
  baseCase("I11", { disabled: true, ariaDisabled: false }),
  baseCase("I12", { targetKey: "duplicate", neighborKey: "primary" }),
  baseCase("I13", { behavior: "replaceOnCommand" }),
  baseCase("I14", { behavior: "rebuildAfterInput" }),
  baseCase("I15", { behavior: "cancelBeforeInput" }),
  baseCase("I16", { grantedEffects: ["browser.read"] }),
  baseCase("I17", { grantedEffects: [] }),
  baseCase("I18", { type: "password" }),
  baseCase("I19", { sensitive: true }),
  baseCase("I20", { initialValue: "goal" }),
  baseCase("I21", { stalePost: true }),
  baseCase("I22", { behavior: "stealFocus" }),
  baseCase("I23", { editableUnprobed: true }),
  baseCase("I24a", { host: "textarea" }),
  baseCase("I24b", { type: "search" }),
  baseCase("I24c", { host: "contenteditable" }),
];

export function caseById(id) {
  const found = CASES.find(item => item.id === id);
  if (!found) throw new Error(`unknown b-input case ${id}`);
  return found;
}

export function materializeCase(family, id) {
  const item = caseById(id);
  const selectors = family === "A" ? A_SELECTORS : B_SELECTORS;
  const texts = family === "A" ? TEXT.familyA : TEXT.familyB;
  const targetKey = item.setup.targetKey;
  const neighborKey = item.setup.neighborKey;
  const initialValue = item.setup.initialValue === "goal" ? TEXT.goal : item.setup.initialValue ?? texts.primary;
  const targetSelector = selectors[targetKey];
  const neighborSelector = selectors[neighborKey];
  const refs = {
    targetRef: `target:${targetKey}`,
    neighborRefs: [
      { ref: `neighbor:${neighborKey}`, selector: neighborSelector },
    ],
  };
  const host = item.setup.host ?? "input";
  const type = item.setup.type ?? "text";
  const placeholder = item.setup.placeholder === "goal" ? TEXT.goal : item.setup.placeholder ?? "";
  const neighborValue = item.setup.neighborValue ?? texts.neighbor;
  return {
    family,
    caseId: id,
    documentRef: `b-input:${family}`,
    scopeRef: `scope:${family}`,
    ...refs,
    targetSelector,
    host,
    type,
    initialValue,
    neighborValue,
    placeholder,
    behavior: item.setup.behavior ?? "none",
    readonly: item.setup.readonly ?? false,
    ariaReadonly: item.setup.ariaReadonly ?? null,
    disabled: item.setup.disabled ?? false,
    ariaDisabled: item.setup.ariaDisabled ?? null,
    sensitive: item.setup.sensitive ?? false,
    editableUnprobed: item.setup.editableUnprobed ?? false,
    stalePost: item.setup.stalePost ?? false,
    throwAfterDispatch: item.setup.throwAfterDispatch ?? false,
    observeFailAfterDispatch: item.setup.observeFailAfterDispatch ?? false,
    grantedEffects: item.setup.grantedEffects ?? ["browser.read", "browser.nativeInputText"],
    expected: item.expected,
  };
}

export const CASE_IDS = CASES.map(item => item.id);
