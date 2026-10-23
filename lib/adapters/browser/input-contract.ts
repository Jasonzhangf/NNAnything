import type { BrowserObservationError, BrowserObservationFeedback, BrowserObservationObligation } from "./action-observation.js";
import type { ActionObservation } from "./single-action-contract.js";
import { expectRecord } from "../../core/schema.js";

export type BrowserInputHostTag = "input" | "textarea" | "contenteditable" | "unknown";
export type BrowserInputReadonlyState = "readonly" | "editable" | "conflict" | "not_applicable";

export interface BrowserInputGoal {
  readonly kind: "BrowserInput";
  readonly targetText: string;
}

export interface BrowserInputBindings {
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly targetRef: string;
  readonly sensitive?: boolean;
  readonly registryRef?: string;
}

export interface BrowserInputTargetFacts {
  readonly ref: string;
  readonly connected: ActionObservation<boolean>;
  readonly currentRef: ActionObservation<string>;
  readonly host: ActionObservation<BrowserInputHostTag>;
  readonly contentEditable: ActionObservation<boolean | null>;
  readonly type: ActionObservation<string>;
  readonly value: ActionObservation<string>;
  readonly placeholder: ActionObservation<string | null>;
  readonly nativeDisabled: ActionObservation<boolean>;
  readonly ariaDisabled: ActionObservation<boolean | null>;
  readonly nativeReadonly: ActionObservation<boolean>;
  readonly ariaReadonly: ActionObservation<boolean | null>;
  readonly readonlyState: ActionObservation<BrowserInputReadonlyState>;
  readonly editable: ActionObservation<boolean>;
  readonly activeElementRef: ActionObservation<string | null>;
  readonly activeElementFocus: ActionObservation<boolean>;
}

export interface BrowserInputNeighborFacts {
  readonly ref: string;
  readonly value: ActionObservation<string>;
}

export interface BrowserInputObservation {
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly target: BrowserInputTargetFacts;
  readonly neighbors: readonly BrowserInputNeighborFacts[];
  readonly evidence: readonly { readonly id: string; readonly source: string; readonly fact: unknown }[];
}

export interface BrowserInputState {
  readonly observation: BrowserInputObservation;
  readonly checkedObservationId: string | null;
}

export interface BrowserInputRequest {
  readonly requestId: string;
  readonly goal: BrowserInputGoal;
  readonly satisfactionThreshold: 100;
  readonly bindings: BrowserInputBindings;
}

export interface BrowserInputControl {
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly observationId: string;
  readonly revision: number;
}

export interface BrowserInputInvocation {
  readonly kind: "input";
  readonly targetRef: string;
  readonly value: string;
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly observationId: string;
  readonly revision: number;
}

export interface BrowserInputNativeEvent {
  readonly type: "mouseMoved" | "mousePressed" | "mouseReleased" | "rawKeyDown" | "keyUp" | "insertText";
  readonly targetRef: string | null;
  readonly detail: string | null;
}

export interface BrowserInputNativeReceipt {
  readonly dispatched: boolean;
  readonly ok: boolean;
  readonly effectKnowledge: "none" | "known" | "unknown";
  readonly source: string;
  readonly error: BrowserObservationError | null;
  readonly events: readonly BrowserInputNativeEvent[];
  readonly textWriteCount: 0 | 1;
  readonly focus: "target" | "other" | "unknown";
}

export interface BrowserInputRefusal {
  readonly code: string;
  readonly message: string;
}

export interface BrowserInputEpisode {
  readonly requestId: string;
  readonly goal: BrowserInputGoal;
  readonly bindings: BrowserInputBindings;
  readonly action: "input";
  readonly decisionSource: { readonly id: string; readonly source: "handwired" };
  readonly dispatchState: "not_dispatched" | "dispatched" | "unknown";
  readonly effectKnowledge: "none" | "known" | "unknown";
  readonly textWriteCount: 0 | 1;
  readonly focus: "target" | "other" | "unknown" | "not_attempted";
  readonly beforeState: BrowserInputObservation | null;
  readonly state: BrowserInputState | null;
  readonly invocation: BrowserInputInvocation | null;
  readonly receipt: BrowserInputNativeReceipt | null;
  readonly nativeEvents: readonly BrowserInputNativeEvent[];
  readonly goalFact: "satisfied" | "unsatisfied" | "unknown";
  readonly satisfaction: 100 | 0 | null;
  readonly refusal: BrowserInputRefusal | null;
  readonly executionErrors: readonly BrowserObservationError[];
  readonly observationFeedback: BrowserObservationFeedback;
  readonly canContinue: boolean;
}

export interface BrowserInputResources {
  readonly grantedEffects: ReadonlySet<string>;
  readonly observe: (obligation: BrowserObservationObligation) => Promise<BrowserInputObservation>;
  readonly currentControl: () => BrowserInputControl | Promise<BrowserInputControl>;
  readonly nativeInputText: (invocation: BrowserInputInvocation) => Promise<BrowserInputNativeReceipt>;
  readonly signal?: AbortSignal;
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function readFact<T>(
  value: unknown,
  kind: "string" | "boolean",
  ids: ReadonlySet<string>,
  allowNull: boolean,
  read: (value: unknown, label: string) => T,
): ActionObservation<T> {
  const row = expectRecord(value, "input observed fact");
  if (row.status === "unknown") {
    if (!text(row.reason)) throw new TypeError("Input unknown fact requires a reason");
    return { status: "unknown", reason: row.reason };
  }
  if (row.status !== "observed") throw new TypeError("Input fact status must be observed or unknown");
  if (!Array.isArray(row.evidenceRefs) || row.evidenceRefs.length === 0
    || row.evidenceRefs.some(id => typeof id !== "string" || !ids.has(id))) {
    throw new TypeError("Input observed fact requires local evidence");
  }
  if (row.value === null) {
    if (!allowNull) throw new TypeError("Input observed fact requires a value");
    return { status: "observed", value: null as T, evidenceRefs: row.evidenceRefs };
  }
  const typed = read(row.value, "input observed fact value");
  if (kind === "boolean" && typeof typed !== "boolean") throw new TypeError("Input boolean fact requires boolean value");
  if (kind === "string" && typeof typed !== "string") throw new TypeError("Input string fact requires string value");
  return { status: "observed", value: typed as T, evidenceRefs: row.evidenceRefs };
}

function readHost(value: unknown): "input" | "textarea" | "contenteditable" | "unknown" {
  if (typeof value !== "string" || !["input", "textarea", "contenteditable", "unknown"].includes(value)) {
    throw new TypeError("Input host tag is invalid");
  }
  return value as "input" | "textarea" | "contenteditable" | "unknown";
}

function readReadonlyState(value: unknown): BrowserInputReadonlyState {
  if (typeof value !== "string" || !["readonly", "editable", "conflict", "not_applicable"].includes(value)) {
    throw new TypeError("Input readonly state is invalid");
  }
  return value as BrowserInputReadonlyState;
}

function readNullableString(value: unknown): string | null {
  return value === null ? null : typeof value === "string" ? value : (() => { throw new TypeError("Input nullable string is invalid"); })();
}

function readString(value: unknown, label: string): string {
  const result = readNullableString(value);
  if (result === null) throw new TypeError(`${label} must be a string`);
  return result;
}

function readNullableBoolean(value: unknown): boolean | null {
  return value === null ? null : typeof value === "boolean" ? value : (() => { throw new TypeError("Input nullable boolean is invalid"); })();
}

export function readBrowserInputObservation(value: unknown): BrowserInputObservation {
  const row = expectRecord(value, "browser input observation");
  if (![row.documentRef, row.scopeRef, row.observationId].every(text)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || !Array.isArray(row.evidence) || !Array.isArray(row.neighbors)) {
    throw new TypeError("Invalid browser input observation identity");
  }
  const ids = new Set<string>();
  for (const raw of row.evidence) {
    const item = expectRecord(raw, "input evidence");
    if (!text(item.id) || ids.has(item.id) || !text(item.source) || !Object.hasOwn(item, "fact")) {
      throw new TypeError("Invalid input evidence");
    }
    ids.add(item.id);
  }
  const target = expectRecord(row.target, "input target");
  if (!text(target.ref)) throw new TypeError("Input target ref is required");
  const currentRef = readFact<string>(target.currentRef, "string", ids, false, readString);
  if (currentRef.status === "observed" && currentRef.value === null) {
    throw new TypeError("Input currentRef observed value must be a string");
  }
  const targetValue = readFact<string>(target.value, "string", ids, false, readString);
  if (targetValue.status === "observed" && targetValue.value === null) {
    throw new TypeError("Input observed value must be a string");
  }
  const targetFacts = {
    ref: target.ref,
    connected: readFact<boolean>(target.connected, "boolean", ids, false, Boolean),
    currentRef: currentRef as ActionObservation<string>,
    host: readFact(target.host, "string", ids, false, readHost),
    contentEditable: readFact<boolean | null>(target.contentEditable, "boolean", ids, true, readNullableBoolean),
    type: readFact<string>(target.type, "string", ids, false, readString),
    value: targetValue as ActionObservation<string>,
    placeholder: readFact<string | null>(target.placeholder, "string", ids, true, readNullableString),
    nativeDisabled: readFact<boolean>(target.nativeDisabled, "boolean", ids, false, Boolean),
    ariaDisabled: readFact<boolean | null>(target.ariaDisabled, "boolean", ids, true, readNullableBoolean),
    nativeReadonly: readFact<boolean>(target.nativeReadonly, "boolean", ids, false, Boolean),
    ariaReadonly: readFact<boolean | null>(target.ariaReadonly, "boolean", ids, true, readNullableBoolean),
    readonlyState: readFact(target.readonlyState, "string", ids, false, readReadonlyState),
    editable: readFact<boolean>(target.editable, "boolean", ids, false, Boolean),
    activeElementRef: readFact<string | null>(target.activeElementRef, "string", ids, true, readNullableString),
    activeElementFocus: readFact<boolean>(target.activeElementFocus, "boolean", ids, false, Boolean),
  };
  const neighborRefs = new Set<string>();
  const neighbors = row.neighbors.map((raw, index) => {
    const item = expectRecord(raw, `input neighbor[${index}]`);
    if (!text(item.ref) || neighborRefs.has(item.ref)) throw new TypeError("Input neighbor refs must be unique");
    neighborRefs.add(item.ref);
    if (item.ref === targetFacts.ref) throw new TypeError("Input neighbor cannot equal target ref");
    const value = readFact<string>(item.value, "string", ids, false, readString);
    if (value.status === "observed" && value.value === null) {
      throw new TypeError("Input neighbor observed value must be a string");
    }
    return {
      ref: item.ref,
      value: value as ActionObservation<string>,
    };
  });
  return {
    documentRef: row.documentRef as string,
    scopeRef: row.scopeRef as string,
    observationId: row.observationId as string,
    revision: Number(row.revision),
    target: targetFacts,
    neighbors,
    evidence: row.evidence as BrowserInputObservation["evidence"],
  };
}

export function readBrowserInputRequest(value: unknown): BrowserInputRequest {
  const row = expectRecord(value, "browser input request");
  const goal = expectRecord(row.goal, "input goal");
  const bindings = expectRecord(row.bindings, "input bindings");
  if (!text(row.requestId) || row.satisfactionThreshold !== 100 || goal.kind !== "BrowserInput"
    || !text(goal.targetText) || !text(bindings.documentRef) || !text(bindings.scopeRef) || !text(bindings.targetRef)
    || Object.keys(row).some(key => !["requestId", "goal", "satisfactionThreshold", "bindings"].includes(key))) {
    throw new TypeError("Invalid typed browser input request");
  }
  if (bindings.sensitive !== undefined && typeof bindings.sensitive !== "boolean") {
    throw new TypeError("Invalid typed browser input bindings.sensitive");
  }
  if (bindings.registryRef !== undefined && !text(bindings.registryRef)) {
    throw new TypeError("Invalid typed browser input bindings.registryRef");
  }
  return {
    requestId: row.requestId,
    goal: { kind: "BrowserInput", targetText: goal.targetText },
    satisfactionThreshold: 100,
    bindings: {
      documentRef: bindings.documentRef,
      scopeRef: bindings.scopeRef,
      targetRef: bindings.targetRef,
      ...(bindings.sensitive === undefined ? {} : { sensitive: bindings.sensitive }),
      ...(bindings.registryRef === undefined ? {} : { registryRef: bindings.registryRef }),
    },
  };
}

export function assertInputBindings(
  observation: BrowserInputObservation,
  bindings: BrowserInputBindings,
): void {
  if (observation.documentRef !== bindings.documentRef
    || observation.scopeRef !== bindings.scopeRef
    || observation.target.ref !== bindings.targetRef) {
    throw new TypeError("Browser input observation changed explicit logical bindings");
  }
}

export function inputGoalFact(
  goal: { readonly targetText: string },
  observation: BrowserInputObservation,
): "satisfied" | "unsatisfied" | "unknown" {
  const value = observation.target.value;
  if (value.status === "unknown") return "unknown";
  return value.value === goal.targetText ? "satisfied" : "unsatisfied";
}
