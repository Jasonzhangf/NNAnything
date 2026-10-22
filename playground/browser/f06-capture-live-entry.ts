// F06/P1#1 end-to-end capture check in a real browser. The entry runs the whole
// public chain in page context: observeLiveDom, candidate chain, basic-kind
// batch, then the real BrowserCaptureSession export. It proves that a password
// value observed in the real DOM never reaches the exported bundle.
import { createStableNodeRefRegistry, observeLiveDom } from "../../lib/adapters/browser/live-dom.js";
import { checkCandidates, observeCandidates } from "../../lib/filters/candidate-chain.js";
import { classifyBasicKindBatch } from "../../lib/filters/basic-kinds.js";
import { createFocusSpec } from "../../lib/filters/focus.js";
import { BrowserCaptureSession } from "../../lib/adapters/browser/capture-bundle.js";

export function run() {
  const secret = (window as unknown as { __f06Secret: string }).__f06Secret;
  const registry = createStableNodeRefRegistry("f06-capture");
  const snapshot = observeLiveDom({
    document, window, registry, excludeRoot: null,
    snapshotRef: "f06-capture", documentRef: "f06-capture",
  });
  const focusSpec = createFocusSpec();
  const candidateBatch = checkCandidates(observeCandidates({ observation: snapshot.observation }), focusSpec);
  const basicKindBatch = classifyBasicKindBatch(
    { ...candidateBatch, itemObservations: snapshot.itemObservations },
    undefined, undefined,
  );
  const frame = { snapshot, focusSpec, profileId: "default", candidateBatch, basicKindBatch, boxes: [], presentation: null };
  const session = new BrowserCaptureSession({ sessionId: "f06-capture-session", createdAt: new Date().toISOString() });
  const qualified = basicKindBatch.slots.filter(slot => slot.candidateStatus === "ok");
  const target = qualified[0];
  if (target === undefined) return { collected: 0, reason: "no_qualified_candidate" };
  const receipt = session.captureSelected(frame, target.nodeRef, { kind: "unsure" });
  const bundle = session.toBundle();
  const sidecar = Object.values(bundle.evidenceSidecar);
  return {
    collected: 1,
    reviewStatus: receipt.reviewStatus,
    sidecarCount: sidecar.length,
    sidecarOwnsInputValue: sidecar.some(entry => Object.hasOwn(entry, "inputValue")),
    serializedContainsSecret: JSON.stringify(bundle).includes(secret),
    qualifiedCandidates: qualified.length,
    totalNodes: snapshot.observation.nodes.length,
  };
}

if (typeof window !== "undefined") {
  (window as unknown as { __f06CaptureResult?: unknown }).__f06CaptureResult = run();
}
