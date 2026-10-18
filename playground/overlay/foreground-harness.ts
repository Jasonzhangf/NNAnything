import {
  BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
  BrowserCaptureSession,
  DEFAULT_BASIC_KIND_CONFIG,
  compileWorkflow,
  createBrowserOverlayNodeDefinitions,
  createStableNodeRefRegistry,
  createWorkflowInputEvent,
  runWorkflow,
  stableNodeRefFor,
} from "../../lib/browser-classify.js";
import type { JsonValue } from "../../lib/core/contracts.js";
import visualOverlayGraph from "../../workflows/browser-visual-overlay.graph.json";

type Scenario = "baseline" | "xhs-open" | "partial-open" | "transparent-open" | "opaque-open" | "rounded-open"
  | "pointer-target" | "negative-background" | "elevated-child" | "rounded-parent" | "unknown-clipping"
  | "visibility-override" | "grid-stacking" | "modern-alpha";

interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  readonly observed: unknown;
}

interface RunResult {
  readonly scenario: Scenario;
  readonly status: string;
  readonly checks: readonly CheckResult[];
  readonly foreground: readonly {
    readonly nodeRef: string;
    readonly tag: string | null;
    readonly id: string | null;
    readonly foreground: unknown;
    readonly exposedRects: unknown;
  }[];
}

const result = document.querySelector<HTMLPreElement>("#result");
const controls = document.querySelector<HTMLElement>("#fixture-controls");
const registry = createStableNodeRefRegistry("foreground-fixture");
const required = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing fixture element: ${selector}`);
  return element;
};

const targets = {
  backgroundCard: required<HTMLElement>("#xhs-background-card"),
  backgroundAction: required<HTMLElement>("#xhs-background-action"),
  detail: required<HTMLElement>("#xhs-detail"),
  detailAction: required<HTMLElement>("#detail-action"),
  partial: required<HTMLElement>("#partial-target"),
  transparent: required<HTMLElement>("#transparent-target"),
  opaque: required<HTMLElement>("#opaque-target"),
  iframe: required<HTMLIFrameElement>("#iframe-host"),
} as const;

const scenarioClass: Record<Scenario, string | null> = {
  baseline: null,
  "xhs-open": "xhs-open",
  "partial-open": "partial-open",
  "transparent-open": "transparent-open",
  "opaque-open": "opaque-open",
  "rounded-open": "rounded-open",
  "pointer-target": "pointer-target",
  "negative-background": "negative-background",
  "elevated-child": "elevated-child",
  "rounded-parent": "rounded-parent",
  "unknown-clipping": "unknown-clipping",
  "visibility-override": "visibility-override",
  "grid-stacking": "grid-stacking",
  "modern-alpha": "modern-alpha",
};

function setScenario(scenario: Scenario): void {
  for (const className of Object.values(scenarioClass)) {
    if (className) document.body.classList.remove(className);
  }
  const className = scenarioClass[scenario];
  if (className) document.body.classList.add(className);
}

function setPressed(selector: string, pressed: boolean): void {
  required<HTMLButtonElement>(selector).setAttribute("aria-pressed", String(pressed));
}

function check(name: string, pass: boolean, observed: unknown): CheckResult {
  return { name, pass, observed };
}

function slotFor(frame: any, element: Element): any {
  const nodeRef = stableNodeRefFor(registry, element);
  return frame.basicKindBatch.slots.find((slot: any) => slot.nodeRef === nodeRef);
}

function candidateFor(frame: any, element: Element): any {
  const nodeRef = stableNodeRefFor(registry, element);
  return frame.candidateBatch.slots.find((slot: any) => slot.nodeRef === nodeRef);
}

function boxFor(frame: any, element: Element): any {
  const nodeRef = stableNodeRefFor(registry, element);
  return frame.boxes.find((box: any) => box.nodeRef === nodeRef);
}

function observationFor(frame: any, element: Element): any {
  const nodeRef = stableNodeRefFor(registry, element);
  return frame.snapshot.observation.nodes.find((node: any) => node.nodeRef === nodeRef);
}

async function executeScenario(scenario: Scenario): Promise<RunResult> {
  setScenario(scenario);
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  let frame: any = null;
  const definitions = createBrowserOverlayNodeDefinitions({
    document,
    window,
    registry,
    excludeHost: result,
    excludeRoots: [controls],
    present: (nextFrame) => {
      frame = nextFrame;
    },
  });
  const compiled = compileWorkflow({
    graph: visualOverlayGraph,
    bindings: {
      "筛选当前视口与关注候选": { config: { viewportOnly: true, scopeMode: "subtree" } },
      "判断DOM基础种类": { config: DEFAULT_BASIC_KIND_CONFIG as unknown as JsonValue },
    },
  }, {
    nodeDefinitions: definitions,
    grantedEffects: ["browser.dom.read", "browser.overlay.present"],
  });
  const runId = `foreground-${scenario}-${Date.now()}`;
  const execution = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "overlay_request",
    type: BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: { snapshotRef: runId, documentRef: "foreground-fixture" },
  }));
  if (execution.status !== "completed" || execution.outputEvent.status !== "ok" || !frame) {
    throw new Error(`Workflow did not complete: ${JSON.stringify(execution)}`);
  }

  const checks: CheckResult[] = [];
  const backgroundSlot = slotFor(frame, targets.backgroundAction);
  const detailSlot = slotFor(frame, targets.detailAction);
  const partialSlot = slotFor(frame, targets.partial);
  const transparentSlot = slotFor(frame, targets.transparent);
  const opaqueSlot = slotFor(frame, targets.opaque);
  const partialBox = boxFor(frame, targets.partial);
  const partialRect = targets.partial.getBoundingClientRect();
  const partialCoverRect = required<HTMLElement>("#partial-cover").getBoundingClientRect();
  const hiddenCenterX = (Math.max(partialRect.left, partialCoverRect.left) + Math.min(partialRect.right, partialCoverRect.right)) / 2;

  if (scenario === "baseline") {
    checks.push(check("background feed action is a candidate", backgroundSlot?.candidateStatus === "ok", backgroundSlot?.candidateStatus));
    checks.push(check("closed detail action is excluded", detailSlot?.candidateStatus !== "ok", detailSlot?.candidateStatus));
  }
  if (scenario === "xhs-open") {
    checks.push(check("background feed action is filtered out", backgroundSlot?.candidateStatus === "filtered_out", backgroundSlot?.candidateStatus));
    checks.push(check("background feed reason is occluded", candidateFor(frame, targets.backgroundAction)?.reasons.includes("occluded"), candidateFor(frame, targets.backgroundAction)?.reasons));
    checks.push(check("foreground detail action remains a candidate", detailSlot?.candidateStatus === "ok", detailSlot?.candidateStatus));
    checks.push(check("occluded background has no overlay box", boxFor(frame, targets.backgroundAction) === undefined, boxFor(frame, targets.backgroundAction)));
    checks.push(check("occluded background is counted as excluded", frame.presentation.view.counts.excluded > 0, frame.presentation.view.counts));
    const session = new BrowserCaptureSession({ sessionId: runId, createdAt: new Date().toISOString() });
    session.collectUnknown(frame);
    const captured = session.toBundle().trainingRequest.rows;
    const occludedRefs = new Set(frame.snapshot.observation.nodes.filter((node: any) => node.foreground === "occluded").map((node: any) => node.nodeRef));
    checks.push(check("unknown capture excludes every occluded target", captured.every(row => !occludedRefs.has(row.inputRef.nodeRef)), captured.length));
    let rejected = false;
    try { session.captureSelected(frame, stableNodeRefFor(registry, targets.backgroundAction), { kind: "unsure" }); } catch { rejected = true; }
    checks.push(check("manual capture rejects occluded target", rejected, rejected));
  }
  if (scenario === "partial-open") {
    checks.push(check("partially exposed target remains a candidate", partialSlot?.candidateStatus === "ok", partialSlot?.candidateStatus));
    checks.push(check("partial target keeps an overlay box", partialBox !== undefined, partialBox));
    checks.push(check("overlay box does not bridge the hidden center", partialBox !== undefined
      && (hiddenCenterX < partialBox.rect.x || hiddenCenterX > partialBox.rect.x + partialBox.rect.width), {
      hiddenCenterX,
      box: partialBox?.rect ?? null,
    }));
    const partialBoxes = frame.boxes.filter((box: any) => box.nodeRef === stableNodeRefFor(registry, targets.partial));
    checks.push(check("both exposed sides have separate boxes", partialBoxes.length === 2
      && partialBoxes.every((box: any) => box.rect.x + box.rect.width <= partialCoverRect.left || box.rect.x >= partialCoverRect.right), partialBoxes));
  }
  if (scenario === "transparent-open") {
    checks.push(check("transparent pass-through target remains a candidate", transparentSlot?.candidateStatus === "ok", transparentSlot?.candidateStatus));
  }
  if (scenario === "opaque-open") {
    checks.push(check("opaque pass-through target is filtered out", opaqueSlot?.candidateStatus === "filtered_out", opaqueSlot?.candidateStatus));
    checks.push(check("opaque pass-through reason is occluded", candidateFor(frame, targets.opaque)?.reasons.includes("occluded"), candidateFor(frame, targets.opaque)?.reasons));
  }
  if (scenario === "rounded-open") {
    checks.push(check("rounded paint is unassessed, never proven occluded", candidateFor(frame, targets.opaque)?.status === "unknown"
      && observationFor(frame, targets.opaque)?.foreground === "unassessed", observationFor(frame, targets.opaque)?.foreground));
  }
  if (["pointer-target", "negative-background", "elevated-child", "visibility-override", "grid-stacking", "modern-alpha"].includes(scenario)) {
    checks.push(check(`${scenario}: foreground stays eligible`, opaqueSlot?.candidateStatus === "ok", observationFor(frame, targets.opaque)));
  }
  if (scenario === "rounded-parent") {
    checks.push(check("ancestor rounded clipping cannot prove rectangle occlusion", observationFor(frame, targets.opaque)?.foreground !== "occluded", observationFor(frame, targets.opaque)));
  }
  if (scenario === "unknown-clipping") {
    checks.push(check("unknown clipping stays unassessed", observationFor(frame, targets.opaque)?.foreground === "unassessed", observationFor(frame, targets.opaque)));
  }

  const foreground = [targets.backgroundAction, targets.detailAction, targets.partial, targets.transparent, targets.opaque, targets.iframe].map((element) => {
    const observation = observationFor(frame, element);
    return {
      nodeRef: stableNodeRefFor(registry, element),
      tag: observation?.tag ?? null,
      id: (element as HTMLElement).id || null,
      foreground: observation?.foreground ?? null,
      exposedRects: observation?.exposedRects ?? observation?.exposedRect ?? null,
    };
  });

  return { scenario, status: execution.outputEvent.status, checks, foreground };
}

async function runFixture(): Promise<void> {
  if (!result) return;
  result.dataset.status = "RUNNING";
  result.textContent = "运行中";
  try {
    const scenarios: readonly Scenario[] = ["baseline", "xhs-open", "partial-open", "transparent-open", "opaque-open", "rounded-open", "pointer-target", "negative-background", "elevated-child", "rounded-parent", "unknown-clipping", "visibility-override", "grid-stacking", "modern-alpha", "baseline"];
    const runs: RunResult[] = [];
    for (const scenario of scenarios) runs.push(await executeScenario(scenario));
    const checks = runs.flatMap((run) => run.checks);
    const status = checks.length > 0 && checks.every((item) => item.pass) ? "PASS" : "FAIL";
    result.dataset.status = status;
    result.textContent = JSON.stringify({
      status,
      publicConsumer: "browser-visual-overlay.graph.json",
      runCount: runs.length,
      checkCount: checks.length,
      failedChecks: checks.filter((item) => !item.pass),
      runs,
    }, null, 2);
  } catch (error) {
    result.dataset.status = "FAIL";
    result.textContent = `FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  } finally {
    setScenario("baseline");
  }
}

function bindToggle(selector: string, scenario: Scenario): void {
  const button = required<HTMLButtonElement>(selector);
  button.addEventListener("click", () => {
    const pressed = button.getAttribute("aria-pressed") !== "true";
    for (const other of ["#toggle-xhs", "#toggle-partial", "#toggle-transparent", "#toggle-opaque"]) {
      setPressed(other, other === selector ? pressed : false);
    }
    setScenario(pressed ? scenario : "baseline");
    void runFixture();
  });
}

bindToggle("#toggle-xhs", "xhs-open");
bindToggle("#toggle-partial", "partial-open");
bindToggle("#toggle-transparent", "transparent-open");
bindToggle("#toggle-opaque", "opaque-open");
required<HTMLButtonElement>("#rerun").addEventListener("click", () => void runFixture());

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void runFixture());
} else {
  void runFixture();
}
