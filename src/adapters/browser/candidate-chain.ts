import type { EventStatus } from "../../core/events.js";
import { createFocusSpec, type FocusSpec, type NodeCondition } from "./focus.js";
import { hasPositiveArea, intersectsPositive, loadSavedObservation, type ObservationNode, type PageObservation, type Rect } from "./observation.js";

export interface CandidateRequest {
  readonly observation: PageObservation;
  readonly nodeRefs?: readonly string[];
}

export interface CandidateSlot {
  readonly index: number;
  readonly nodeRef: string;
  readonly status: EventStatus;
  readonly reasons: readonly string[];
  readonly evidence: {
    readonly boundingBoxIntersection: "positive" | "none" | "unassessed";
    readonly fragments: "assessed" | "unassessed";
    readonly clipping: "assessed" | "unassessed";
  };
}

export interface CandidateBatch {
  readonly observation: PageObservation;
  readonly mode: "page" | "explicit";
  readonly slots: readonly CandidateSlot[];
  readonly candidateRefs: readonly string[];
  readonly ruleVersion: "0.1.0";
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("candidate payload must be an object");
  return value as Record<string, unknown>;
}

export function validateCandidateRequest(value: unknown): CandidateRequest {
  const input = record(value);
  if (input.nodeRefs !== undefined && (!Array.isArray(input.nodeRefs) || !input.nodeRefs.every(ref => typeof ref === "string" && ref.length > 0))) {
    throw new Error("nodeRefs must be an array of nonempty strings");
  }
  return {
    observation: loadSavedObservation(input.observation),
    ...(input.nodeRefs === undefined ? {} : { nodeRefs: input.nodeRefs as string[] }),
  };
}

export function validateCandidateBatch(value: unknown): CandidateBatch {
  const input = record(value);
  if (input.mode !== "page" && input.mode !== "explicit") throw new Error("candidate mode must be page or explicit");
  if (input.ruleVersion !== "0.1.0" || !Array.isArray(input.slots) || !Array.isArray(input.candidateRefs)) throw new Error("invalid candidate batch");
  const observation = loadSavedObservation(input.observation);
  const slots = input.slots.map((raw, index) => {
    const slot = record(raw);
    const evidence = record(slot.evidence);
    if (slot.index !== index || typeof slot.nodeRef !== "string" || !["ok", "skipped", "filtered_out", "unknown"].includes(String(slot.status)) || !Array.isArray(slot.reasons) || !slot.reasons.every(reason => typeof reason === "string") || !["positive", "none", "unassessed"].includes(String(evidence.boundingBoxIntersection)) || !["assessed", "unassessed"].includes(String(evidence.fragments)) || !["assessed", "unassessed"].includes(String(evidence.clipping))) throw new Error("invalid candidate slot");
    return raw as CandidateSlot;
  });
  const candidateRefs = slots.filter(slot => slot.status === "ok").map(slot => slot.nodeRef);
  if (JSON.stringify(input.candidateRefs) !== JSON.stringify(candidateRefs)) throw new Error("candidateRefs must match ok slots in order");
  return { observation, mode: input.mode, slots, candidateRefs, ruleVersion: "0.1.0" };
}

function batchWith(batch: CandidateBatch, slots: readonly CandidateSlot[]): CandidateBatch {
  return { ...batch, slots, candidateRefs: slots.filter(slot => slot.status === "ok").map(slot => slot.nodeRef) };
}

export function observeCandidates(request: CandidateRequest): CandidateBatch {
  const refs = request.nodeRefs ?? request.observation.nodes.map(node => node.nodeRef);
  const known = new Set(request.observation.nodes.map(node => node.nodeRef));
  const slots: CandidateSlot[] = refs.map((nodeRef, index) => ({
    index, nodeRef, status: known.has(nodeRef) ? "ok" : "unknown", reasons: known.has(nodeRef) ? [] : ["missing_node_ref"],
    evidence: { boundingBoxIntersection: "unassessed", fragments: "unassessed", clipping: "unassessed" },
  }));
  return batchWith({ observation: request.observation, mode: request.nodeRefs === undefined ? "page" : "explicit", slots, candidateRefs: [], ruleVersion: "0.1.0" }, slots);
}

function verdict(slot: CandidateSlot, status: EventStatus, reason: string): CandidateSlot {
  return { ...slot, status, reasons: [reason] };
}

function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

function geometry(slot: CandidateSlot, node: ObservationNode, area: Rect, outside: string): CandidateSlot {
  const evidence: CandidateSlot["evidence"] = {
    boundingBoxIntersection: node.rect === null ? "unassessed" : intersectsPositive(node.rect, area) ? "positive" : "none",
    fragments: node.fragments === null ? "unassessed" : "assessed",
    clipping: node.clippedRect === null ? "unassessed" : "assessed",
  };
  const next = { ...slot, evidence };
  if (node.rect === null) return verdict(next, "unknown", "insufficient_geometry");
  if (!hasPositiveArea(node.rect)) return verdict(next, "skipped", "zero_geometry");
  if (!intersectsPositive(node.rect, area)) return verdict(next, "filtered_out", outside);
  if (node.fragments === null || node.clippedRect === null) return verdict(next, "unknown", "insufficient_observation");
  const visible = intersection(intersection(node.rect, area), node.clippedRect);
  if (!hasPositiveArea(visible) || !node.fragments.some(fragment => hasPositiveArea(fragment) && intersectsPositive(fragment, visible))) return verdict(next, "filtered_out", "nonrendered");
  return next;
}

// Missing rule fields are unknown, never evidence of a failed condition.
type Match = true | false | "unknown";
function matches(node: ObservationNode, condition: NodeCondition): Match {
  const checks: Match[] = [];
  if (condition.nodeRef !== undefined) checks.push(node.nodeRef === condition.nodeRef);
  if (condition.tag !== undefined) checks.push(node.tag === null ? "unknown" : node.tag.toLowerCase() === condition.tag.toLowerCase());
  if (condition.role !== undefined) checks.push(node.role === null ? "unknown" : node.role === condition.role);
  for (const [key, expected] of Object.entries(condition.attributes ?? {})) checks.push(Object.hasOwn(node.attributes, key) ? node.attributes[key] === expected : "unknown");
  return checks.includes(false) ? false : checks.includes("unknown") ? "unknown" : true;
}
function anyMatch(node: ObservationNode, conditions: readonly NodeCondition[]): Match {
  const results = conditions.map(condition => matches(node, condition));
  return results.includes(true) ? true : results.includes("unknown") ? "unknown" : false;
}

function ancestors(node: ObservationNode, nodes: ReadonlyMap<string, ObservationNode>): ObservationNode[] {
  const result = [node];
  let parent = node.parentRef;
  while (parent !== null) {
    const next = nodes.get(parent);
    if (!next) break;
    result.push(next);
    parent = next.parentRef;
  }
  return result;
}

export type RuleStage = "viewport" | "focus" | "deny" | "allow";
export function applyCandidateStage(batch: CandidateBatch, focus: FocusSpec, stage: RuleStage): CandidateBatch {
  const nodes = new Map(batch.observation.nodes.map(node => [node.nodeRef, node]));
  const slots = batch.slots.map(slot => {
    if (slot.status !== "ok") return slot;
    const node = nodes.get(slot.nodeRef);
    if (!node) return verdict(slot, "unknown", "missing_node_ref");
    if (stage === "viewport") return geometry(slot, node, batch.observation.viewport, "outside_viewport");
    if (stage === "focus") {
      if (focus.within !== undefined && !ancestors(node, nodes).some(ancestor => ancestor.nodeRef === focus.within)) return verdict(slot, "filtered_out", "outside_focus");
      return focus.region === undefined ? slot : geometry(slot, node, intersection(batch.observation.viewport, focus.region), "outside_focus");
    }
    if (stage === "deny") {
      const subtreeMatches = ancestors(node, nodes).map(ancestor => anyMatch(ancestor, focus.excludeSubtrees ?? []));
      if (subtreeMatches.includes(true)) return verdict(slot, "filtered_out", "subtree_excluded");
      const denied = anyMatch(node, focus.deny ?? []);
      if (denied === true) return verdict(slot, "filtered_out", "deny_match");
      if (denied === "unknown" || subtreeMatches.includes("unknown")) return verdict(slot, "unknown", "insufficient_rule_observation");
    }
    if (stage === "allow" && focus.allow !== undefined) {
      const allowed = anyMatch(node, focus.allow);
      if (allowed === false) return verdict(slot, "filtered_out", "allow_miss");
      if (allowed === "unknown") return verdict(slot, "unknown", "insufficient_rule_observation");
    }
    return slot;
  });
  return batchWith(batch, slots);
}

export function scopeIssue(batch: CandidateBatch, focus: FocusSpec): string | undefined {
  if (focus.within !== undefined && !batch.observation.nodes.some(node => node.nodeRef === focus.within)) return "stale_scope";
  // This adapter has no semantic ownership measurements. DOM parents are not ownership.
  if (focus.scopeMode === "owned") return "unsupported_scope";
  return undefined;
}

export function splitCandidates(batch: CandidateBatch): CandidateBatch {
  if (batch.mode === "explicit") return batch;
  const children = new Map<string | null, ObservationNode[]>();
  for (const node of batch.observation.nodes) children.set(node.parentRef, [...(children.get(node.parentRef) ?? []), node]);
  const slots = new Map(batch.slots.map(slot => [slot.nodeRef, slot]));
  const ordered: CandidateSlot[] = [];
  const stack = [...(children.get(null) ?? [])].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    const slot = slots.get(node.nodeRef);
    if (slot) ordered.push({ ...slot, index: ordered.length });
    // A self verdict never prunes descendants. Explicit subtree exclusions retain their mapping too.
    stack.push(...[...(children.get(node.nodeRef) ?? [])].reverse());
  }
  return batchWith(batch, ordered);
}

export function checkCandidates(batch: CandidateBatch, focus: FocusSpec): CandidateBatch {
  let result = batch;
  for (const stage of ["viewport", "focus", "deny", "allow"] as const) result = applyCandidateStage(result, focus, stage);
  return result;
}
