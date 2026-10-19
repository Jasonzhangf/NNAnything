import type { CliEffect, PwdObservation } from "../adapters/cli/observation.js";
import { validateCliCwd } from "./cli-path.js";

export const CLI_GOAL_ACTIONS = Object.freeze(["REJECT", "PWD"] as const);
export const CLI_GOAL_WIRES = Object.freeze(["bias", "goalObserveCwd", "goalSetCwd"] as const);

export type CliGoalAction = (typeof CLI_GOAL_ACTIONS)[number];
export type CliGoalWire = (typeof CLI_GOAL_WIRES)[number];
export type CliGoalFeatures = readonly [number, number, number];

export type CliGoalProfile = Readonly<{
  contract: "cli.goal-policy.v1";
  actions: readonly ["REJECT", "PWD"];
  wires: readonly ["bias", "goalObserveCwd", "goalSetCwd"];
  weights: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  calibration: "uncalibrated";
  adoption: "not_applied";
}>;

export type StructuredCliGoal = Readonly<{
  kind: string;
  session: string;
  [field: string]: unknown;
}>;

export type CwdKnowledge = Readonly<{
  physicalCwd: string;
  evidence: PwdObservation;
  sourceRun: string;
}>;

export type CliGoalState = Readonly<{
  session: string;
  cwdObservation: null | CwdKnowledge;
}>;

export type CliGoalSession = Readonly<{
  id: string;
  cwd: string;
  grantedEffects: readonly CliEffect[];
}>;

export type CliGoalStepRequest = Readonly<{
  goal: StructuredCliGoal;
  state: CliGoalState;
}>;

export type CliGoalPolicySelection = Readonly<{
  features: CliGoalFeatures;
  scores: readonly [number, number];
  selectedAction: CliGoalAction;
}>;

export type CliGoalActionRecord =
  | Readonly<{ kind: "REJECT" }>
  | Readonly<{ kind: "PWD"; session: string }>;

export type CliGoalExecutionResult =
  | Readonly<{ status: "succeeded"; runId: string; executorInvoked: true; observation: PwdObservation }>
  | Readonly<{ status: "failed"; runId: string; executorInvoked: true; error: Readonly<{ operation: string; stage: string; code: string; message: string }> }>
  | Readonly<{ status: "rejected"; runId: string; executorInvoked: false; reason: "policy_rejected" | "unsupported_goal" }>;

export type CliGoalTransition = Readonly<{
  goal: StructuredCliGoal;
  state_before: CliGoalState;
  policy: CliGoalPolicySelection;
  action: CliGoalActionRecord;
  execution_result: CliGoalExecutionResult;
  observed_state_after: CliGoalState;
  policy_error: null | Readonly<{
    code: "UNEXPECTED_ACTION";
    expectedAction: CliGoalAction;
    selectedAction: CliGoalAction;
  }>;
  goal_result:
    | Readonly<{ status: "achieved"; reason: "fresh_pwd_observation" }>
    | Readonly<{ status: "unmet"; reason: "unsupported_goal" | "policy_rejected" | "execution_failed"; detail: string }>;
}>;

export type CliGoalFitRow = Readonly<{
  features: CliGoalFeatures;
  expected: CliGoalAction;
}>;

const CONTRACT = "cli.goal-policy.v1" as const;
const CALIBRATION = "uncalibrated" as const;
const ADOPTION = "not_applied" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (path.includes("\0") || !path.startsWith("/")) throw new TypeError(`${label} must be an absolute path without NUL`);
  return path;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

export function validateCliGoal(value: unknown): StructuredCliGoal {
  const goal = isRecord(value) ? value : null;
  if (goal === null) throw new TypeError("goal must be an object");
  const kind = nonEmpty(goal.kind, "goal.kind");
  const session = nonEmpty(goal.session, "goal.session");
  if (kind === "observe_cwd") {
    exactKeys(goal, ["kind", "session"], "observe_cwd goal");
    return Object.freeze({ kind, session });
  }
  if (kind === "set_cwd") {
    exactKeys(goal, ["kind", "session", "target"], "set_cwd goal");
    return Object.freeze({ kind, session, target: absolutePath(goal.target, "goal.target") });
  }
  return Object.freeze({ ...goal, kind, session });
}

function validatePwdObservation(value: unknown): PwdObservation {
  const observation = isRecord(value) ? value : null;
  if (observation === null) throw new TypeError("cwdObservation.evidence must be an object");
  exactKeys(observation, ["kind", "configuredCwd", "physicalCwd", "executable", "argv", "stdout", "stderr", "exitCode"], "pwd observation");
  if (observation.kind !== "pwd" || observation.executable !== "/bin/pwd") throw new TypeError("cwdObservation.evidence is not a native pwd observation");
  if (!Array.isArray(observation.argv) || observation.argv.length !== 1 || observation.argv[0] !== "-P") throw new TypeError("pwd observation argv must be [-P]");
  const configuredCwd = validateCliCwd(observation.configuredCwd);
  const physicalCwd = absolutePath(observation.physicalCwd, "pwd observation physicalCwd");
  if (typeof observation.stdout !== "string" || observation.stdout !== `${physicalCwd}\n`) throw new TypeError("pwd observation stdout must end with one newline");
  if (typeof observation.stderr !== "string" || observation.exitCode !== 0) throw new TypeError("pwd observation must have string stderr and exitCode 0");
  return Object.freeze({
    kind: "pwd",
    configuredCwd,
    physicalCwd,
    executable: "/bin/pwd",
    argv: Object.freeze(["-P"] as const),
    stdout: observation.stdout,
    stderr: observation.stderr,
    exitCode: 0,
  });
}

export function validateCwdKnowledge(value: unknown): CwdKnowledge {
  const knowledge = isRecord(value) ? value : null;
  if (knowledge === null) throw new TypeError("state.cwdObservation must be null or an object");
  exactKeys(knowledge, ["physicalCwd", "evidence", "sourceRun"], "state.cwdObservation");
  return Object.freeze({
    physicalCwd: absolutePath(knowledge.physicalCwd, "state.cwdObservation.physicalCwd"),
    evidence: validatePwdObservation(knowledge.evidence),
    sourceRun: nonEmpty(knowledge.sourceRun, "state.cwdObservation.sourceRun"),
  });
}

export function validateCliGoalState(value: unknown): CliGoalState {
  const state = isRecord(value) ? value : null;
  if (state === null) throw new TypeError("state must be an object");
  exactKeys(state, ["session", "cwdObservation"], "state");
  const session = nonEmpty(state.session, "state.session");
  if (state.cwdObservation === null) return Object.freeze({ session, cwdObservation: null });
  return Object.freeze({
    session,
    cwdObservation: validateCwdKnowledge(state.cwdObservation),
  });
}

export function validateCliGoalSession(value: unknown): CliGoalSession {
  const session = isRecord(value) ? value : null;
  if (session === null) throw new TypeError("session must be an object");
  exactKeys(session, ["id", "cwd", "grantedEffects"], "session");
  if (!Array.isArray(session.grantedEffects) || session.grantedEffects.some(effect => effect !== "filesystem.read" && effect !== "process.exec")) {
    throw new TypeError("session.grantedEffects must contain only filesystem.read and process.exec");
  }
  return Object.freeze({
    id: nonEmpty(session.id, "session.id"),
    cwd: validateCliCwd(session.cwd),
    grantedEffects: Object.freeze([...new Set(session.grantedEffects)] as CliEffect[]),
  });
}

export function validateCliGoalStepRequest(value: unknown, session?: Readonly<{ id: string }>): CliGoalStepRequest {
  const request = isRecord(value) ? value : null;
  if (request === null) throw new TypeError("goal step request must be an object");
  exactKeys(request, ["goal", "state"], "goal step request");
  const goal = validateCliGoal(request.goal);
  const state = validateCliGoalState(request.state);
  if (goal.session !== state.session) throw new TypeError("goal and state session references differ");
  if (session !== undefined && (goal.session !== session.id || state.session !== session.id)) {
    throw new TypeError("goal and state must reference the bound session");
  }
  return Object.freeze({ goal, state });
}

export function goalFeatures(goal: StructuredCliGoal): CliGoalFeatures {
  return goal.kind === "observe_cwd" ? [1, 1, 0] : goal.kind === "set_cwd" ? [1, 0, 1] : [1, 0, 0];
}

export function expectedGoalAction(goal: StructuredCliGoal): CliGoalAction {
  return goal.kind === "observe_cwd" ? "PWD" : "REJECT";
}

export function zeroCliGoalProfile(): CliGoalProfile {
  return Object.freeze({
    contract: CONTRACT,
    actions: Object.freeze([...CLI_GOAL_ACTIONS] as ["REJECT", "PWD"]),
    wires: Object.freeze([...CLI_GOAL_WIRES] as ["bias", "goalObserveCwd", "goalSetCwd"]),
    weights: Object.freeze([
      Object.freeze([0, 0, 0] as const),
      Object.freeze([0, 0, 0] as const),
    ] as const),
    calibration: CALIBRATION,
    adoption: ADOPTION,
  });
}

export function validateCliGoalProfile(value: unknown): CliGoalProfile {
  const profile = isRecord(value) ? value : null;
  if (profile === null) throw new TypeError("profile must be an object");
  exactKeys(profile, ["contract", "actions", "wires", "weights", "calibration", "adoption"], "profile");
  if (profile.contract !== CONTRACT) throw new TypeError("profile contract must be cli.goal-policy.v1");
  if (!Array.isArray(profile.actions) || profile.actions.length !== 2 || profile.actions[0] !== "REJECT" || profile.actions[1] !== "PWD") {
    throw new TypeError("profile actions must be [REJECT, PWD]");
  }
  const wires = profile.wires;
  if (!Array.isArray(wires) || wires.length !== 3 || CLI_GOAL_WIRES.some((wire, index) => wires[index] !== wire)) {
    throw new TypeError("profile wires must be [bias, goalObserveCwd, goalSetCwd]");
  }
  if (!Array.isArray(profile.weights) || profile.weights.length !== 2) throw new TypeError("profile weights must have two action rows");
  const weights = profile.weights.map((row, actionIndex) => {
    if (!Array.isArray(row) || row.length !== 3) throw new TypeError(`profile weight row ${actionIndex} must have three values`);
    return row.map((weight, wireIndex) => {
      if (typeof weight !== "number" || !Number.isFinite(weight)) throw new TypeError(`profile weight ${actionIndex}:${wireIndex} must be finite`);
      return weight;
    }) as [number, number, number];
  }) as [[number, number, number], [number, number, number]];
  if (profile.calibration !== CALIBRATION) throw new TypeError("profile calibration must be uncalibrated");
  if (profile.adoption !== ADOPTION) throw new TypeError("profile adoption must be not_applied");
  return Object.freeze({
    contract: CONTRACT,
    actions: Object.freeze(["REJECT", "PWD"] as const),
    wires: Object.freeze(["bias", "goalObserveCwd", "goalSetCwd"] as const),
    weights: Object.freeze([Object.freeze(weights[0]), Object.freeze(weights[1])] as const),
    calibration: CALIBRATION,
    adoption: ADOPTION,
  });
}

export function scoreCliGoalActions(features: CliGoalFeatures, profile: CliGoalProfile): readonly [number, number] {
  if (!Array.isArray(features) || features.length !== 3 || features.some(value => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError("features must contain three finite values");
  }
  const validated = validateCliGoalProfile(profile);
  const scores = validated.weights.map(row => row.reduce((sum, weight, index) => sum + weight * features[index]!, 0));
  return Object.freeze([scores[0]!, scores[1]!] as const);
}

export function selectCliGoalAction(scores: readonly [number, number]): CliGoalAction {
  return scores[1] > scores[0] ? "PWD" : "REJECT";
}
