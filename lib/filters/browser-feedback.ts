import { FEEDBACK_HEADS, FEEDBACK_WIRES, type FeedbackInput, type FeedbackPrediction, type FeedbackProfile } from "../adapters/browser/feedback-contract.js";
import { readSingleActionRequest, readSingleActionSnapshot } from "../adapters/browser/single-action-observation.js";
import type { SingleActionEpisodeResult } from "../adapters/browser/single-action-contract.js";
import { expectRecord } from "../core/schema.js";

function control(value: unknown) {
  const input = expectRecord(value, "feedback control");
  if (typeof input.documentRef !== "string" || !input.documentRef
    || typeof input.observationId !== "string" || !input.observationId
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new TypeError("Invalid feedback control");
  return { documentRef: input.documentRef, observationId: input.observationId, revision: Number(input.revision) };
}
function error(value: unknown): void {
  if (value === null) return;
  const input = expectRecord(value, "feedback error");
  if (typeof input.code !== "string" || !input.code || typeof input.message !== "string") throw new TypeError("Invalid feedback error");
}
export function readFeedbackInput(value: unknown): FeedbackInput {
  const input = expectRecord(value, "feedback input");
  const request = readSingleActionRequest(input.request);
  const rawResult = expectRecord(input.result, "feedback attempt result");
  if (!["not_dispatched", "dispatched", "unknown"].includes(String(rawResult.dispatchState))
    || !["none", "known", "unknown"].includes(String(rawResult.effectKnowledge))
    || typeof rawResult.achieved !== "boolean"
    || ![null, 0, 100].includes(rawResult.satisfaction as null | number)
    || (rawResult.collectionError !== null && typeof rawResult.collectionError !== "string")) throw new TypeError("Invalid feedback attempt result");
  const result = rawResult as unknown as SingleActionEpisodeResult;
  error(result.error);
  if (result.newState !== null) readSingleActionSnapshot(result.newState);
  if (input.controlAtCompletion !== null) control(input.controlAtCompletion);
  if (result.receipt !== null) {
    const receipt = expectRecord(result.receipt, "feedback receipt");
    if (typeof receipt.dispatched !== "boolean" || typeof receipt.ok !== "boolean"
      || !["none", "known", "unknown"].includes(String(receipt.effectKnowledge))
      || typeof receipt.source !== "string" || !receipt.source
      || (!receipt.dispatched && receipt.effectKnowledge !== "none")) throw new TypeError("Invalid feedback receipt");
    error(receipt.error);
    if (result.dispatchState !== (receipt.dispatched ? "dispatched" : "not_dispatched")
      || result.effectKnowledge !== receipt.effectKnowledge) throw new TypeError("Feedback receipt contradicts dispatch/effect knowledge");
  }
  if (result.invocation !== null) {
    const invocation = expectRecord(result.invocation, "feedback invocation");
    control(invocation);
    const point = expectRecord(invocation.point, "feedback point");
    if (invocation.kind !== "click" || typeof invocation.targetRef !== "string" || !invocation.targetRef
      || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new TypeError("Invalid feedback invocation");
  }
  return { request, result, controlAtCompletion: input.controlAtCompletion === null ? null : control(input.controlAtCompletion) };
}
export function validateFeedbackProfile(value: unknown): FeedbackProfile {
  const input = expectRecord(value, "feedback profile");
  if (input.contract !== "browser.action-feedback.v1" || input.calibration !== "uncalibrated" || input.adoption !== "not_applied"
    || JSON.stringify(input.heads) !== JSON.stringify(FEEDBACK_HEADS)
    || JSON.stringify(input.wires) !== JSON.stringify(FEEDBACK_WIRES)
    || !Array.isArray(input.weights) || input.weights.length !== FEEDBACK_HEADS.length
    || input.weights.some(row => !Array.isArray(row) || row.length !== FEEDBACK_WIRES.length || row.some(x => typeof x !== "number" || !Number.isFinite(x)))) {
    throw new TypeError("Invalid browser feedback profile");
  }
  return value as FeedbackProfile;
}
export function createZeroFeedbackProfile(): FeedbackProfile {
  return { contract: "browser.action-feedback.v1", heads: [...FEEDBACK_HEADS], wires: [...FEEDBACK_WIRES],
    weights: FEEDBACK_HEADS.map(() => FEEDBACK_WIRES.map(() => 0)), calibration: "uncalibrated", adoption: "not_applied" };
}
function postValid(input: FeedbackInput): boolean {
  const { request, result, controlAtCompletion: current } = input;
  const state = result.newState;
  if (!state || !current || state.documentRef !== request.state.documentRef || state.scopeRef !== request.state.scopeRef
    || current.documentRef !== state.documentRef || current.observationId !== state.observationId || current.revision !== state.revision
    || !state.regions.some(region => region.ref === request.goal.regionRef)
    || ["stale_reference", "invalid_binding", "control_unavailable", "post_observation_failed"].includes(result.error?.code ?? "")) return false;
  if (result.invocation === null) {
    return result.dispatchState === "not_dispatched" && state.observationId === request.state.observationId && state.revision === request.state.revision;
  }
  return result.invocation.documentRef === request.state.documentRef
    && result.invocation.observationId === request.state.observationId && result.invocation.revision === request.state.revision
    && state.observationId !== request.state.observationId && state.revision > request.state.revision;
}
export function feedbackFeatures(value: FeedbackInput): readonly number[] {
  const input = readFeedbackInput(value);
  const valid = postValid(input);
  const region = valid ? input.result.newState!.regions.find(item => item.ref === input.request.goal.regionRef) : undefined;
  return [1, Number(input.result.dispatchState !== "unknown"), Number(input.result.dispatchState === "dispatched"),
    Number(input.result.receipt !== null), Number(input.result.receipt?.ok === true),
    Number(input.result.receipt?.error != null || input.result.error?.code === "native_click_failed"), Number(valid),
    Number(region?.expanded.status === "observed"), Number(region?.expanded.status === "observed" && region.expanded.value),
    Number(region?.rendered.status === "observed"), Number(region?.rendered.status === "observed" && region.rendered.value),
    Number(input.result.effectKnowledge !== "unknown")];
}
export function predictFeedback(value: FeedbackInput, rawProfile: FeedbackProfile): FeedbackPrediction {
  const input = readFeedbackInput(value);
  const profile = validateFeedbackProfile(rawProfile);
  const features = feedbackFeatures(input);
  const region = input.result.newState?.regions.find(item => item.ref === input.request.goal.regionRef);
  const evidenceRefs = region ? [region.expanded, region.rendered].flatMap(fact => fact.status === "observed" ? [...fact.evidenceRefs] : []) : [];
  if (postValid(input) && input.result.error === null && input.result.achieved && input.result.satisfaction === 100
    && region?.expanded.status === "observed" && region.expanded.value
    && region.rendered.status === "observed" && region.rendered.value) {
    return { status: "goal_achieved", head: null, features, scores: [], evidenceRefs };
  }
  const scores = profile.weights.map(row => row.reduce((sum, weight, index) => sum + weight * features[index]!, 0));
  const maximum = Math.max(...scores);
  const winners = scores.map((score, index) => score === maximum ? index : -1).filter(index => index >= 0);
  return { status: winners.length === 1 ? "predicted" : "unknown", head: winners.length === 1 ? FEEDBACK_HEADS[winners[0]!]! : null,
    features, scores, evidenceRefs };
}
