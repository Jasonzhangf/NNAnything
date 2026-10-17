import { DOMInspectorController } from "./controller.js";
import visualOverlayGraph from "../workflows/browser-visual-overlay.graph.json";
import captureGraph from "../workflows/browser-capture.graph.json";

declare global {
  interface Window {
    __nnanything_inspector_singleton__?: DOMInspectorController;
  }
}

(function () {
  if (window.__nnanything_inspector_singleton__) {
    window.__nnanything_inspector_singleton__.toggle();
  } else {
    const controller = new DOMInspectorController({
      visualOverlayGraph,
      captureGraph,
      document,
      window,
    });
    window.__nnanything_inspector_singleton__ = controller;
    controller.mount();
  }
})();
