import {
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  type BrowserWeightFileSource,
} from "nnanything/browser-classify";
import { DOMInspectorController } from "../../extension/controller.js";
import captureGraph from "../../workflows/browser-capture.graph.json";
import visualOverlayGraph from "../../workflows/browser-visual-overlay.graph.json";

const HOST_ID = "nnanything-dom-inspector-host";
const PROFILE_ID = "dom-basic-kinds-file-source-harness-v1";
const WAIT_TIMEOUT_MS = 10000;

type MutableSource = BrowserWeightFileSource & {
  readonly fileName: string;
  setText(text: string): void;
  reads(): number;
};

type DelayedSource = MutableSource & {
  delayNextText(text: string): void;
  hasPendingRead(): boolean;
  resolvePending(): boolean;
};

const targetButton = required<HTMLButtonElement>("#fixture-target-button");
const output = required<HTMLPreElement>("#output");
// Reporting must not feed back into the controller's document observer.
const outputHost = document.createElement("div");
output.replaceWith(outputHost);
outputHost.attachShadow({ mode: "open" }).appendChild(output);
output.style.cssText = "margin:0;padding:10px;max-height:22vh;overflow:auto;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;color:#334155;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace";
const selectedSource = required<HTMLElement>("#selected-source");

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing fixture element: ${selector}`);
  return element;
}

function weightText(buttonFamilyWeight: number): string {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  (profile.familyWeights.control as Record<string, number>).nat_control_button = buttonFamilyWeight;
  return JSON.stringify({
    targetOperator: "dom.basic_kinds",
    operatorVersion: "0.1.0",
    contractVersion: 1,
    taskId: "dom.basic-kinds.v1",
    profileId: PROFILE_ID,
    baseProfileId: PROFILE_ID,
    calibrated: false,
    compatibility: { ...DEFAULT_BASIC_KIND_CONFIG },
    profile: { ...profile, id: PROFILE_ID },
  });
}

function mutableSource(fileName: string, initialText: string): MutableSource {
  let text = initialText;
  let readCount = 0;
  return {
    sourceLabel: fileName,
    fileName,
    readText: async () => {
      readCount += 1;
      return text;
    },
    setText: (nextText) => {
      text = nextText;
    },
    reads: () => readCount,
  };
}

function delayedSource(fileName: string): DelayedSource {
  let text = weightText(1);
  let readCount = 0;
  let deferNext = false;
  let pending: { text: string; resolve(text: string): void } | null = null;
  return {
    sourceLabel: fileName,
    fileName,
    readText: () => {
      readCount += 1;
      if (!deferNext) return Promise.resolve(text);
      deferNext = false;
      return new Promise<string>((resolve) => {
        pending = { text, resolve };
      });
    },
    setText: (nextText) => {
      text = nextText;
    },
    reads: () => readCount,
    delayNextText: (nextText) => {
      text = nextText;
      deferNext = true;
    },
    hasPendingRead: () => pending !== null,
    resolvePending: () => {
      const current = pending;
      pending = null;
      if (!current) return false;
      current.resolve(current.text);
      return true;
    },
  };
}

const sourceA = mutableSource("source-a-button.json", weightText(1));
const sourceB = mutableSource("source-b-other.json", weightText(0.3));
const failureSource = mutableSource("source-failure.json", "{");
const delayed = delayedSource("source-delayed.json");

if (weightJsonProfileId(weightText(1)) !== weightJsonProfileId(weightText(0.3))) {
  throw new Error("A and B fixtures must keep the same profileId");
}

function weightJsonProfileId(text: string): string {
  return String((JSON.parse(text) as { profileId?: unknown }).profileId ?? "");
}

const controller = new DOMInspectorController({
  visualOverlayGraph,
  captureGraph,
  document,
  window,
  weightFile: sourceA,
});

let observedShadowRoot: ShadowRoot | null = null;
let checkResult: Record<string, unknown> | null = null;
const shadowObserver = new MutationObserver(() => publishState());

function observeHost(): void {
  shadowObserver.disconnect();
  const shadowRoot = document.getElementById(HOST_ID)?.shadowRoot ?? null;
  observedShadowRoot = shadowRoot;
  if (shadowRoot) shadowObserver.observe(shadowRoot, { childList: true, subtree: true, characterData: true, attributes: true });
}

function panel(): ShadowRoot | null {
  return document.getElementById(HOST_ID)?.shadowRoot ?? null;
}

function panelText(): string {
  return panel()?.querySelector(".inspector-panel")?.textContent ?? "";
}

function targetKind(): string | null {
  const host = panel();
  if (!host) return null;
  const targetRect = targetButton.getBoundingClientRect();
  const boxes = Array.from(host.querySelectorAll<HTMLElement>(".box"));
  const matching = boxes.find((box) => {
    const tolerance = 2;
    return Math.abs(Number.parseFloat(box.style.left) - targetRect.left) <= tolerance
      && Math.abs(Number.parseFloat(box.style.top) - targetRect.top) <= tolerance
      && Math.abs(Number.parseFloat(box.style.width) - targetRect.width) <= tolerance
      && Math.abs(Number.parseFloat(box.style.height) - targetRect.height) <= tolerance;
  });
  return matching?.dataset.basicKind ?? null;
}

function captureButtonsDisabled(): boolean {
  const host = panel();
  if (!host) return true;
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
  const bulk = buttons.find(button => button.textContent?.startsWith("一键收集未知与冲突"));
  const qualified = buttons.find(button => button.textContent?.startsWith("收集当前候选"));
  return (bulk?.disabled ?? true) && (qualified?.disabled ?? true);
}

function publicState(): Record<string, unknown> {
  const host = panel();
  const panelRoot = host?.querySelector<HTMLElement>(".inspector-panel");
  return {
    mounted: document.getElementById(HOST_ID)?.isConnected === true,
    selectedSource: selectedSource.textContent,
    profileTag: host?.querySelector(".profile-tag")?.textContent ?? null,
    error: host?.querySelector(".notice-warning")?.textContent ?? null,
    boxes: host?.querySelectorAll(".box").length ?? 0,
    targetKind: targetKind(),
    collectionDisabled: captureButtonsDisabled(),
    panelPresent: panelRoot !== null,
    sourceReads: {
      a: sourceA.reads(),
      b: sourceB.reads(),
      failure: failureSource.reads(),
      delayed: delayed.reads(),
    },
  };
}

function publishState(): void {
  const state = publicState();
  const controllerSource = panel()?.querySelector(".profile-tag")?.textContent ?? null;
  if (controllerSource && selectedSource.textContent !== controllerSource) {
    selectedSource.textContent = controllerSource;
  }
  if (checkResult) {
    output.dataset.status = String(checkResult.status);
    output.textContent = JSON.stringify({ ...checkResult, state }, null, 2);
    return;
  }
  const error = typeof state.error === "string" && state.error.length > 0;
  output.dataset.status = error ? "ERROR" : state.mounted ? "READY" : "CLOSED";
  output.textContent = JSON.stringify(state, null, 2);
}

function selectSource(label: string, source: BrowserWeightFileSource | null): void {
  selectedSource.textContent = label;
  controller.setWeightFile(source);
  publishState();
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true;
    await nextAnimationFrame();
  }
  return predicate();
}

async function waitForTargetKind(kind: string): Promise<boolean> {
  return waitFor(() => targetKind() === kind);
}

async function waitForError(text: string): Promise<boolean> {
  return waitFor(() => {
    const state = publicState();
    return state.boxes === 0
      && state.collectionDisabled === true
      && typeof state.error === "string"
      && state.error.includes(text);
  });
}

async function runChecks(): Promise<void> {
  checkResult = null;
  output.dataset.status = "RUNNING";
  output.textContent = "Running public controller checks.";
  const checks: Record<string, boolean> = {};

  selectSource("source A", sourceA);
  checks.sourceAButton = await waitForTargetKind("button");

  selectSource("source B", sourceB);
  checks.sourceBOther = await waitForTargetKind("other");

  const readsBeforeRefresh = sourceB.reads();
  sourceB.setText(weightText(1));
  controller.scheduleRefresh();
  checks.sameSourceRefreshRereads = await waitForTargetKind("button") && sourceB.reads() > readsBeforeRefresh;
  sourceB.setText(weightText(0.3));
  controller.scheduleRefresh();
  await waitForTargetKind("other");

  selectSource("source failure", failureSource);
  checks.failureClears = await waitForError("权重文件加载失败");

  selectSource("source A", sourceA);
  checks.failureRecovers = await waitForTargetKind("button");

  delayed.delayNextText(weightText(1));
  const delayedReadsBeforeRace = delayed.reads();
  selectSource("delayed source", delayed);
  const delayedStarted = await waitFor(() => delayed.hasPendingRead());
  selectSource("source B", sourceB);
  const released = delayed.resolvePending();
  checks.slowAAfterB = delayedStarted && released && delayed.reads() > delayedReadsBeforeRace
    && await waitForTargetKind("other");

  delayed.delayNextText(weightText(1));
  const delayedReadsBeforeClose = delayed.reads();
  selectSource("delayed source", delayed);
  const closeRaceStarted = await waitFor(() => delayed.hasPendingRead());
  controller.destroy();
  shadowObserver.disconnect();
  const closeRaceReleased = delayed.resolvePending();
  await nextAnimationFrame();
  selectSource("source B", sourceB);
  controller.mount();
  observeHost();
  checks.slowAAfterClose = closeRaceStarted && closeRaceReleased && delayed.reads() > delayedReadsBeforeClose
    && await waitForTargetKind("other");

  selectSource("unconfigured", null);
  checks.unconfiguredStops = await waitForError("未选择权重文件");

  selectSource("source A", sourceA);
  checks.unconfiguredRecovers = await waitForTargetKind("button");

  // A mock picker isolates the pending-selection lifecycle. This is not a
  // native file-handle capability test; that acceptance uses the real dialog.
  const pickerWindow = window as unknown as {
    showOpenFilePicker?: () => Promise<FileSystemFileHandle[]>;
  };
  const originalPicker = pickerWindow.showOpenFilePicker;
  const fixtureHandle = {
    name: "picker-fixture.json",
    getFile: async () => new File([weightText(1)], "picker-fixture.json"),
  } as unknown as FileSystemFileHandle;
  let finishPicker: ((handles: FileSystemFileHandle[]) => void) | null = null;
  const startPicker = (): boolean => {
    finishPicker = null;
    pickerWindow.showOpenFilePicker = () => new Promise(resolve => { finishPicker = resolve; });
    const button = Array.from(panel()?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find(candidate => candidate.textContent === "选择权重文件");
    button?.click();
    return finishPicker !== null;
  };
  const finishSelection = (): boolean => {
    const finish = finishPicker;
    finishPicker = null;
    if (!finish) return false;
    finish([fixtureHandle]);
    return true;
  };
  try {
    selectSource("source B", sourceB);
    await waitForTargetKind("other");
    const pickerStarted = startPicker();
    const readsBeforeMutation = sourceB.reads();
    controller.scheduleRefresh();
    const refreshedWhilePending = await waitFor(() => sourceB.reads() > readsBeforeMutation);
    const pickerReleased = finishSelection();
    checks.pickerSurvivesUnrelatedRefresh = pickerStarted && refreshedWhilePending && pickerReleased
      && await waitForTargetKind("button");

    const switchedPickerStarted = startPicker();
    selectSource("source B", sourceB);
    await waitForTargetKind("other");
    const switchedPickerReleased = finishSelection();
    await nextAnimationFrame();
    await nextAnimationFrame();
    checks.pickerAfterSourceSwitchIsDiscarded = switchedPickerStarted && switchedPickerReleased
      && targetKind() === "other";

    const closedPickerStarted = startPicker();
    controller.destroy();
    shadowObserver.disconnect();
    const closedPickerReleased = finishSelection();
    controller.mount();
    observeHost();
    checks.pickerAfterCloseIsDiscarded = closedPickerStarted && closedPickerReleased
      && await waitForTargetKind("other");
  } finally {
    pickerWindow.showOpenFilePicker = originalPicker;
    selectSource("source A", sourceA);
  }

  checkResult = {
    status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
    checks,
  };
  publishState();
}

required<HTMLButtonElement>("#source-a").onclick = () => selectSource("source A", sourceA);
required<HTMLButtonElement>("#source-b").onclick = () => selectSource("source B", sourceB);
required<HTMLButtonElement>("#source-failure").onclick = () => selectSource("source failure", failureSource);
required<HTMLButtonElement>("#source-delayed").onclick = () => {
  delayed.delayNextText(weightText(1));
  selectSource("delayed source", delayed);
};
required<HTMLButtonElement>("#resolve-delayed").onclick = () => {
  delayed.resolvePending();
  publishState();
};
required<HTMLButtonElement>("#source-unconfigured").onclick = () => selectSource("unconfigured", null);
required<HTMLButtonElement>("#refresh").onclick = () => {
  controller.scheduleRefresh();
  publishState();
};
required<HTMLButtonElement>("#mutate-source-a").onclick = () => {
  sourceA.setText(weightText(0.3));
  selectSource("source A with B contents", sourceA);
};
required<HTMLButtonElement>("#restore-source-a").onclick = () => {
  sourceA.setText(weightText(1));
  selectSource("source A", sourceA);
};
required<HTMLButtonElement>("#close").onclick = () => {
  controller.destroy();
  shadowObserver.disconnect();
  publishState();
};
required<HTMLButtonElement>("#reopen").onclick = () => {
  controller.mount();
  observeHost();
  publishState();
};
required<HTMLButtonElement>("#run-checks").onclick = () => {
  void runChecks().catch((error) => {
    checkResult = { status: "FAIL", error: error instanceof Error ? error.message : String(error) };
    publishState();
  });
};

controller.mount();
observeHost();
publishState();
