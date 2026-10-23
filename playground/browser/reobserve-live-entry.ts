// Read-only re-observation entry. Runs the real observeLiveDom adapter on the
// current top document of an already open page and returns, for every observed
// node, the full current measurement set plus the geometric facts needed to pair
// rows across snapshots. Page text, class, id and full URL stay in the page.
import { createStableNodeRefRegistry, observeLiveDom } from "../../lib/adapters/browser/live-dom.js";

export function run() {
  const registry = createStableNodeRefRegistry("reobserve");
  const snapshot = observeLiveDom({
    document, window, registry, excludeRoot: null,
    snapshotRef: "reobserve", documentRef: "reobserve",
  });
  const rows = snapshot.observation.nodes.map(node => {
    const properties = snapshot.properties.get(node.nodeRef);
    return {
      nodeRef: node.nodeRef,
      tag: node.tag,
      role: node.role,
      parentRef: node.parentRef,
      rect: node.rect,
      clippedRect: node.clippedRect,
      measurements: properties === undefined ? null : { ...properties },
    };
  });
  return {
    schemaVersion: "browser-foundation-reobserve.v1",
    origin: document.location.origin,
    path: document.location.pathname,
    viewport: snapshot.observation.viewport,
    coverage: snapshot.observation.coverage,
    capturedAt: new Date().toISOString(),
    rows,
  };
}

if (typeof window !== "undefined") {
  (window as unknown as { __reobserveResult?: unknown }).__reobserveResult = run();
}
