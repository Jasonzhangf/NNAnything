import {
  BASIC_KIND_FAMILIES,
  DEFAULT_BASIC_KIND_CONFIG,
  classifyBasicKindBatch,
  validateBasicKindProfile,
  type BasicKindLabel,
  type BasicKindProfile,
  type BasicKindStatus,
} from "../../filters/basic-kinds.js";
import {
  checkCandidates,
  observeCandidates,
} from "../../filters/candidate-chain.js";
import { createFocusSpec } from "../../filters/focus.js";
import type { Rect } from "./observation.js";
import {
  observeLiveDom,
  stableNodeRefFor,
  type LiveDomSnapshot,
  type StableNodeRefRegistry,
} from "./live-dom.js";
import type {
  ActionObservation,
  SingleActionElement,
  SingleActionRegion,
  SingleActionRequest,
  SingleActionSnapshot,
} from "./single-action-contract.js";

export interface ObserveBrowserSingleActionInput {
  readonly document: Document;
  readonly window: Window;
  readonly registry: StableNodeRefRegistry;
  readonly scope: Element;
  readonly regions: readonly Element[];
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly l1Profile: BasicKindProfile;
}

interface EvidenceBinding {
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
}

interface BasicKindSlotFacts {
  readonly basicKind: BasicKindLabel | null;
  readonly judgmentStatus: BasicKindStatus;
  readonly candidateStatus: SingleActionElement["candidateStatus"];
}

interface ProjectedElement {
  readonly element: SingleActionElement;
  readonly sourceElement: Element;
}

const basicKindLabels = new Set<string>([
  ...Object.values(BASIC_KIND_FAMILIES).flat(),
  "other",
]);
const basicKindStatuses = new Set<BasicKindStatus>([
  "judged",
  "unknown",
  "conflict",
  "excluded",
]);
const candidateStatuses = new Set<SingleActionElement["candidateStatus"]>([
  "ok",
  "filtered_out",
  "skipped",
  "unknown",
]);
const nativeDisableableTags = new Set([
  "button",
  "fieldset",
  "input",
  "optgroup",
  "option",
  "select",
  "textarea",
]);

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unsupported field ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`);
  }
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, label);
}

function uniqueStrings(value: unknown, label: string, allowEmpty: boolean): readonly string[] {
  const strings = array(value, label).map((entry, index) =>
    nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) {
    throw new TypeError(`${label} contains duplicate ids`);
  }
  if (!allowEmpty && strings.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return strings;
}

function readObserved<T>(
  value: unknown,
  label: string,
  readValue: (value: unknown, label: string) => T,
): ActionObservation<T> {
  const input = record(value, label);
  if (input.status === "unknown") {
    exactKeys(input, ["status", "reason"], label);
    return { status: "unknown", reason: nonEmptyString(input.reason, `${label}.reason`) };
  }
  if (input.status !== "observed") {
    throw new TypeError(`${label}.status must be observed or unknown`);
  }
  exactKeys(input, ["status", "value", "evidenceRefs"], label);
  return {
    status: "observed",
    value: readValue(input.value, `${label}.value`),
    evidenceRefs: uniqueStrings(input.evidenceRefs, `${label}.evidenceRefs`, false),
  };
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function readPoint(value: unknown, label: string): { readonly x: number; readonly y: number } {
  const input = record(value, label);
  exactKeys(input, ["x", "y"], label);
  for (const key of ["x", "y"] as const) {
    if (typeof input[key] !== "number" || !Number.isFinite(input[key])) {
      throw new TypeError(`${label}.${key} must be a finite number`);
    }
  }
  return { x: input.x as number, y: input.y as number };
}

function readElement(value: unknown, label: string): SingleActionElement {
  const input = record(value, label);
  exactKeys(input, [
    "ref",
    "parentRef",
    "tag",
    "role",
    "basicKind",
    "judgmentStatus",
    "candidateStatus",
    "controls",
    "enabled",
    "hit",
    "buttonSemantics",
    "point",
    "evidenceRefs",
  ], label);
  if (input.basicKind !== null && !basicKindLabels.has(String(input.basicKind))) {
    throw new TypeError(`${label}.basicKind is invalid`);
  }
  if (!basicKindStatuses.has(input.judgmentStatus as BasicKindStatus)) {
    throw new TypeError(`${label}.judgmentStatus is invalid`);
  }
  if (!candidateStatuses.has(input.candidateStatus as SingleActionElement["candidateStatus"])) {
    throw new TypeError(`${label}.candidateStatus is invalid`);
  }
  return {
    ref: nonEmptyString(input.ref, `${label}.ref`),
    parentRef: nullableString(input.parentRef, `${label}.parentRef`),
    tag: nullableString(input.tag, `${label}.tag`),
    role: nullableString(input.role, `${label}.role`),
    basicKind: input.basicKind as BasicKindLabel | null,
    judgmentStatus: input.judgmentStatus as BasicKindStatus,
    candidateStatus: input.candidateStatus as SingleActionElement["candidateStatus"],
    controls: readObserved(
      input.controls,
      `${label}.controls`,
      (entry, itemLabel) => uniqueStrings(entry, itemLabel, true),
    ),
    enabled: readObserved(input.enabled, `${label}.enabled`, readBoolean),
    hit: readObserved(input.hit, `${label}.hit`, readBoolean),
    buttonSemantics: readObserved(
      input.buttonSemantics,
      `${label}.buttonSemantics`,
      readBoolean,
    ),
    point: readObserved(input.point, `${label}.point`, readPoint),
    evidenceRefs: uniqueStrings(input.evidenceRefs, `${label}.evidenceRefs`, false),
  };
}

function readRegion(value: unknown, label: string): SingleActionRegion {
  const input = record(value, label);
  exactKeys(input, ["ref", "expanded", "rendered"], label);
  return {
    ref: nonEmptyString(input.ref, `${label}.ref`),
    expanded: readObserved(input.expanded, `${label}.expanded`, readBoolean),
    rendered: readObserved(input.rendered, `${label}.rendered`, readBoolean),
  };
}

export function readSingleActionSnapshot(value: unknown): SingleActionSnapshot {
  const input = record(value, "single-action snapshot");
  exactKeys(input, [
    "documentRef",
    "observationId",
    "revision",
    "scopeRef",
    "regions",
    "elements",
    "evidence",
  ], "single-action snapshot");
  const documentRef = nonEmptyString(input.documentRef, "snapshot.documentRef");
  const observationId = nonEmptyString(input.observationId, "snapshot.observationId");
  const revision = nonnegativeInteger(input.revision, "snapshot.revision");
  const scopeRef = nonEmptyString(input.scopeRef, "snapshot.scopeRef");
  const regions = array(input.regions, "snapshot.regions").map((entry, index) =>
    readRegion(entry, `snapshot.regions[${index}]`));
  const elements = array(input.elements, "snapshot.elements").map((entry, index) =>
    readElement(entry, `snapshot.elements[${index}]`));
  const evidence = array(input.evidence, "snapshot.evidence").map((entry, index) => {
    const label = `snapshot.evidence[${index}]`;
    const item = record(entry, label);
    exactKeys(item, ["id", "observationId", "source", "fact"], label);
    if (!Object.hasOwn(item, "fact")) throw new TypeError(`${label}.fact is required`);
    const evidenceObservationId = nonEmptyString(item.observationId, `${label}.observationId`);
    if (evidenceObservationId !== observationId) {
      throw new TypeError(`${label}.observationId is stale or mismatched`);
    }
    return {
      id: nonEmptyString(item.id, `${label}.id`),
      observationId: evidenceObservationId,
      source: nonEmptyString(item.source, `${label}.source`),
      fact: item.fact,
    };
  });

  const evidenceIds = new Set<string>();
  for (const item of evidence) {
    if (evidenceIds.has(item.id)) throw new TypeError(`snapshot.evidence has duplicate id ${item.id}`);
    evidenceIds.add(item.id);
  }
  const regionRefs = new Set<string>();
  for (const region of regions) {
    if (regionRefs.has(region.ref)) throw new TypeError(`duplicate region ref ${region.ref}`);
    regionRefs.add(region.ref);
  }
  const elementRefs = new Set<string>();
  for (const element of elements) {
    if (elementRefs.has(element.ref)) throw new TypeError(`duplicate element ref ${element.ref}`);
    elementRefs.add(element.ref);
  }
  if (!elementRefs.has(scopeRef)) throw new TypeError("snapshot.scopeRef is not present in elements");
  for (const region of regions) {
    if (!elementRefs.has(region.ref)) throw new TypeError(`region ${region.ref} is not present in elements`);
  }
  for (const element of elements) {
    if (element.ref !== scopeRef && (element.parentRef === null || !elementRefs.has(element.parentRef))) {
      throw new TypeError(`element ${element.ref}.parentRef leaves the observed scope`);
    }
  }

  const requireEvidence = (refs: readonly string[], label: string): void => {
    for (const ref of refs) {
      if (!evidenceIds.has(ref)) throw new TypeError(`${label} references unavailable evidence ${ref}`);
    }
  };
  const readObservation = <T>(
    observation: ActionObservation<T>,
    label: string,
  ): ActionObservation<T> => {
    if (observation.status === "observed") requireEvidence(observation.evidenceRefs, label);
    return observation;
  };
  for (const element of elements) {
    requireEvidence(element.evidenceRefs, `element ${element.ref}`);
    readObservation(element.controls, `element ${element.ref}.controls`);
    readObservation(element.enabled, `element ${element.ref}.enabled`);
    readObservation(element.hit, `element ${element.ref}.hit`);
    readObservation(element.buttonSemantics, `element ${element.ref}.buttonSemantics`);
    readObservation(element.point, `element ${element.ref}.point`);
    if (element.controls.status === "observed") {
      for (const ref of element.controls.value) {
        if (!elementRefs.has(ref)) {
          throw new TypeError(`element ${element.ref}.controls references unavailable element ${ref}`);
        }
      }
    }
  }
  for (const region of regions) {
    readObservation(region.expanded, `region ${region.ref}.expanded`);
    readObservation(region.rendered, `region ${region.ref}.rendered`);
  }
  return {
    documentRef,
    observationId,
    revision,
    scopeRef,
    regions,
    elements,
    evidence,
  };
}

export function readSingleActionRequest(value: unknown): SingleActionRequest {
  const input = record(value, "single-action request");
  exactKeys(input, ["goal", "satisfactionThreshold", "state"], "single-action request");
  const goal = record(input.goal, "single-action request.goal");
  exactKeys(goal, ["kind", "regionRef", "desired"], "single-action request.goal");
  if (goal.kind !== "SetExpanded") {
    throw new TypeError("single-action request supports only SetExpanded");
  }
  if (goal.desired !== true) {
    throw new TypeError("single-action request SetExpanded desired must be true");
  }
  if (input.satisfactionThreshold !== 100) {
    throw new TypeError("single-action request satisfactionThreshold must be 100");
  }
  const state = readSingleActionSnapshot(input.state);
  const regionRef = nonEmptyString(goal.regionRef, "single-action request.goal.regionRef");
  if (!state.regions.some(region => region.ref === regionRef)) {
    throw new TypeError(`single-action request goal.regionRef is not an explicitly bound region ${regionRef}`);
  }
  return {
    goal: { kind: "SetExpanded", regionRef, desired: true },
    satisfactionThreshold: 100,
    state,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isElement(value: unknown, label: string): Element {
  if (!isRecord(value) || value.nodeType !== 1 || typeof value.tagName !== "string") {
    throw new TypeError(`${label} must be an Element`);
  }
  if (typeof value.getAttribute !== "function" || typeof value.getBoundingClientRect !== "function") {
    throw new TypeError(`${label} must expose read-only DOM element methods`);
  }
  return value as unknown as Element;
}

function elementDocument(element: Element, document: Document): Document | null {
  if (element.ownerDocument !== null) return element.ownerDocument === document ? document : null;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current === document.documentElement) return document;
  }
  return null;
}

function within(element: Element, ancestor: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current === ancestor) return true;
  }
  return false;
}

function attribute(element: Element, name: string): string | null | undefined {
  try {
    const value = element.getAttribute(name);
    return typeof value === "string" ? value : null;
  } catch {
    return undefined;
  }
}

function booleanAttribute(element: Element, name: string): boolean | null {
  try {
    return element.hasAttribute(name);
  } catch {
    return null;
  }
}

function tagOf(element: Element): string {
  return String(element.tagName).toLowerCase();
}

function roleTokens(role: string | null): readonly string[] {
  return String(role ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function positive(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function intersection(left: Rect, right: Rect): Rect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(left.x + left.width, right.x + right.width) - x),
    height: Math.max(0, Math.min(left.y + left.height, right.y + right.height) - y),
  };
}

function observed<T>(value: T, evidenceRefs: readonly string[]): ActionObservation<T> {
  return { status: "observed", value, evidenceRefs };
}

function unknown<T>(reason: string): ActionObservation<T> {
  return { status: "unknown", reason };
}

function renderedObservation(
  node: LiveDomSnapshot["observation"]["nodes"][number],
  evidenceRefs: readonly string[],
): ActionObservation<boolean> {
  if (node.rect === null || node.clippedRect === null || node.fragments === null) {
    return unknown("region_geometry_or_presentation_unavailable");
  }
  const rendered = node.fragments.some(fragment =>
    positive(intersection(intersection(node.rect!, node.clippedRect!), fragment)));
  return observed(rendered, evidenceRefs);
}

function reconcileExpandedWithPresentation(
  expanded: ActionObservation<boolean>,
  rendered: ActionObservation<boolean>,
): ActionObservation<boolean> {
  if (
    expanded.status === "observed"
    && rendered.status === "observed"
    && expanded.value !== rendered.value
  ) {
    return unknown("conflicting_expanded_and_rendered_state");
  }
  return expanded;
}

function nativeDisabledObservation(element: Element): boolean | null {
  try {
    return element.matches(":disabled");
  } catch {
    return null;
  }
}

function enabledObservation(element: Element, evidenceRefs: readonly string[]): ActionObservation<boolean> {
  const ariaDisabled = attribute(element, "aria-disabled");
  const disabledAttribute = booleanAttribute(element, "disabled");
  const tag = tagOf(element);
  const nativeDisableable = nativeDisableableTags.has(tag);
  const nativeDisabled = nativeDisableable || ariaDisabled === "false"
    ? nativeDisabledObservation(element)
    : null;
  if (ariaDisabled !== null) {
    if (ariaDisabled === undefined) return unknown("aria_disabled_unavailable");
    if (ariaDisabled === "true") return observed(false, evidenceRefs);
    if (ariaDisabled === "false") {
      if (disabledAttribute === true || nativeDisabled === true) return observed(false, evidenceRefs);
      if (nativeDisabled === false) return observed(true, evidenceRefs);
      return unknown("native_disabled_unavailable");
    }
    return unknown("invalid_aria_disabled");
  }
  if (nativeDisableable) {
    if (disabledAttribute === true || nativeDisabled === true) return observed(false, evidenceRefs);
    if (nativeDisabled === false) return observed(true, evidenceRefs);
    return unknown("native_disabled_unavailable");
  }
  return unknown("enabled_not_observable_for_element_semantics");
}

function buttonSemantics(
  element: Element,
  role: string | null,
  evidenceRefs: readonly string[],
): ActionObservation<boolean> {
  const tag = tagOf(element);
  const rawInputType = tag === "input" ? attribute(element, "type") : null;
  if (rawInputType === undefined) return unknown("input_type_unavailable");
  const inputType = tag === "input" ? String(rawInputType ?? "text").toLowerCase() : null;
  const value = tag === "button"
    || (tag === "input" && ["button", "submit", "reset", "image"].includes(inputType ?? ""))
    || roleTokens(role).includes("button");
  return observed(value, evidenceRefs);
}

function hitCandidates(rects: readonly Rect[]): readonly { readonly x: number; readonly y: number }[] {
  const points: { readonly x: number; readonly y: number }[] = [];
  const seen = new Set<string>();
  for (const rect of rects) {
    if (!positive(rect)) continue;
    const fractions = [
      [0.5, 0.5],
      [0.5, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5],
      [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9],
    ] as const;
    for (const [fx, fy] of fractions) {
      const point = { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
      const key = `${point.x},${point.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        points.push(point);
      }
    }
  }
  return points;
}

function hitObservation(input: {
  readonly document: Document;
  readonly registry: StableNodeRefRegistry;
  readonly element: Element;
  readonly node: LiveDomSnapshot["observation"]["nodes"][number];
  readonly addEvidence: (source: string, fact: unknown) => string;
}): {
  readonly hit: ActionObservation<boolean>;
  readonly point: ActionObservation<{ readonly x: number; readonly y: number }>;
  readonly evidenceRefs: readonly string[];
} {
  if (input.node.foreground === undefined || input.node.foreground === "unassessed") {
    return {
      hit: unknown("native_hit_unassessed"),
      point: unknown("native_hit_point_unavailable"),
      evidenceRefs: [],
    };
  }
  if (input.node.foreground === "occluded") {
    const id = input.addEvidence("dom.elementsFromPoint", {
      ref: input.node.nodeRef,
      hit: false,
      reason: "foreground_occluded",
    });
    return { hit: observed(false, [id]), point: unknown("no_hit_point"), evidenceRefs: [id] };
  }
  const exposedRects = input.node.exposedRects;
  if (exposedRects === null || exposedRects === undefined) {
    return {
      hit: unknown("native_exposed_rects_unavailable"),
      point: unknown("native_hit_point_unavailable"),
      evidenceRefs: [],
    };
  }
  const usableRects = exposedRects.filter(positive);
  if (usableRects.length === 0) {
    const id = input.addEvidence("dom.elementsFromPoint", {
      ref: input.node.nodeRef,
      hit: false,
      reason: "no_positive_exposed_rect",
    });
    return { hit: observed(false, [id]), point: unknown("no_hit_point"), evidenceRefs: [id] };
  }
  if (typeof input.document.elementsFromPoint !== "function") {
    return {
      hit: unknown("elementsFromPoint_unavailable"),
      point: unknown("native_hit_point_unavailable"),
      evidenceRefs: [],
    };
  }
  for (const point of hitCandidates(usableRects)) {
    let hits: readonly Element[];
    try {
      hits = Array.from(input.document.elementsFromPoint(point.x, point.y));
    } catch {
      return {
        hit: unknown("elementsFromPoint_failed"),
        point: unknown("native_hit_point_unavailable"),
        evidenceRefs: [],
      };
    }
    const topHit = hits[0];
    if (topHit === undefined || !within(topHit, input.element)) continue;
    const id = input.addEvidence("dom.elementsFromPoint", {
      ref: input.node.nodeRef,
      point,
      hit: true,
      hitRefs: hits.map(hit => stableNodeRefFor(input.registry, hit)),
    });
    return {
      hit: observed(true, [id]),
      point: observed(point, [id]),
      evidenceRefs: [id],
    };
  }
  const id = input.addEvidence("dom.elementsFromPoint", {
    ref: input.node.nodeRef,
    hit: false,
    testedPoints: hitCandidates(usableRects),
  });
  return { hit: observed(false, [id]), point: unknown("no_hit_point"), evidenceRefs: [id] };
}

function idRefs(snapshot: LiveDomSnapshot): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const evidence of snapshot.evidence.values()) {
    if (evidence.id === null) continue;
    result.set(evidence.id, [...(result.get(evidence.id) ?? []), evidence.nodeRef]);
  }
  return result;
}

function controlsObservation(input: {
  readonly element: Element;
  readonly registry: StableNodeRefRegistry;
  readonly scopeRefs: ReadonlySet<string>;
  readonly ids: ReadonlyMap<string, readonly string[]>;
  readonly addEvidence: (source: string, fact: unknown) => string;
}): ActionObservation<readonly string[]> {
  const raw = attribute(input.element, "aria-controls");
  if (raw === undefined) return unknown("aria_controls_unavailable");
  if (raw === null) {
    const id = input.addEvidence("dom.aria-controls", {
      ref: stableNodeRefFor(input.registry, input.element),
      value: null,
      targets: [],
    });
    return observed([], [id]);
  }
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (new Set(tokens).size !== tokens.length) return unknown("duplicate_aria_controls_idref");
  const refs: string[] = [];
  for (const token of tokens) {
    const matches = input.ids.get(token) ?? [];
    if (matches.length !== 1) return unknown(matches.length === 0 ? "broken_aria_controls_idref" : "duplicate_aria_controls_target_id");
    const ref = matches[0]!;
    if (!input.scopeRefs.has(ref)) return unknown("aria_controls_target_outside_scope");
    refs.push(ref);
  }
  const id = input.addEvidence("dom.aria-controls", {
    ref: stableNodeRefFor(input.registry, input.element),
    value: raw,
    targets: refs,
  });
  return observed(refs, [id]);
}

function expandedObservation(
  regionRef: string,
  controls: readonly ProjectedElement[],
  addEvidence: (source: string, fact: unknown) => string,
): {
  readonly observation: ActionObservation<boolean>;
  readonly evidenceRefs: readonly string[];
} {
  const providers = controls.filter(control =>
    control.element.controls.status === "observed"
    && control.element.controls.value.includes(regionRef));
  const values: { readonly value: boolean; readonly id: string }[] = [];
  for (const provider of providers) {
    const raw = attribute(provider.sourceElement, "aria-expanded");
    if (raw === null) continue;
    if (raw !== "true" && raw !== "false") return {
      observation: unknown("invalid_aria_expanded"),
      evidenceRefs: [],
    };
    const value = raw === "true";
    values.push({
      value,
      id: addEvidence("dom.aria-expanded", { ref: provider.element.ref, value }),
    });
  }
  if (values.length === 0) return {
    observation: unknown("no_expanded_evidence"),
    evidenceRefs: [],
  };
  const unique = new Set(values.map(item => item.value));
  if (unique.size !== 1) return {
    observation: unknown("conflicting_expanded_evidence"),
    evidenceRefs: values.map(item => item.id),
  };
  const evidenceRefs = values.map(item => item.id);
  return { observation: observed(values[0]!.value, evidenceRefs), evidenceRefs };
}

function elementFacts(input: {
  readonly document: Document;
  readonly registry: StableNodeRefRegistry;
  readonly node: LiveDomSnapshot["observation"]["nodes"][number];
  readonly element: Element;
  readonly scopeRef: string;
  readonly scopeRefs: ReadonlySet<string>;
  readonly ids: ReadonlyMap<string, readonly string[]>;
  readonly binding: EvidenceBinding;
  readonly slot: BasicKindSlotFacts;
  readonly addEvidence: (source: string, fact: unknown) => string;
}): ProjectedElement {
  const ref = input.node.nodeRef;
  const base = input.addEvidence("dom.singleAction.element", {
    binding: input.binding,
    scopeRef: input.scopeRef,
    ref,
    parentRef: input.node.parentRef,
    tag: input.node.tag,
    role: input.node.role,
    basicKind: input.slot.basicKind,
    judgmentStatus: input.slot.judgmentStatus,
    candidateStatus: input.slot.candidateStatus,
    ariaControls: attribute(input.element, "aria-controls"),
  });
  const controls = controlsObservation({
    element: input.element,
    registry: input.registry,
    scopeRefs: input.scopeRefs,
    ids: input.ids,
    addEvidence: input.addEvidence,
  });
  const enabledId = input.addEvidence("dom.enabled", {
    ref,
    tag: input.node.tag,
    ariaDisabled: attribute(input.element, "aria-disabled"),
    disabledAttribute: booleanAttribute(input.element, "disabled"),
  });
  const enabled = enabledObservation(input.element, [enabledId]);
  const semanticsId = input.addEvidence("dom.buttonSemantics", {
    ref,
    tag: input.node.tag,
    role: input.node.role,
    inputType: tagOf(input.element) === "input" ? attribute(input.element, "type") : null,
  });
  const button = buttonSemantics(input.element, input.node.role, [semanticsId]);
  const renderedId = input.addEvidence("dom.regionPresentation", {
    ref,
    rect: input.node.rect,
    clippedRect: input.node.clippedRect,
    fragments: input.node.fragments,
  });
  const hit = hitObservation({
    document: input.document,
    registry: input.registry,
    element: input.element,
    node: input.node,
    addEvidence: input.addEvidence,
  });
  const evidenceRefs = [
    base,
    ...(controls.status === "observed" ? controls.evidenceRefs : []),
    ...(enabled.status === "observed" ? enabled.evidenceRefs : []),
    ...(button.status === "observed" ? button.evidenceRefs : []),
    ...hit.evidenceRefs,
    renderedId,
  ];
  return {
    sourceElement: input.element,
    element: {
      ref,
      parentRef: input.node.parentRef,
      tag: input.node.tag,
      role: input.node.role,
      basicKind: input.slot.basicKind,
      judgmentStatus: input.slot.judgmentStatus,
      candidateStatus: input.slot.candidateStatus,
      controls,
      enabled,
      hit: hit.hit,
      buttonSemantics: button,
      point: hit.point,
      evidenceRefs: [...new Set(evidenceRefs)],
    },
  };
}

export function observeBrowserSingleAction(input: ObserveBrowserSingleActionInput): SingleActionSnapshot {
  const documentRef = nonEmptyString(input.documentRef, "observation.documentRef");
  const observationId = nonEmptyString(input.observationId, "observation.observationId");
  const revision = nonnegativeInteger(input.revision, "observation.revision");
  const scope = isElement(input.scope, "observation.scope");
  if (elementDocument(scope, input.document) === null) {
    throw new TypeError("observation.scope must belong to the provided document");
  }
  const regions = array(input.regions, "observation.regions").map((entry, index) =>
    isElement(entry, `observation.regions[${index}]`));
  if (new Set(regions).size !== regions.length) throw new TypeError("observation.regions contains duplicate elements");
  for (const region of regions) {
    if (elementDocument(region, input.document) === null || !within(region, scope)) {
      throw new TypeError("observation.regions must belong to the provided document and stay within scope");
    }
  }
  const l1Profile = validateBasicKindProfile(input.l1Profile);
  const binding = { documentRef, observationId, revision };
  const live = observeLiveDom({
    document: input.document,
    window: input.window,
    registry: input.registry,
    excludeRoot: null,
    snapshotRef: observationId,
    documentRef,
  });
  const scopeRef = stableNodeRefFor(input.registry, scope);
  const scopeNodes = live.observation.nodes.filter(node => {
    const element = live.resolveElement(node.nodeRef);
    return element !== null && within(element, scope);
  });
  if (!scopeNodes.some(node => node.nodeRef === scopeRef)) {
    throw new TypeError("observation.scope was not observed");
  }
  const scopeRefs = new Set(scopeNodes.map(node => node.nodeRef));
  for (const region of regions) {
    if (!scopeRefs.has(stableNodeRefFor(input.registry, region))) {
      throw new TypeError("observation region was not observed inside scope");
    }
  }
  const candidateBatch = checkCandidates(
    observeCandidates({ observation: live.observation, nodeRefs: scopeNodes.map(node => node.nodeRef) }),
    createFocusSpec(),
  );
  const basicKindBatch = classifyBasicKindBatch({
    ...candidateBatch,
    itemObservations: live.itemObservations,
  }, DEFAULT_BASIC_KIND_CONFIG, l1Profile);
  const slots = new Map(basicKindBatch.slots.map(slot => [slot.nodeRef, slot]));

  const evidence: {
    id: string;
    observationId: string;
    source: string;
    fact: unknown;
  }[] = [];
  const evidenceIds = new Set<string>();
  const addEvidence = (source: string, fact: unknown): string => {
    let sequence = evidence.length;
    let id = `${observationId}:evidence:${sequence}`;
    while (evidenceIds.has(id)) id = `${observationId}:evidence:${++sequence}`;
    evidenceIds.add(id);
    evidence.push({ id, observationId, source, fact });
    return id;
  };
  const ids = idRefs(live);
  const elements = scopeNodes.map(node => {
    const element = live.resolveElement(node.nodeRef);
    const slot = slots.get(node.nodeRef);
    if (element === null) throw new TypeError(`scope element ${node.nodeRef} was not resolvable`);
    return elementFacts({
      document: input.document,
      registry: input.registry,
      node,
      element,
      scopeRef,
      scopeRefs,
      ids,
      binding,
      slot: slot ?? {
        basicKind: null,
        judgmentStatus: "unknown",
        candidateStatus: "unknown",
      },
      addEvidence,
    });
  });
  const nodeByRef = new Map(scopeNodes.map(node => [node.nodeRef, node]));
  const regionResults: SingleActionRegion[] = regions.map(region => {
    const ref = stableNodeRefFor(input.registry, region);
    const node = nodeByRef.get(ref);
    if (node === undefined) throw new TypeError(`region ${ref} is unavailable from live observation`);
    const renderedId = addEvidence("dom.regionPresentation", {
      binding,
      ref,
      rect: node.rect,
      clippedRect: node.clippedRect,
      fragments: node.fragments,
    });
    const rendered = renderedObservation(node, [renderedId]);
    const expanded = reconcileExpandedWithPresentation(
      expandedObservation(ref, elements, addEvidence).observation,
      rendered,
    );
    return {
      ref,
      expanded,
      rendered,
    };
  });
  return {
    documentRef,
    observationId,
    revision,
    scopeRef,
    regions: regionResults,
    elements: elements.map(item => item.element),
    evidence,
  };
}
