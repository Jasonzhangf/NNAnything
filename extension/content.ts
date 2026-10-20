import { DOMInspectorController } from "./controller.js";
import type { BrowserWeightAsset } from "nnanything/browser-classify";
import visualOverlayGraph from "../workflows/browser-visual-overlay.graph.json";
import captureGraph from "../workflows/browser-capture.graph.json";

declare const __NNANYTHING_BROWSER_WEIGHT_ASSET__: BrowserWeightAsset | undefined;

declare global {
  interface Window {
    __nnanything_inspector_singleton__?: DOMInspectorController;
  }
}

(function () {
  if (window.__nnanything_inspector_singleton__) {
    window.__nnanything_inspector_singleton__.toggle();
  } else {
    const initialWeight = __NNANYTHING_BROWSER_WEIGHT_ASSET__;
    const controller = new DOMInspectorController({
      visualOverlayGraph,
      captureGraph,
      document,
      window,
      ...(initialWeight ? { initialWeight } : {}),
    });
    window.__nnanything_inspector_singleton__ = controller;
    controller.mount();
  }
})();