declare module "nnanything/browser-classify" {
  export type BasicKindFamily = "control" | "media" | "navigation" | "text" | "structure";
  export type SpecificBasicKindLabel =
    | "button" | "input" | "select"
    | "image" | "video" | "audio"
    | "link"
    | "text"
    | "container" | "list" | "listitem";
  export type BasicKindLabel = SpecificBasicKindLabel | "other";
  export type BasicKindStatus = "judged" | "unknown" | "conflict" | "excluded";

  export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }

  export interface BasicKindConfig {
    readonly taskId: string;
    readonly minScore: number;
    readonly minMargin: number;
  }

  export interface BasicKindProfile {
    readonly id: string;
    readonly taskId: string;
    readonly baseProfileId: string;
    readonly rules: readonly unknown[];
    readonly weights: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface FocusSpec {
    readonly viewportOnly?: boolean;
    readonly scopeMode?: "subtree" | "owned";
    readonly within?: string | null;
    [key: string]: unknown;
  }

  export interface CandidateSlot {
    readonly index: number;
    readonly nodeRef: string;
    readonly status: "ok" | "filtered_out" | "skipped" | "unknown";
    readonly reasons: readonly string[];
    [key: string]: unknown;
  }

  export interface CandidateBatch {
    readonly slots: readonly CandidateSlot[];
    readonly candidateRefs: readonly string[];
    [key: string]: unknown;
  }

  export interface BasicKindSlot {
    readonly index: number;
    readonly nodeRef: string;
    readonly candidateStatus: "ok" | "filtered_out" | "skipped" | "unknown";
    readonly basicKind: BasicKindLabel | null;
    readonly judgmentStatus: BasicKindStatus;
    readonly score: number | null;
    readonly margin: number | null;
    readonly reasons: readonly string[];
    readonly evidence: {
      readonly wires?: Record<string, unknown>;
      readonly activeTerms?: readonly string[];
      readonly path?: readonly unknown[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  export interface BasicKindBatch {
    readonly slots: readonly BasicKindSlot[];
    [key: string]: unknown;
  }

  export interface PageObservation {
    readonly viewport: Rect;
    readonly nodes: readonly unknown[];
    readonly coverage: unknown;
  }

  export interface BasicKindMeasurements {
    readonly inputType?: string | null;
    readonly hrefPresent?: boolean | null;
    readonly contentEditable?: boolean | null;
    readonly directTextPresent?: boolean | null;
    readonly childElementCount?: number | null;
    readonly positiveAreaChildCount?: number | null;
    readonly repeatedChildGeometry?: boolean | null;
    readonly inVerifiedListParent?: boolean | null;
  }

  export interface BasicKindProperties extends BasicKindMeasurements {
    readonly tag: string | null;
    readonly role: string | null;
    readonly disabled?: boolean | null;
    readonly hidden?: boolean | null;
  }

  export interface StableNodeRefRegistry {
    readonly refByElement: WeakMap<Element, string>;
    readonly elementByRef: Map<string, WeakRef<Element>>;
    readonly nextSequence: { value: number };
  }

  export type LiveCaptureCoverage = {
    scope: "top_document_only";
    frameContent: "captured";
    directChildren: "complete";
    traversedElementCount: number;
    excludedElementCount: number;
    unassessedIframeCount: number;
    unassessedOpenShadowRootCount: number;
    closedShadowRootDetection: "not_available";
  };

  export type LiveDomEvidence = {
    nodeRef: string;
    tag: string;
    id: string | null;
    classList: readonly string[];
    textSummary: string | null;
    linkPathname: string | null;
    rect: Rect | null;
    clippedRect: Rect | null;
    parentTags: readonly string[];
  };

  export type LiveDomSnapshot = {
    snapshotRef: string;
    documentRef: string;
    frameRef: string;
    pageRef: string;
    observation: PageObservation;
    itemObservations: readonly ({ nodeRef: string } & BasicKindMeasurements)[];
    properties: ReadonlyMap<string, BasicKindProperties>;
    evidence: ReadonlyMap<string, LiveDomEvidence>;
    coverage: LiveCaptureCoverage;
    resolveElement(nodeRef: string): Element | null;
  };

  export type BrowserWeightAsset = {
    profile: BasicKindProfile;
    config: BasicKindConfig;
    sourceLabel: string;
    calibrated: false;
  };

  export type OverlayBox = {
    nodeRef: string;
    rect: Rect;
    basicKind: BasicKindLabel | null;
    judgmentStatus: BasicKindStatus;
    score: number | null;
    margin: number | null;
  };

  export type OverlayCounts = {
    totalNodes: number;
    candidates: number;
    judged: number;
    unknown: number;
    conflict: number;
    excluded: number;
  };

  export type OverlayPresentationView = {
    boxes: readonly OverlayBox[];
    counts: OverlayCounts;
    focus: { nodeRef: string; rect: Rect } | null;
    coverage: LiveCaptureCoverage;
    profileId: string;
    focusSpec: FocusSpec;
    confidenceState: "uncalibrated";
  };

  export type BrowserOverlayFrame = {
    snapshot: LiveDomSnapshot;
    focusSpec: FocusSpec;
    profileId: string;
    candidateBatch: CandidateBatch;
    basicKindBatch: BasicKindBatch;
    boxes: readonly OverlayBox[];
    presentation: { view: OverlayPresentationView; receipt: unknown };
  };

  export type BrowserCaptureAnnotation =
    | { kind: "correct"; otherReason?: string }
    | { kind: "wrong"; correctedLabel?: BasicKindLabel; otherReason?: string }
    | { kind: "unsure" };

  export type BrowserCaptureRowReceipt = {
    reviewStatus: "verified" | "rejected" | "ambiguous" | "unreviewed";
    [key: string]: unknown;
  };

  export type BrowserCaptureBulkReceipt = {
    eligibleUnknown: number;
    collected: number;
    existingReviewed: number;
  };

  export type BrowserCaptureStats = {
    total: number;
    verified: number;
    rejected: number;
    ambiguous: number;
    unreviewed: number;
    [key: string]: unknown;
  };

  export type BrowserCaptureExportReceipt = {
    receiptId: string;
    downloadReceipt: unknown;
  };

  export type BrowserCaptureDownloadCallback = (bundle: unknown, filename?: string) => Promise<unknown> | unknown;

  export class BrowserCaptureSession {
    readonly sessionId: string;
    readonly createdAt: string;
    constructor(input: { sessionId: string; createdAt: string });
    captureSelected(frame: BrowserOverlayFrame, nodeRef: string, annotation: BrowserCaptureAnnotation): BrowserCaptureRowReceipt;
    collectUnknown(frame: BrowserOverlayFrame): BrowserCaptureBulkReceipt;
    stats(): BrowserCaptureStats;
    toBundle(): unknown;
    export(download: BrowserCaptureDownloadCallback): Promise<BrowserCaptureExportReceipt>;
  }

  export function createStableNodeRefRegistry(prefix?: string): StableNodeRefRegistry;
  export function stableNodeRefFor(registry: StableNodeRefRegistry, element: Element): string;
  export function resolveStableNodeRef(registry: StableNodeRefRegistry, nodeRef: string): Element | null;
  export function parseBrowserWeightAsset(rawJson: unknown, sourceLabel?: string): BrowserWeightAsset;
  export function extractTrainingRequestFromBundle(raw: unknown): any;

  export function createBrowserOverlayNodeDefinitions(input: {
    document: Document;
    window: Window;
    registry: StableNodeRefRegistry;
    excludeHost: Element | null;
    present: (frame: BrowserOverlayFrame) => Promise<unknown> | unknown | void;
  }): readonly unknown[];

  export function createBrowserCaptureNodeDefinitions(input: {
    session: BrowserCaptureSession;
    download: BrowserCaptureDownloadCallback;
  }): readonly unknown[];

  export function compileWorkflow(
    workflow: { graph: unknown; bindings: Record<string, unknown> },
    options: { nodeDefinitions: readonly unknown[]; profiles?: Record<string, unknown>; grantedEffects?: readonly string[] }
  ): unknown;

  export function createWorkflowInputEvent(input: {
    runId: string;
    eventId: string;
    port: string;
    type: string;
    correlation: Record<string, unknown>;
    payload: unknown;
  }): unknown;

  export function runWorkflow(compiled: unknown, inputEvent: unknown): Promise<{
    status: string;
    outputEvent: { status: string; payload: any };
  }>;

  export const BROWSER_OVERLAY_REQUEST_EVENT_TYPE: string;
  export const BROWSER_CAPTURE_REQUEST_EVENT_TYPE: string;
  export const DEFAULT_BASIC_KIND_CONFIG: BasicKindConfig;
  export const DEFAULT_BASIC_KIND_PROFILE: BasicKindProfile;
}
