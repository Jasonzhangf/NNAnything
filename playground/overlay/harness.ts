import { DOMInspectorController } from "../../extension/controller.js";
import visualOverlayGraph from "../../workflows/browser-visual-overlay.graph.json";
import captureGraph from "../../workflows/browser-capture.graph.json";

let inspectorController: DOMInspectorController | null = null;
let siteClickCount = 0;
let dynamicItems: HTMLElement[] = [];
let savedFocusContainer: HTMLElement | null = null;

function initHarness(): void {
  // 1. Populate > 2500 synthetic DOM elements
  const massContainer = document.getElementById("mass-nodes-container");
  if (massContainer) {
    const fragment = document.createDocumentFragment();
    const tags = ["span", "button", "div", "a", "label"];

    for (let i = 0; i < 2600; i++) {
      const tag = tags[i % tags.length] || "span";
      const el = document.createElement(tag);
      el.className = "synthetic-item";
      el.textContent = `N-${i}`;
      if (tag === "a") {
        el.setAttribute("href", `#item-${i}`);
      }
      fragment.appendChild(el);
    }
    massContainer.appendChild(fragment);
  }

  // Update total DOM nodes badge
  const totalBadge = document.getElementById("total-nodes-badge");
  if (totalBadge) {
    totalBadge.textContent = String(document.querySelectorAll("*").length);
  }

  // 2. Normal site button click counter
  const siteBtn = document.getElementById("btn-site-click");
  const siteCountLabel = document.getElementById("site-click-count");
  if (siteBtn && siteCountLabel) {
    siteBtn.addEventListener("click", () => {
      siteClickCount += 1;
      siteCountLabel.textContent = String(siteClickCount);
    });
  }

  // 3. Focus dynamic remove / restore
  const removeFocusBtn = document.getElementById("btn-remove-focus-target");
  const restoreFocusBtn = document.getElementById("btn-restore-focus-target");
  const focusMount = document.getElementById("focus-mount-point");
  const focusTarget = document.getElementById("target-focus-container");

  if (focusTarget) {
    savedFocusContainer = focusTarget;
  }

  if (removeFocusBtn && focusMount) {
    removeFocusBtn.addEventListener("click", () => {
      const current = document.getElementById("target-focus-container");
      if (current && current.parentNode) {
        current.parentNode.removeChild(current);
      }
    });
  }

  if (restoreFocusBtn && focusMount) {
    restoreFocusBtn.addEventListener("click", () => {
      if (!document.getElementById("target-focus-container") && savedFocusContainer) {
        focusMount.appendChild(savedFocusContainer);
      }
    });
  }

  // 4. Dynamic DOM nodes add / remove
  const addDynamicBtn = document.getElementById("btn-add-dynamic");
  const removeDynamicBtn = document.getElementById("btn-remove-dynamic");
  const dynamicContainer = document.getElementById("dynamic-container");
  const dynamicCountLabel = document.getElementById("dynamic-count-label");

  if (addDynamicBtn && dynamicContainer && dynamicCountLabel) {
    addDynamicBtn.addEventListener("click", () => {
      for (let i = 0; i < 50; i++) {
        const item = document.createElement("button");
        item.className = "harness-btn";
        item.textContent = `动态按钮 ${dynamicItems.length + 1}`;
        dynamicContainer.appendChild(item);
        dynamicItems.push(item);
      }
      dynamicCountLabel.textContent = `当前动态添加数: ${dynamicItems.length}`;
      if (totalBadge) {
        totalBadge.textContent = String(document.querySelectorAll("*").length);
      }
    });
  }

  if (removeDynamicBtn && dynamicContainer && dynamicCountLabel) {
    removeDynamicBtn.addEventListener("click", () => {
      for (const item of dynamicItems) {
        if (item.parentNode) item.parentNode.removeChild(item);
      }
      dynamicItems = [];
      dynamicCountLabel.textContent = `当前动态添加数: 0`;
      if (totalBadge) {
        totalBadge.textContent = String(document.querySelectorAll("*").length);
      }
    });
  }

  // 5. Inspector Controller launch / close
  const toggleBtn = document.getElementById("btn-toggle-inspector");
  const closeBtn = document.getElementById("btn-close-inspector");

  const getOrCreateController = () => {
    if (!inspectorController) {
      inspectorController = new DOMInspectorController({
        visualOverlayGraph,
        captureGraph,
        document,
        window,
      });
    }
    return inspectorController;
  };

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const c = getOrCreateController();
      c.toggle();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      if (inspectorController && inspectorController.isMounted()) {
        inspectorController.destroy();
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initHarness);
} else {
  initHarness();
}
