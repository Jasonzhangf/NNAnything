// F04 limited-domain real-browser matrix. The entry runs the real observeLiveDom
// adapter on the real DOM and classifies the resulting properties with the same
// frozen candidate the F04 matrix used. Inputs come from window.__f04Cases;
// the profile and config are injected as window.__f04Asset. It returns only
// labels, scores and statuses, never page text.
import { createStableNodeRefRegistry, observeLiveDom, stableNodeRefFor } from "../../lib/adapters/browser/live-dom.js";
import { classifyBasicKind } from "../../lib/filters/basic-kinds.js";

interface Case { readonly id: string; readonly selector: string; readonly expected: string; readonly split: string }
interface Asset { readonly config: unknown; readonly profile: unknown }

export function run() {
  const cases = (window as unknown as { __f04Cases: Case[] }).__f04Cases;
  const asset = (window as unknown as { __f04Asset: Asset }).__f04Asset;
  const registry = createStableNodeRefRegistry("f04-live");
  const snapshot = observeLiveDom({
    document, window, registry, excludeRoot: null,
    snapshotRef: "f04-live", documentRef: "f04-live",
  });
  const rows = cases.map(item => {
    const element = document.querySelector(item.selector);
    if (element === null) return { ...item, present: false, status: "missing_element", kind: null, score: null, margin: null };
    const ref = stableNodeRefFor(registry, element);
    const properties = snapshot.properties.get(ref);
    if (properties === undefined) return { ...item, present: true, status: "no_properties", kind: null, score: null, margin: null };
    const judgment = classifyBasicKind(properties, asset.config as never, asset.profile as never);
    return {
      ...item, present: true,
      status: judgment.judgmentStatus,
      kind: judgment.basicKind,
      score: judgment.score,
      margin: judgment.margin,
      family: judgment.family,
    };
  });
  return {
    schemaVersion: "browser-foundation-f04-live.v1",
    totalNodes: snapshot.observation.nodes.length,
    rows,
  };
}

if (typeof window !== "undefined") {
  (window as unknown as { __f04Result?: unknown }).__f04Result = run();
}
