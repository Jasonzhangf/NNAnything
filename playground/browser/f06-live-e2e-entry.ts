// F06 real-browser adapter evidence. This entry is bundled by esbuild and run
// inside a controlled Chrome tab over CDP. It calls the real observeLiveDom
// adapter on the real DOM and returns only counts, state facts and per-item
// assertions, never page text or form values.
import { createStableNodeRefRegistry, observeLiveDom, stableNodeRefFor } from "../../lib/adapters/browser/live-dom.js";
import { observeBrowserSingleAction } from "../../lib/adapters/browser/single-action-observation.js";
import { DEFAULT_BASIC_KIND_PROFILE } from "../../lib/filters/basic-kinds.js";

interface Out { [key: string]: unknown }

export function run(): Out {
  const registry = createStableNodeRefRegistry("f06-live");
  const read = observeLiveDom({
    document, window, registry, excludeRoot: null,
    snapshotRef: "f06-live-read", documentRef: "f06-live",
    readContent: true,
  });
  const noRead = observeLiveDom({
    document, window, registry, excludeRoot: null,
    snapshotRef: "f06-live-noread", documentRef: "f06-live",
  });

  const nodeOf = (snapshot, selector: string) => {
    const element = document.querySelector(selector);
    return element ? snapshot.observation.nodes.find(n => n.nodeRef === stableNodeRefFor(registry, element)) ?? null : null;
  };
  const evidenceOf = (snapshot, selector: string) => {
    const element = document.querySelector(selector);
    return element ? snapshot.evidence.get(stableNodeRefFor(registry, element)) ?? null : null;
  };

  const forward = evidenceOf(read, "#labelled-forward");
  const option = nodeOf(read, "#opt-current");
  const ariaReadonly = evidenceOf(read, "#aria-readonly-only");
  const longLabel = evidenceOf(read, "#labelled-long");
  const tooLongLabel = evidenceOf(read, "#labelled-too-long");

  // F10 relation evidence runs through the real single-action observation path,
  // which is the only adapter that resolves an aria-controls relation.
  const readControls = (scopeSelector: string, triggerSelector: string, prefix: string) => {
    const scope = document.querySelector(scopeSelector);
    if (!scope) return null;
    const registry = createStableNodeRefRegistry(prefix);
    const snapshot = observeBrowserSingleAction({
      document, window, registry, scope, regions: [],
      documentRef: prefix, observationId: `${prefix}-observation`, revision: 0,
      l1Profile: DEFAULT_BASIC_KIND_PROFILE,
    });
    const triggerEl = document.querySelector(triggerSelector);
    const triggerRef = triggerEl ? stableNodeRefFor(registry, triggerEl) : null;
    const trigger = triggerRef === null ? null : snapshot.elements.find(entry => entry.ref === triggerRef) ?? null;
    const fact = triggerRef === null ? null : snapshot.evidence.find(entry => entry.source === "dom.aria-controls"
      && (entry.fact as { ref?: string } | null)?.ref === triggerRef)?.fact ?? null;
    const controls = trigger?.controls ?? null;
    return {
      controlsStatus: controls === null ? null : controls.status,
      controls,
      fact,
    };
  };
  const inside = readControls("#f10-scope", "#f10-trigger", "f10-live");
  const outside = readControls("#f10-outer-scope", "#f10-outside", "f10-outside");
  const triggerControlsEvidence = inside?.fact ?? null;

  return {
    schemaVersion: "browser-foundation-f06-live.v1",
    totalNodes: read.observation.nodes.length,
    // Forward aria-labelledby resolves only after the full traversal.
    forwardNameResolved: forward?.accessibleName ?? null,
    forwardCoverage: forward?.accessibleNameCoverage ?? null,
    forwardSource: forward?.accessibleNameSource ?? null,
    forwardUnresolved: forward?.labelledByUnresolved ?? null,
    // Native option.selected is the live choice, not the default attribute.
    optionSelected: option?.attributes.selected ?? null,
    optionSelectedDeclaration: (() => { const el = document.querySelector("#opt-current"); return el ? el.hasAttribute("selected") : null; })(),
    // aria-readonly alone never claims native readonly.
    ariaReadonlyState: ariaReadonly?.readonlyState ?? null,
    ariaReadonlyNative: (() => { const el = document.querySelector("#aria-readonly-only"); return el ? el.hasAttribute("readonly") : null; })(),
    // Long label reports truncated coverage instead of a summary-as-name.
    longLabelCoverage: longLabel?.accessibleNameCoverage ?? null,
    longLabelLength: longLabel?.accessibleName?.length ?? null,
    tooLongLabelCoverage: tooLongLabel?.accessibleNameCoverage ?? null,
    tooLongLabelLength: tooLongLabel?.accessibleName?.length ?? null,
    // Default capture path never reads input values.
    noReadInputValue: evidenceOf(noRead, "#secret")?.inputValue ?? null,
    readInputValuePresent: (evidenceOf(read, "#secret")?.inputValue?.length ?? 0) > 0,
    // F10: the relation target is a node ref, and the fact is observed, not guessed.
    controlsStatus: inside?.controlsStatus ?? null,
    controlsTargetCount: (triggerControlsEvidence as { targets?: unknown[] } | null)?.targets?.length ?? null,
    controlsRawValue: (triggerControlsEvidence as { value?: string | null } | null)?.value ?? null,
    controlsTargetOutsideScope: outside?.controlsStatus ?? null,
    controlsTargetOutsideScopeDetail: outside?.controls ?? null,
  };
}

if (typeof window !== "undefined" && (window as unknown as { __f06Run?: boolean }).__f06Run === undefined) {
  (window as unknown as { __f06Run?: boolean }).__f06Run = true;
  (window as unknown as { __f06Result?: unknown }).__f06Result = run();
}
