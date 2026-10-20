import { validateBasicKindProperties, type BasicKindBatch, type BasicKindLabel, type BasicKindStatus } from "../../filters/basic-kinds.js";
import type { CandidateBatch } from "../../filters/candidate-chain.js";
import type { FocusSpec } from "../../filters/focus.js";
import { expectNonEmptyString, expectRecord } from "../../core/schema.js";
import { readBasicKindTrainingRequest, type BasicKindTrainingRequest, type ReviewedBasicKindRow } from "../../training/basic-kind-samples.js";
import type { LiveCaptureCoverage, LiveDomEvidence, LiveDomSnapshot } from "./live-dom.js";
import type { Rect } from "./observation.js";

export interface OverlayBox {
  readonly nodeRef: string;
  readonly rect: Rect;
  readonly basicKind: BasicKindLabel | null;
  readonly judgmentStatus: BasicKindStatus;
  readonly score: number | null;
  readonly margin: number | null;
}
export interface BrowserOverlayFrame {
  readonly snapshot: LiveDomSnapshot;
  readonly focusSpec: FocusSpec;
  readonly profileId: string;
  readonly candidateBatch: CandidateBatch;
  readonly basicKindBatch: BasicKindBatch;
  readonly boxes: readonly OverlayBox[];
  readonly presentation: { readonly view: OverlayView; readonly receipt: unknown };
}
export interface OverlayCounts {
  readonly totalNodes: number; readonly candidates: number; readonly judged: number; readonly unknown: number;
  readonly conflict: number; readonly ignored: number; readonly unresolved: number; readonly excluded: number; readonly candidateUnknown: number;
}
export interface OverlayView {
  readonly boxes: readonly OverlayBox[];
  readonly counts: OverlayCounts;
  readonly focus: { readonly nodeRef: string; readonly rect: Rect } | null;
  readonly coverage: LiveCaptureCoverage;
  readonly profileId: string;
  readonly focusSpec: FocusSpec;
  readonly confidenceState: "uncalibrated";
}
export type BrowserCaptureAnnotation =
  | { readonly kind: "correct"; readonly otherReason?: string }
  | { readonly kind: "wrong"; readonly correctedLabel?: BasicKindLabel; readonly otherReason?: string }
  | { readonly kind: "unsure" };
export interface BrowserCaptureContext { readonly contextRef: string; readonly profileId: string; readonly focusSpec: FocusSpec }
type CaptureEvidence = LiveDomEvidence & { readonly provenanceRef: string; readonly evidenceRef: string; readonly contextRef: string };
export interface BrowserCaptureBundleV1 {
  readonly kind: "nnanything.browser-capture-bundle.v1";
  readonly sessionId: string;
  readonly createdAt: string;
  readonly currentContextRef: string;
  readonly contexts: readonly BrowserCaptureContext[];
  readonly sourceRefs: { readonly snapshotRefs: readonly string[]; readonly documentRefs: readonly string[]; readonly pageRefs: readonly string[] };
  readonly trainingRequest: BasicKindTrainingRequest;
  readonly evidenceSidecar: Readonly<Record<string, CaptureEvidence>>;
}
export interface BrowserCaptureStats { readonly total: number; readonly verified: number; readonly unreviewed: number; readonly ambiguous: number; readonly rejected: number }
export interface BrowserCaptureRowReceipt { readonly sampleId: string; readonly reviewStatus: ReviewedBasicKindRow["review"]["status"]; readonly updated: boolean }
export interface BrowserCaptureBulkReceipt {
  readonly eligible: number;
  readonly eligibleUnknown: number;
  readonly eligibleConflict?: number;
  readonly collected: number;
  readonly existingReviewed: number;
  readonly existingPending: number;
}
export type BrowserCaptureDownloadCallback = (bundle: BrowserCaptureBundleV1, fileName: string) => unknown | Promise<unknown>;
export interface BrowserCaptureExportReceipt { readonly fileName: string; readonly rowCount: number; readonly downloadReceipt: unknown }

export class BrowserCaptureSession {
  private readonly sessionId: string;
  private readonly createdAt: string;
  private readonly rows = new Map<string, ReviewedBasicKindRow>();
  private readonly sidecar = new Map<string, CaptureEvidence>();
  private readonly contexts: BrowserCaptureContext[] = [];
  private readonly documents = new Set<string>();
  private readonly pages = new Set<string>();
  private currentContextRef = "";

  constructor(input: { sessionId: string; createdAt: string }) {
    this.sessionId = expectNonEmptyString(input.sessionId, "sessionId");
    this.createdAt = expectNonEmptyString(input.createdAt, "createdAt");
  }
  private put(frame: BrowserOverlayFrame, nodeRef: string, annotation: BrowserCaptureAnnotation | null): BrowserCaptureRowReceipt {
    const slot = frame.basicKindBatch.slots.find(slot => slot.nodeRef === nodeRef);
    const candidate = frame.candidateBatch.slots.find(slot => slot.nodeRef === nodeRef);
    if (!slot || candidate?.status !== "ok" || slot.candidateStatus !== "ok") throw new TypeError("Only qualified candidate elements can be collected");
    const properties = frame.snapshot.properties.get(nodeRef), evidence = frame.snapshot.evidence.get(nodeRef);
    if (!properties || !evidence) throw new TypeError("Element measurements or evidence are unavailable");
    let review: ReviewedBasicKindRow["review"] = { status: "unreviewed", expectedLabel: null, reviewerRef: null, evidenceRef: null, otherReason: null };
    const key = `${this.sessionId}:${frame.snapshot.snapshotRef}:${frame.snapshot.frameRef}:${nodeRef}`;
    const provenanceRef = `${key}:evidence`;
    if (annotation?.kind === "unsure") review = { ...review, status: "ambiguous" };
    else if (annotation) {
      const label = annotation.kind === "wrong" ? annotation.correctedLabel : slot.basicKind;
      if (!label) {
        if (annotation.kind === "correct") throw new TypeError("Confirm a concrete class or other with a reason");
        review = { ...review, status: "rejected" };
      } else {
        const reason = label === "other" ? annotation.otherReason?.trim() : null;
        if (label === "other" && !reason) throw new TypeError("Confirm a concrete class or provide an other reason");
        review = { status: "verified", expectedLabel: label, reviewerRef: "human:browser-overlay", evidenceRef: provenanceRef, otherReason: reason ?? null };
      }
    }
    let context = this.contexts.find(context => context.profileId === frame.profileId && JSON.stringify(context.focusSpec) === JSON.stringify(frame.focusSpec));
    if (!context) {
      context = { contextRef: `${this.sessionId}:context-${this.contexts.length + 1}`, profileId: frame.profileId, focusSpec: structuredClone(frame.focusSpec) };
      this.contexts.push(context);
    }
    const proposal = slot.judgmentStatus === "judged" && slot.basicKind && slot.basicKind !== "other"
      ? { ruleRef: frame.profileId, label: slot.basicKind, status: "matched" as const }
      : { ruleRef: frame.profileId, label: null, status: slot.judgmentStatus === "conflict" ? "conflict" as const : "unknown" as const };
    const row: ReviewedBasicKindRow = {
      sampleId: key,
      inputRef: { snapshotRef: frame.snapshot.snapshotRef, documentRef: frame.snapshot.documentRef, frameRef: frame.snapshot.frameRef, nodeRef, index: 0 },
      provenanceRef,
      sourceAssociations: { snapshotRefs: [frame.snapshot.snapshotRef], postRefs: [], assetRefs: [`page:${frame.snapshot.pageRef}`] },
      candidateQualification: { status: "ok", reasons: [...candidate.reasons] },
      // This row describes the top-document host element, never its unread inner document.
      captureCoverage: { frameContent: "not_applicable", directChildren: "complete" },
      properties: validateBasicKindProperties(properties), proposal, review,
      ...(frame.snapshot.explorationInputs?.get(nodeRef) ? { explorationInput: structuredClone(frame.snapshot.explorationInputs.get(nodeRef)!) } : {}),
    };
    // Validate only the new row here; batch validation occurs once at export.
    readBasicKindTrainingRequest({ schemaVersion: 1, taskId: "dom.basic-kinds.v1", rows: [row] });
    const updated = this.rows.has(key);
    this.rows.set(key, row);
    this.sidecar.set(provenanceRef, {
      nodeRef: evidence.nodeRef, tag: evidence.tag, id: evidence.id, classList: [...evidence.classList], textSummary: evidence.textSummary,
      linkPathname: evidence.linkPathname, rect: evidence.rect ? { ...evidence.rect } : null, clippedRect: evidence.clippedRect ? { ...evidence.clippedRect } : null,
      parentTags: [...evidence.parentTags], ...(evidence.unassessedChildContent ? { unassessedChildContent: [...evidence.unassessedChildContent] } : {}),
      provenanceRef, evidenceRef: provenanceRef, contextRef: context.contextRef,
    });
    this.documents.add(frame.snapshot.documentRef); this.pages.add(frame.snapshot.pageRef);
    this.currentContextRef = context.contextRef;
    return { sampleId: key, reviewStatus: review.status, updated };
  }
  captureSelected(frame: BrowserOverlayFrame, nodeRef: string, annotation: BrowserCaptureAnnotation): BrowserCaptureRowReceipt {
    if (!["correct", "wrong", "unsure"].includes(annotation?.kind)) throw new TypeError("Choose a capture review decision");
    return this.put(frame, nodeRef, annotation);
  }
  collectUnknown(frame: BrowserOverlayFrame): BrowserCaptureBulkReceipt {
    let eligibleUnknown = 0, collected = 0, existingReviewed = 0, existingPending = 0;
    for (const slot of frame.basicKindBatch.slots) {
      if (slot.candidateStatus !== "ok" || slot.judgmentStatus !== "unknown") continue;
      eligibleUnknown++;
      const key = `${this.sessionId}:${frame.snapshot.snapshotRef}:${frame.snapshot.frameRef}:${slot.nodeRef}`;
      const existing = this.rows.get(key);
      if (existing) { if (existing.review.status === "unreviewed") existingPending++; else existingReviewed++; continue; }
      this.put(frame, slot.nodeRef, null); collected++;
    }
    return { eligible: eligibleUnknown, eligibleUnknown, collected, existingReviewed, existingPending };
  }
  collectUnresolved(frame: BrowserOverlayFrame): BrowserCaptureBulkReceipt {
    let eligibleUnknown = 0, eligibleConflict = 0, collected = 0, existingReviewed = 0, existingPending = 0;
    for (const slot of frame.basicKindBatch.slots) {
      if (slot.candidateStatus !== "ok" || (slot.judgmentStatus !== "unknown" && slot.judgmentStatus !== "conflict")) continue;
      if (slot.judgmentStatus === "unknown") eligibleUnknown++;
      else eligibleConflict++;
      const key = `${this.sessionId}:${frame.snapshot.snapshotRef}:${frame.snapshot.frameRef}:${slot.nodeRef}`;
      const existing = this.rows.get(key);
      if (existing) { if (existing.review.status === "unreviewed") existingPending++; else existingReviewed++; continue; }
      this.put(frame, slot.nodeRef, null); collected++;
    }
    return { eligible: eligibleUnknown + eligibleConflict, eligibleUnknown, eligibleConflict, collected, existingReviewed, existingPending };
  }
  collectQualified(frame: BrowserOverlayFrame): BrowserCaptureBulkReceipt {
    let eligible = 0, collected = 0, existingReviewed = 0, existingPending = 0;
    for (const slot of frame.basicKindBatch.slots) {
      if (slot.candidateStatus !== "ok") continue;
      eligible++;
      const key = `${this.sessionId}:${frame.snapshot.snapshotRef}:${frame.snapshot.frameRef}:${slot.nodeRef}`;
      const existing = this.rows.get(key);
      if (existing) { if (existing.review.status === "unreviewed") existingPending++; else existingReviewed++; continue; }
      this.put(frame, slot.nodeRef, null); collected++;
    }
    return { eligible, eligibleUnknown: 0, collected, existingReviewed, existingPending };
  }
  stats(): BrowserCaptureStats {
    const counts = { total: this.rows.size, verified: 0, unreviewed: 0, ambiguous: 0, rejected: 0 };
    for (const row of this.rows.values()) counts[row.review.status]++;
    return counts;
  }
  toBundle(): BrowserCaptureBundleV1 {
    const rows = Array.from(this.rows.values(), (row, index) => ({ ...structuredClone(row), inputRef: { ...row.inputRef, index } }));
    return {
      kind: "nnanything.browser-capture-bundle.v1", sessionId: this.sessionId, createdAt: this.createdAt, currentContextRef: this.currentContextRef,
      contexts: structuredClone(this.contexts),
      sourceRefs: { snapshotRefs: [...new Set(rows.map(row => row.inputRef.snapshotRef))], documentRefs: [...this.documents], pageRefs: [...this.pages] },
      trainingRequest: readBasicKindTrainingRequest({ schemaVersion: 1, taskId: "dom.basic-kinds.v1", rows }),
      evidenceSidecar: Object.fromEntries(Array.from(this.sidecar, ([ref, evidence]) => [ref, structuredClone(evidence)])),
    };
  }
  async export(download: BrowserCaptureDownloadCallback): Promise<BrowserCaptureExportReceipt> {
    const bundle = this.toBundle(), fileName = `nnanything-capture-${this.sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`;
    const downloadReceipt = await download(bundle, fileName);
    return { fileName, rowCount: bundle.trainingRequest.rows.length, downloadReceipt };
  }
}

export function extractTrainingRequestFromBundle(raw: unknown): BasicKindTrainingRequest {
  const bundle = expectRecord(raw, "capture bundle");
  if (bundle.kind !== "nnanything.browser-capture-bundle.v1") throw new TypeError("Unsupported capture bundle kind");
  const allowed = ["kind", "sessionId", "createdAt", "currentContextRef", "contexts", "sourceRefs", "trainingRequest", "evidenceSidecar"];
  if (Object.keys(bundle).some(key => !allowed.includes(key))) throw new TypeError("Unsupported capture bundle field");
  const request = readBasicKindTrainingRequest(bundle.trainingRequest);
  const sidecar = expectRecord(bundle.evidenceSidecar, "evidence sidecar"), sources = expectRecord(bundle.sourceRefs, "sourceRefs");
  if (!Array.isArray(sources.snapshotRefs) || !Array.isArray(sources.documentRefs) || !Array.isArray(sources.pageRefs)) throw new TypeError("Invalid source reference lists");
  if (!Array.isArray(bundle.contexts)) throw new TypeError("Invalid capture contexts");
  const contexts = new Set(bundle.contexts.map(context => expectRecord(context, "capture context").contextRef));
  for (const row of request.rows) {
    const evidence = expectRecord(sidecar[row.provenanceRef], "provenance evidence");
    if (evidence.nodeRef !== row.inputRef.nodeRef || evidence.provenanceRef !== row.provenanceRef || !contexts.has(evidence.contextRef)) throw new TypeError("Capture evidence does not match its element or context");
    if (row.review.evidenceRef && row.review.evidenceRef !== evidence.evidenceRef) throw new TypeError("Review evidence reference mismatch");
    if (!sources.snapshotRefs.includes(row.inputRef.snapshotRef) || !row.sourceAssociations.snapshotRefs.includes(row.inputRef.snapshotRef)) throw new TypeError("Capture snapshot association mismatch");
    if (!sources.documentRefs.includes(row.inputRef.documentRef)) throw new TypeError("Capture document association mismatch");
  }
  return request;
}
