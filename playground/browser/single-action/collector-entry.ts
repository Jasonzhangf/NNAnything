import type { BasicKindProfile } from "../../../lib/filters/basic-kinds.js";
import type { StableNodeRefRegistry } from "../../../lib/adapters/browser/live-dom.js";
import { observeBrowserSingleAction } from "../../../lib/adapters/browser/single-action-observation.js";

export interface CollectSingleActionInput {
  readonly scopeSelector: string;
  readonly regionSelectors: readonly string[];
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly l1Profile: BasicKindProfile;
  readonly registryPrefix?: string;
}

// The read-only CUA tool realm exposes Map/Set but not WeakMap/WeakRef. The
// registry is finite for one read-only observation and never writes page state.
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

export function collectBrowserSingleAction(input: CollectSingleActionInput) {
  const scope = document.querySelector(input.scopeSelector);
  if (!(scope instanceof Element)) throw new TypeError(`Scope selector did not resolve: ${input.scopeSelector}`);
  const regions = input.regionSelectors.map(selector => {
    const region = document.querySelector(selector);
    if (!(region instanceof Element)) throw new TypeError(`Region selector did not resolve: ${selector}`);
    return region;
  });
  const registry = finiteNodeRegistry(document, input.registryPrefix ?? "single-action-element");
  return observeBrowserSingleAction({
    document,
    window,
    registry,
    scope,
    regions,
    documentRef: input.documentRef,
    observationId: input.observationId,
    revision: input.revision,
    l1Profile: input.l1Profile,
  });
}
