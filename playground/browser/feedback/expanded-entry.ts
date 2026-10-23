import { DEFAULT_BASIC_KIND_PROFILE } from "../../../lib/filters/basic-kinds.js";
import type { StableNodeRefRegistry } from "../../../lib/adapters/browser/live-dom.js";
import { observeBrowserSingleAction } from "../../../lib/adapters/browser/single-action-observation.js";

export interface ExpandedCollectInput {
  readonly scopeSelector: string;
  readonly goalSelector: string;
  readonly targetSelectors: readonly string[];
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
}

function finiteNodeRegistry(document: Document, prefix: string): StableNodeRefRegistry {
  const refByElement = new Map<Element, string>();
  const elementByRef = new Map<string, { deref(): Element | undefined }>();
  const elements = Array.from(document.querySelectorAll("*"));
  elements.forEach((element, index) => {
    const ref = `${prefix}-${index + 1}`;
    refByElement.set(element, ref);
    elementByRef.set(ref, {
      deref: () => (element.isConnected === false ? undefined : element),
    });
  });
  return {
    prefix,
    refByElement,
    elementByRef,
    nextSequence: { value: elements.length },
  } as unknown as StableNodeRefRegistry;
}

export function collectExpandedSnapshot(input: ExpandedCollectInput) {
  const scope = document.querySelector(input.scopeSelector);
  if (!(scope instanceof Element)) throw new TypeError(`Scope selector did not resolve: ${input.scopeSelector}`);
  const regions = [document.querySelector(input.goalSelector)];
  if (regions.some(region => !(region instanceof Element))) {
    throw new TypeError(`Goal selector did not resolve: ${input.goalSelector}`);
  }
  const all = Array.from(document.querySelectorAll("*"));
  const refOf = (selector: string): string => {
    const element = document.querySelector(selector);
    if (!(element instanceof Element)) throw new TypeError(`Selector did not resolve: ${selector}`);
    const index = all.indexOf(element);
    if (index < 0) throw new TypeError(`Selector is not observable: ${selector}`);
    return `single-action-element-${index + 1}`;
  };
  const registry = finiteNodeRegistry(document, "single-action-element");
  const snapshot = observeBrowserSingleAction({
    document,
    window,
    registry,
    scope: scope as Element,
    regions: regions as Element[],
    documentRef: input.documentRef,
    observationId: input.observationId,
    revision: input.revision,
    l1Profile: DEFAULT_BASIC_KIND_PROFILE,
  });
  return {
    snapshot,
    scopeRef: refOf(input.scopeSelector),
    goalRegionRef: refOf(input.goalSelector),
    targetRefs: Object.fromEntries(input.targetSelectors.map(selector => [selector, refOf(selector)])),
  };
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__bFeedbackCollect =
    (input: ExpandedCollectInput) => collectExpandedSnapshot(input);
}
