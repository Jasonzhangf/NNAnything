import { DOMInspectorController } from "../../extension/controller.js";
import visualOverlayGraph from "../../workflows/browser-visual-overlay.graph.json";
import captureGraph from "../../workflows/browser-capture.graph.json";

const HOST_ID = "nnanything-dom-inspector-host";
const RECORDING_MS = 2000;
const MUTATION_INTERVAL_MS = 80;
const INITIAL_STABLE_TIMEOUT_MS = 10000;
const SETTLE_TIMEOUT_MS = 1500;

type HostMetrics = {
  hostId: number | null;
  hostConnected: boolean;
  boxes: number;
  targetBoxes: number;
  contentBoxes: number;
  panelPresent: boolean;
  panelHeight: number;
  captureDisabled: boolean;
  sessionTotal: number;
  updating: boolean;
  manualCaptureDisabled: boolean;
};

type FrameSample = HostMetrics & {
  t: number;
  mutationSincePreviousFrame: boolean;
};

type SyncSample = HostMetrics & {
  t: number;
  mutationRecords: number;
};

const target = required<HTMLElement>("#fixture-target");
const targetButton = required<HTMLButtonElement>("#target-button");
const contentTarget = required<HTMLElement>("#detail-copy");
const statusText = required<HTMLElement>("#status-text");
const output = required<HTMLPreElement>("#recording-output");
const startButton = required<HTMLButtonElement>("#start-recording");
const replayButton = required<HTMLButtonElement>("#replay-recording");

let nextRunHook: (() => void) | null = null;
let pipelineStarts = 0;
// Wrap only the public scheduling resource to inject events while a real
// workflow awaits completion. No private controller state is inspected.
const resourceWindow = new Proxy(window, {
  get(source, key) {
    if (key === "requestAnimationFrame") return (callback: FrameRequestCallback) => window.requestAnimationFrame(time => {
      pipelineStarts++;
      callback(time);
      const hook = nextRunHook;
      nextRunHook = null;
      hook?.();
    });
    const value = Reflect.get(source, key, source);
    return typeof value === "function" ? value.bind(source) : value;
  },
});
const fixtureGraph = structuredClone(visualOverlayGraph);
const controller = new DOMInspectorController({
  visualOverlayGraph: fixtureGraph,
  captureGraph,
  document,
  window: resourceWindow,
});

const hostIds = new WeakMap<Element, number>();
const seenHostIds = new Set<number>();
let nextHostId = 0;
let running = false;
let initialEmptyFrames = 0;

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing fixture element: ${selector}`);
  return element;
}

function hostIdFor(host: Element): number {
  const existing = hostIds.get(host);
  if (existing !== undefined) return existing;
  const id = ++nextHostId;
  hostIds.set(host, id);
  seenHostIds.add(id);
  return id;
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && Math.max(a.left, b.left) < Math.min(a.right, b.right)
    && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
}

function rectsMatch(a: DOMRect, b: DOMRect, tolerance = 2): boolean {
  return Math.abs(a.left - b.left) <= tolerance
    && Math.abs(a.top - b.top) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance
    && Math.abs(a.height - b.height) <= tolerance;
}

function readHostMetrics(): HostMetrics {
  const host = document.getElementById(HOST_ID);
  if (!host || !host.shadowRoot) {
    return { hostId: null, hostConnected: false, boxes: 0, targetBoxes: 0, contentBoxes: 0, panelPresent: false, panelHeight: 0, captureDisabled: true, sessionTotal: 0, updating: false, manualCaptureDisabled: true };
  }

  const targetRect = targetButton.getBoundingClientRect();
  const contentRect = contentTarget.getBoundingClientRect();
  const boxes = Array.from(host.shadowRoot.querySelectorAll<HTMLElement>(".box"));
  const boxRect = (box: HTMLElement) => new DOMRect(
    Number.parseFloat(box.style.left),
    Number.parseFloat(box.style.top),
    Number.parseFloat(box.style.width),
    Number.parseFloat(box.style.height),
  );
  const targetBoxes = boxes.filter((box) => {
    return rectsMatch(boxRect(box), targetRect);
  }).length;
  const contentBoxes = boxes.filter((box) => {
    return rectsMatch(boxRect(box), contentRect);
  }).length;

  const panel = host.shadowRoot.querySelector<HTMLElement>(".inspector-panel");
  const bulk = Array.from(host.shadowRoot.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.startsWith("一键收集当前未知"));
  const save = Array.from(host.shadowRoot.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "保存此元素样本");
  return {
    hostId: hostIdFor(host),
    hostConnected: host.isConnected,
    boxes: boxes.length,
    targetBoxes,
    contentBoxes,
    panelPresent: host.shadowRoot.querySelector(".inspector-panel") !== null,
    panelHeight: panel?.getBoundingClientRect().height ?? 0,
    captureDisabled: bulk?.disabled ?? true,
    sessionTotal: Number(/总计\s*(\d+)\s*条/.exec(panel?.textContent ?? "")?.[1] ?? 0),
    updating: panel?.textContent?.includes("正在更新") ?? false,
    manualCaptureDisabled: save?.disabled ?? true,
  };
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function waitForStableFrame(timeoutMs: number): Promise<boolean> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    await nextAnimationFrame();
    const metrics = readHostMetrics();
    if (metrics.hostConnected && metrics.boxes > 0 && !metrics.updating) return true;
    initialEmptyFrames += 1;
  }
  return false;
}

function countEmptyRuns(samples: readonly FrameSample[]): number {
  let runs = 0;
  let inEmptyRun = false;
  for (const sample of samples) {
    if (sample.boxes === 0) {
      if (!inEmptyRun) runs += 1;
      inEmptyRun = true;
    } else {
      inEmptyRun = false;
    }
  }
  return runs;
}

async function waitFor(predicate: () => boolean): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < INITIAL_STABLE_TIMEOUT_MS) {
    await nextAnimationFrame();
    if (predicate()) return true;
  }
  return false;
}

function panelButton(label: string): HTMLButtonElement {
  const buttons = document.getElementById(HOST_ID)!.shadowRoot!.querySelectorAll<HTMLButtonElement>("button");
  const button = Array.from(buttons).find(button => button.textContent === label);
  if (!button) throw new Error(`Missing panel button: ${label}`);
  return button;
}

async function verifyBoundaries(): Promise<Record<string, boolean>> {
  const checks: Record<string, boolean> = {};
  let before = pipelineStarts;
  for (let i = 0; i < 100; i++) controller.scheduleRefresh();
  checks.burstCoalesced = await waitForStableFrame(INITIAL_STABLE_TIMEOUT_MS) && pipelineStarts - before === 1;

  before = pipelineStarts;
  let invalidatedDuringRun = false;
  nextRunHook = () => {
    controller.scheduleRefresh();
    invalidatedDuringRun = readHostMetrics().captureDisabled;
  };
  controller.scheduleRefresh();
  checks.inFlightFollowup = await waitForStableFrame(INITIAL_STABLE_TIMEOUT_MS)
    && invalidatedDuringRun && pipelineStarts - before === 2;

  const oldHost = document.getElementById(HOST_ID)!;
  nextRunHook = () => { controller.destroy(); controller.mount(); };
  controller.scheduleRefresh();
  checks.reopenDiscardsOldGeneration = await waitForStableFrame(INITIAL_STABLE_TIMEOUT_MS)
    && !oldHost.isConnected && document.getElementById(HOST_ID) !== oldHost;

  const operator = fixtureGraph.nodes[0]!.operator;
  fixtureGraph.nodes[0]!.operator = "fixture.missing_operator";
  controller.scheduleRefresh();
  checks.errorClears = await waitFor(() => readHostMetrics().boxes === 0
    && document.getElementById(HOST_ID)?.shadowRoot?.textContent?.includes("分类失败") === true);
  fixtureGraph.nodes[0]!.operator = operator;
  controller.scheduleRefresh();
  checks.errorRecovers = await waitForStableFrame(INITIAL_STABLE_TIMEOUT_MS);

  panelButton("选择Focus").click();
  const rect = targetButton.getBoundingClientRect();
  targetButton.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
  const focused = await waitForStableFrame(INITIAL_STABLE_TIMEOUT_MS);
  targetButton.style.display = "none";
  checks.emptySuccessClears = focused && await waitFor(() => {
    const metrics = readHostMetrics();
    return !metrics.updating && metrics.boxes === 0 && !document.getElementById(HOST_ID)?.shadowRoot?.textContent?.includes("分类失败");
  });
  targetButton.style.display = "";
  await waitForStableFrame(INITIAL_STABLE_TIMEOUT_MS);
  const parent = targetButton.parentElement!;
  const sibling = targetButton.nextSibling;
  targetButton.remove();
  checks.staleFocusClears = await waitFor(() => readHostMetrics().boxes === 0
    && document.getElementById(HOST_ID)?.shadowRoot?.textContent?.includes("Focus 失效") === true);
  parent.insertBefore(targetButton, sibling);
  panelButton("清除Focus").click();
  checks.focusRecovers = await waitForStableFrame(INITIAL_STABLE_TIMEOUT_MS);
  await nextAnimationFrame();
  before = pipelineStarts;
  for (let i = 0; i < 4; i++) await nextAnimationFrame();
  checks.ownPanelDoesNotLoop = before === pipelineStarts;
  return checks;
}

async function runRecording(): Promise<void> {
  if (running) return;
  running = true;
  initialEmptyFrames = 0;
  seenHostIds.clear();
  output.dataset.status = "ARMING";
  output.textContent = "Arming after the next stable overlay frame.";

  const armed = await waitForStableFrame(INITIAL_STABLE_TIMEOUT_MS);
  if (!armed) {
    output.dataset.status = "NO_INITIAL_FRAME";
    output.textContent = JSON.stringify({
      status: "NO_INITIAL_FRAME",
      initialEmptyFrames,
      hostConnected: readHostMetrics().hostConnected,
    }, null, 2);
    running = false;
    return;
  }

  output.dataset.status = "RECORDING";
  output.textContent = "Recording 2 seconds of benign DOM mutations.";
  panelButton("检查元素").click();
  const targetRectBefore = targetButton.getBoundingClientRect();
  targetButton.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: targetRectBefore.x + targetRectBefore.width / 2, clientY: targetRectBefore.y + targetRectBefore.height / 2 }));
  await waitForStableFrame(INITIAL_STABLE_TIMEOUT_MS);

  const frameSamples: FrameSample[] = [];
  const syncSamples: SyncSample[] = [];
  let mutationCallbacks = 0;
  let mutationRecords = 0;
  let mutationPending = false;
  let rafId = 0;
  let mutationCount = 0;
  const recordingStarted = performance.now();
  const staleBulkButton = Array.from(document.getElementById(HOST_ID)!.shadowRoot!.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.startsWith("一键收集当前未知"));
  const staleBulkCallback = staleBulkButton?.onclick;
  const staleSaveButton = Array.from(document.getElementById(HOST_ID)!.shadowRoot!.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent === "保存此元素样本");
  const staleSaveCallback = staleSaveButton?.onclick;

  const mutationObserver = new MutationObserver((records) => {
    mutationCallbacks += 1;
    mutationRecords += records.length;
    mutationPending = true;
    // Exercise an old UI callback while the actual measurement is invalidated.
    staleBulkCallback?.call(staleBulkButton!, new PointerEvent("click"));
    staleSaveCallback?.call(staleSaveButton!, new PointerEvent("click"));
    syncSamples.push({
      ...readHostMetrics(),
      t: performance.now() - recordingStarted,
      mutationRecords: records.length,
    });
  });

  const sampleFrame = () => {
    frameSamples.push({
      ...readHostMetrics(),
      t: performance.now() - recordingStarted,
      mutationSincePreviousFrame: mutationPending,
    });
    mutationPending = false;
    rafId = window.requestAnimationFrame(sampleFrame);
  };

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  const mutationTimer = window.setInterval(() => {
    mutationCount += 1;
    statusText.firstChild!.nodeValue = `Benign content ${mutationCount}`;
    targetButton.setAttribute("data-benign-tick", String(mutationCount));
  }, MUTATION_INTERVAL_MS);

  sampleFrame();
  await new Promise<void>((resolve) => window.setTimeout(resolve, RECORDING_MS));

  window.clearInterval(mutationTimer);
  window.cancelAnimationFrame(rafId);
  mutationObserver.disconnect();

  const boxesAtStop = readHostMetrics().boxes;
  const settled = await waitForStableFrame(SETTLE_TIMEOUT_MS);
  const settledMetrics = readHostMetrics();
  const panelRect = document.getElementById(HOST_ID)?.shadowRoot?.querySelector<HTMLElement>(".inspector-panel")?.getBoundingClientRect() ?? null;
  const targetRect = target.getBoundingClientRect();

  const nonemptySamples = frameSamples.filter((sample) => sample.boxes > 0);
  const emptySamples = frameSamples.filter((sample) => sample.boxes === 0);
  const emptyAfterMutationFrames = frameSamples.filter((sample) => sample.boxes === 0 && sample.mutationSincePreviousFrame);
  const syncEmptyAfterMutation = syncSamples.filter((sample) => sample.boxes === 0);
  const targetNonemptyFrames = frameSamples.filter((sample) => sample.targetBoxes > 0);
  const contentNonemptyFrames = frameSamples.filter((sample) => sample.contentBoxes > 0);
  const panelHeights = frameSamples.map(sample => sample.panelHeight);
  const checks = {
    sameMountedHost: seenHostIds.size === 1 && settledMetrics.hostConnected,
    noBlankFrame: emptySamples.length === 0,
    noBlankOnMutation: syncSamples.length >= 10 && syncEmptyAfterMutation.length === 0,
    panelHeightStable: Math.max(...panelHeights) - Math.min(...panelHeights) < 1,
    captureDisabledDuringUpdate: syncSamples.every(sample => sample.captureDisabled),
    manualCaptureDisabledDuringUpdate: syncSamples.every(sample => sample.manualCaptureDisabled),
    staleCallbacksExercised: !!staleBulkCallback && !!staleSaveCallback,
    staleCallbackCapturedNothing: settledMetrics.sessionTotal === 0,
    recovered: settled && settledMetrics.boxes > 0,
    ...await verifyBoundaries(),
  };
  const result = {
    status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
    checks,
    panelHeightRange: [Math.min(...panelHeights), Math.max(...panelHeights)],
    mountedStable: seenHostIds.size === 1 && settledMetrics.hostConnected,
    observedEmptyAfterInitial: emptySamples.length > 0,
    nonemptyFrames: nonemptySamples.length,
    frameSamples: frameSamples.length,
    emptyFramesAfterInitial: emptySamples.length,
    emptyAfterMutationFrames: emptyAfterMutationFrames.length,
    emptyFrameRuns: countEmptyRuns(frameSamples),
    syncMutationSamples: syncSamples.length,
    syncEmptyAfterMutation: syncEmptyAfterMutation.length,
    targetNonemptyFrames: targetNonemptyFrames.length,
    contentNonemptyFrames: contentNonemptyFrames.length,
    maxBoxes: Math.max(0, ...frameSamples.map((sample) => sample.boxes)),
    minBoxesAfterInitial: Math.min(...frameSamples.map((sample) => sample.boxes)),
    initialEmptyFrames,
    mutationCallbacks,
    mutationRecords,
    uniqueHostIds: seenHostIds.size,
    hostConnectedAtEnd: settledMetrics.hostConnected,
    panelPresentAtEnd: settledMetrics.panelPresent,
    panelOverlapsTarget: panelRect !== null && rectsOverlap(panelRect, targetRect),
    boxesAtStop,
    recoveredAfterStop: settled && settledMetrics.boxes > 0,
    recoveredBoxes: settledMetrics.boxes,
    recordingMs: Math.round(performance.now() - recordingStarted),
    sampleTimeline: frameSamples.map((sample) => ({
      t: Math.round(sample.t),
      boxes: sample.boxes,
      targetBoxes: sample.targetBoxes,
      contentBoxes: sample.contentBoxes,
      hostId: sample.hostId,
      mutation: sample.mutationSincePreviousFrame,
    })),
  };

  output.dataset.status = result.status;
  output.textContent = JSON.stringify(result, null, 2);
  running = false;
}

function startRecording(): void {
  void runRecording().catch(error => {
    running = false;
    output.dataset.status = "FAIL";
    output.textContent = JSON.stringify({ status: "FAIL", error: String(error) });
  });
}
startButton.addEventListener("click", startRecording);
replayButton.addEventListener("click", startRecording);

controller.mount();
startRecording();
