// F04 retention consumer: one controlled page, the public chain
// observeLiveDom -> candidate chain -> classifyBasicKindBatch, with no
// presentation/overlay layer. It verifies that a default available result
// contains the target nodeRef, that the same ref can be re-observed, and that
// a descendant keeps an independent slot even when its parent is classified
// ignore. The weight/config are injected as window.__retentionAsset.
import { createStableNodeRefRegistry, observeLiveDom, stableNodeRefFor } from "../../lib/adapters/browser/live-dom.js";
import { checkCandidates, observeCandidates } from "../../lib/filters/candidate-chain.js";
import { createFocusSpec } from "../../lib/filters/focus.js";
import { classifyBasicKindBatch } from "../../lib/filters/basic-kinds.js";

interface RetentionCase { readonly id: string; readonly parentSelector: string; readonly descendantSelector: string }
interface Asset { readonly config: unknown; readonly profile: unknown }

export function run() {
  const cases = (window as unknown as { __retentionCases: RetentionCase[] }).__retentionCases;
  const asset = (window as unknown as { __retentionAsset: Asset }).__retentionAsset;
  const registry = createStableNodeRefRegistry("f04-retention");
  const snapshot1 = observeLiveDom({
    document, window, registry, excludeRoot: null,
    snapshotRef: "f04-retention-1", documentRef: "f04-retention",
  });
  const batch = checkCandidates(
    observeCandidates({ observation: snapshot1.observation }),
    createFocusSpec(),
  );
  const classified = classifyBasicKindBatch(
    { ...batch, itemObservations: snapshot1.itemObservations },
    asset.config as never,
    asset.profile as never,
  );
  const slotByRef = new Map(classified.slots.map(slot => [slot.nodeRef, slot]));
  const rows = cases.map(item => {
    const parent = document.querySelector(item.parentSelector);
    const descendant = document.querySelector(item.descendantSelector);
    if (!(parent instanceof Element) || !(descendant instanceof Element)) {
      return { ...item, present: false, reason: "missing_element" };
    }
    const parentRef = stableNodeRefFor(registry, parent);
    const descendantRef = stableNodeRefFor(registry, descendant);
    const parentSlot = slotByRef.get(parentRef) ?? null;
    const descendantSlot = slotByRef.get(descendantRef) ?? null;
    const reObserved = observeLiveDom({
      document, window, registry, excludeRoot: null,
      snapshotRef: "f04-retention-2", documentRef: "f04-retention",
    });
    const parentRef2 = stableNodeRefFor(registry, parent);
    const descendantRef2 = stableNodeRefFor(registry, descendant);
    const refStable = parentRef2 === parentRef && descendantRef2 === descendantRef;
    return {
      ...item,
      parentRef,
      descendantRef,
      parentCandidateStatus: parentSlot?.candidateStatus ?? null,
      parentKind: parentSlot?.basicKind ?? null,
      parentStatus: parentSlot?.judgmentStatus ?? null,
      descendantCandidateStatus: descendantSlot?.candidateStatus ?? null,
      descendantKind: descendantSlot?.basicKind ?? null,
      descendantStatus: descendantSlot?.judgmentStatus ?? null,
      descendantInDefaultAvailable: descendantSlot !== null && descendantSlot.candidateStatus === "ok",
      refStableAcrossReobservation: refStable,
      descendantPropertiesAgain: reObserved.properties.has(descendantRef2),
      parentIgnoreDescendantIndependent:
        parentSlot?.basicKind === "ignore" &&
        descendantSlot !== null &&
        descendantSlot.candidateStatus === "ok",
    };
  });
  return {
    schemaVersion: "browser-foundation-f04-retention.v1",
    presentationLayerUsed: false,
    publicChain: ["observeLiveDom", "observeCandidates", "checkCandidates", "classifyBasicKindBatch"],
    rows,
  };
}

if (typeof window !== "undefined") {
  (window as unknown as { __f04RetentionResult?: unknown }).__f04RetentionResult = run();
}
