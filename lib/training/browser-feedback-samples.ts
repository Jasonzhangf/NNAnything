import { FEEDBACK_HEADS, type FeedbackEpisode, type FeedbackEvaluation, type FeedbackProfile } from "../adapters/browser/feedback-contract.js";
import type { SingleActionEpisodeResult } from "../adapters/browser/single-action-contract.js";
import { readFeedbackInput, predictFeedback } from "../filters/browser-feedback.js";
import { makeBrowserSingleActionSamples } from "./browser-single-action-samples.js";
import { expectRecord, isRecord } from "../core/schema.js";

/** One semantic field a recipe declares for a generated instance. */
export interface RecipeCondition {
  readonly path: string;
  readonly expected: unknown;
}

/**
 * F02 sample preparation declares a recipe before instantiation. This function
 * turns its nested semantic fields into dotted paths; callers assert those
 * paths against each generated instance before fitting. This module holds no
 * recipe and does not derive gold from predictions.
 */
export function declareRecipeConditions(recipe: unknown): RecipeCondition[] {
  const root = expectRecord(recipe, "recipe");
  const conditions: RecipeCondition[] = [];
  const visit = (record: Readonly<Record<string, unknown>>, prefix: string): void => {
    for (const [key, value] of Object.entries(record)) {
      if (key.length === 0) throw new TypeError("recipe condition path must not be empty");
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      if (isRecord(value)) visit(value, path);
      else conditions.push({ path, expected: value });
    }
  };
  visit(root, "");
  if (conditions.length === 0) throw new TypeError("recipe must declare at least one condition");
  return conditions;
}

const MISSING_RECIPE_FIELD = Symbol("missing recipe field");

function readRecipePath(instance: unknown, path: string): unknown | typeof MISSING_RECIPE_FIELD {
  let current: unknown = instance;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return MISSING_RECIPE_FIELD;
    }
    current = current[segment];
  }
  return current;
}

function formatRecipeValue(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

/**
 * Check declared recipe fields against one generated instance. A missing path
 * fails with the `recipe_field_missing:<path>` prefix; a present but different
 * value fails with `recipe_field_mismatch:<path>`. Nothing is inferred from
 * predictions, and neither the instance nor its gold is modified.
 */
export function assertRecipeFields(instance: unknown, conditions: readonly RecipeCondition[]): void {
  if (!Array.isArray(conditions)) throw new TypeError("recipe conditions must be an array");
  for (const condition of conditions) {
    if (!isRecord(condition) || typeof condition.path !== "string" || condition.path.length === 0) {
      throw new TypeError("recipe condition must declare a nonempty path");
    }
    const actual = readRecipePath(instance, condition.path);
    if (actual === MISSING_RECIPE_FIELD) {
      throw new TypeError(`recipe_field_missing:${condition.path}: expected ${formatRecipeValue(condition.expected)}`);
    }
    if (!Object.is(actual, condition.expected)) {
      throw new TypeError(
        `recipe_field_mismatch:${condition.path}: expected ${formatRecipeValue(condition.expected)}, actual ${formatRecipeValue(actual)}`,
      );
    }
  }
}

export function readFeedbackEpisodes(value: unknown): readonly FeedbackEpisode[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("Feedback episodes must be nonempty");
  const ids = new Set<string>();
  const families = new Map<string, string>();
  return value.map(raw => {
    const row = expectRecord(raw, "feedback episode");
    if (typeof row.id !== "string" || !row.id || ids.has(row.id) || typeof row.family !== "string" || !row.family
      || !["train", "development", "verification"].includes(String(row.partition))) throw new TypeError("Invalid feedback episode identity or partition");
    ids.add(row.id);
    if (families.has(row.family) && families.get(row.family) !== row.partition) throw new TypeError("Feedback family crosses partitions");
    families.set(row.family, String(row.partition));
    const input = readFeedbackInput(row.input);
    const teacher = expectRecord(row.teacher, "feedback teacher");
    const evidence = new Set([...input.request.state.evidence, ...(input.result.newState?.evidence ?? [])].map(fact => fact.id));
    if (!FEEDBACK_HEADS.includes(teacher.head as FeedbackEpisode["teacher"]["head"])
      || !["synthetic_projection", "observed_episode"].includes(String(teacher.source))
      || typeof teacher.note !== "string" || !teacher.note
      || !Array.isArray(teacher.evidenceRefs) || !teacher.evidenceRefs.length
      || teacher.evidenceRefs.some(ref => typeof ref !== "string" || !evidence.has(ref))) throw new TypeError("Invalid feedback supervision or evidence references");
    return { ...row, input } as unknown as FeedbackEpisode;
  });
}
export function partitionFeedbackEpisodes(value: readonly FeedbackEpisode[]) {
  const episodes = readFeedbackEpisodes(value);
  return { train: episodes.filter(row => row.partition === "train"), development: episodes.filter(row => row.partition === "development"), verification: episodes.filter(row => row.partition === "verification") };
}
export function evaluateFeedbackCases(profile: FeedbackProfile, value: readonly FeedbackEpisode[]): FeedbackEvaluation {
  const rows = readFeedbackEpisodes(value).map(row => {
    const actual = predictFeedback(row.input, profile).head;
    return { id: row.id, expected: row.teacher.head, actual, passed: actual === row.teacher.head };
  });
  return { count: rows.length, passed: rows.filter(row => row.passed).length, failed: rows.filter(row => !row.passed).length, rows };
}
export function makeFeedbackSamples(): readonly FeedbackEpisode[] {
  const base = makeBrowserSingleActionSamples()[0]!;
  const episodes: FeedbackEpisode[] = [];
  for (const [familyIndex, family] of ["native-panel", "nested-card", "toolbar", "development-dialog"].entries()) {
    for (let variant = 0; variant < 12; variant += 1) {
      const id = `feedback-${family}-${variant}`;
      const original = structuredClone(base.request);
      const request = { ...original, state: { ...original.state, documentRef: `document:${id}`, observationId: `${id}:pre`, revision: 1,
        evidence: original.state.evidence.map(fact => ({ ...fact, observationId: `${id}:pre`, source: "synthetic.feedback", fact: { family, variant } })) } };
      const post = structuredClone(request.state);
      const newState = { ...post, observationId: `${id}:post`, revision: 2,
        evidence: post.evidence.map(fact => ({ ...fact, observationId: `${id}:post` })) };
      const region = newState.regions.find(item => item.ref === request.goal.regionRef)!;
      Object.assign(region, { expanded: { status: "observed", value: false, evidenceRefs: [newState.evidence[0]!.id] },
        rendered: { status: "observed", value: false, evidenceRefs: [newState.evidence[0]!.id] } });
      const target = request.state.elements.find(item => item.controls.status === "observed" && item.controls.value.includes(request.goal.regionRef) && item.enabled.status === "observed" && item.enabled.value)!;
      const invocation = { kind: "click" as const, targetRef: target.ref, point: { x: 10 + familyIndex, y: 20 },
        documentRef: request.state.documentRef, observationId: request.state.observationId, revision: request.state.revision };
      let result: SingleActionEpisodeResult = { prediction: null, invocation, receipt: { dispatched: true, ok: true, effectKnowledge: "known", source: "synthetic.fixture", error: null },
        dispatchState: "dispatched", effectKnowledge: "known", newState, satisfaction: 0, achieved: false, error: null, collectionError: null };
      let controlAtCompletion: { documentRef: string; observationId: string; revision: number } | null = {
        documentRef: newState.documentRef, observationId: newState.observationId, revision: newState.revision,
      };
      let head: FeedbackEpisode["teacher"]["head"] = "completed_without_goal";
      if (variant >= 4 && variant <= 7) {
        head = "execution_rejected";
        result = { ...result, receipt: { dispatched: false, ok: false, effectKnowledge: "none", source: "synthetic.fixture", error: { code: "native_input_rejected", message: "Synthetic explicit rejection" } },
          dispatchState: "not_dispatched", effectKnowledge: "none", newState: null, satisfaction: null };
        controlAtCompletion = null;
        if (variant === 5 || variant === 7) {
          result = { ...result, receipt: { ...result.receipt!, dispatched: true, effectKnowledge: "known" }, dispatchState: "dispatched", effectKnowledge: "known", newState };
          controlAtCompletion = { documentRef: newState.documentRef, observationId: newState.observationId, revision: newState.revision };
        }
      } else if (variant >= 8) {
        head = "indeterminate";
        if (variant === 8) result = { ...result, receipt: { ...result.receipt!, effectKnowledge: "unknown" }, effectKnowledge: "unknown" };
        if (variant === 9) { result = { ...result, newState: null, satisfaction: null, error: { code: "post_observation_failed", message: "Synthetic missing posterior" } }; controlAtCompletion = null; }
        if (variant === 10) controlAtCompletion = { ...controlAtCompletion!, revision: 3 };
        if (variant === 11) { result = { ...result, dispatchState: "unknown", effectKnowledge: "unknown", receipt: null, newState: null, satisfaction: null,
          error: { code: "native_click_failed", message: "Synthetic uncertain dispatch" } }; controlAtCompletion = null; }
      }
      episodes.push({ id, family: `feedback.${family}`, partition: familyIndex === 3 ? "development" : "train", input: { request, result, controlAtCompletion },
        teacher: { head, source: "synthetic_projection", evidenceRefs: [request.state.evidence[0]!.id], note: "Explicit synthetic receipt/posterior projection; not a real browser effect." } });
    }
  }
  return readFeedbackEpisodes(episodes);
}
