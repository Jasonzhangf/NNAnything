import type { NodeDefinition } from "../core/contracts.js";
import { expectNonEmptyString, expectRecord } from "../core/schema.js";
import { observeLiveDom, type LiveDomSnapshot, type StableNodeRefRegistry } from "../adapters/browser/live-dom.js";
import type { BrowserJpegImageResourceProducer } from "../adapters/browser/image-resource-browser.js";
import { BrowserCaptureSession, type BrowserCaptureAnnotation, type BrowserCaptureDownloadCallback, type BrowserOverlayFrame, type OverlayBox } from "../adapters/browser/capture-bundle.js";
import { createFocusSpec, type FocusSpec } from "../filters/focus.js";
import { checkCandidates, observeCandidates, scopeIssue, splitCandidates, type CandidateBatch } from "../filters/candidate-chain.js";
import { classifyBasicKindBatch, DEFAULT_BASIC_KIND_PROFILE, validateBasicKindConfig, validateBasicKindProfile, type BasicKindConfig } from "../filters/basic-kinds.js";

export const BROWSER_OVERLAY_REQUEST_EVENT_TYPE = "browser.overlay.request.v1";
export const BROWSER_CAPTURE_REQUEST_EVENT_TYPE = "browser.capture.request.v1";
const port = (name: string, eventType: string) => ({ name, schemaId: `browser/${name}/v1`, eventType, validate: (value: unknown) => expectRecord(value, name) });
const request = port("overlay_request", BROWSER_OVERLAY_REQUEST_EVENT_TYPE);
const observed = port("live_observation", "browser.live-observation.v1");
const candidates = port("live_candidates", "browser.live-candidates.v1");
const classified = port("classified_frame", "browser.classified-frame.v1");
const presented = port("overlay_frame", "browser.overlay-frame.v1");
interface QualifiedFrame { readonly snapshot: LiveDomSnapshot; readonly focusSpec: FocusSpec; readonly candidateBatch: CandidateBatch }
type ClassifiedFrame = QualifiedFrame & { readonly basicKindBatch: BrowserOverlayFrame["basicKindBatch"] };

function intersection(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

export function createBrowserOverlayNodeDefinitions(resources: {
  document: Document; window: Window; registry: StableNodeRefRegistry; excludeHost: Element | null;
  excludeRoots?: readonly (Element | null)[]; excludeRootIds?: readonly string[];
  maxRelationHops?: number;
  imageResources?: Pick<BrowserJpegImageResourceProducer, "read" | "peek">;
  present: (frame: BrowserOverlayFrame) => unknown | Promise<unknown>;
}): readonly NodeDefinition[] {
  return [
    {
      operator: "browser.observe_live", version: "0.1.0", inputPorts: [request], outputPort: observed,
      effects: resources.imageResources ? ["browser.dom.read", "browser.resource.read"] : ["browser.dom.read"],
      execute: async context => {
        const input = expectRecord(context.inputs[0]!.payload, "overlay request");
        const observationInput = { document: resources.document, window: resources.window, registry: resources.registry, excludeRoot: resources.excludeHost,
          ...(resources.excludeRoots ? { excludeRoots: resources.excludeRoots } : {}), ...(resources.excludeRootIds ? { excludeRootIds: resources.excludeRootIds } : {}),
          ...(resources.maxRelationHops === undefined ? {} : { maxRelationHops: resources.maxRelationHops }),
          snapshotRef: expectNonEmptyString(input.snapshotRef, "snapshotRef"), documentRef: expectNonEmptyString(input.documentRef, "documentRef") };
        const producer = resources.imageResources;
        if (!producer) return context.emit(observeLiveDom(observationInput));
        const requests = new Set<HTMLImageElement>();
        const first = observeLiveDom({ ...observationInput, imageResourceFor: element => {
          const image = element as HTMLImageElement;
          const observation = producer.peek(image);
          if (observation === undefined) requests.add(image);
          return observation;
        } });
        if (requests.size === 0) return context.emit(first);
        await Promise.all([...requests].map(image => producer.read(image)));
        return context.emit(observeLiveDom({ ...observationInput, imageResourceFor: element => producer.peek(element as HTMLImageElement) }));
      },
    },
    {
      operator: "browser.qualify_live", version: "0.1.0", inputPorts: [observed], outputPort: candidates,
      config: { required: true, validate: createFocusSpec }, effects: [],
      execute: context => {
        const snapshot = context.inputs[0]!.payload as LiveDomSnapshot, focusSpec = createFocusSpec(context.config);
        const base = observeCandidates({ observation: snapshot.observation });
        const issue = scopeIssue(base, focusSpec);
        if (issue) return context.emit({ reason: issue }, { status: "unknown" });
        return context.emit({ snapshot, focusSpec, candidateBatch: checkCandidates(splitCandidates(base), focusSpec) } satisfies QualifiedFrame);
      },
    },
    {
      operator: "browser.classify_live", version: "0.1.0", inputPorts: [candidates], outputPort: classified,
      config: { required: true, validate: validateBasicKindConfig }, profileValidator: validateBasicKindProfile, effects: [], acceptNonOkInputs: true,
      execute: context => {
        const upstream = context.inputs[0]!;
        if (upstream.status !== "ok") return context.emit(upstream.payload, { status: upstream.status });
        const frame = upstream.payload as QualifiedFrame;
        const basicKindBatch = classifyBasicKindBatch({ ...frame.candidateBatch, itemObservations: frame.snapshot.itemObservations }, context.config as BasicKindConfig, context.profile ? validateBasicKindProfile(context.profile) : DEFAULT_BASIC_KIND_PROFILE);
        return context.emit({ ...frame, basicKindBatch } satisfies ClassifiedFrame);
      },
    },
    {
      operator: "overlay.present", version: "0.1.0", inputPorts: [classified], outputPort: presented,
      effects: ["browser.overlay.present"], acceptNonOkInputs: true,
      execute: async context => {
        const upstream = context.inputs[0]!;
        if (upstream.status !== "ok") return context.emit(upstream.payload, { status: upstream.status });
        const source = upstream.payload as ClassifiedFrame;
        const byRef = new Map(source.snapshot.observation.nodes.map(node => [node.nodeRef, node]));
        const boxes: OverlayBox[] = [];
        for (const slot of source.basicKindBatch.slots) {
          if (slot.candidateStatus !== "ok") continue;
          const node = byRef.get(slot.nodeRef);
          const focusArea = source.focusSpec.region;
          const area = focusArea
            ? intersection(intersection(source.snapshot.observation.viewport, focusArea), node?.rect ?? source.snapshot.observation.viewport)
            : node?.rect ? intersection(source.snapshot.observation.viewport, node.rect) : source.snapshot.observation.viewport;
          const rects = node?.exposedRects === undefined
            ? node?.clippedRect ? [node.clippedRect] : []
            : node.exposedRects ?? [];
          for (const exposed of rects) {
            const rect = intersection(exposed, area);
            if (rect.width > 0 && rect.height > 0) boxes.push({ nodeRef: slot.nodeRef, rect, basicKind: slot.basicKind, judgmentStatus: slot.judgmentStatus, score: slot.score, margin: slot.margin });
          }
        }
        const slots = source.basicKindBatch.slots, root = source.focusSpec.within ? byRef.get(source.focusSpec.within) : null;
        const view = {
          boxes, profileId: source.basicKindBatch.profileId, focusSpec: source.focusSpec, confidenceState: "uncalibrated" as const,
          counts: { totalNodes: slots.length, candidates: slots.filter(slot => slot.candidateStatus === "ok").length,
            judged: slots.filter(slot => slot.judgmentStatus === "judged").length,
            unknown: slots.filter(slot => slot.candidateStatus === "ok" && slot.judgmentStatus === "unknown").length,
            conflict: slots.filter(slot => slot.judgmentStatus === "conflict").length,
            ignored: slots.filter(slot => slot.judgmentStatus === "judged" && slot.basicKind === "ignore").length,
            unresolved: slots.filter(slot => slot.candidateStatus === "ok" && (slot.judgmentStatus === "unknown" || slot.judgmentStatus === "conflict")).length,
            excluded: slots.filter(slot => slot.candidateStatus !== "ok").length,
            candidateUnknown: slots.filter(slot => slot.candidateStatus === "unknown").length },
          focus: root && source.candidateBatch.candidateRefs.includes(root.nodeRef)
            && (root.exposedRects === undefined ? root.rect : root.exposedRects?.[0])
            ? { nodeRef: root.nodeRef, rect: (root.exposedRects === undefined ? root.rect : root.exposedRects?.[0])! } : null,
          coverage: source.snapshot.coverage,
        };
        const frame: BrowserOverlayFrame = { ...source, profileId: source.basicKindBatch.profileId, boxes, presentation: { view, receipt: undefined } };
        const receipt = await resources.present(frame);
        return context.emit({ ...frame, presentation: { view, receipt } });
      },
    },
  ];
}

export function createBrowserCaptureNodeDefinitions(resources: {
  session: BrowserCaptureSession; download: BrowserCaptureDownloadCallback;
}): readonly NodeDefinition[] {
  return [{
    operator: "browser.capture", version: "0.1.0",
    inputPorts: [port("capture_request", BROWSER_CAPTURE_REQUEST_EVENT_TYPE)],
    outputPort: port("capture_receipt", "browser.capture-receipt.v1"), effects: ["browser.capture.download"],
    execute: async context => {
      const input = expectRecord(context.inputs[0]!.payload, "capture request");
      let receipt: unknown;
      if (input.action === "export") receipt = await resources.session.export(resources.download);
      else if (input.action === "capture_selected") receipt = resources.session.captureSelected(input.frame as BrowserOverlayFrame, expectNonEmptyString(input.nodeRef, "nodeRef"), input.annotation as BrowserCaptureAnnotation);
      else if (input.action === "collect_unknown") receipt = resources.session.collectUnknown(input.frame as BrowserOverlayFrame);
      else if (input.action === "collect_unresolved") receipt = resources.session.collectUnresolved(input.frame as BrowserOverlayFrame);
      else if (input.action === "collect_qualified") receipt = resources.session.collectQualified(input.frame as BrowserOverlayFrame);
      else throw new TypeError("Unsupported browser capture action");
      return context.emit({ action: input.action, receipt });
    },
  }];
}
