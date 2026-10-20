import {
  BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
  BASIC_KIND_FAMILIES,
  BASIC_KIND_WIRE_NAMES,
  BrowserCaptureSession,
  DEFAULT_BASIC_KIND_CONFIG,
  compileWorkflow,
  createBrowserOverlayNodeDefinitions,
  createStableNodeRefRegistry,
  createWorkflowInputEvent,
  runWorkflow,
  stableNodeRefFor,
  type BasicKindFamily,
  type BasicKindProfile,
  type BasicKindProperties,
  type BasicKindWeights,
  type SpecificBasicKindLabel,
} from "../../lib/browser-classify.js";
import type { JsonValue } from "../../lib/core/contracts.js";
import visualOverlayGraph from "../../workflows/browser-visual-overlay.graph.json";

type Scenario = "baseline" | "xhs-open" | "partial-open" | "transparent-open" | "opaque-open" | "rounded-open"
  | "pointer-target" | "negative-background" | "elevated-child" | "rounded-parent" | "unknown-clipping"
  | "visibility-override" | "grid-stacking" | "modern-alpha" | "clipping" | "paint-svg"
  | "actual-focus" | "actual-focus-lost" | "editable";

interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  readonly observed: unknown;
}

interface RunResult {
  readonly scenario: Scenario;
  readonly status: string;
  readonly checks: readonly CheckResult[];
  readonly editable?: EditableScenarioResult;
  readonly foreground: readonly {
    readonly nodeRef: string;
    readonly name: string | null;
    readonly tag: string | null;
    readonly id: string | null;
    readonly foreground: unknown;
    readonly clippedRect: unknown;
    readonly exposedRects: unknown;
  }[];
}

type EditableMeasuredValue = boolean | null | "missing";

interface EditablePublicState {
  readonly publicStatus: string | null;
  readonly candidateStatus: string | null;
  readonly judgmentStatus: string | null;
  readonly basicKind: string | null;
  readonly attrEditable: number | null;
  readonly editableNonInput: number | null;
}

interface EditableCaseResult {
  readonly id: string;
  readonly note: string;
  readonly native: {
    readonly value: EditableMeasuredValue;
    readonly type: string;
    readonly attribute: string | null;
    readonly designMode: string | null;
    readonly cssUserModify: string;
    readonly error: string | null;
    readonly public: EditablePublicState;
  };
  readonly masked: {
    readonly value: EditableMeasuredValue;
    readonly designMode: string | null;
    readonly public: EditablePublicState;
  };
  readonly expectedNative: boolean | null;
  readonly expectedMasked: boolean | null;
  readonly expectationBasis: "html" | "native" | "native-selector";
  readonly nativeMatchesExpected: boolean | null;
  readonly maskedMatchesExpected: boolean | null;
  readonly maskedMatchesNative: boolean | null;
}

interface EditableScenarioResult {
  readonly cases: readonly EditableCaseResult[];
  readonly mismatches: readonly string[];
  readonly nativeGetterAvailable: boolean;
  readonly activeElementPreserved: boolean;
  readonly geometryPreserved: boolean;
  readonly globalPrototypeUnchanged: boolean;
  readonly mainDesignModePreserved: boolean;
  readonly disposableFramesRemoved: boolean;
  readonly selectorEvidence: SelectorScenarioResult | null;
  readonly blocker: string | null;
}

type SelectorAvailability = "available" | "throwing" | "nonBoolean";

interface SelectorFact {
  readonly value: boolean | null;
  readonly availability: SelectorAvailability;
  readonly error: string | null;
}

type SelectorEligibility = "eligible" | "not-eligible";

interface SelectorRow {
  readonly id: string;
  readonly note: string;
  readonly namespace: string | null;
  readonly localName: string;
  readonly declaration: string | null;
  readonly designMode: string | null;
  readonly nativeBoolean: boolean | null;
  readonly nativeType: string;
  readonly selector: {
    readonly readWrite: SelectorFact;
    readonly readOnly: SelectorFact;
  };
  readonly eligibility: SelectorEligibility;
  readonly ineligibleReason: string | null;
  readonly masked: {
    readonly value: EditableMeasuredValue;
    readonly selectorAvailability: SelectorAvailability;
    readonly designMode: string | null;
    readonly forwarded: boolean | null;
    readonly isContentEditableHidden: boolean;
    readonly designModeHidden: boolean;
  } | null;
  readonly matchesNative: boolean | null;
}

interface SelectorScenarioResult {
  readonly rows: readonly SelectorRow[];
  readonly eligibleMismatches: readonly string[];
  readonly counterexamples: readonly string[];
  readonly eligibleMatchCount: number;
  readonly selectorForwardedToOriginalReceiver: boolean;
  readonly unavailableSelectorRetainsNull: boolean;
  readonly availableMaskAgreement: boolean;
  readonly blocker: string | null;
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
  scaledRetained: required<HTMLElement>("#scaled-retained"),
  scaledFree: required<HTMLElement>("#scaled-free-target"),
  svgShape: required<SVGGraphicsElement>("#svg-root-shape"),
  scaledExcluded: required<HTMLElement>("#scaled-excluded"),
  nested: required<HTMLElement>("#nested-clip-target"),
  legacyAbsolute: required<HTMLElement>("#legacy-absolute-target"),
  legacyStatic: required<HTMLElement>("#legacy-static-target"),
  unsupportedRotate: required<HTMLElement>("#unsupported-rotate-target"),
  unsupportedClipPath: required<HTMLElement>("#unsupported-clip-path-target"),
  paintSvgOuter: required<SVGSVGElement>("#paint-svg-outer"),
  paintSvgNested: required<SVGSVGElement>("#paint-svg-nested"),
  paintSvgClippedGroup: required<SVGGElement>("#paint-svg-clipped-group"),
  paintSvgClippedShape: required<SVGPathElement>("#paint-svg-clipped-shape"),
  paintLetterboxOuter: required<SVGSVGElement>("#paint-letterbox-outer"),
  paintLetterboxNested: required<SVGSVGElement>("#paint-letterbox-nested"),
  paintLetterboxShape: required<SVGRectElement>("#paint-letterbox-shape"),
  paintUnpaintedRadiusImage: required<HTMLImageElement>("#paint-unpainted-radius-image"),
  paintBorderRingImage: required<HTMLImageElement>("#paint-border-ring-image"),
  paintOpacityZeroImage: required<HTMLImageElement>("#paint-opacity-zero-image"),
  paintOpacityZeroOverlay: required<HTMLButtonElement>("#paint-opacity-zero-overlay"),
  paintOpaqueHeaderImage: required<HTMLImageElement>("#paint-opaque-header-image"),
  paintOpaqueHeader: required<HTMLElement>("#paint-opaque-header"),
  paintShadowOnlyImage: required<HTMLImageElement>("#paint-shadow-only-image"),
  paintShadowOnlyOverlay: required<HTMLElement>("#paint-shadow-only-overlay"),
  actualFocusTarget: required<HTMLElement>("#actual-focus-target"),
  actualFocusControl: required<HTMLElement>("#actual-focus-control"),
  editableExplicitTrue: required<HTMLElement>("#editable-explicit-true"),
  editableExplicitFalse: required<HTMLElement>("#editable-explicit-false"),
  editablePlaintextOnly: required<HTMLElement>("#editable-plaintext-only"),
  editableInheritedChild: required<HTMLElement>("#editable-inherited-child"),
  editableNestedFalseChild: required<HTMLElement>("#editable-nested-false-child"),
  editableNestedTrueGrandchild: required<HTMLElement>("#editable-nested-true-grandchild"),
  editablePaddedInvalid: required<HTMLElement>("#editable-padded-invalid"),
  editableCssReadOnly: required<HTMLElement>("#editable-css-read-only"),
  editableCssReadWrite: required<HTMLElement>("#editable-css-read-write"),
  editableFrameHost: required<HTMLElement>("#editable-frame-host"),
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
  clipping: "clipping-open",
  "paint-svg": "paint-svg-open",
  "actual-focus": "actual-focus-open",
  "actual-focus-lost": "actual-focus-open",
  editable: "editable-open",
};

function zeroWeights(): BasicKindWeights {
  return Object.fromEntries(BASIC_KIND_WIRE_NAMES.map((wire) => [wire, 0])) as BasicKindWeights;
}
function zeroRows<T extends string>(names: readonly T[]): Record<T, BasicKindWeights> {
  return Object.fromEntries(names.map((name) => [name, zeroWeights()])) as Record<T, BasicKindWeights>;
}
const fixtureFamilyWeights = zeroRows(Object.keys(BASIC_KIND_FAMILIES) as BasicKindFamily[]);
const fixtureLeafWeights = zeroRows(Object.values(BASIC_KIND_FAMILIES).flat() as SpecificBasicKindLabel[]);
const actualFocusProfile: BasicKindProfile = {
  id: "fixture-actual-focus-v1",
  familyWeights: {
    ...fixtureFamilyWeights,
    structure: { ...fixtureFamilyWeights.structure, neutral_actual_focus: 1 },
  },
  leafWeights: {
    ...fixtureLeafWeights,
    container: { ...fixtureLeafWeights.container, neutral_actual_focus: 1 },
  },
};
const actualFocusProfileId = actualFocusProfile.id;

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

interface RectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function rectClose(actual: RectLike | null | undefined, expected: RectLike, tolerance = 0.06): boolean {
  return actual !== null && actual !== undefined
    && Math.abs(actual.x - expected.x) <= tolerance
    && Math.abs(actual.y - expected.y) <= tolerance
    && Math.abs(actual.width - expected.width) <= tolerance
    && Math.abs(actual.height - expected.height) <= tolerance;
}

function intersectRect(a: RectLike, b: RectLike): RectLike {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

function exposedArea(rects: readonly RectLike[] | null | undefined): number {
  if (!Array.isArray(rects)) return 0;
  return rects.reduce((sum, rect) => sum + Math.max(0, rect.width) * Math.max(0, rect.height), 0);
}

// Independent oracle: measured bounds plus the fixture's declared cumulative scale and client metrics.
function clientClip(element: Element, scaleX: number, scaleY: number): RectLike {
  const bounds = element.getBoundingClientRect();
  return {
    x: bounds.x + scaleX * element.clientLeft,
    y: bounds.y + scaleY * element.clientTop,
    width: scaleX * element.clientWidth,
    height: scaleY * element.clientHeight,
  };
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

function measurementFor(frame: any, element: Element): BasicKindProperties | undefined {
  return frame.snapshot.properties.get(stableNodeRefFor(registry, element));
}

interface FixtureView {
  readonly document: Document;
  readonly window: Window;
  wrapElement(element: Element): Element;
  unwrapElement(element: Element): Element;
}

const forwardedGeometryProperties = new Set<PropertyKey>([
  "clientLeft", "clientTop", "clientWidth", "clientHeight",
  "offsetLeft", "offsetTop", "offsetWidth", "offsetHeight",
  "scrollLeft", "scrollTop", "scrollWidth", "scrollHeight",
]);

// The view keeps native DOM identity and layout. Only the requested read is
// masked; every element proxy is retained so WeakRef lookups stay resolvable.
function createFixtureView(
  realDocument: Document,
  realWindow: Window,
  options: { readonly maskIsContentEditable: boolean; readonly maskDesignMode?: boolean; readonly maskSelectorMatches?: boolean },
): FixtureView {
  const proxies = new WeakMap<Element, Element>();
  const natives = new WeakMap<Element, Element>();
  const retained: Element[] = [];
  let documentView!: Document;
  const unwrapElement = (element: Element): Element => natives.get(element) ?? element;
  const wrapNode = (node: Node): Node => node.nodeType === 1 ? wrapElement(node as Element) : node;

  function wrapElement(element: Element): Element {
    const cached = proxies.get(element);
    if (cached) return cached;
    const proxy = new Proxy(element, {
      get(target, property) {
        if (property === "isContentEditable") {
          return options.maskIsContentEditable ? undefined : Reflect.get(target, property, target);
        }
        // Selector reads must still forward to the original element receiver in the
        // evidence view. The unavailable variant throws so the resolver's guard can
        // be observed as a retained null, not a fabricated boolean.
        if (property === "matches" && options.maskSelectorMatches === true) {
          return () => { throw new Error("selector masked"); };
        }
        if (property === "ownerDocument") return documentView;
        if (property === "parentElement") {
          return target.parentElement === null ? null : wrapElement(target.parentElement);
        }
        if (property === "children") {
          return Array.from(target.children, (child) => wrapElement(child));
        }
        if (property === "childNodes") {
          return Array.from(target.childNodes, wrapNode);
        }
        if (property === "querySelectorAll") {
          return (selectors: string) => Array.from(target.querySelectorAll(selectors), (child) => wrapElement(child));
        }
        if (property === "getBoundingClientRect") return () => target.getBoundingClientRect();
        if (property === "getClientRects") return () => target.getClientRects();
        if (forwardedGeometryProperties.has(property)) return Reflect.get(target, property, target);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    proxies.set(element, proxy);
    natives.set(proxy, element);
    retained.push(proxy);
    return proxy;
  }

  documentView = {
    get documentElement() {
      return realDocument.documentElement === null ? null : wrapElement(realDocument.documentElement);
    },
    get activeElement() {
      return realDocument.activeElement === null ? null : wrapElement(realDocument.activeElement);
    },
    get designMode() {
      return options.maskDesignMode === true ? undefined : realDocument.designMode;
    },
    get baseURI() {
      return realDocument.baseURI;
    },
    querySelectorAll(selectors: string) {
      return Array.from(realDocument.querySelectorAll(selectors), (child) => wrapElement(child)) as unknown as NodeListOf<Element>;
    },
    ...(typeof realDocument.elementsFromPoint === "function" ? {
      elementsFromPoint(x: number, y: number) {
        return Array.from(realDocument.elementsFromPoint(x, y), (child) => wrapElement(child));
      },
    } : {}),
  } as unknown as Document;

  const windowView = {
    get innerWidth() { return realWindow.innerWidth; },
    get innerHeight() { return realWindow.innerHeight; },
    get document() { return documentView; },
    getComputedStyle(element: Element, pseudo?: string | null) {
      return realWindow.getComputedStyle(unwrapElement(element), pseudo ?? undefined);
    },
  } as unknown as Window;

  return { document: documentView, window: windowView, wrapElement, unwrapElement };
}

function nativeEditableFact(element: Element): { value: EditableMeasuredValue; type: string; error: string | null } {
  try {
    const raw = (element as HTMLElement).isContentEditable;
    return {
      value: typeof raw === "boolean" ? raw : raw === null ? null : "missing",
      type: typeof raw,
      error: null,
    };
  } catch (error) {
    return { value: "missing", type: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
}

function designModeFact(documentValue: Document): string | null {
  try {
    return typeof documentValue.designMode === "string" ? documentValue.designMode : null;
  } catch {
    return null;
  }
}

const XHTML_NAMESPACE_URI = "http://www.w3.org/1999/xhtml";

// Read the native pseudo-class on the original element. A throw or non-Boolean
// answer is missingness for the capability gate, never a fabricated false.
function readSelector(element: Element, selector: ":read-write" | ":read-only"): SelectorFact {
  try {
    const matched = element.matches(selector);
    return typeof matched === "boolean"
      ? { value: matched, availability: "available", error: null }
      : { value: null, availability: "nonBoolean", error: null };
  } catch (error) {
    return { value: null, availability: "throwing", error: error instanceof Error ? error.message : String(error) };
  }
}

// Eligible means exactly the plan's supported boundary: XHTML namespace, a
// non-input/non-textarea target, and a complete all-XHTML chain to this root.
function selectorIneligibility(element: Element, documentValue: Document): string | null {
  if (element.namespaceURI !== XHTML_NAMESPACE_URI) return "non-html-namespace";
  const local = element.localName.toLowerCase();
  if (local === "input" || local === "textarea") return "form-control-excluded";
  let root: Element | null;
  try {
    root = documentValue.documentElement;
  } catch {
    return "unreadable-root";
  }
  if (!root) return "missing-root";
  const visited = new Set<Element>();
  let cursor: Element | null = element;
  while (cursor) {
    if (visited.has(cursor)) return "cyclic-ancestry";
    visited.add(cursor);
    if (cursor.namespaceURI !== XHTML_NAMESPACE_URI) return "mixed-namespace-ancestry";
    if (cursor === root) return null;
    try {
      cursor = cursor.parentElement;
    } catch {
      return "unreadable-ancestry";
    }
  }
  return "incomplete-ancestry";
}

function editableMeasurementValue(frame: any, captureRegistry: ReturnType<typeof createStableNodeRefRegistry>, element: Element): EditableMeasuredValue {
  const measurement = frame.snapshot.properties.get(stableNodeRefFor(captureRegistry, element));
  const value = measurement?.contentEditable;
  return typeof value === "boolean" ? value : value === null ? null : "missing";
}

function editablePublicState(
  frame: any,
  captureRegistry: ReturnType<typeof createStableNodeRefRegistry>,
  element: Element,
  publicStatus: string,
): EditablePublicState {
  const slot = frame.basicKindBatch.slots.find((item: any) => item.nodeRef === stableNodeRefFor(captureRegistry, element));
  return {
    publicStatus,
    candidateStatus: slot?.candidateStatus ?? null,
    judgmentStatus: slot?.judgmentStatus ?? null,
    basicKind: slot?.basicKind ?? null,
    attrEditable: slot?.evidence?.wires?.attr_editable ?? null,
    editableNonInput: slot?.evidence?.wires?.editable_non_input ?? null,
  };
}

async function runEditableCapture(resources: {
  readonly document: Document;
  readonly window: Window;
  readonly registry: ReturnType<typeof createStableNodeRefRegistry>;
  readonly excludeRoots: readonly Element[];
}): Promise<{ readonly frame: any; readonly status: string }> {
  let frame: any = null;
  const definitions = createBrowserOverlayNodeDefinitions({
    document: resources.document,
    window: resources.window,
    registry: resources.registry,
    excludeHost: null,
    excludeRoots: resources.excludeRoots,
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
  const runId = `editable-${Date.now()}-${resources.registry.prefix}`;
  const execution = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "overlay_request",
    type: BROWSER_OVERLAY_REQUEST_EVENT_TYPE,
    correlation: {},
    payload: { snapshotRef: runId, documentRef: "editable-fixture" },
  }));
  if (execution.status !== "completed" || execution.outputEvent.status !== "ok" || !frame) {
    throw new Error(`Editable workflow did not complete: ${JSON.stringify(execution)}`);
  }
  return { frame, status: execution.outputEvent.status };
}

function sameRectList(left: DOMRectList, right: DOMRectList): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    if (!a || !b || Math.abs(a.x - b.x) > 0.001 || Math.abs(a.y - b.y) > 0.001
      || Math.abs(a.width - b.width) > 0.001 || Math.abs(a.height - b.height) > 0.001) return false;
  }
  return true;
}

interface EditableCaseSpec {
  readonly id: string;
  readonly note: string;
  readonly element: Element;
  readonly expectedNative?: boolean | null;
  readonly expectedMasked?: boolean | null;
  readonly basis: "html" | "native" | "native-selector";
}

interface EditablePair {
  readonly nativeFrame: any;
  readonly maskedFrame: any;
  readonly nativeStatus: string;
  readonly maskedStatus: string;
  readonly nativeRegistry: ReturnType<typeof createStableNodeRefRegistry>;
  readonly maskedRegistry: ReturnType<typeof createStableNodeRefRegistry>;
  readonly view: FixtureView;
  readonly nativeDocument: Document;
  readonly nativeWindow: Window;
}

async function captureEditablePair(
  nativeDocument: Document,
  nativeWindow: Window,
  options: { readonly exclude?: readonly Element[]; readonly maskDesignMode?: boolean },
): Promise<EditablePair> {
  const nativeRegistry = createStableNodeRefRegistry(`editable-native-${Date.now()}`);
  const nativeCapture = await runEditableCapture({
    document: nativeDocument,
    window: nativeWindow,
    registry: nativeRegistry,
    excludeRoots: options.exclude ?? [],
  });
  const view = createFixtureView(nativeDocument, nativeWindow, {
    maskIsContentEditable: true,
    ...(options.maskDesignMode === true ? { maskDesignMode: true } : {}),
  });
  const maskedRegistry = createStableNodeRefRegistry(`editable-masked-${Date.now()}`);
  const maskedCapture = await runEditableCapture({
    document: view.document,
    window: view.window,
    registry: maskedRegistry,
    excludeRoots: (options.exclude ?? []).map((element) => view.wrapElement(element)),
  });
  return {
    nativeFrame: nativeCapture.frame,
    maskedFrame: maskedCapture.frame,
    nativeStatus: nativeCapture.status,
    maskedStatus: maskedCapture.status,
    nativeRegistry,
    maskedRegistry,
    view,
    nativeDocument,
    nativeWindow,
  };
}

function editableCaseResult(
  spec: EditableCaseSpec,
  pair: EditablePair,
): EditableCaseResult {
  const nativeFact = nativeEditableFact(spec.element);
  const maskedElement = pair.view.wrapElement(spec.element);
  const maskedValue = editableMeasurementValue(pair.maskedFrame, pair.maskedRegistry, maskedElement);
  const nativeBasis = spec.basis === "native" || spec.basis === "native-selector";
  const nativeExpected = nativeBasis
    ? (typeof nativeFact.value === "boolean" ? nativeFact.value : null)
    : spec.expectedNative ?? null;
  const maskedExpected = nativeBasis
    ? (typeof nativeFact.value === "boolean" ? nativeFact.value : null)
    : spec.expectedMasked ?? null;
  const nativeComparable = nativeBasis || spec.expectedNative !== undefined;
  const maskedComparable = nativeBasis ? typeof nativeFact.value === "boolean" : spec.expectedMasked !== undefined;
  const nativeMatchesExpected = nativeComparable && typeof nativeFact.value === "boolean"
    ? nativeFact.value === nativeExpected : null;
  const maskedMatchesExpected = maskedComparable && maskedValue !== "missing"
    ? maskedValue === maskedExpected : null;
  const maskedMatchesNative = typeof nativeFact.value === "boolean" && maskedValue !== "missing"
    ? maskedValue === nativeFact.value : null;
  const nativeDesignMode = designModeFact(pair.nativeDocument);
  const maskedDesignMode = designModeFact(pair.view.document);
  const nativePublic = editablePublicState(pair.nativeFrame, pair.nativeRegistry, spec.element, pair.nativeStatus);
  const maskedPublic = editablePublicState(pair.maskedFrame, pair.maskedRegistry, maskedElement, pair.maskedStatus);
  return {
    id: spec.id,
    note: spec.note,
    native: {
      value: nativeFact.value,
      type: nativeFact.type,
      attribute: spec.element.getAttribute("contenteditable"),
      designMode: nativeDesignMode,
      cssUserModify: pair.nativeWindow.getComputedStyle(spec.element).getPropertyValue("-webkit-user-modify").trim(),
      error: nativeFact.error,
      public: nativePublic,
    },
    masked: {
      value: maskedValue,
      designMode: maskedDesignMode,
      public: maskedPublic,
    },
    expectedNative: nativeExpected,
    expectedMasked: maskedExpected,
    expectationBasis: spec.basis,
    nativeMatchesExpected,
    maskedMatchesExpected,
    maskedMatchesNative,
  };
}

interface DisposableDocument {
  readonly iframe: HTMLIFrameElement;
  readonly document: Document;
  readonly window: Window;
}

const DESIGN_MODE_FIXTURE_SRCDOC = `<!doctype html><html><head><style>
    html,body { margin: 0; padding: 0; background: #fff; }
    body { padding: 10px; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; }
    #designmode-target { min-height: 42px; padding: 8px; border: 1px solid #64748b; background: #e2e8f0; }
  </style></head><body><div id="designmode-target">designMode target</div></body></html>`;

async function mountDisposableDocument(options: {
  readonly title: string;
  readonly srcdoc: string;
  readonly designMode: "on" | "off";
}): Promise<DisposableDocument> {
  const iframe = document.createElement("iframe");
  iframe.className = "editable-fixture-frame";
  iframe.title = options.title;
  iframe.srcdoc = options.srcdoc;
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Disposable fixture "${options.title}" load timed out`)), 3000);
    iframe.addEventListener("load", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  targets.editableFrameHost.append(iframe);
  try {
    await loaded;
    const frameDocument = iframe.contentDocument;
    const frameWindow = iframe.contentWindow;
    if (!frameDocument || !frameWindow) throw new Error("Disposable iframe has no same-origin document");
    frameDocument.designMode = options.designMode;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { iframe, document: frameDocument, window: frameWindow };
  } catch (error) {
    iframe.remove();
    throw error;
  }
}

async function createDisposableDesignModeFixture(mode: "on" | "off"): Promise<{
  readonly iframe: HTMLIFrameElement;
  readonly document: Document;
  readonly window: Window;
}> {
  return mountDisposableDocument({ title: `designMode ${mode} fixture`, srcdoc: DESIGN_MODE_FIXTURE_SRCDOC, designMode: mode });
}

function matrixDocument(options: { readonly htmlDeclaration?: string | null; readonly body: string }): string {
  const htmlAttribute = options.htmlDeclaration == null ? "" : ` contenteditable="${options.htmlDeclaration}"`;
  return `<!doctype html><html${htmlAttribute}><head><style>
    html,body { margin: 0; padding: 0; background: #fff; }
    body { padding: 10px; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; }
    input,textarea,div,svg,foreignObject { margin: 2px; display: inline-block; }
  </style></head><body>${options.body}</body></html>`;
}

function selectorRow(
  id: string,
  note: string,
  element: Element,
  documentValue: Document,
  masked?: SelectorRow["masked"],
): SelectorRow {
  const native = nativeEditableFact(element);
  let declaration: string | null = null;
  try {
    declaration = element.getAttribute("contenteditable");
  } catch {
    declaration = null;
  }
  const ineligibleReason = selectorIneligibility(element, documentValue);
  const readWrite = readSelector(element, ":read-write");
  const readOnly = readSelector(element, ":read-only");
  const nativeBoolean = typeof native.value === "boolean" ? native.value : null;
  const matchesNative = ineligibleReason === null && nativeBoolean !== null && readWrite.value !== null && readOnly.value !== null
    ? readWrite.value === nativeBoolean && readOnly.value === !nativeBoolean
    : null;
  return {
    id,
    note,
    namespace: element.namespaceURI,
    localName: typeof element.localName === "string" ? element.localName.toLowerCase() : "",
    declaration,
    designMode: designModeFact(documentValue),
    nativeBoolean,
    nativeType: native.type,
    selector: { readWrite, readOnly },
    eligibility: ineligibleReason === null ? "eligible" : "not-eligible",
    ineligibleReason,
    masked: masked ?? null,
    matchesNative,
  };
}

async function maskedSelectorProbe(
  nativeDocument: Document,
  nativeWindow: Window,
  nativeElement: Element,
  maskSelectorMatches: boolean,
): Promise<NonNullable<SelectorRow["masked"]>> {
  const view = createFixtureView(nativeDocument, nativeWindow, {
    maskIsContentEditable: true,
    maskDesignMode: true,
    ...(maskSelectorMatches ? { maskSelectorMatches: true } : {}),
  });
  const maskedElement = view.wrapElement(nativeElement);
  const maskedRegistry = createStableNodeRefRegistry(`editable-selector-${Date.now()}`);
  const capture = await runEditableCapture({ document: view.document, window: view.window, registry: maskedRegistry, excludeRoots: [] });
  const value = editableMeasurementValue(capture.frame, maskedRegistry, maskedElement);
  const readWrite = readSelector(maskedElement, ":read-write");
  let forwarded: boolean | null = null;
  if (!maskSelectorMatches) {
    try {
      forwarded = maskedElement.matches(":read-write") === nativeElement.matches(":read-write");
    } catch {
      forwarded = null;
    }
  }
  return {
    value,
    selectorAvailability: readWrite.availability,
    designMode: designModeFact(view.document),
    forwarded,
    isContentEditableHidden: (maskedElement as { isContentEditable?: unknown }).isContentEditable === undefined,
    designModeHidden: (view.document as { designMode?: unknown }).designMode === undefined,
  };
}

async function runSelectorEvidence(): Promise<{ result: SelectorScenarioResult; checks: readonly CheckResult[] }> {
  const checks: CheckResult[] = [];
  const rows: SelectorRow[] = [];
  let blocker: string | null = null;

  try {
    // Base no-declaration DIV under designMode off/on, both getters masked and the
    // native selector still forwarded. Reuses the existing disposable document.
    for (const mode of ["off", "on"] as const) {
      const fixture = await createDisposableDesignModeFixture(mode);
      try {
        const target = fixture.document.querySelector<HTMLElement>("#designmode-target");
        if (!target) throw new Error(`Missing designMode target for ${mode}`);
        const masked = await maskedSelectorProbe(fixture.document, fixture.window, target, false);
        rows.push(selectorRow(`no-decl-div-designmode-${mode}`, `no-declaration DIV under designMode ${mode}`, target, fixture.document, masked));
      } finally {
        fixture.iframe.remove();
      }
    }

    // Control: both getters and the selector are masked. The current and future
    // resolver must retain null instead of inventing a boolean.
    {
      const fixture = await createDisposableDesignModeFixture("off");
      try {
        const target = fixture.document.querySelector<HTMLElement>("#designmode-target");
        if (!target) throw new Error("Missing designMode target for unavailable control");
        const masked = await maskedSelectorProbe(fixture.document, fixture.window, target, true);
        rows.push(selectorRow("no-decl-div-selector-unavailable", "no-declaration DIV with selector unavailable", target, fixture.document, masked));
      } finally {
        fixture.iframe.remove();
      }
    }

    // Root declaration matrix: absent, false, true and plaintext-only, each under
    // designMode off/on, recording the root and an ordinary descendant.
    const rootDeclarations: readonly { readonly id: string; readonly attribute: string | null }[] = [
      { id: "decl-absent", attribute: null },
      { id: "decl-false", attribute: "false" },
      { id: "decl-true", attribute: "true" },
      { id: "decl-plaintext-only", attribute: "plaintext-only" },
    ];
    for (const declaration of rootDeclarations) {
      for (const mode of ["off", "on"] as const) {
        const fixture = await mountDisposableDocument({
          title: `${declaration.id} designMode ${mode}`,
          designMode: mode,
          srcdoc: matrixDocument({ htmlDeclaration: declaration.attribute, body: `<div id="ordinary-child">ordinary child</div>` }),
        });
        try {
          const root = fixture.document.documentElement;
          const child = fixture.document.querySelector<HTMLElement>("#ordinary-child");
          if (!root || !child) throw new Error(`Missing root or child for ${declaration.id} ${mode}`);
          rows.push(selectorRow(`root-${declaration.id}-designmode-${mode}-root`, `root ${declaration.id}, designMode ${mode}`, root, fixture.document));
          rows.push(selectorRow(`root-${declaration.id}-designmode-${mode}-child`, `ordinary child under ${declaration.id}, designMode ${mode}`, child, fixture.document));
        } finally {
          fixture.iframe.remove();
        }
      }
    }

    // Non-root false barrier under designMode on with a nested true descendant.
    {
      const fixture = await mountDisposableDocument({
        title: "false barrier designMode on",
        designMode: "on",
        srcdoc: matrixDocument({ htmlDeclaration: null, body: `<div id="barrier" contenteditable="false"><div id="nested" contenteditable="true">nested true</div></div>` }),
      });
      try {
        const barrier = fixture.document.querySelector<HTMLElement>("#barrier");
        const nested = fixture.document.querySelector<HTMLElement>("#nested");
        if (!barrier || !nested) throw new Error("Missing barrier or nested target");
        // Run the same production workflow capture with both getters masked so the
        // native counterexample is verified through the observer, not only raw facts.
        const masked = await maskedSelectorProbe(fixture.document, fixture.window, barrier, false);
        rows.push(selectorRow("false-barrier", "false barrier under designMode on", barrier, fixture.document, masked));
        rows.push(selectorRow("barrier-nested-true", "nested true inside a false barrier", nested, fixture.document));
      } finally {
        fixture.iframe.remove();
      }
    }

    // Form controls, checkbox and namespace boundaries.
    {
      const body = `<input id="input-normal" type="text"><input id="input-readonly" type="text" readonly><input id="input-disabled" type="text" disabled><textarea id="textarea-normal"></textarea><textarea id="textarea-readonly" readonly></textarea><textarea id="textarea-disabled" disabled></textarea><div id="editable-parent" contenteditable="true"><input id="input-normal-in-editable" type="text"><input id="input-readonly-in-editable" type="text" readonly><input id="input-disabled-in-editable" type="text" disabled><textarea id="textarea-normal-in-editable"></textarea><textarea id="textarea-readonly-in-editable" readonly></textarea><textarea id="textarea-disabled-in-editable" disabled></textarea></div><input id="checkbox" type="checkbox"><svg id="svg-root" width="40" height="40"><rect id="svg-target" width="20" height="20"></rect></svg><svg id="foreign-root" width="60" height="30"><foreignObject width="60" height="30"><div id="foreign-html">foreign html</div></foreignObject></svg>`;
      const fixture = await mountDisposableDocument({ title: "form control matrix", designMode: "off", srcdoc: matrixDocument({ htmlDeclaration: null, body }) });
      try {
        const controlIds = ["input-normal", "input-readonly", "input-disabled", "textarea-normal", "textarea-readonly", "textarea-disabled", "input-normal-in-editable", "input-readonly-in-editable", "input-disabled-in-editable", "textarea-normal-in-editable", "textarea-readonly-in-editable", "textarea-disabled-in-editable", "checkbox"];
        for (const id of controlIds) {
          const element = fixture.document.querySelector<HTMLElement>(`#${id}`);
          if (!element) throw new Error(`Missing form control ${id}`);
          rows.push(selectorRow(id, `form control ${id}`, element, fixture.document));
        }
        const svg = fixture.document.querySelector<SVGElement>("#svg-target");
        if (!svg) throw new Error("Missing SVG target");
        rows.push(selectorRow("svg-target", "SVG rect target", svg, fixture.document));
        const foreign = fixture.document.querySelector<HTMLElement>("#foreign-html");
        if (!foreign) throw new Error("Missing foreignObject HTML target");
        rows.push(selectorRow("foreign-object-html", "HTML below foreignObject", foreign, fixture.document));
      } finally {
        fixture.iframe.remove();
      }
    }
  } catch (error) {
    blocker = error instanceof Error ? error.message : String(error);
  }

  const eligibleRows = rows.filter((row) => row.eligibility === "eligible");
  const eligibleMismatches = eligibleRows.filter((row) => row.matchesNative !== true).map((row) => row.id);
  const formRows = rows.filter((row) => row.localName === "input" || row.localName === "textarea");
  const counterexamples = formRows
    .filter((row) => row.selector.readWrite.value !== null && row.nativeBoolean !== null && row.selector.readWrite.value !== row.nativeBoolean)
    .map((row) => row.id);
  const namespaceRows = rows.filter((row) => row.id === "svg-target" || row.id === "foreign-object-html");
  const availableProbes = rows.filter((row) => row.masked !== null && row.masked.selectorAvailability === "available");
  const maskedProbes = rows.filter((row) => row.masked !== null);
  const unavailableRow = rows.find((row) => row.id === "no-decl-div-selector-unavailable") ?? null;
  const unavailableSelectorRetainsNull = unavailableRow !== null && unavailableRow.masked !== null && unavailableRow.masked.value === null;
  // A masked capture with an available selector must return the native Boolean.
  // A null, "missing", or opposite value is a failure, not a pending capability.
  const availableEligibleProbes = availableProbes.filter((row) => row.eligibility === "eligible");
  const availableMaskFailures = availableEligibleProbes
    .filter((row) => row.nativeBoolean === null || row.masked === null || row.masked.value !== row.nativeBoolean)
    .map((row) => row.id);
  const availableMaskAgreement = availableEligibleProbes.length > 0 && availableMaskFailures.length === 0;
  const ordinaryModeRows = ["no-decl-div-designmode-off", "no-decl-div-designmode-on"]
    .map((id) => rows.find((row) => row.id === id) ?? null);
  const ordinaryModeAgreement = ordinaryModeRows.every((row) => row !== null
    && row.masked !== null
    && row.masked.selectorAvailability === "available"
    && row.masked.isContentEditableHidden
    && row.masked.designModeHidden
    && row.nativeBoolean !== null
    && row.masked.value === row.nativeBoolean);
  const falseBarrierRow = rows.find((row) => row.id === "false-barrier") ?? null;
  const falseBarrierMaskedCapture = falseBarrierRow !== null
    && falseBarrierRow.nativeBoolean === true
    && falseBarrierRow.selector.readWrite.value === true
    && falseBarrierRow.selector.readOnly.value === false
    && falseBarrierRow.masked !== null
    && falseBarrierRow.masked.isContentEditableHidden
    && falseBarrierRow.masked.designModeHidden
    && falseBarrierRow.masked.forwarded === true
    && falseBarrierRow.masked.value === falseBarrierRow.nativeBoolean;
  const selectorForwardedToOriginalReceiver = availableProbes.length > 0 && availableProbes.every((row) => row.masked?.forwarded === true);
  const fixturesRemoved = targets.editableFrameHost.children.length === 0;

  checks.push(check("editable selector evidence: eligible non-form HTML rows are collected", eligibleRows.length > 0, {
    eligibleCount: eligibleRows.length,
    eligibleIds: eligibleRows.map((row) => row.id),
  }));
  checks.push(check("editable selector evidence: eligible :read-write and :read-only agree with native isContentEditable", eligibleMismatches.length === 0, {
    eligibleMismatches,
    eligibleCount: eligibleRows.length,
  }));
  checks.push(check("editable selector evidence: input and textarea rows are excluded from eligibility", formRows.length > 0 && formRows.every((row) => row.eligibility === "not-eligible" && row.ineligibleReason === "form-control-excluded"), {
    formRows: formRows.map((row) => ({ id: row.id, eligibility: row.eligibility, reason: row.ineligibleReason })),
    counterexamples,
  }));
  checks.push(check("editable selector evidence: unsupported and mixed namespaces are documented not eligible", namespaceRows.length === 2 && namespaceRows.every((row) => row.eligibility === "not-eligible" && row.ineligibleReason !== null), {
    namespaceRows: namespaceRows.map((row) => ({ id: row.id, namespace: row.namespace, reason: row.ineligibleReason })),
  }));
  checks.push(check("editable selector evidence: native selector forwards to the original element receiver", selectorForwardedToOriginalReceiver, {
    availableProbes: availableProbes.map((row) => ({ id: row.id, forwarded: row.masked?.forwarded ?? null })),
  }));
  checks.push(check("editable selector evidence: evidence view masks isContentEditable and designMode", maskedProbes.length > 0 && maskedProbes.every((row) => row.masked?.isContentEditableHidden === true && row.masked?.designModeHidden === true), {
    maskedProbes: maskedProbes.map((row) => ({ id: row.id, isContentEditableHidden: row.masked?.isContentEditableHidden ?? null, designModeHidden: row.masked?.designModeHidden ?? null })),
  }));
  checks.push(check("editable selector evidence: ordinary off/on masked values match native false/true", ordinaryModeAgreement, {
    rows: ordinaryModeRows.map((row) => ({
      id: row?.id ?? null,
      native: row?.nativeBoolean ?? null,
      masked: row?.masked?.value ?? null,
      selectorAvailability: row?.masked?.selectorAvailability ?? null,
      isContentEditableHidden: row?.masked?.isContentEditableHidden ?? null,
      designModeHidden: row?.masked?.designModeHidden ?? null,
    })),
  }));
  checks.push(check("editable selector evidence: false barrier public masked capture matches native true", falseBarrierMaskedCapture, {
    id: falseBarrierRow?.id ?? null,
    native: falseBarrierRow?.nativeBoolean ?? null,
    selector: falseBarrierRow === null ? null : [falseBarrierRow.selector.readWrite.value, falseBarrierRow.selector.readOnly.value],
    masked: falseBarrierRow?.masked ?? null,
  }));
  checks.push(check("editable selector evidence: available eligible probes agree with native isContentEditable", availableMaskAgreement, {
    probeCount: availableEligibleProbes.length,
    failures: availableMaskFailures,
    probes: availableEligibleProbes.map((row) => ({ id: row.id, native: row.nativeBoolean, masked: row.masked?.value ?? null })),
  }));
  checks.push(check("editable selector evidence: unavailable selector with unknown designMode retains null", unavailableSelectorRetainsNull, {
    id: unavailableRow?.id ?? null,
    maskedValue: unavailableRow?.masked?.value ?? null,
    selectorAvailability: unavailableRow?.masked?.selectorAvailability ?? null,
    maskedDesignMode: unavailableRow?.masked?.designMode ?? null,
  }));
  checks.push(check("editable selector evidence: disposable fixtures are removed", fixturesRemoved, targets.editableFrameHost.children.length));

  return {
    result: {
      rows,
      eligibleMismatches,
      counterexamples,
      eligibleMatchCount: eligibleRows.length - eligibleMismatches.length,
      selectorForwardedToOriginalReceiver,
      unavailableSelectorRetainsNull,
      availableMaskAgreement,
      blocker,
    },
    checks,
  };
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
      "判断DOM基础种类": {
        config: DEFAULT_BASIC_KIND_CONFIG as unknown as JsonValue,
        ...(scenario === "actual-focus" || scenario === "actual-focus-lost" ? { profileId: actualFocusProfileId } : {}),
      },
    },
  }, {
    nodeDefinitions: definitions,
    grantedEffects: ["browser.dom.read", "browser.overlay.present"],
    ...(scenario === "actual-focus" || scenario === "actual-focus-lost" ? { profiles: { [actualFocusProfileId]: actualFocusProfile } } : {}),
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
  if (scenario === "clipping") {
    const scaledFree = observationFor(frame, targets.scaledFree);
    const scaledRetained = observationFor(frame, targets.scaledRetained);
    const scaledExcluded = observationFor(frame, targets.scaledExcluded);
    const nested = observationFor(frame, targets.nested);
    const legacyAbsolute = observationFor(frame, targets.legacyAbsolute);
    const legacyStatic = observationFor(frame, targets.legacyStatic);
    const unsupportedRotate = observationFor(frame, targets.unsupportedRotate);
    const unsupportedClipPath = observationFor(frame, targets.unsupportedClipPath);
    const scaledRect = targets.scaledRetained.getBoundingClientRect();
    const clipOuter = clientClip(required<HTMLElement>("#scaled-clip-outer"), 0.5, 1.2);
    const nestedOuter = clientClip(required<HTMLElement>("#nested-clip-outer"), 0.5, 1.2);
    const nestedInner = clientClip(required<HTMLElement>("#nested-clip-inner"), 1, 1.2);
    const nestedRect = targets.nested.getBoundingClientRect();
    const expectedNested = intersectRect(intersectRect(nestedRect, nestedInner), nestedOuter);
    checks.push(check("scaled positive-transform target has measured clipped rect", rectClose(scaledFree?.clippedRect, targets.scaledFree.getBoundingClientRect()), {
      expected: targets.scaledFree.getBoundingClientRect(),
      actual: scaledFree?.clippedRect,
      ancestorScale: "1.2x0.5 without clipping",
    }));
    checks.push(check("scaled retained region intersects the true client box", rectClose(scaledRetained?.clippedRect, intersectRect(scaledRect, clipOuter)), {
      expected: intersectRect(scaledRect, clipOuter),
      actual: scaledRetained?.clippedRect,
    }));
    checks.push(check("scaled excluded target has zero-area clipped rect", scaledExcluded?.clippedRect != null
      && (scaledExcluded.clippedRect.width === 0 || scaledExcluded.clippedRect.height === 0), scaledExcluded?.clippedRect));
    const svgClip = clientClip(required<SVGSVGElement>("#svg-root-viewport"), 1, 1);
    checks.push(check("root SVG retains its CSS viewport clipping", rectClose(observationFor(frame, targets.svgShape)?.clippedRect,
      intersectRect(targets.svgShape.getBoundingClientRect(), svgClip)), observationFor(frame, targets.svgShape)));
    checks.push(check("scaled excluded target has no overlay box", boxFor(frame, targets.scaledExcluded) === undefined, boxFor(frame, targets.scaledExcluded)));
    checks.push(check("nested nonuniform scales compose for inner clip", rectClose(nested?.clippedRect, expectedNested), {
      expected: expectedNested,
      actual: nested?.clippedRect,
      outer: nestedOuter,
      inner: nestedInner,
    }));
    checks.push(check("legacy absolute zero clip is known empty", legacyAbsolute?.clippedRect?.width === 0 && legacyAbsolute?.clippedRect?.height === 0, legacyAbsolute?.clippedRect));
    checks.push(check("legacy static zero clip is ignored", rectClose(legacyStatic?.clippedRect, targets.legacyStatic.getBoundingClientRect()), {
      actual: legacyStatic?.clippedRect,
      measured: targets.legacyStatic.getBoundingClientRect(),
    }));
    checks.push(check("rotation remains unassessed", unsupportedRotate?.clippedRect === null && unsupportedRotate?.foreground === "unassessed", unsupportedRotate));
    checks.push(check("clip-path remains unassessed", unsupportedClipPath?.clippedRect === null && unsupportedClipPath?.foreground === "unassessed", unsupportedClipPath));
    checks.push(check("scaled retained target stays a candidate", slotFor(frame, targets.scaledRetained)?.candidateStatus === "ok", slotFor(frame, targets.scaledRetained)?.candidateStatus));
    checks.push(check("scaled excluded target is filtered as nonrendered", slotFor(frame, targets.scaledExcluded)?.candidateStatus === "filtered_out"
      && candidateFor(frame, targets.scaledExcluded)?.reasons.includes("nonrendered"), {
      status: slotFor(frame, targets.scaledExcluded)?.candidateStatus,
      reasons: candidateFor(frame, targets.scaledExcluded)?.reasons,
    }));
    checks.push(check("scaled excluded target exposes no area", Array.isArray(scaledExcluded?.exposedRects) && scaledExcluded.exposedRects.length === 0, scaledExcluded?.exposedRects));
    checks.push(check("nested target stays a candidate", slotFor(frame, targets.nested)?.candidateStatus === "ok", slotFor(frame, targets.nested)?.candidateStatus));
    checks.push(check("legacy absolute target is filtered as nonrendered", slotFor(frame, targets.legacyAbsolute)?.candidateStatus === "filtered_out"
      && candidateFor(frame, targets.legacyAbsolute)?.reasons.includes("nonrendered"), {
      status: slotFor(frame, targets.legacyAbsolute)?.candidateStatus,
      reasons: candidateFor(frame, targets.legacyAbsolute)?.reasons,
    }));
    checks.push(check("legacy absolute target exposes no area", Array.isArray(legacyAbsolute?.exposedRects) && legacyAbsolute.exposedRects.length === 0, legacyAbsolute?.exposedRects));
    checks.push(check("legacy static target remains a candidate", slotFor(frame, targets.legacyStatic)?.candidateStatus === "ok", slotFor(frame, targets.legacyStatic)?.candidateStatus));
    checks.push(check("rotation candidate remains unknown", slotFor(frame, targets.unsupportedRotate)?.candidateStatus === "unknown", slotFor(frame, targets.unsupportedRotate)?.candidateStatus));
    checks.push(check("clip-path candidate remains unknown", slotFor(frame, targets.unsupportedClipPath)?.candidateStatus === "unknown", slotFor(frame, targets.unsupportedClipPath)?.candidateStatus));
    checks.push(check("clipping scenario keeps public workflow status", execution.outputEvent.status === "ok", execution.outputEvent.status));
  }
  if (scenario === "paint-svg") {
    const clippedGroup = observationFor(frame, targets.paintSvgClippedGroup);
    const clippedShape = observationFor(frame, targets.paintSvgClippedShape);
    const svgViewport = targets.paintSvgOuter.getBoundingClientRect();
    checks.push(check("nested SVG clip group resolves to the known 16px viewport", clippedGroup?.clippedRect != null
      && rectClose(clippedGroup.clippedRect, svgViewport, 0.6)
      && Math.abs(clippedGroup.clippedRect.width - 16) <= 0.6
      && Math.abs(clippedGroup.clippedRect.height - 16) <= 0.6, {
      expected: svgViewport,
      actual: clippedGroup?.clippedRect,
    }));
    checks.push(check("nested SVG clipped shape keeps the known 16px clip", clippedShape?.clippedRect != null
      && rectClose(clippedShape.clippedRect, svgViewport, 0.6), {
      expected: svgViewport,
      actual: clippedShape?.clippedRect,
    }));

    const letterboxShape = observationFor(frame, targets.paintLetterboxShape);
    const letterboxViewport = targets.paintLetterboxNested.getBoundingClientRect();
    checks.push(check("letterboxed nested SVG keeps the physical 16px square clip", letterboxShape?.clippedRect != null
      && rectClose(letterboxShape.clippedRect, letterboxViewport, 0.6)
      && Math.abs(letterboxShape.clippedRect.width - 16) <= 0.6
      && Math.abs(letterboxShape.clippedRect.height - 16) <= 0.6, {
      expected: letterboxViewport,
      actual: letterboxShape?.clippedRect,
      letterboxViewBox: "0 0 200 100",
    }));

    const unpainted = observationFor(frame, targets.paintUnpaintedRadiusImage);
    const unpaintedArea = exposedArea(unpainted?.exposedRects);
    checks.push(check("unpainted radius/opacity overlay leaves the image visible", unpainted?.foreground === "visible" && unpaintedArea > 0, {
      foreground: unpainted?.foreground,
      exposedArea: unpaintedArea,
      exposedRects: unpainted?.exposedRects,
    }));

    const ring = observationFor(frame, targets.paintBorderRingImage);
    const ringArea = exposedArea(ring?.exposedRects);
    checks.push(check("border-only ring over a 24px image exposes a positive clear region", ring?.foreground === "visible" && ringArea > 0, {
      foreground: ring?.foreground,
      exposedArea: ringArea,
      exposedRects: ring?.exposedRects,
    }));
    checks.push(check("border-only ring does not expose the whole image", ringArea > 0 && ringArea < 24 * 24, {
      exposedArea: ringArea,
      imageArea: 24 * 24,
    }));

    const opacityZero = observationFor(frame, targets.paintOpacityZeroImage);
    const opacityZeroArea = exposedArea(opacityZero?.exposedRects);
    checks.push(check("opacity0 painted hover overlay keeps the image visible", opacityZero?.foreground === "visible" && opacityZeroArea > 0, {
      foreground: opacityZero?.foreground,
      exposedArea: opacityZeroArea,
      exposedRects: opacityZero?.exposedRects,
    }));
    checks.push(check("opacity0 hover overlay remains an eligible candidate", slotFor(frame, targets.paintOpacityZeroOverlay)?.candidateStatus === "ok", slotFor(frame, targets.paintOpacityZeroOverlay)?.candidateStatus));

    const opaqueHeader = observationFor(frame, targets.paintOpaqueHeaderImage);
    checks.push(check("opaque content-box header occludes the behind image", opaqueHeader?.foreground === "occluded"
      && Array.isArray(opaqueHeader.exposedRects) && opaqueHeader.exposedRects.length === 0, {
      foreground: opaqueHeader?.foreground,
      exposedRects: opaqueHeader?.exposedRects,
      headerForeground: observationFor(frame, targets.paintOpaqueHeader)?.foreground,
    }));

    const shadowOnly = observationFor(frame, targets.paintShadowOnlyImage);
    checks.push(check("shadow-only overlay remains unassessed rather than false opaque", shadowOnly?.foreground === "unassessed" && shadowOnly.exposedRects === null, {
      foreground: shadowOnly?.foreground,
      exposedRects: shadowOnly?.exposedRects,
      overlayForeground: observationFor(frame, targets.paintShadowOnlyOverlay)?.foreground,
    }));
  }
  if (scenario === "actual-focus" || scenario === "actual-focus-lost") {
    const targetMeasurement = measurementFor(frame, targets.actualFocusTarget);
    const controlMeasurement = measurementFor(frame, targets.actualFocusControl);
    const targetSlot = slotFor(frame, targets.actualFocusTarget);
    const controlSlot = slotFor(frame, targets.actualFocusControl);
    const targetObservation = observationFor(frame, targets.actualFocusTarget);
    const targetRect = targets.actualFocusTarget.getBoundingClientRect();
    const controlRect = targets.actualFocusControl.getBoundingClientRect();
    const viewport = frame.snapshot.observation.viewport;
    const targetWithinViewport = targetRect.width > 0 && targetRect.height > 0
      && targetRect.x >= viewport.x && targetRect.y >= viewport.y
      && targetRect.x + targetRect.width <= viewport.x + viewport.width
      && targetRect.y + targetRect.height <= viewport.y + viewport.height;
    if (scenario === "actual-focus") {
      checks.push(check("consumer button event actually focuses the target", document.activeElement === targets.actualFocusTarget, document.activeElement?.id ?? document.activeElement?.tagName ?? null));
      checks.push(check("original observer reports actual focus", targetMeasurement?.activeElementFocus === true, targetMeasurement?.activeElementFocus));
      checks.push(check("original tabIndexFocus stays false for the negative attribute", targetMeasurement?.tabIndexFocus === false, targetMeasurement?.tabIndexFocus));
      checks.push(check("focused and unfocused wrappers share the same measured size", targetRect.width === controlRect.width && targetRect.height === controlRect.height, { targetRect, controlRect }));
      checks.push(check("focused target is inside the viewport with positive exposed geometry", targetWithinViewport
        && targetObservation?.foreground === "visible" && exposedArea(targetObservation?.exposedRects) > 0, {
        viewport,
        rect: targetRect,
        foreground: targetObservation?.foreground,
        exposedRects: targetObservation?.exposedRects,
      }));
      checks.push(check("focused target remains a public workflow candidate", targetSlot?.candidateStatus === "ok", targetSlot?.candidateStatus));
      checks.push(check("fixture profile yields a specific non-ignore focused kind", targetSlot?.judgmentStatus === "judged" && targetSlot?.basicKind === "container", {
        judgmentStatus: targetSlot?.judgmentStatus,
        basicKind: targetSlot?.basicKind,
        profileId: frame.basicKindBatch.profileId,
      }));
      checks.push(check("focused classification uses the explicit synthetic wire", targetSlot?.evidence?.wires?.neutral_actual_focus === 1, targetSlot?.evidence?.wires));
      checks.push(check("unfocused control has no actual focus fact", controlMeasurement?.activeElementFocus === false, controlMeasurement?.activeElementFocus));
      checks.push(check("unfocused same-size control is not classified as container", controlSlot?.basicKind !== "container", {
        judgmentStatus: controlSlot?.judgmentStatus,
        basicKind: controlSlot?.basicKind,
      }));
    } else {
      checks.push(check("loss-of-focus action removes the target from activeElement", document.activeElement !== targets.actualFocusTarget, document.activeElement?.id ?? document.activeElement?.tagName ?? null));
      checks.push(check("original observer clears actual focus after the loss", targetMeasurement?.activeElementFocus === false, targetMeasurement?.activeElementFocus));
      checks.push(check("loss does not turn the negative tabindex into tabIndexFocus", targetMeasurement?.tabIndexFocus === false, targetMeasurement?.tabIndexFocus));
      checks.push(check("workflow no longer classifies the target as container", targetSlot?.basicKind !== "container", {
        judgmentStatus: targetSlot?.judgmentStatus,
        basicKind: targetSlot?.basicKind,
      }));
    }
  }

  const foregroundElements = scenario === "paint-svg"
    ? [targets.paintSvgOuter, targets.paintSvgNested, targets.paintSvgClippedGroup, targets.paintSvgClippedShape,
      targets.paintLetterboxOuter, targets.paintLetterboxNested, targets.paintLetterboxShape,
      targets.paintUnpaintedRadiusImage, targets.paintBorderRingImage, targets.paintOpacityZeroImage,
      targets.paintOpacityZeroOverlay, targets.paintOpaqueHeaderImage, targets.paintOpaqueHeader,
      targets.paintShadowOnlyImage, targets.paintShadowOnlyOverlay]
    : scenario === "clipping"
    ? [targets.scaledFree, targets.svgShape, targets.scaledRetained, targets.scaledExcluded, targets.nested, targets.legacyAbsolute, targets.legacyStatic, targets.unsupportedRotate, targets.unsupportedClipPath]
    : scenario === "actual-focus" || scenario === "actual-focus-lost"
    ? [targets.actualFocusTarget, targets.actualFocusControl]
    : [targets.backgroundAction, targets.detailAction, targets.partial, targets.transparent, targets.opaque, targets.iframe];
  const foreground = foregroundElements.map((element) => {
    const observation = observationFor(frame, element);
    return {
      nodeRef: stableNodeRefFor(registry, element),
      name: element.getAttribute("data-target-name") ?? (element.id || element.getAttribute("aria-label") || null),
      tag: observation?.tag ?? null,
      id: (element as HTMLElement).id || null,
      foreground: observation?.foreground ?? null,
      clippedRect: observation?.clippedRect ?? null,
      exposedRects: observation?.exposedRects ?? observation?.exposedRect ?? null,
    };
  });

  return { scenario, status: execution.outputEvent.status, checks, foreground };
}

async function executeEditableScenario(): Promise<RunResult> {
  setScenario("editable");
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  const checks: CheckResult[] = [];
  const cases: EditableCaseResult[] = [];
  let blocker: string | null = null;
  let activeElementPreserved = false;
  let geometryPreserved = false;
  let globalPrototypeUnchanged = false;
  let mainDesignModePreserved = false;
  let disposableFramesRemoved = false;
  const baselineGetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "isContentEditable")?.get ?? null;
  const mainDesignModeBefore = designModeFact(document);
  const resultElement = required<HTMLElement>("#result");
  const controlsElement = required<HTMLElement>("#fixture-controls");

  try {
    const mainPair = await captureEditablePair(document, window, { exclude: [resultElement, controlsElement] });
    const nativeActive = document.activeElement;
    const maskedActive = mainPair.view.document.activeElement;
    activeElementPreserved = nativeActive === null
      ? maskedActive === null
      : maskedActive !== null && mainPair.view.unwrapElement(maskedActive) === nativeActive;
    checks.push(check("masked view preserves activeElement identity", activeElementPreserved, {
      native: nativeActive === null ? null : { id: nativeActive.id || null, tag: nativeActive.tagName },
      masked: maskedActive === null ? null : { id: maskedActive.id || null, tag: maskedActive.tagName },
    }));

    const geometryProbe = targets.editableExplicitTrue;
    const maskedProbe = mainPair.view.wrapElement(geometryProbe);
    const nativeRect = geometryProbe.getBoundingClientRect();
    const maskedRect = maskedProbe.getBoundingClientRect();
    geometryPreserved = sameRectList(maskedProbe.getClientRects(), geometryProbe.getClientRects())
      && Math.abs(nativeRect.x - maskedRect.x) <= 0.001
      && Math.abs(nativeRect.y - maskedRect.y) <= 0.001
      && Math.abs(nativeRect.width - maskedRect.width) <= 0.001
      && Math.abs(nativeRect.height - maskedRect.height) <= 0.001
      && maskedProbe.clientLeft === geometryProbe.clientLeft
      && maskedProbe.clientTop === geometryProbe.clientTop
      && maskedProbe.clientWidth === geometryProbe.clientWidth
      && maskedProbe.clientHeight === geometryProbe.clientHeight
      && (maskedProbe as HTMLElement).offsetWidth === geometryProbe.offsetWidth
      && (maskedProbe as HTMLElement).offsetHeight === geometryProbe.offsetHeight;
    checks.push(check("masked view preserves geometry getters", geometryPreserved, {
      nativeRect,
      maskedRect,
      nativeClient: [geometryProbe.clientLeft, geometryProbe.clientTop, geometryProbe.clientWidth, geometryProbe.clientHeight],
      maskedClient: [maskedProbe.clientLeft, maskedProbe.clientTop, maskedProbe.clientWidth, maskedProbe.clientHeight],
      nativeOffset: [geometryProbe.offsetWidth, geometryProbe.offsetHeight],
      maskedOffset: [(maskedProbe as HTMLElement).offsetWidth, (maskedProbe as HTMLElement).offsetHeight],
    }));

    const mainSpecs: readonly EditableCaseSpec[] = [
      { id: "explicit-true", note: "own contenteditable=true", element: targets.editableExplicitTrue, expectedNative: true, expectedMasked: true, basis: "html" },
      { id: "explicit-false", note: "own contenteditable=false", element: targets.editableExplicitFalse, expectedNative: false, expectedMasked: false, basis: "html" },
      { id: "plaintext-only", note: "own contenteditable=plaintext-only", element: targets.editablePlaintextOnly, expectedNative: true, expectedMasked: true, basis: "html" },
      { id: "inherited-true", note: "child of a true editing host", element: targets.editableInheritedChild, expectedNative: true, expectedMasked: true, basis: "html" },
      { id: "nested-false", note: "false child under a true editing host", element: targets.editableNestedFalseChild, expectedNative: false, expectedMasked: false, basis: "html" },
      { id: "nested-true", note: "true grandchild under a false child", element: targets.editableNestedTrueGrandchild, expectedNative: true, expectedMasked: true, basis: "html" },
      { id: "padded-invalid", note: "whitespace-padded token is invalid and inherits", element: targets.editablePaddedInvalid, expectedNative: false, expectedMasked: false, basis: "html" },
      { id: "css-read-only", note: "contenteditable=true with CSS read-only override", element: targets.editableCssReadOnly, basis: "native" },
      { id: "css-read-write", note: "contenteditable=true with CSS read-write override", element: targets.editableCssReadWrite, basis: "native" },
    ];
    for (const spec of mainSpecs) {
      const caseResult = editableCaseResult(spec, mainPair);
      cases.push(caseResult);
      checks.push(check(`editable ${spec.id}: native getter is available`, typeof caseResult.native.value === "boolean", {
        value: caseResult.native.value,
        type: caseResult.native.type,
        error: caseResult.native.error,
        attribute: caseResult.native.attribute,
      }));
      checks.push(check(`editable ${spec.id}: masked result matches expected`, caseResult.maskedMatchesExpected === true, {
        expected: caseResult.expectedMasked,
        actual: caseResult.masked.value,
        native: caseResult.native.value,
        basis: caseResult.expectationBasis,
        cssUserModify: caseResult.native.cssUserModify,
      }));
    }
  } catch (error) {
    blocker = error instanceof Error ? error.message : String(error);
    checks.push(check("editable main capture completed", false, blocker));
  }

  const designModeSpecs: readonly {
    readonly id: string;
    readonly mode: "on" | "off";
    readonly maskDesignMode: boolean;
    readonly expectedNative: boolean;
    readonly expectedMasked: boolean | null;
    readonly basis: "html" | "native-selector";
  }[] = [
    { id: "designmode-on", mode: "on", maskDesignMode: false, expectedNative: true, expectedMasked: true, basis: "html" },
    { id: "designmode-off", mode: "off", maskDesignMode: false, expectedNative: false, expectedMasked: false, basis: "html" },
    { id: "designmode-unknown", mode: "off", maskDesignMode: true, expectedNative: false, expectedMasked: false, basis: "native-selector" },
  ];
  for (const spec of designModeSpecs) {
    let iframe: HTMLIFrameElement | null = null;
    try {
      const fixture = await createDisposableDesignModeFixture(spec.mode);
      iframe = fixture.iframe;
      const target = fixture.document.querySelector<HTMLElement>("#designmode-target");
      if (!target) throw new Error(`Missing ${spec.id} target`);
      const pair = await captureEditablePair(fixture.document, fixture.window, { maskDesignMode: spec.maskDesignMode });
      const caseResult = editableCaseResult({
        id: spec.id,
        note: spec.basis === "native-selector"
          ? "designMode unreadable with no declaration; the native selector supplies the Boolean"
          : `disposable same-origin document with designMode ${spec.mode}`,
        element: target,
        expectedNative: spec.expectedNative,
        expectedMasked: spec.expectedMasked,
        basis: spec.basis,
      }, pair);
      cases.push(caseResult);
      checks.push(check(`editable ${spec.id}: native getter is available`, typeof caseResult.native.value === "boolean", {
        value: caseResult.native.value,
        type: caseResult.native.type,
        error: caseResult.native.error,
        nativeDesignMode: caseResult.native.designMode,
      }));
      checks.push(check(`editable ${spec.id}: masked result matches expected`, caseResult.maskedMatchesExpected === true, {
        expected: caseResult.expectedMasked,
        actual: caseResult.masked.value,
        native: caseResult.native.value,
        maskedDesignMode: caseResult.masked.designMode,
        basis: caseResult.expectationBasis,
      }));
    } catch (error) {
      blocker ??= error instanceof Error ? error.message : String(error);
      checks.push(check(`editable ${spec.id}: disposable fixture completed`, false, blocker));
    } finally {
      iframe?.remove();
    }
  }

  disposableFramesRemoved = targets.editableFrameHost.children.length === 0;
  checks.push(check("editable disposable designMode frames are removed", disposableFramesRemoved, targets.editableFrameHost.children.length));
  globalPrototypeUnchanged = (Object.getOwnPropertyDescriptor(HTMLElement.prototype, "isContentEditable")?.get ?? null) === baselineGetter;
  checks.push(check("editable masking does not mutate HTMLElement.prototype", globalPrototypeUnchanged, {
    baselineGetter: baselineGetter !== null,
    currentGetter: (Object.getOwnPropertyDescriptor(HTMLElement.prototype, "isContentEditable")?.get ?? null) !== null,
  }));
  mainDesignModePreserved = designModeFact(document) === mainDesignModeBefore;
  checks.push(check("editable fixtures do not change main document designMode", mainDesignModePreserved, {
    before: mainDesignModeBefore,
    after: designModeFact(document),
  }));

  const nativeGetterAvailable = cases.some((item) => typeof item.native.value === "boolean");
  const mismatches = cases
    .filter((item) => item.maskedMatchesExpected === false || item.maskedMatchesNative === false)
    .map((item) => item.id);
  checks.push(check("editable native isContentEditable getter is available", nativeGetterAvailable, cases.map((item) => ({
    id: item.id,
    type: item.native.type,
    value: item.native.value,
  }))));
  checks.push(check("editable masked results report no native mismatch", mismatches.length === 0, mismatches));
  checks.push(check("editable public workflow completed every capture", cases.every((item) => item.native.public.publicStatus === "ok" && item.masked.public.publicStatus === "ok"), {
    statuses: cases.map((item) => ({ id: item.id, native: item.native.public.publicStatus, masked: item.masked.public.publicStatus })),
  }));

  // Selector capability gate evidence is appended after the original checks. The
  // earlier 32 checks keep their names, order and expectations at this stage.
  let selectorEvidence: SelectorScenarioResult | null = null;
  try {
    const evidence = await runSelectorEvidence();
    selectorEvidence = evidence.result;
    checks.push(...evidence.checks);
    if (evidence.result.blocker !== null) blocker ??= evidence.result.blocker;
  } catch (error) {
    blocker ??= error instanceof Error ? error.message : String(error);
    checks.push(check("editable selector evidence completed", false, blocker));
  }

  return {
    scenario: "editable",
    status: blocker === null ? "ok" : "failed",
    checks,
    foreground: [],
    editable: {
      cases,
      mismatches,
      nativeGetterAvailable,
      activeElementPreserved,
      geometryPreserved,
      globalPrototypeUnchanged,
      mainDesignModePreserved,
      disposableFramesRemoved,
      selectorEvidence,
      blocker,
    },
  };
}

async function runFixture(): Promise<void> {
  if (!result) return;
  result.dataset.status = "RUNNING";
  result.textContent = "运行中";
  try {
    const scenarios: readonly Scenario[] = ["baseline", "xhs-open", "partial-open", "transparent-open", "opaque-open", "rounded-open", "pointer-target", "negative-background", "elevated-child", "rounded-parent", "unknown-clipping", "visibility-override", "grid-stacking", "modern-alpha", "clipping", "paint-svg", "baseline"];
    const runs: RunResult[] = [];
    for (const scenario of scenarios) runs.push(await executeScenario(scenario));
    setScenario("actual-focus");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    required<HTMLButtonElement>("#focus-target").click();
    runs.push(await executeScenario("actual-focus"));
    required<HTMLButtonElement>("#lose-focus").click();
    runs.push(await executeScenario("actual-focus-lost"));
    renderRuns(runs);
  } catch (error) {
    result.dataset.status = "FAIL";
    result.textContent = `FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  } finally {
    setScenario("baseline");
  }
}

function renderRuns(runs: readonly RunResult[]): void {
  if (!result) return;
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
}

async function runEditableOnly(): Promise<void> {
  if (!result) return;
  result.dataset.status = "RUNNING";
  result.textContent = "运行可编辑状态场景中";
  try {
    const run = await executeEditableScenario();
    renderRuns([run]);
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
required<HTMLButtonElement>("#editable-run").addEventListener("click", () => void runEditableOnly());
required<HTMLButtonElement>("#focus-target").addEventListener("click", () => {
  setScenario("actual-focus");
  targets.actualFocusTarget.focus();
});
required<HTMLButtonElement>("#lose-focus").addEventListener("click", () => targets.actualFocusTarget.blur());

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void runFixture());
} else {
  void runFixture();
}
