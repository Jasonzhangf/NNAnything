import {
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  createStableNodeRefRegistry,
  stableNodeRefFor,
  resolveStableNodeRef,
  parseBrowserWeightAsset,
  BrowserCaptureSession,
  createBrowserOverlayNodeDefinitions,
  createBrowserCaptureNodeDefinitions,
  compileWorkflow,
  createWorkflowInputEvent,
  runWorkflow,
  BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
  BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
  type BasicKindConfig,
  type BasicKindProfile,
  type BasicKindLabel,
  type BasicKindSlot,
  type StableNodeRefRegistry,
  type BrowserOverlayFrame,
  type OverlayBox,
  type OverlayCounts,
  type LiveCaptureCoverage,
  type BrowserCaptureAnnotation,
  type BrowserCaptureBundleV1,
  DEFAULT_EXCLUDED_TOOL_ROOT_IDS,
} from "nnanything/browser-classify";

export interface DOMInspectorOptions {
  visualOverlayGraph: unknown;
  captureGraph: unknown;
  document?: Document;
  window?: Window;
}

export const CATEGORY_COLORS: Record<string, { border: string; bg: string; text: string; zh: string }> = {
  button: { border: "#2563eb", bg: "rgba(37, 99, 235, 0.12)", text: "#1d4ed8", zh: "按钮" },
  link: { border: "#7c3aed", bg: "rgba(124, 58, 237, 0.12)", text: "#6d28d9", zh: "链接" },
  input: { border: "#059669", bg: "rgba(5, 150, 105, 0.12)", text: "#047857", zh: "输入框" },
  select: { border: "#0891b2", bg: "rgba(8, 145, 178, 0.12)", text: "#0e7490", zh: "选择框" },
  text: { border: "#334155", bg: "rgba(51, 65, 85, 0.10)", text: "#1e293b", zh: "文本" },
  container: { border: "#d97706", bg: "rgba(217, 119, 6, 0.10)", text: "#b45309", zh: "容器" },
  list: { border: "#b45309", bg: "rgba(180, 83, 9, 0.10)", text: "#92400e", zh: "列表" },
  listitem: { border: "#ca8a04", bg: "rgba(202, 138, 4, 0.10)", text: "#a16207", zh: "列表项" },
  image: { border: "#ec4899", bg: "rgba(236, 72, 153, 0.12)", text: "#db2777", zh: "图片" },
  video: { border: "#db2777", bg: "rgba(219, 39, 119, 0.12)", text: "#be185d", zh: "视频" },
  audio: { border: "#e11d48", bg: "rgba(225, 29, 72, 0.12)", text: "#be123c", zh: "音频" },
  other: { border: "#64748b", bg: "rgba(100, 116, 139, 0.10)", text: "#475569", zh: "其他" },
};

export const STATUS_COLORS = {
  unknown: { border: "#94a3b8", bg: "rgba(148, 163, 184, 0.15)", text: "#475569", zh: "未知" },
  conflict: { border: "#ea580c", bg: "rgba(234, 88, 12, 0.15)", text: "#c2410c", zh: "冲突" },
  focus: { border: "#7c3aed", bg: "rgba(124, 58, 237, 0.20)", text: "#6d28d9", zh: "Focus焦点" },
};

function generateUUID(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join("-");
}

export class DOMInspectorController {
  private doc: Document;
  private win: Window;
  private overlayGraph: any;
  private captureGraph: any;

  private hostElement: HTMLElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private canvasContainer: HTMLElement | null = null;
  private panelContainer: HTMLElement | null = null;
  private pickingHighlight: HTMLElement | null = null;

  private registry: StableNodeRefRegistry;
  private captureSession: BrowserCaptureSession;
  private documentRef: string;
  private snapshotCounter: number = 0;
  private sequence: number = 0;

  private currentProfile: BasicKindProfile;
  private currentConfig: BasicKindConfig;
  private profileSourceLabel: string = "手写基础权重";

  private currentFrame: BrowserOverlayFrame | null = null;
  // Presentation may remain visible while its measurements are invalidated.
  private presentedFrame: BrowserOverlayFrame | null = null;
  private refreshRevision = 0;
  private focusNodeRef: string | null = null;
  private isFocusStale: boolean = false;
  private selectedNodeRef: string | null = null;

  private showAllLabels: boolean = false;
  private categoryFilters: Set<string> = new Set(Object.keys(CATEGORY_COLORS).concat(["unknown", "conflict"]));

  private isPickingMode: "inspect" | "focus" | null = null;
  private rafId: number | null = null;
  private isRefreshing: boolean = false;
  private refreshPending: boolean = false;
  private mountGeneration = 0;
  private pipelineError: string | null = null;
  private originalCursor = "";

  private mutationObserver: MutationObserver | null = null;
  private boundOnScroll: () => void;
  private boundOnResize: () => void;
  private boundOnPickClick: (e: MouseEvent) => void;
  private boundOnPickMouseMove: (e: MouseEvent) => void;
  private boundOnPickKeyDown: (e: KeyboardEvent) => void;

  private exportNotice: string | null = null;
  private userReviewSelection: "correct" | "wrong" | "unsure" = "correct";
  private userCorrectedLabel: BasicKindLabel | "" = "";
  private userOtherReason: string = "";
  private userReviewFeedback: string | null = null;

  constructor(options: DOMInspectorOptions) {
    this.doc = options.document ?? document;
    this.win = options.window ?? window;
    this.overlayGraph = options.visualOverlayGraph;
    this.captureGraph = options.captureGraph;

    this.registry = createStableNodeRefRegistry("nnanything-inspector");
    this.documentRef = "doc-" + generateUUID();
    this.captureSession = new BrowserCaptureSession({
      sessionId: "session-" + generateUUID(),
      createdAt: new Date().toISOString(),
    });

    this.currentProfile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
    this.currentConfig = structuredClone(DEFAULT_BASIC_KIND_CONFIG);

    this.boundOnScroll = () => this.scheduleRefresh();
    this.boundOnResize = () => this.scheduleRefresh();
    this.boundOnPickClick = (e: MouseEvent) => this.handlePickClick(e);
    this.boundOnPickMouseMove = (e: MouseEvent) => this.handlePickMouseMove(e);
    this.boundOnPickKeyDown = (e: KeyboardEvent) => this.handlePickKeyDown(e);
  }

  public isMounted(): boolean {
    return this.hostElement !== null && this.hostElement.isConnected;
  }

  public mount(): void {
    if (this.isMounted()) return;
    this.mountGeneration++;

    this.hostElement = this.doc.createElement("div");
    this.hostElement.id = "nnanything-dom-inspector-host";
    this.hostElement.style.cssText = "all: initial; position: static; z-index: 2147483640;";

    this.shadowRoot = this.hostElement.attachShadow({ mode: "open" });
    this.setupShadowDom();

    this.doc.documentElement.appendChild(this.hostElement);

    this.mutationObserver = new MutationObserver((mutations) => {
      const hasExternalMutation = mutations.some(
        (m) => this.hostElement && !this.hostElement.contains(m.target)
      );
      if (hasExternalMutation) {
        this.scheduleRefresh();
      }
    });

    this.mutationObserver.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    this.win.addEventListener("scroll", this.boundOnScroll, { capture: true, passive: true });
    this.win.addEventListener("resize", this.boundOnResize, { passive: true });

    this.scheduleRefresh();
  }

  public toggle(): void {
    if (this.isMounted()) {
      this.destroy();
    } else {
      this.mount();
    }
  }

  public destroy(): void {
    this.mountGeneration++;
    this.refreshPending = false;
    if (this.rafId !== null) {
      this.win.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.isPickingMode) {
      this.stopPickingMode();
    }

    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    this.win.removeEventListener("scroll", this.boundOnScroll, { capture: true });
    this.win.removeEventListener("resize", this.boundOnResize);

    if (this.hostElement && this.hostElement.parentNode) {
      this.hostElement.parentNode.removeChild(this.hostElement);
    }

    this.hostElement = null;
    this.shadowRoot = null;
    this.canvasContainer = null;
    this.panelContainer = null;
    this.currentFrame = null;
    this.presentedFrame = null;
  }

  public scheduleRefresh(): void {
    if (!this.isMounted()) return;
    this.refreshRevision++;
    this.currentFrame = null;
    if (this.presentedFrame && (this.presentedFrame.focusSpec.within ?? null) !== this.focusNodeRef) {
      this.presentedFrame = null;
      this.renderOverlayBoxes([]);
    }
    if (this.isRefreshing) {
      this.refreshPending = true;
      return;
    }
    if (this.rafId !== null) return;
    this.renderPanel();
    this.rafId = this.win.requestAnimationFrame(async () => {
      this.rafId = null;
      if (this.isRefreshing) {
        this.refreshPending = true;
        return;
      }
      await this.runOverlayPipeline();
      if (this.refreshPending) {
        this.refreshPending = false;
        this.scheduleRefresh();
      }
    });
  }

  private async runOverlayPipeline(): Promise<void> {
    if (!this.isMounted()) return;
    const generation = this.mountGeneration;
    const revision = this.refreshRevision;
    this.isRefreshing = true;
    this.pipelineError = null;

    try {
      this.snapshotCounter += 1;
      const snapshotRef = `snapshot-${this.snapshotCounter}`;

      if (this.focusNodeRef) {
        const focusEl = resolveStableNodeRef(this.registry, this.focusNodeRef);
        if (!focusEl || !focusEl.isConnected) {
          this.isFocusStale = true;
        } else {
          this.isFocusStale = false;
        }
      } else {
        this.isFocusStale = false;
      }

      if (this.isFocusStale) {
        this.presentedFrame = null;
        this.renderOverlayBoxes([]);
        this.renderPanel();
        return;
      }

      const overlayDefs = createBrowserOverlayNodeDefinitions({
        document: this.doc,
        window: this.win,
        registry: this.registry,
        excludeHost: this.hostElement,
        present: () => undefined,
      });

      const compiledOverlay = compileWorkflow(
        {
          graph: this.overlayGraph,
          bindings: {
            "筛选当前视口与关注候选": {
              config: {
                viewportOnly: true,
                scopeMode: "subtree",
                ...(this.focusNodeRef ? { within: this.focusNodeRef } : {}),
              },
            },
            "判断DOM基础种类": {
              config: { ...this.currentConfig },
              profileId: "current",
            },
          },
        },
        {
          nodeDefinitions: overlayDefs,
          profiles: { current: this.currentProfile },
          grantedEffects: ["browser.dom.read", "browser.overlay.present"],
        }
      );

      this.sequence += 1;
      const runId = `overlay-run-${Date.now()}-${this.sequence}`;
      const inputEvent = createWorkflowInputEvent({
        runId,
        eventId: `${runId}:input`,
        port: "overlay_request",
        type: BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
        correlation: {},
        payload: {
          snapshotRef,
          documentRef: this.documentRef,
        },
      });

      const execution = await runWorkflow(compiledOverlay, inputEvent);
      if (!this.isMounted() || generation !== this.mountGeneration || revision !== this.refreshRevision) return;
      if (execution.status === "completed" && execution.outputEvent.status === "ok") {
        this.currentFrame = execution.outputEvent.payload as BrowserOverlayFrame;
        this.presentedFrame = this.currentFrame;
        this.renderOverlayBoxes(this.currentFrame ? this.currentFrame.boxes : []);
        this.renderPanel();
      } else {
        throw new Error(execution.status === "failed" ? execution.error.message : `分类结果不可用：${(execution.outputEvent.payload as { reason: string }).reason}`);
      }
    } catch (err) {
      if (!this.isMounted() || generation !== this.mountGeneration || revision !== this.refreshRevision) return;
      console.error("[NNAnything DOM Inspector] Overlay execution error:", err);
      this.currentFrame = null;
      this.presentedFrame = null;
      this.pipelineError = err instanceof Error ? err.message : String(err);
      this.renderOverlayBoxes([]);
      this.renderPanel();
    } finally {
      this.isRefreshing = false;
    }
  }

  private setupShadowDom(): void {
    if (!this.shadowRoot) return;

    const style = this.doc.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 12px;
        color: #0f172a;
        line-height: 1.4;
      }
      * {
        box-sizing: border-box;
      }
      .overlay-canvas {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 2147483641;
        overflow: hidden;
      }
      .box {
        position: absolute;
        pointer-events: none;
        box-sizing: border-box;
      }
      .box-label {
        position: absolute;
        top: -18px;
        left: -1px;
        padding: 1px 4px;
        font-size: 10px;
        font-weight: 500;
        border-radius: 2px 2px 0 0;
        white-space: nowrap;
        pointer-events: auto;
        cursor: pointer;
        user-select: none;
      }
      .box-focus-indicator {
        position: absolute;
        border: 3px double #7c3aed;
        box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.25);
        pointer-events: none;
        z-index: 2147483642;
      }
      .box-focus-badge {
        position: absolute;
        top: -20px;
        left: -2px;
        background: #7c3aed;
        color: #ffffff;
        padding: 1px 6px;
        font-size: 10px;
        font-weight: 700;
        border-radius: 2px;
        letter-spacing: 0.5px;
      }
      .picking-highlight {
        position: absolute;
        border: 2px solid #2563eb;
        background: rgba(37, 99, 235, 0.15);
        pointer-events: none;
        z-index: 2147483643;
        display: none;
      }
      .inspector-panel {
        position: fixed;
        top: 16px;
        right: 16px;
        width: 320px;
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 32px);
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        box-shadow: 0 4px 16px -2px rgba(15, 23, 42, 0.12), 0 2px 6px -1px rgba(15, 23, 42, 0.08);
        z-index: 2147483645;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: #f8fafc;
        border-bottom: 1px solid #e2e8f0;
      }
      .panel-title {
        font-size: 13px;
        font-weight: 600;
        color: #0f172a;
      }
      .profile-tag {
        font-size: 10px;
        color: #475569;
        background: #e2e8f0;
        padding: 2px 6px;
        border-radius: 4px;
        margin-left: 6px;
      }
      .close-btn {
        background: none;
        border: none;
        font-size: 16px;
        color: #64748b;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      .close-btn:hover {
        color: #0f172a;
      }
      .panel-body {
        padding: 10px 12px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .btn-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .btn {
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 4px;
        border: 1px solid #cbd5e1;
        background: #ffffff;
        color: #334155;
        cursor: pointer;
        font-weight: 500;
        transition: background-color 0.1s, border-color 0.1s;
      }
      .btn:hover {
        background: #f1f5f9;
        border-color: #94a3b8;
      }
      .btn-primary {
        background: #2563eb;
        color: #ffffff;
        border-color: #1d4ed8;
      }
      .btn-primary:hover {
        background: #1d4ed8;
      }
      .btn-active {
        background: #eff6ff;
        color: #1d4ed8;
        border-color: #3b82f6;
      }
      .btn-danger {
        background: #ef4444;
        color: #ffffff;
        border-color: #dc2626;
      }
      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 4px;
        background: #f8fafc;
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid #e2e8f0;
      }
      .metric-cell {
        display: flex;
        flex-direction: column;
      }
      .metric-label {
        font-size: 10px;
        color: #64748b;
      }
      .metric-val {
        font-size: 12px;
        font-weight: 600;
        color: #1e293b;
      }
      .notice-banner {
        padding: 6px 8px;
        font-size: 11px;
        border-radius: 4px;
        border: 1px solid transparent;
      }
      .notice-info {
        background: #f1f5f9;
        color: #475569;
        border-color: #e2e8f0;
      }
      .notice-warning {
        background: #fffbeb;
        color: #b45309;
        border-color: #fde68a;
      }
      .notice-success {
        background: #f0fdf4;
        color: #15803d;
        border-color: #bbf7d0;
      }
      .legend-container {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .legend-items {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 4px;
        max-height: 110px;
        overflow-y: auto;
        padding-right: 2px;
      }
      .legend-item {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        cursor: pointer;
      }
      .color-dot {
        width: 10px;
        height: 10px;
        border-radius: 2px;
        flex-shrink: 0;
      }
      .section-title {
        font-size: 11px;
        font-weight: 600;
        color: #475569;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .details-block {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        padding: 8px;
      }
      .details-row {
        margin-bottom: 4px;
        font-size: 11px;
      }
      .details-label {
        color: #64748b;
        margin-right: 4px;
      }
      .details-raw {
        margin-top: 6px;
        font-size: 10px;
      }
      .details-raw summary {
        cursor: pointer;
        color: #2563eb;
      }
      .details-raw pre {
        background: #ffffff;
        padding: 4px;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        overflow-x: auto;
        max-height: 120px;
      }
      .form-radio-group {
        display: flex;
        gap: 8px;
        margin: 6px 0;
      }
      .form-select, .form-input {
        width: 100%;
        padding: 4px 6px;
        font-size: 11px;
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        margin-top: 4px;
      }
      .file-input {
        font-size: 11px;
        margin-top: 4px;
      }
    `;

    this.shadowRoot.appendChild(style);

    this.canvasContainer = this.doc.createElement("div");
    this.canvasContainer.className = "overlay-canvas";
    this.shadowRoot.appendChild(this.canvasContainer);

    this.pickingHighlight = this.doc.createElement("div");
    this.pickingHighlight.className = "picking-highlight";
    this.canvasContainer.appendChild(this.pickingHighlight);

    this.panelContainer = this.doc.createElement("div");
    this.panelContainer.className = "inspector-panel";
    this.shadowRoot.appendChild(this.panelContainer);

    this.renderPanel();
  }

  private renderOverlayBoxes(boxes: readonly OverlayBox[]): void {
    if (!this.canvasContainer) return;

    const existingBoxes = this.canvasContainer.querySelectorAll(".box, .box-focus-indicator");
    existingBoxes.forEach((el) => el.remove());

    if (this.isFocusStale) return;

    if (this.focusNodeRef) {
      const focusEl = resolveStableNodeRef(this.registry, this.focusNodeRef);
      if (focusEl && focusEl.isConnected) {
        const rect = focusEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const focusInd = this.doc.createElement("div");
          focusInd.className = "box-focus-indicator";
          focusInd.style.left = `${rect.left}px`;
          focusInd.style.top = `${rect.top}px`;
          focusInd.style.width = `${rect.width}px`;
          focusInd.style.height = `${rect.height}px`;

          const badge = this.doc.createElement("div");
          badge.className = "box-focus-badge";
          badge.textContent = `FOCUS: <${focusEl.tagName.toLowerCase()}>`;
          focusInd.appendChild(badge);

          this.canvasContainer.appendChild(focusInd);
        }
      }
    }

    for (const box of boxes) {
      const kind = box.basicKind ?? "other";
      const status = box.judgmentStatus;

      if (!this.categoryFilters.has(status === "judged" ? kind : status)) continue;

      const boxEl = this.doc.createElement("div");
      boxEl.className = "box";
      boxEl.style.left = `${box.rect.x}px`;
      boxEl.style.top = `${box.rect.y}px`;
      boxEl.style.width = `${box.rect.width}px`;
      boxEl.style.height = `${box.rect.height}px`;

      let borderColor = CATEGORY_COLORS[kind]?.border ?? "#64748b";
      let borderStyle = "solid";
      let borderWidth = "1.5px";

      if (status === "unknown") {
        borderColor = STATUS_COLORS.unknown.border;
        borderStyle = "dashed";
      } else if (status === "conflict") {
        borderColor = STATUS_COLORS.conflict.border;
        borderStyle = "dashed";
      }

      if (box.nodeRef === this.selectedNodeRef) {
        borderWidth = "2.5px";
        boxEl.style.boxShadow = `0 0 0 2px rgba(37, 99, 235, 0.4)`;
      }

      boxEl.style.border = `${borderWidth} ${borderStyle} ${borderColor}`;

      const shouldShowLabel = this.showAllLabels || (box.nodeRef === this.selectedNodeRef);
      if (shouldShowLabel) {
        const labelEl = this.doc.createElement("div");
        labelEl.className = "box-label";
        const kindZh = CATEGORY_COLORS[kind]?.zh ?? kind;
        const statusText = status === "unknown" ? " (未知)" : status === "conflict" ? " (冲突)" : "";
        const scoreText = box.score !== null ? ` ${box.score.toFixed(2)}` : "";
        labelEl.textContent = `${kindZh}${statusText}${scoreText}`;
        labelEl.style.background = borderColor;
        labelEl.style.color = "#ffffff";

        labelEl.addEventListener("click", (e) => {
          e.stopPropagation();
          this.selectNode(box.nodeRef);
        });

        boxEl.appendChild(labelEl);
      }

      this.canvasContainer.appendChild(boxEl);
    }
  }

  private renderPanel(): void {
    if (!this.panelContainer) return;
    this.panelContainer.innerHTML = "";

    const header = this.doc.createElement("div");
    header.className = "panel-header";

    const titleGroup = this.doc.createElement("div");
    titleGroup.style.display = "flex";
    titleGroup.style.alignItems = "center";

    const title = this.doc.createElement("span");
    title.className = "panel-title";
    title.textContent = "NNAnything 审查器";

    const profileTag = this.doc.createElement("span");
    profileTag.className = "profile-tag";
    profileTag.textContent = this.profileSourceLabel;

    titleGroup.appendChild(title);
    titleGroup.appendChild(profileTag);

    const closeBtn = this.doc.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭审查器";
    closeBtn.onclick = () => this.destroy();

    header.appendChild(titleGroup);
    header.appendChild(closeBtn);
    this.panelContainer.appendChild(header);

    const body = this.doc.createElement("div");
    body.className = "panel-body";

    // 1. Action Toolbar
    const toolbar = this.doc.createElement("div");
    toolbar.className = "btn-row";

    const inspectBtn = this.doc.createElement("button");
    inspectBtn.className = `btn ${this.isPickingMode === "inspect" ? "btn-active" : ""}`;
    inspectBtn.textContent = this.isPickingMode === "inspect" ? "按ESC取消点选" : "检查元素";
    inspectBtn.onclick = () => {
      if (this.isPickingMode === "inspect") {
        this.stopPickingMode();
      } else {
        this.startPickingMode("inspect");
      }
    };

    const focusBtn = this.doc.createElement("button");
    focusBtn.className = `btn ${this.isPickingMode === "focus" ? "btn-active" : ""}`;
    focusBtn.textContent = this.isPickingMode === "focus" ? "按ESC取消选择" : "选择Focus";
    focusBtn.onclick = () => {
      if (this.isPickingMode === "focus") {
        this.stopPickingMode();
      } else {
        this.startPickingMode("focus");
      }
    };

    const clearFocusBtn = this.doc.createElement("button");
    clearFocusBtn.className = "btn";
    clearFocusBtn.textContent = "清除Focus";
    clearFocusBtn.disabled = !this.focusNodeRef;
    clearFocusBtn.onclick = () => {
      this.focusNodeRef = null;
      this.isFocusStale = false;
      this.scheduleRefresh();
    };

    const refreshBtn = this.doc.createElement("button");
    refreshBtn.className = "btn";
    refreshBtn.textContent = "刷新";
    refreshBtn.onclick = () => this.scheduleRefresh();

    toolbar.appendChild(inspectBtn);
    toolbar.appendChild(focusBtn);
    toolbar.appendChild(clearFocusBtn);
    toolbar.appendChild(refreshBtn);
    body.appendChild(toolbar);

    // 2. Focus Status Banner
    if (this.isFocusStale) {
      const staleBanner = this.doc.createElement("div");
      staleBanner.className = "notice-banner notice-warning";
      staleBanner.textContent = "⚠️ Focus 失效：目标元素已脱离 DOM。保持该选择，边框已清空。请点击「清除Focus」重置。";
      body.appendChild(staleBanner);
    } else if (this.focusNodeRef) {
      const focusEl = resolveStableNodeRef(this.registry, this.focusNodeRef);
      const tag = focusEl ? focusEl.tagName.toLowerCase() : "unknown";
      const focusBanner = this.doc.createElement("div");
      focusBanner.className = "notice-banner notice-info";
      focusBanner.textContent = `Focus 范围: <${tag}> (子树限定)`;
      body.appendChild(focusBanner);
    }

    if (this.pipelineError) {
      const error = this.doc.createElement("div");
      error.className = "notice-banner notice-warning";
      error.textContent = `分类失败，已清空旧结果：${this.pipelineError}。请点击刷新重试。`;
      body.appendChild(error);
    } else if (!this.isFocusStale) {
      const loading = this.doc.createElement("div");
      loading.className = "notice-banner notice-info";
      loading.style.minHeight = "32px";
      loading.textContent = this.currentFrame ? "页面分类已更新。" : "正在更新，暂不可采集。";
      body.appendChild(loading);
    }

    // 3. Metrics Summary
    const counts: OverlayCounts = this.presentedFrame?.presentation.view.counts ?? {
      totalNodes: 0,
      candidates: 0,
      judged: 0,
      unknown: 0,
      conflict: 0,
      excluded: 0,
      candidateUnknown: 0,
    };
    const coverage: LiveCaptureCoverage | undefined = this.presentedFrame?.presentation.view.coverage;

    const metricsGrid = this.doc.createElement("div");
    metricsGrid.className = "metrics-grid";

    const addMetric = (label: string, val: string | number) => {
      const cell = this.doc.createElement("div");
      cell.className = "metric-cell";
      const l = this.doc.createElement("span");
      l.className = "metric-label";
      l.textContent = label;
      const v = this.doc.createElement("span");
      v.className = "metric-val";
      v.textContent = String(val);
      cell.appendChild(l);
      cell.appendChild(v);
      metricsGrid.appendChild(cell);
    };

    addMetric("DOM 总数", counts.totalNodes);
    addMetric("视口候选", counts.candidates);
    addMetric("已判断", counts.judged);
    addMetric("未知", counts.unknown);
    addMetric("冲突", counts.conflict);
    addMetric("已排除", counts.excluded);

    body.appendChild(metricsGrid);

    // Unassessed & Score Notice
    const noticeBlock = this.doc.createElement("div");
    noticeBlock.className = "notice-banner notice-info";
    const iframeCount = coverage?.unassessedIframeCount ?? 0;
    const shadowCount = coverage?.unassessedOpenShadowRootCount ?? 0;
    noticeBlock.innerHTML = `
      <div><strong>覆盖范围:</strong> 顶层文档 (${coverage?.traversedElementCount ?? 0} 个元素)</div>
      <div><strong>未评估:</strong> ${iframeCount} 个 iframe, ${shadowCount} 个 shadow 内部</div>
      <div style="margin-top: 2px; color: #64748b;">* 未校准分数，非概率</div>
    `;
    body.appendChild(noticeBlock);

    // 4. Category Filters & Legend
    const legendSection = this.doc.createElement("div");
    legendSection.className = "legend-container";

    const legendHeader = this.doc.createElement("div");
    legendHeader.style.display = "flex";
    legendHeader.style.justifyContent = "space-between";
    legendHeader.style.alignItems = "center";

    const legendTitle = this.doc.createElement("span");
    legendTitle.className = "section-title";
    legendTitle.textContent = "图例与类别过滤";

    const showAllLabelToggle = this.doc.createElement("label");
    showAllLabelToggle.style.fontSize = "11px";
    showAllLabelToggle.style.display = "flex";
    showAllLabelToggle.style.alignItems = "center";
    showAllLabelToggle.style.gap = "4px";
    showAllLabelToggle.style.cursor = "pointer";

    const showAllCheckbox = this.doc.createElement("input");
    showAllCheckbox.type = "checkbox";
    showAllCheckbox.checked = this.showAllLabels;
    showAllCheckbox.onchange = () => {
      this.showAllLabels = showAllCheckbox.checked;
      this.renderOverlayBoxes(this.presentedFrame?.boxes ?? []);
    };
    showAllLabelToggle.appendChild(showAllCheckbox);
    showAllLabelToggle.appendChild(this.doc.createTextNode("显示全部标签"));

    legendHeader.appendChild(legendTitle);
    legendHeader.appendChild(showAllLabelToggle);
    legendSection.appendChild(legendHeader);

    // Filter quick buttons
    const filterQuickRow = this.doc.createElement("div");
    filterQuickRow.className = "btn-row";
    filterQuickRow.style.margin = "2px 0 4px 0";

    const allBtn = this.doc.createElement("button");
    allBtn.className = "btn";
    allBtn.textContent = "全部";
    allBtn.onclick = () => {
      this.categoryFilters = new Set(Object.keys(CATEGORY_COLORS).concat(["unknown", "conflict"]));
      this.renderOverlayBoxes(this.presentedFrame?.boxes ?? []);
      this.renderPanel();
    };

    const knownBtn = this.doc.createElement("button");
    knownBtn.className = "btn";
    knownBtn.textContent = "仅已知";
    knownBtn.onclick = () => {
      this.categoryFilters = new Set(Object.keys(CATEGORY_COLORS));
      this.renderOverlayBoxes(this.presentedFrame?.boxes ?? []);
      this.renderPanel();
    };

    const unknownBtn = this.doc.createElement("button");
    unknownBtn.className = "btn";
    unknownBtn.textContent = "仅未知";
    unknownBtn.onclick = () => {
      this.categoryFilters = new Set(["unknown", "conflict"]);
      this.renderOverlayBoxes(this.presentedFrame?.boxes ?? []);
      this.renderPanel();
    };

    filterQuickRow.appendChild(allBtn);
    filterQuickRow.appendChild(knownBtn);
    filterQuickRow.appendChild(unknownBtn);
    legendSection.appendChild(filterQuickRow);

    const legendItems = this.doc.createElement("div");
    legendItems.className = "legend-items";

    const categoriesToList = Object.entries(CATEGORY_COLORS).map(([key, val]) => ({
      key,
      zh: val.zh,
      border: val.border,
      bg: val.bg,
    })).concat([
      { key: "unknown", zh: "未知 (unknown)", border: STATUS_COLORS.unknown.border, bg: STATUS_COLORS.unknown.bg },
      { key: "conflict", zh: "冲突 (conflict)", border: STATUS_COLORS.conflict.border, bg: STATUS_COLORS.conflict.bg },
    ]);

    for (const item of categoriesToList) {
      const itemEl = this.doc.createElement("label");
      itemEl.className = "legend-item";

      const chk = this.doc.createElement("input");
      chk.type = "checkbox";
      chk.checked = this.categoryFilters.has(item.key);
      chk.onchange = () => {
        if (chk.checked) {
          this.categoryFilters.add(item.key);
        } else {
          this.categoryFilters.delete(item.key);
        }
        this.renderOverlayBoxes(this.presentedFrame?.boxes ?? []);
      };

      const dot = this.doc.createElement("span");
      dot.className = "color-dot";
      dot.style.background = item.border;

      const name = this.doc.createElement("span");
      name.textContent = item.zh;

      itemEl.appendChild(chk);
      itemEl.appendChild(dot);
      itemEl.appendChild(name);
      legendItems.appendChild(itemEl);
    }
    legendSection.appendChild(legendItems);
    body.appendChild(legendSection);

    // 5. Selected Element Inspection & Collection
    if (this.selectedNodeRef) {
      this.renderSelectedNodeSection(body);
    }

    // 6. Bulk Unknown Collection & Session Export
    const sessionSection = this.doc.createElement("div");
    sessionSection.className = "details-block";

    const sessionTitle = this.doc.createElement("div");
    sessionTitle.className = "section-title";
    sessionTitle.textContent = "样本采集与导出";
    sessionSection.appendChild(sessionTitle);

    const eligibleUnknownCount = this.presentedFrame?.basicKindBatch.slots.filter(
      (slot: BasicKindSlot) => slot.candidateStatus === "ok" && slot.judgmentStatus === "unknown"
    ).length ?? 0;

    const stats = this.captureSession.stats();

    const statsText = this.doc.createElement("div");
    statsText.style.fontSize = "11px";
    statsText.style.marginBottom = "6px";
    statsText.innerHTML = `
      <div><strong>会话样本:</strong> 总计 ${stats.total} 条</div>
      <div style="color: #64748b; font-size: 10px;">
        已确认: ${stats.verified} | 标错: ${stats.rejected} | 待定: ${stats.ambiguous} | 未复核未知: ${stats.unreviewed}
      </div>
    `;
    sessionSection.appendChild(statsText);

    const actionRow = this.doc.createElement("div");
    actionRow.className = "btn-row";

    const bulkUnknownBtn = this.doc.createElement("button");
    bulkUnknownBtn.className = "btn";
    bulkUnknownBtn.textContent = `一键收集当前未知 (${eligibleUnknownCount})`;
    bulkUnknownBtn.disabled = eligibleUnknownCount === 0 || !this.currentFrame;
    bulkUnknownBtn.onclick = async () => {
      await this.runCaptureAction({ action: "collect_unknown" });
    };

    const exportBtn = this.doc.createElement("button");
    exportBtn.className = "btn btn-primary";
    exportBtn.textContent = "导出 JSON 样本包";
    exportBtn.disabled = stats.total === 0;
    exportBtn.onclick = async () => {
      await this.runCaptureAction({ action: "export" });
    };

    actionRow.appendChild(bulkUnknownBtn);
    actionRow.appendChild(exportBtn);
    sessionSection.appendChild(actionRow);

    if (this.exportNotice) {
      const exportMsg = this.doc.createElement("div");
      exportMsg.className = "notice-banner notice-success";
      exportMsg.style.marginTop = "6px";
      exportMsg.textContent = this.exportNotice;
      sessionSection.appendChild(exportMsg);
    }

    body.appendChild(sessionSection);

    // 7. Custom Weight Asset Loader
    const weightSection = this.doc.createElement("details");
    weightSection.style.fontSize = "11px";

    const weightSummary = this.doc.createElement("summary");
    weightSummary.textContent = "⚙️ 加载自定义权重文件";
    weightSummary.style.cursor = "pointer";
    weightSummary.style.color = "#475569";
    weightSection.appendChild(weightSummary);

    const weightBody = this.doc.createElement("div");
    weightBody.style.marginTop = "6px";

    const fileInput = this.doc.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json";
    fileInput.className = "file-input";
    fileInput.onchange = (e) => this.handleCustomWeightUpload(e);

    weightBody.appendChild(fileInput);
    weightSection.appendChild(weightBody);
    body.appendChild(weightSection);

    this.panelContainer.appendChild(body);
  }

  private renderSelectedNodeSection(parent: HTMLElement): void {
    if (!this.selectedNodeRef || !this.presentedFrame) return;

    const slot = this.presentedFrame.basicKindBatch.slots.find((s: BasicKindSlot) => s.nodeRef === this.selectedNodeRef);
    const evidence = this.presentedFrame.snapshot.evidence.get(this.selectedNodeRef);
    const el = resolveStableNodeRef(this.registry, this.selectedNodeRef);

    const section = this.doc.createElement("div");
    section.className = "details-block";

    const titleRow = this.doc.createElement("div");
    titleRow.style.display = "flex";
    titleRow.style.justifyContent = "space-between";
    titleRow.style.alignItems = "center";

    const title = this.doc.createElement("span");
    title.className = "section-title";
    title.textContent = `选中元素: <${evidence?.tag ?? el?.tagName.toLowerCase() ?? "div"}>`;

    const deselectBtn = this.doc.createElement("button");
    deselectBtn.className = "close-btn";
    deselectBtn.textContent = "✕";
    deselectBtn.title = "取消选中";
    deselectBtn.onclick = () => {
      this.selectedNodeRef = null;
      this.userReviewFeedback = null;
      this.renderOverlayBoxes(this.presentedFrame?.boxes ?? []);
      this.renderPanel();
    };

    titleRow.appendChild(title);
    titleRow.appendChild(deselectBtn);
    section.appendChild(titleRow);

    // Summary info
    const summary = this.doc.createElement("div");
    summary.className = "details-row";
    const kind = slot?.basicKind ?? "other";
    const kindZh = CATEGORY_COLORS[kind]?.zh ?? kind;
    const scoreStr = slot?.score !== null && slot?.score !== undefined ? `${slot.score.toFixed(3)} (未校准)` : "无";
    const marginStr = slot?.margin !== null && slot?.margin !== undefined ? slot.margin.toFixed(3) : "无";

    const candidate = this.presentedFrame.candidateBatch.slots.find((item) => item.nodeRef === this.selectedNodeRef);
    summary.textContent = `候选状态: ${candidate?.status ?? "unknown"}${candidate?.reasons.length ? ` (${candidate.reasons.join(", ")})` : ""}\n提议种类: ${kindZh} (${kind}) [提议]\n判断状态: ${slot?.judgmentStatus ?? "unknown"}\n分数: ${scoreStr} | 余量: ${marginStr}\n文本摘要: ${evidence?.textSummary?.slice(0, 80) ?? "无"}\nID: ${evidence?.id ?? "无"}`;
    summary.style.whiteSpace = "pre-wrap";
    section.appendChild(summary);

    // Collapsed Raw Evidence & Wires
    const rawDetails = this.doc.createElement("details");
    rawDetails.className = "details-raw";
    const rawSummary = this.doc.createElement("summary");
    rawSummary.textContent = "查看原始特征与连线";
    rawDetails.appendChild(rawSummary);

    const pre = this.doc.createElement("pre");
    pre.textContent = JSON.stringify({
      nodeRef: this.selectedNodeRef,
      candidateStatus: slot?.candidateStatus,
      reasons: slot?.reasons,
      evidence: slot?.evidence,
      classList: evidence?.classList,
    }, null, 2);
    rawDetails.appendChild(pre);
    section.appendChild(rawDetails);

    // Human Review & Annotation Controls
    const formTitle = this.doc.createElement("div");
    formTitle.style.fontWeight = "600";
    formTitle.style.fontSize = "11px";
    formTitle.style.marginTop = "8px";
    formTitle.textContent = "人工复核与标注:";
    section.appendChild(formTitle);

    const radioGroup = this.doc.createElement("div");
    radioGroup.className = "form-radio-group";

    const createRadio = (val: "correct" | "wrong" | "unsure", labelText: string) => {
      const lbl = this.doc.createElement("label");
      lbl.style.display = "flex";
      lbl.style.alignItems = "center";
      lbl.style.gap = "2px";
      lbl.style.cursor = "pointer";

      const rad = this.doc.createElement("input");
      rad.type = "radio";
      rad.name = "userReview";
      rad.value = val;
      rad.checked = this.userReviewSelection === val;
      rad.onchange = () => {
        this.userReviewSelection = val;
        this.renderPanel();
      };

      lbl.appendChild(rad);
      lbl.appendChild(this.doc.createTextNode(labelText));
      return lbl;
    };

    radioGroup.appendChild(createRadio("correct", "正确"));
    radioGroup.appendChild(createRadio("wrong", "标错"));
    radioGroup.appendChild(createRadio("unsure", "待复核"));
    section.appendChild(radioGroup);

    // Specific options for wrong / other
    if (this.userReviewSelection === "wrong") {
      const selectLabel = this.doc.createElement("div");
      selectLabel.style.fontSize = "10px";
      selectLabel.style.color = "#475569";
      selectLabel.textContent = "指定正确类别:";
      section.appendChild(selectLabel);

      const select = this.doc.createElement("select");
      select.className = "form-select";
      select.setAttribute("aria-label", "指定正确类别");
      const undecided = this.doc.createElement("option");
      undecided.value = "";
      undecided.textContent = "仅标错，暂不指定正确类别";
      select.appendChild(undecided);
      for (const [catKey, catVal] of Object.entries(CATEGORY_COLORS)) {
        const opt = this.doc.createElement("option");
        opt.value = catKey;
        opt.textContent = `${catVal.zh} (${catKey})`;
        if (catKey === this.userCorrectedLabel) opt.selected = true;
        select.appendChild(opt);
      }
      select.onchange = () => {
        this.userCorrectedLabel = select.value as BasicKindLabel | "";
        this.renderPanel();
      };
      section.appendChild(select);
    }

    const needsOtherReason = (this.userReviewSelection === "wrong" && this.userCorrectedLabel === "other") ||
                             (this.userReviewSelection === "correct" && slot?.basicKind === "other");

    if (needsOtherReason) {
      const reasonLabel = this.doc.createElement("div");
      reasonLabel.style.fontSize = "10px";
      reasonLabel.style.color = "#475569";
      reasonLabel.style.marginTop = "4px";
      reasonLabel.textContent = "确认/更正为「其他」的具体理由 (必填):";
      section.appendChild(reasonLabel);

      const reasonInput = this.doc.createElement("input");
      reasonInput.type = "text";
      reasonInput.className = "form-input";
      reasonInput.placeholder = "例如：不在现有11类词表中、特殊浮动工具栏等";
      reasonInput.value = this.userOtherReason;
      reasonInput.oninput = () => {
        this.userOtherReason = reasonInput.value;
      };
      section.appendChild(reasonInput);
    }

    const saveBtn = this.doc.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.style.marginTop = "8px";
    saveBtn.textContent = "保存此元素样本";
    saveBtn.disabled = !this.currentFrame || slot?.candidateStatus !== "ok" || !el?.isConnected;
    saveBtn.onclick = async () => {
      await this.saveSelectedAnnotation();
    };
    section.appendChild(saveBtn);

    if (this.userReviewFeedback) {
      const feedbackEl = this.doc.createElement("div");
      feedbackEl.className = "notice-banner notice-success";
      feedbackEl.style.marginTop = "6px";
      feedbackEl.textContent = this.userReviewFeedback;
      section.appendChild(feedbackEl);
    }

    parent.appendChild(section);
  }

  private async saveSelectedAnnotation(): Promise<void> {
    if (!this.selectedNodeRef || !this.currentFrame) return;
    const slot = this.currentFrame.basicKindBatch.slots.find(item => item.nodeRef === this.selectedNodeRef);

    let annotation: BrowserCaptureAnnotation;
    if (this.userReviewSelection === "correct") {
      if (slot?.basicKind === "other" && !this.userOtherReason.trim()) {
        alert("确认为「其他」需要填写具体理由！");
        return;
      }
      annotation = {
        kind: "correct",
        ...(slot?.basicKind === "other" ? { otherReason: this.userOtherReason.trim() } : {}),
      };
    } else if (this.userReviewSelection === "wrong") {
      if (this.userCorrectedLabel === "other" && !this.userOtherReason.trim()) {
        alert("指定正确类别为「其他」需要填写具体理由！");
        return;
      }
      annotation = {
        kind: "wrong",
        ...(this.userCorrectedLabel ? { correctedLabel: this.userCorrectedLabel } : {}),
        ...(this.userCorrectedLabel === "other" ? { otherReason: this.userOtherReason.trim() } : {}),
      };
    } else {
      annotation = { kind: "unsure" };
    }

    const receipt = await this.runCaptureAction({
      action: "capture_selected",
      nodeRef: this.selectedNodeRef,
      annotation,
    });

    if (receipt) {
      this.userReviewFeedback = `已保存样本: ${receipt.reviewStatus}`;
      this.renderPanel();
    }
  }

  private async runCaptureAction(input: {
    action: "capture_selected" | "collect_unknown" | "export";
    nodeRef?: string;
    annotation?: BrowserCaptureAnnotation;
  }): Promise<any> {
    if (input.action !== "export" && (!this.currentFrame || this.isFocusStale)) return null;

    try {
      let downloadResult: any = null;
      const downloadCallback = async (bundle: BrowserCaptureBundleV1, fname: string) => {
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = this.doc.createElement("a");
        a.href = url;
        a.download = fname;
        a.click();
        this.win.setTimeout(() => URL.revokeObjectURL(url), 1000);
        downloadResult = { receiptId: `download-${Date.now()}`, filename: fname };
        return downloadResult;
      };

      const captureDefs = createBrowserCaptureNodeDefinitions({
        session: this.captureSession,
        download: downloadCallback,
      });

      const compiledCapture = compileWorkflow(
        { graph: this.captureGraph, bindings: {} },
        {
          nodeDefinitions: captureDefs,
          grantedEffects: ["browser.capture.download"],
        }
      );

      this.sequence += 1;
      const runId = `capture-run-${Date.now()}-${this.sequence}`;
      const payload: any = {
        action: input.action,
        frame: this.currentFrame,
      };
      if (input.nodeRef) payload.nodeRef = input.nodeRef;
      if (input.annotation) payload.annotation = input.annotation;

      const inputEvent = createWorkflowInputEvent({
        runId,
        eventId: `${runId}:input`,
        port: "capture_request",
        type: BROWSER_CAPTURE_REQUEST_EVENT_TYPE,
        correlation: {},
        payload,
      });

      const result = await runWorkflow(compiledCapture, inputEvent);
      if (result.status === "completed" && result.outputEvent.status === "ok") {
        const receipt = (result.outputEvent.payload as { receipt: unknown }).receipt;
        if (input.action === "export") {
          this.exportNotice = `已请求下载样本包：${downloadResult.filename}。请在浏览器下载记录中确认。`;
        }
        this.renderPanel();
        return receipt;
      }
      throw new Error(result.status === "failed" ? result.error.message : `采集结果不可用：${(result.outputEvent.payload as { reason: string }).reason}`);
    } catch (err) {
      console.error("[NNAnything DOM Inspector] Capture action error:", err);
      alert("采集操作失败: " + (err instanceof Error ? err.message : String(err)));
    }
    return null;
  }

  private startPickingMode(mode: "inspect" | "focus"): void {
    this.isPickingMode = mode;
    this.win.addEventListener("click", this.boundOnPickClick, true);
    this.win.addEventListener("mousemove", this.boundOnPickMouseMove, true);
    this.win.addEventListener("keydown", this.boundOnPickKeyDown, true);

    if (this.doc.body) {
      this.originalCursor = this.doc.body.style.cursor;
      this.doc.body.style.cursor = "crosshair";
    }
    this.renderPanel();
  }

  private stopPickingMode(): void {
    this.isPickingMode = null;
    this.win.removeEventListener("click", this.boundOnPickClick, true);
    this.win.removeEventListener("mousemove", this.boundOnPickMouseMove, true);
    this.win.removeEventListener("keydown", this.boundOnPickKeyDown, true);

    if (this.doc.body) {
      this.doc.body.style.cursor = this.originalCursor;
    }
    if (this.pickingHighlight) {
      this.pickingHighlight.style.display = "none";
    }
    this.renderPanel();
  }

  private handlePickKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      this.stopPickingMode();
    }
  }

  private handlePickMouseMove(e: MouseEvent): void {
    if (!this.pickingHighlight) return;

    const el = this.pickSiteElementAtPoint(e.clientX, e.clientY);
    if (!el) {
      this.pickingHighlight.style.display = "none";
      return;
    }

    const rect = el.getBoundingClientRect();
    this.pickingHighlight.style.display = "block";
    this.pickingHighlight.style.left = `${rect.left}px`;
    this.pickingHighlight.style.top = `${rect.top}px`;
    this.pickingHighlight.style.width = `${rect.width}px`;
    this.pickingHighlight.style.height = `${rect.height}px`;
  }

  private handlePickClick(e: MouseEvent): void {
    if (this.hostElement && e.composedPath().includes(this.hostElement)) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    const el = this.pickSiteElementAtPoint(e.clientX, e.clientY);
    if (!el) {
      this.stopPickingMode();
      return;
    }

    const mode = this.isPickingMode;
    const ref = stableNodeRefFor(this.registry, el);

    this.stopPickingMode();

    if (mode === "inspect") {
      this.selectNode(ref);
    } else if (mode === "focus") {
      this.focusNodeRef = ref;
      this.isFocusStale = false;
      this.scheduleRefresh();
    }
  }

  private pickSiteElementAtPoint(x: number, y: number): Element | null {
    const isInspector = (element: Element): boolean => {
      if (this.hostElement && (element === this.hostElement || this.hostElement.contains(element))) return true;
      for (let current: Element | null = element; current; current = current.parentElement) {
        if (current.id !== "" && DEFAULT_EXCLUDED_TOOL_ROOT_IDS.includes(current.id as typeof DEFAULT_EXCLUDED_TOOL_ROOT_IDS[number])) return true;
      }
      return false;
    };
    const elements = typeof this.doc.elementsFromPoint === "function"
      ? this.doc.elementsFromPoint(x, y)
      : [this.doc.elementFromPoint(x, y)].filter((element): element is Element => element !== null);
    return elements.find(element => !isInspector(element)) ?? null;
  }

  private selectNode(nodeRef: string): void {
    this.selectedNodeRef = nodeRef;
    this.userReviewFeedback = null;
    this.userOtherReason = "";
    this.userCorrectedLabel = "";
    this.userReviewSelection = "correct";
    this.renderOverlayBoxes(this.presentedFrame?.boxes ?? []);
    this.renderPanel();
  }

  private async handleCustomWeightUpload(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseBrowserWeightAsset(text, file.name);

      this.currentProfile = parsed.profile;
      this.currentConfig = parsed.config;
      this.profileSourceLabel = parsed.sourceLabel || file.name;

      alert(`✅ 成功加载权重: ${file.name}`);
      this.scheduleRefresh();
    } catch (err) {
      console.error("[NNAnything DOM Inspector] Weight upload error:", err);
      alert(`❌ 权重文件无效: ${err instanceof Error ? err.message : String(err)}\n已保留当前已有配置。`);
    } finally {
      input.value = "";
    }
  }
}
