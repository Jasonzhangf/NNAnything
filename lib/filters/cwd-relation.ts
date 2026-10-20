import { expectRecord } from "../core/schema.js";
import { selectSecondOnlyWhenGreater, scoreTwoClassLinear } from "./two-class-linear.js";
import { validateCwdKnowledge, type CwdKnowledge } from "./cli-state.js";

export const CWD_RELATION_ACTIONS = Object.freeze(["NO_MATCH", "MATCH"] as const);
export const CWD_RELATION_WIRES = Object.freeze(["bias", "sameSession", "hasObservation"] as const);

export type CwdRelationAction = (typeof CWD_RELATION_ACTIONS)[number];
export type CwdRelationWire = (typeof CWD_RELATION_WIRES)[number];
export type CwdRelationFeatures = readonly [number, number, number];

export type CwdRelationProfile = Readonly<{
  contract: "cli.cwd-relation.v1";
  actions: readonly ["NO_MATCH", "MATCH"];
  wires: readonly ["bias", "sameSession", "hasObservation"];
  weights: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  calibration: "uncalibrated";
  adoption: "not_applied";
}>;

export type CwdRelationQuestion = Readonly<{
  kind: "cwd.belongs_to";
  session: string;
  candidate: Readonly<{
    session: string;
    observation: null | CwdKnowledge;
  }>;
}>;

export type CwdRelationPrediction = Readonly<{
  features: CwdRelationFeatures;
  scores: readonly [number, number];
  selectedRelation: CwdRelationAction;
}>;

export type CwdRelationFitRow = Readonly<{
  features: CwdRelationFeatures;
  expected: CwdRelationAction;
}>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

export function zeroCwdRelationProfile(): CwdRelationProfile {
  return Object.freeze({
    contract: "cli.cwd-relation.v1",
    actions: Object.freeze([...CWD_RELATION_ACTIONS] as ["NO_MATCH", "MATCH"]),
    wires: Object.freeze([...CWD_RELATION_WIRES] as ["bias", "sameSession", "hasObservation"]),
    weights: Object.freeze([
      Object.freeze([0, 0, 0] as const),
      Object.freeze([0, 0, 0] as const),
    ] as const),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

export function validateCwdRelationProfile(value: unknown): CwdRelationProfile {
  const profile = expectRecord(value, "CWD relation profile");
  exactKeys(profile, ["contract", "actions", "wires", "weights", "calibration", "adoption"], "CWD relation profile");
  if (profile.contract !== "cli.cwd-relation.v1") throw new TypeError("CWD relation profile contract must be cli.cwd-relation.v1");
  if (!Array.isArray(profile.actions) || profile.actions.length !== 2 || profile.actions.some((action, index) => action !== CWD_RELATION_ACTIONS[index])) {
    throw new TypeError("CWD relation actions must be [NO_MATCH, MATCH]");
  }
  if (!Array.isArray(profile.wires) || profile.wires.length !== 3 || profile.wires.some((wire, index) => wire !== CWD_RELATION_WIRES[index])) {
    throw new TypeError("CWD relation wires must be [bias, sameSession, hasObservation]");
  }
  if (!Array.isArray(profile.weights) || profile.weights.length !== 2) throw new TypeError("CWD relation weights must have two rows");
  const weights = profile.weights.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== 3) throw new TypeError(`CWD relation weight row ${rowIndex} must have three values`);
    return row.map((weight, weightIndex) => {
      if (typeof weight !== "number" || !Number.isFinite(weight)) throw new TypeError(`CWD relation weight ${rowIndex}:${weightIndex} must be finite`);
      return weight;
    }) as [number, number, number];
  }) as [[number, number, number], [number, number, number]];
  if (profile.calibration !== "uncalibrated") throw new TypeError("CWD relation calibration must be uncalibrated");
  if (profile.adoption !== "not_applied") throw new TypeError("CWD relation adoption must be not_applied");
  return Object.freeze({
    contract: "cli.cwd-relation.v1",
    actions: Object.freeze(["NO_MATCH", "MATCH"] as const),
    wires: Object.freeze(["bias", "sameSession", "hasObservation"] as const),
    weights: Object.freeze([Object.freeze(weights[0]), Object.freeze(weights[1])] as const),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

export function validateCwdRelationQuestion(value: unknown): CwdRelationQuestion {
  const question = expectRecord(value, "CWD relation question");
  exactKeys(question, ["kind", "session", "candidate"], "CWD relation question");
  if (question.kind !== "cwd.belongs_to") throw new TypeError("CWD relation question kind must be cwd.belongs_to");
  const candidate = expectRecord(question.candidate, "CWD relation candidate");
  exactKeys(candidate, ["session", "observation"], "CWD relation candidate");
  return Object.freeze({
    kind: "cwd.belongs_to",
    session: nonEmpty(question.session, "question.session"),
    candidate: Object.freeze({
      session: nonEmpty(candidate.session, "candidate.session"),
      observation: candidate.observation === null ? null : validateCwdKnowledge(candidate.observation),
    }),
  });
}

export function cwdRelationFeatures(question: CwdRelationQuestion): CwdRelationFeatures {
  const validated = validateCwdRelationQuestion(question);
  return Object.freeze([
    1,
    validated.candidate.session === validated.session ? 1 : 0,
    validated.candidate.observation === null ? 0 : 1,
  ] as const);
}

export function scoreCwdRelation(features: CwdRelationFeatures, profile: CwdRelationProfile): readonly [number, number] {
  if (!Array.isArray(features) || features.length !== 3 || features.some(value => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError("CWD relation features must contain three finite values");
  }
  const validated = validateCwdRelationProfile(profile);
  return scoreTwoClassLinear(features, validated.weights);
}

export function selectCwdRelation(scores: readonly [number, number]): CwdRelationAction {
  return selectSecondOnlyWhenGreater(scores, "NO_MATCH", "MATCH");
}

export function predictCwdRelation(question: CwdRelationQuestion, profile: CwdRelationProfile): CwdRelationPrediction {
  const features = cwdRelationFeatures(question);
  const scores = scoreCwdRelation(features, profile);
  return Object.freeze({ features, scores, selectedRelation: selectCwdRelation(scores) });
}

export function expectedCwdRelation(question: CwdRelationQuestion): CwdRelationAction {
  const features = cwdRelationFeatures(question);
  return features[1] === 1 && features[2] === 1 ? "MATCH" : "NO_MATCH";
}

export function readCwdRelationFitRows(value: unknown): readonly CwdRelationFitRow[] {
  if (!Array.isArray(value)) throw new TypeError("CWD relation rows must be an array");
  return Object.freeze(value.map((raw, index) => {
    const row = expectRecord(raw, `CWD relation rows[${index}]`);
    exactKeys(row, ["features", "expected"], `CWD relation rows[${index}]`);
    if (!Array.isArray(row.features) || row.features.length !== 3 || row.features.some(feature => typeof feature !== "number" || !Number.isFinite(feature))) {
      throw new TypeError(`CWD relation rows[${index}].features must contain three finite values`);
    }
    if (row.expected !== "NO_MATCH" && row.expected !== "MATCH") throw new TypeError(`CWD relation rows[${index}].expected is invalid`);
    return Object.freeze({
      features: Object.freeze([...row.features] as [number, number, number]) as CwdRelationFeatures,
      expected: row.expected,
    });
  }));
}
