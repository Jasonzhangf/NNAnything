import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
  type StableNodeRefRegistry,
} from "../../../lib/adapters/browser/live-dom.js";
import { observeBrowserSingleAction } from "../../../lib/adapters/browser/single-action-observation.js";
import { DEFAULT_BASIC_KIND_PROFILE } from "../../../lib/filters/basic-kinds.js";

export interface InputTargetConfig {
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly targetRef: string;
  readonly targetSelector: string;
  readonly host: string;
  readonly type: string;
  readonly sensitive: boolean;
  readonly editableUnprobed: boolean;
  readonly neighborRefs: readonly { readonly ref: string; readonly selector: string }[];
}

let registry: StableNodeRefRegistry | null = null;
// Identity anchor: the registry ref (stable per DOM object) observed on the
// first observation. A rebuilt/replaced bound element gets a NEW registry ref,
// so currentRef diverges from the logical binding and the node treats the
// post state as not-the-originally-bound object.
let boundRegistryRef: string | null = null;

function valueOf(element: Element, type: string): string | null {
  if (type === "password" || type === "file") return null;
  return (element as HTMLInputElement).value;
}

function observeOnce(config: InputTargetConfig, revision: number): unknown {
  if (!registry) registry = createStableNodeRefRegistry("b-input");
  const observationId = `${config.documentRef}:${revision}`;
  const snapshot = observeLiveDom({
    document,
    window,
    registry,
    excludeRoot: null,
    snapshotRef: observationId,
    documentRef: config.documentRef,
    readContent: true,
  });
  const targetElement = document.querySelector(config.targetSelector);
  if (!(targetElement instanceof Element)) throw new Error("bound target selector missing");
  const registryRef = stableNodeRefFor(registry, targetElement);
  if (boundRegistryRef === null) boundRegistryRef = registryRef;
  // The exposed logical binding ref is always the caller-provided targetRef.
  // currentRef reports the same logical value while the observed element is
  // still the originally bound DOM object, and the registry ref otherwise, so
  // identity-change detection (stale_binding / rebuilt post) keeps working.
  const targetRef = config.targetRef;
  const sameIdentity = registryRef === boundRegistryRef;
  const currentRefValue = sameIdentity ? config.targetRef : registryRef;
  const evidence = snapshot.evidence.get(registryRef);
  const node = snapshot.observation.nodes.find(item => item.nodeRef === registryRef);
  if (!evidence || !node) throw new Error("bound target evidence missing");

  const pageScope = document.body;
  if (!(pageScope instanceof Element)) throw new Error("document body is unavailable");
  const actionSnapshot = observeBrowserSingleAction({
    document,
    window,
    registry,
    scope: pageScope,
    regions: [],
    documentRef: config.documentRef,
    observationId,
    revision,
    l1Profile: DEFAULT_BASIC_KIND_PROFILE,
  });
  const actionTarget = actionSnapshot.elements.find(item => item.ref === registryRef);
  if (!actionTarget) throw new Error("bound target executable hit facts missing");
  const evidenceRefs = (fact: typeof actionTarget.hit | typeof actionTarget.point): readonly string[] =>
    fact.status === "observed" ? fact.evidenceRefs : [];
  const hitRefs = [...evidenceRefs(actionTarget.hit), ...evidenceRefs(actionTarget.point)];
  const hitEvidence = actionSnapshot.evidence
    .filter(item => hitRefs.includes(item.id))
    .map(item => ({ id: item.id, source: item.source, fact: item.fact }));

  const evidenceId = `${config.documentRef}:${config.targetRef}:${revision}`;
  const observed = <T,>(value: T, refs: readonly string[]) =>
    ({ status: "observed" as const, value, evidenceRefs: refs });
  const unknown = (reason: string) => ({ status: "unknown" as const, reason });

  const attributes = node.attributes;
  const host = config.host as "input" | "textarea" | "contenteditable" | "unknown";
  const type = config.type;
  const nativeDisabled = attributes.disabled === true;
  const ariaDisabled = attributes["aria-disabled"] === "true"
    ? true : attributes["aria-disabled"] === "false" ? false : null;
  const nativeReadonly = attributes.readonly === true;
  const ariaReadonly = attributes["aria-readonly"] === "true"
    ? true : attributes["aria-readonly"] === "false" ? false : null;
  const readonlyState = nativeReadonly
    ? ariaReadonly === false ? "conflict" : "readonly"
    : ariaReadonly === true ? "conflict" : "editable";
  const contentEditable = host === "contenteditable" || attributes.contenteditable === "true";
  const editableKnown = !config.editableUnprobed;
  const editableValue = editableKnown && !nativeDisabled && !nativeReadonly && readonlyState === "editable";
  const valueRead = config.sensitive || host === "contenteditable" ? null : valueOf(targetElement, type);

  const activeElement = (document as Document & { activeElement?: Element | null }).activeElement;
  const activeElementRef = activeElement instanceof Element ? registry.refByElement.get(activeElement) ?? null : null;
  const activeElementFocus = activeElementRef === null ? null : activeElementRef === registryRef;

  const target = {
    ref: targetRef,
    connected: observed(targetElement.isConnected, [evidenceId]),
    currentRef: observed(currentRefValue, [evidenceId]),
    host: observed(host, [evidenceId]),
    contentEditable: observed(contentEditable, [evidenceId]),
    type: observed(type, [evidenceId]),
    value: valueRead === null ? unknown("value_not_observed") : observed(valueRead, [evidenceId]),
    placeholder: evidence.placeholder === null ? observed(null, [evidenceId]) : observed(evidence.placeholder, [evidenceId]),
    nativeDisabled: observed(nativeDisabled, [evidenceId]),
    ariaDisabled: ariaDisabled === null ? observed(null, [evidenceId]) : observed(ariaDisabled, [evidenceId]),
    nativeReadonly: observed(nativeReadonly, [evidenceId]),
    ariaReadonly: ariaReadonly === null ? observed(null, [evidenceId]) : observed(ariaReadonly, [evidenceId]),
    readonlyState: observed(readonlyState, [evidenceId]),
    editable: editableKnown ? observed(editableValue, [evidenceId]) : unknown("editable_not_probed"),
    activeElementRef: activeElementRef === null ? observed(null, [evidenceId]) : observed(activeElementRef, [evidenceId]),
    activeElementFocus: activeElementFocus === null ? observed(null, [evidenceId]) : observed(activeElementFocus, [evidenceId]),
    executableHit: actionTarget.hit,
    point: actionTarget.point,
  };

  const neighbors = config.neighborRefs.map(item => {
    const element = document.querySelector(item.selector);
    if (!(element instanceof Element)) throw new Error(`bound neighbor selector missing: ${item.selector}`);
    const value = valueOf(element, (element as HTMLInputElement).type);
    return {
      ref: item.ref,
      value: value === null ? unknown("neighbor_value_not_observed") : observed(value, [evidenceId]),
    };
  });

  return {
    documentRef: config.documentRef,
    scopeRef: config.scopeRef,
    observationId,
    revision,
    target,
    neighbors,
    evidence: [
      {
        id: evidenceId,
        source: "browser.input.live-dom.v1",
        fact: { kind: "live-input-observation", documentRef: config.documentRef, targetRef },
      },
      ...hitEvidence,
    ],
  };
}

if (typeof window !== "undefined") {
  (window as unknown as { __bInputObserve?: (config: InputTargetConfig, revision: number) => unknown }).__bInputObserve =
    (config, revision) => observeOnce(config, revision);
}
