import { mkdir, lstat, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { CliRequest, CliResult } from "../adapters/cli/observation.js";
import type { NodeDefinition } from "../core/contracts.js";
import { expectNonEmptyString, expectRecord } from "../core/schema.js";
import {
  CLI_GOAL_ACTIONS,
  expectedGoalAction,
  goalFeatures,
  scoreCliGoalActions,
  selectCliGoalAction,
  validateCliGoalProfile,
  validateCliGoalStepRequest,
  zeroCliGoalProfile,
  type CliGoalAction,
  type CliGoalExecutionResult,
  type CliGoalPolicySelection,
  type CliGoalSession,
  type CliGoalState,
  type CliGoalStepRequest,
  type CliGoalTransition,
  type StructuredCliGoal,
} from "../filters/cli-goal-policy.js";
import { fitCliGoalPolicy, type FitCliGoalPolicyResult } from "../training/cli-goal-numeric.js";
import {
  prepareCliGoalDataset,
  type CliGoalDataset,
  type CliGoalSample,
  type PreparedCliGoalDataset,
} from "../training/cli-goal-samples.js";

export interface CliGoalBoundSession {
  readonly id: string;
  readonly cwd: string;
  observe(request: CliRequest): Promise<CliResult>;
}

export interface CliGoalPolicyEvaluator {
  step(request: CliGoalStepRequest): Promise<CliGoalTransition>;
}

export type CliGoalPolicyFactory = (
  profile: ReturnType<typeof zeroCliGoalProfile>,
  session: CliGoalSession,
) => CliGoalPolicyEvaluator;

type SelectionPayload = Readonly<{
  goal: StructuredCliGoal;
  state: CliGoalState;
  policy: CliGoalPolicySelection;
}>;

type ExecutionPayload = Readonly<{
  goal: StructuredCliGoal;
  state_before: CliGoalState;
  policy: CliGoalPolicySelection;
  action: CliGoalTransition["action"];
  execution_result: CliGoalExecutionResult;
}>;

export interface CliGoalEvaluationRow {
  readonly id: string;
  readonly expectedAction: CliGoalAction;
  readonly expectedGoalStatus: "achieved" | "unmet";
  readonly features: readonly [number, number, number];
  readonly scores: readonly [number, number];
  readonly selectedAction: CliGoalAction;
  readonly action: "REJECT" | "PWD";
  readonly executionStatus: "succeeded" | "failed" | "rejected";
  readonly executionReason: string | null;
  readonly errorCode: string | null;
  readonly executorInvoked: boolean;
  readonly policyErrorCode: string | null;
  readonly goalStatus: "achieved" | "unmet";
  readonly goalReason: string;
  readonly stateCwd: string | null;
  readonly observedCwd: string | null;
  readonly session: string;
}

export interface CliGoalPolicyEvaluation {
  readonly sampleCount: number;
  readonly uniqueFeatureVectors: number;
  readonly correctActions: number;
  readonly policyAccuracy: number;
  readonly policyErrorCount: number;
  readonly guardRejections: number;
  readonly achievedGoals: number;
  readonly expectedAchievedGoals: number;
  readonly executionCount: number;
  readonly rows: readonly CliGoalEvaluationRow[];
}

export interface CliGoalPartitionComparison {
  readonly zero: CliGoalPolicyEvaluation;
  readonly frozen: CliGoalPolicyEvaluation;
  readonly trained: CliGoalPolicyEvaluation;
  readonly fixed: number;
  readonly regressed: number;
  readonly retained: number;
  readonly unresolved: number;
}

export interface CliGoalTrainingRequest {
  readonly dataset: CliGoalDataset;
  readonly epochs: number;
  readonly learningRate: number;
}

export interface CliGoalTrainingResources {
  readonly handwiredRoot: string;
  readonly outputRoot: string;
  readonly grantedEffects: readonly string[];
}

export interface CliGoalTrainingReceipt {
  readonly runId: string;
  readonly paths: { readonly samples: string; readonly profile: string; readonly report: string };
  readonly accepted: boolean;
  readonly comparison: { readonly train: CliGoalPartitionComparison; readonly development: CliGoalPartitionComparison };
  readonly timing: FitCliGoalPolicyResult["timing"];
  readonly evaluationMs: number;
  readonly saveMs: number;
  readonly workflowMs: number;
}

export interface CliGoalTrainingDiagnostics {
  partialPaths: { samples?: string; profile?: string; report?: string };
  fitTiming?: unknown;
  evaluationMs?: number;
}

interface PreparedStage {
  readonly prepared: PreparedCliGoalDataset;
  readonly initial: ReturnType<typeof zeroCliGoalProfile>;
  readonly epochs: number;
  readonly learningRate: number;
}

interface CandidateStage extends PreparedStage {
  readonly fit: FitCliGoalPolicyResult;
}

interface EvaluatedStage extends CandidateStage {
  readonly comparison: CliGoalTrainingReceipt["comparison"];
  readonly frozen: FitCliGoalPolicyResult;
  readonly evaluationMs: number;
}

const port = (name: string, eventType: string, validate: (value: unknown) => unknown) => ({
  name,
  schemaId: eventType,
  eventType,
  validate,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAction(value: unknown, label: string): CliGoalAction {
  const action = expectNonEmptyString(value, label);
  if (!CLI_GOAL_ACTIONS.includes(action as CliGoalAction)) throw new TypeError(`${label} is not a cli-goal action`);
  return action as CliGoalAction;
}

function readPolicySelection(value: unknown): CliGoalPolicySelection {
  const policy = expectRecord(value, "goal policy selection");
  const features = policy.features;
  const scores = policy.scores;
  if (!Array.isArray(features) || features.length !== 3 || features.some(number => typeof number !== "number" || !Number.isFinite(number))) {
    throw new TypeError("goal selection features must contain three finite values");
  }
  if (!Array.isArray(scores) || scores.length !== 2 || scores.some(number => typeof number !== "number" || !Number.isFinite(number))) {
    throw new TypeError("goal selection scores must contain two finite values");
  }
  return value as CliGoalPolicySelection;
}

function readSelection(value: unknown): SelectionPayload {
  const selection = expectRecord(value, "goal selection");
  const request = validateCliGoalStepRequest({ goal: selection.goal, state: selection.state });
  return { goal: request.goal, state: request.state, policy: readPolicySelection(selection.policy) };
}

function readExecutionResult(value: unknown): CliGoalExecutionResult {
  const result = expectRecord(value, "goal execution result");
  if (typeof result.runId !== "string" || typeof result.executorInvoked !== "boolean") throw new TypeError("Invalid goal execution result");
  if (result.status === "succeeded") {
    if (result.executorInvoked !== true || !isRecord(result.observation) || result.observation.kind !== "pwd") throw new TypeError("Invalid successful goal execution");
    return value as CliGoalExecutionResult;
  }
  if (result.status === "failed") {
    if (result.executorInvoked !== true || !isRecord(result.error)) throw new TypeError("Invalid failed goal execution");
    return value as CliGoalExecutionResult;
  }
  if (result.status === "rejected" && result.executorInvoked === false && (result.reason === "policy_rejected" || result.reason === "unsupported_goal")) {
    return value as CliGoalExecutionResult;
  }
  throw new TypeError("Invalid goal execution result");
}

function readExecution(value: unknown): ExecutionPayload {
  const execution = expectRecord(value, "goal execution");
  const request = validateCliGoalStepRequest({ goal: execution.goal, state: execution.state_before });
  const action = expectRecord(execution.action, "goal action");
  if (action.kind === "REJECT" && Object.keys(action).length === 1) {
    return {
      goal: request.goal,
      state_before: request.state,
      policy: readPolicySelection(execution.policy),
      action: { kind: "REJECT" },
      execution_result: readExecutionResult(execution.execution_result),
    };
  }
  if (action.kind === "PWD" && typeof action.session === "string" && action.session === request.goal.session) {
    return {
      goal: request.goal,
      state_before: request.state,
      policy: readPolicySelection(execution.policy),
      action: { kind: "PWD", session: action.session },
      execution_result: readExecutionResult(execution.execution_result),
    };
  }
  throw new TypeError("Invalid goal action");
}

export function readCliGoalTransition(value: unknown): CliGoalTransition {
  const transition = expectRecord(value, "goal transition");
  const execution = readExecution({
    goal: transition.goal,
    state_before: transition.state_before,
    policy: transition.policy,
    action: transition.action,
    execution_result: transition.execution_result,
  });
  if (!isRecord(transition.observed_state_after) || !isRecord(transition.goal_result)) throw new TypeError("Invalid goal transition state or result");
  if (transition.policy_error !== null && !isRecord(transition.policy_error)) throw new TypeError("Invalid goal policy error");
  if (transition.goal_result.status !== "achieved" && transition.goal_result.status !== "unmet") throw new TypeError("Invalid goal result status");
  if (execution.policy.selectedAction !== execution.action.kind) throw new TypeError("Selected action differs from bound action");
  return value as CliGoalTransition;
}

export function createCliGoalStepNodes(session: CliGoalBoundSession): readonly NodeDefinition[] {
  const selectionPort = port("goal_selection", "cli.goal.selection.v1", readSelection);
  const executionPort = port("goal_execution", "cli.goal.execution.v1", readExecution);
  return [
    {
      operator: "cli.goal.select",
      version: "0.1.0",
      inputPorts: [port("goal_step_request", "cli.goal.step-request.v1", value => validateCliGoalStepRequest(value))],
      outputPort: selectionPort,
      config: {
        required: true,
        validate(value) {
          const config = expectRecord(value, "goal selection config");
          if (Object.keys(config).length) throw new TypeError("Goal selection config must be empty");
          return {};
        },
      },
      profileValidator: validateCliGoalProfile,
      effects: [],
      execute(context) {
        const request = validateCliGoalStepRequest(context.inputs[0]!.payload, session);
        const profile = validateCliGoalProfile(context.profile);
        const features = goalFeatures(request.goal);
        const scores = scoreCliGoalActions(features, profile);
        const selectedAction = selectCliGoalAction(scores);
        return context.emit({ goal: request.goal, state: request.state, policy: { features, scores, selectedAction } });
      },
    },
    {
      operator: "cli.goal.execute",
      version: "0.1.0",
      inputPorts: [selectionPort],
      outputPort: executionPort,
      effects: [],
      async execute(context) {
        const selection = readSelection(context.inputs[0]!.payload);
        const { goal, state, policy } = selection;
        const runId = context.runId;
        if (policy.selectedAction === "REJECT") {
          return context.emit({
            goal,
            state_before: state,
            policy,
            action: { kind: "REJECT" },
            execution_result: {
              status: "rejected",
              runId,
              executorInvoked: false,
              reason: goal.kind === "observe_cwd" ? "policy_rejected" : "unsupported_goal",
            },
          });
        }
        const action = { kind: "PWD" as const, session: goal.session };
        if (goal.kind !== "observe_cwd") {
          return context.emit({
            goal,
            state_before: state,
            policy,
            action,
            execution_result: { status: "rejected", runId, executorInvoked: false, reason: "unsupported_goal" },
          });
        }
        const result = await session.observe({ kind: "pwd" });
        const execution_result: CliGoalExecutionResult = result.ok && result.observation.kind === "pwd"
          ? { status: "succeeded", runId, executorInvoked: true, observation: result.observation }
          : result.ok
            ? {
                status: "failed",
                runId,
                executorInvoked: true,
                error: { operation: "pwd", stage: "observe", code: "INVALID_OBSERVATION", message: "pwd returned a non-pwd observation" },
              }
            : { status: "failed", runId, executorInvoked: true, error: { ...result.error } };
        return context.emit({ goal, state_before: state, policy, action, execution_result });
      },
    },
    {
      operator: "cli.goal.evaluate",
      version: "0.1.0",
      inputPorts: [executionPort],
      outputPort: port("goal_transition", "cli.goal.transition.v1", readCliGoalTransition),
      effects: [],
      execute(context) {
        const execution = readExecution(context.inputs[0]!.payload);
        const { goal, state_before, policy, action, execution_result } = execution;
        const expectedAction = expectedGoalAction(goal);
        const policyError = policy.selectedAction === expectedAction
          ? null
          : { code: "UNEXPECTED_ACTION" as const, expectedAction, selectedAction: policy.selectedAction };
        const success = execution_result.status === "succeeded"
          && goal.kind === "observe_cwd"
          && policy.selectedAction === "PWD"
          && goal.session === session.id
          && execution_result.observation.configuredCwd === session.cwd;
        const observed_state_after = success && execution_result.status === "succeeded"
          ? {
              session: goal.session,
              cwdObservation: {
                physicalCwd: execution_result.observation.physicalCwd,
                evidence: execution_result.observation,
                sourceRun: execution_result.runId,
              },
            }
          : state_before;
        const goal_result: CliGoalTransition["goal_result"] = success
          ? { status: "achieved", reason: "fresh_pwd_observation" }
          : goal.kind !== "observe_cwd"
            ? { status: "unmet", reason: "unsupported_goal", detail: `${goal.kind} is outside this capability` }
            : policy.selectedAction === "REJECT"
              ? { status: "unmet", reason: "policy_rejected", detail: "the policy selected REJECT for observe_cwd" }
              : execution_result.status === "failed"
                ? { status: "unmet", reason: "execution_failed", detail: execution_result.error.message }
                : { status: "unmet", reason: "execution_failed", detail: "pwd evidence did not match the bound session" };
        return context.emit({
          goal,
          state_before,
          policy,
          action,
          execution_result,
          observed_state_after,
          policy_error: policyError,
          goal_result,
        });
      },
    },
  ];
}

function readTrainingRequest(value: unknown): CliGoalTrainingRequest {
  const request = expectRecord(value, "goal training request");
  if (Object.keys(request).some(key => !["dataset", "epochs", "learningRate"].includes(key))) throw new TypeError("Unknown goal training request field");
  if (!Number.isInteger(request.epochs) || (request.epochs as number) < 0) throw new TypeError("epochs must be a nonnegative integer");
  if (typeof request.learningRate !== "number" || !Number.isFinite(request.learningRate) || request.learningRate <= 0) throw new TypeError("learningRate must be positive finite");
  return {
    dataset: prepareCliGoalDataset(request.dataset).dataset,
    epochs: request.epochs as number,
    learningRate: request.learningRate,
  };
}

function readPrepared(value: unknown): PreparedStage {
  const stage = expectRecord(value, "goal prepared stage");
  const prepared = expectRecord(stage.prepared, "goal prepared dataset");
  if (prepared.dataset === undefined) throw new TypeError("Prepared stage needs dataset");
  const validated = prepareCliGoalDataset(prepared.dataset);
  if (!Number.isInteger(stage.epochs) || (stage.epochs as number) < 0) throw new TypeError("Invalid prepared epochs");
  if (typeof stage.learningRate !== "number" || !Number.isFinite(stage.learningRate) || stage.learningRate <= 0) throw new TypeError("Invalid prepared learningRate");
  return {
    prepared: validated,
    initial: validateCliGoalProfile(stage.initial),
    epochs: stage.epochs as number,
    learningRate: stage.learningRate,
  };
}

function readCandidate(value: unknown): CandidateStage {
  const prepared = readPrepared(value);
  const stage = expectRecord(value, "goal candidate stage");
  const fit = expectRecord(stage.fit, "goal fit");
  validateCliGoalProfile(fit.profile);
  expectRecord(fit.timing, "goal fit timing");
  return { ...prepared, fit: stage.fit as unknown as FitCliGoalPolicyResult };
}

function readEvaluated(value: unknown): EvaluatedStage {
  const candidate = readCandidate(value);
  const stage = expectRecord(value, "goal evaluation stage");
  const comparison = expectRecord(stage.comparison, "goal comparison");
  for (const partition of ["train", "development"]) expectRecord(comparison[partition], partition);
  const frozen = expectRecord(stage.frozen, "goal frozen control");
  validateCliGoalProfile(frozen.profile);
  if (typeof stage.evaluationMs !== "number" || stage.evaluationMs < 0) throw new TypeError("Invalid goal evaluation timing");
  return {
    ...candidate,
    comparison: stage.comparison as unknown as CliGoalTrainingReceipt["comparison"],
    frozen: stage.frozen as unknown as FitCliGoalPolicyResult,
    evaluationMs: stage.evaluationMs,
  };
}

function transitionRow(sample: CliGoalSample, transition: CliGoalTransition): CliGoalEvaluationRow {
  const execution = transition.execution_result;
  return {
    id: sample.id,
    expectedAction: sample.expectedAction,
    expectedGoalStatus: sample.expectedGoalStatus,
    features: transition.policy.features,
    scores: transition.policy.scores,
    selectedAction: transition.policy.selectedAction,
    action: transition.action.kind,
    executionStatus: execution.status,
    executionReason: execution.status === "rejected" ? execution.reason : null,
    errorCode: execution.status === "failed" ? execution.error.code : null,
    executorInvoked: execution.executorInvoked,
    policyErrorCode: transition.policy_error?.code ?? null,
    goalStatus: transition.goal_result.status,
    goalReason: transition.goal_result.reason,
    stateCwd: transition.state_before.cwdObservation?.physicalCwd ?? null,
    observedCwd: transition.observed_state_after.cwdObservation?.physicalCwd ?? null,
    session: transition.observed_state_after.session,
  };
}

export async function evaluateCliGoalSamples(
  samples: readonly CliGoalSample[],
  profile: ReturnType<typeof zeroCliGoalProfile>,
  policyFor: CliGoalPolicyFactory,
): Promise<CliGoalPolicyEvaluation> {
  const rows: CliGoalEvaluationRow[] = [];
  for (const sample of samples) {
    const transition = await policyFor(profile, sample.session).step({ goal: sample.goal, state: sample.state });
    rows.push(transitionRow(sample, transition));
  }
  const correctActions = rows.filter(row => row.selectedAction === row.expectedAction).length;
  const achievedGoals = rows.filter(row => row.goalStatus === "achieved").length;
  return {
    sampleCount: rows.length,
    uniqueFeatureVectors: new Set(rows.map(row => JSON.stringify(row.features))).size,
    correctActions,
    policyAccuracy: rows.length === 0 ? 0 : correctActions / rows.length,
    policyErrorCount: rows.filter(row => row.policyErrorCode !== null).length,
    guardRejections: rows.filter(row => row.selectedAction === "PWD" && row.executionReason === "unsupported_goal").length,
    achievedGoals,
    expectedAchievedGoals: samples.filter(sample => sample.expectedGoalStatus === "achieved").length,
    executionCount: rows.filter(row => row.executorInvoked).length,
    rows,
  };
}

function comparePartition(
  samples: readonly CliGoalSample[],
  zero: CliGoalPolicyEvaluation,
  frozen: CliGoalPolicyEvaluation,
  trained: CliGoalPolicyEvaluation,
): CliGoalPartitionComparison {
  let fixed = 0, regressed = 0, retained = 0, unresolved = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const oldCorrect = zero.rows[index]!.selectedAction === zero.rows[index]!.expectedAction;
    const newCorrect = trained.rows[index]!.selectedAction === trained.rows[index]!.expectedAction;
    if (!oldCorrect && newCorrect) fixed += 1;
    else if (oldCorrect && !newCorrect) regressed += 1;
    else if (oldCorrect && newCorrect) retained += 1;
    else unresolved += 1;
  }
  return { zero, frozen, trained, fixed, regressed, retained, unresolved };
}

async function ownedDirectory(root: string, segments: readonly string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    if (!segment || segment !== basename(segment) || segment === "." || segment === ".." || segment.includes("\0")) throw new TypeError("Invalid artifact path segment");
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const attributes = await lstat(current);
    if (attributes.isSymbolicLink() || !attributes.isDirectory()) throw new TypeError("Artifact parent must be an owned directory, not a link");
  }
  return current;
}

export function createCliGoalTrainingNodes(
  resources: CliGoalTrainingResources,
  policyFor: CliGoalPolicyFactory,
  diagnostics: CliGoalTrainingDiagnostics,
): readonly NodeDefinition[] {
  const preparedPort = port("goal_prepared", "cli.goal.prepared.v1", readPrepared);
  const candidatePort = port("goal_candidate", "cli.goal.candidate.v1", readCandidate);
  const evaluatedPort = port("goal_evaluation", "cli.goal.evaluation.v1", readEvaluated);
  const started = performance.now();
  return [
    {
      operator: "cli.goal.prepare",
      version: "0.1.0",
      inputPorts: [port("goal_training_request", "cli.goal.training-request.v1", readTrainingRequest)],
      outputPort: preparedPort,
      effects: [],
      execute(context) {
        const request = readTrainingRequest(context.inputs[0]!.payload);
        return context.emit({
          prepared: prepareCliGoalDataset(request.dataset),
          initial: zeroCliGoalProfile(),
          epochs: request.epochs,
          learningRate: request.learningRate,
        });
      },
    },
    {
      operator: "cli.goal.fit",
      version: "0.1.0",
      inputPorts: [preparedPort],
      outputPort: candidatePort,
      effects: ["filesystem.read"],
      async execute(context) {
        const stage = readPrepared(context.inputs[0]!.payload);
        try {
          const fit = await fitCliGoalPolicy({
            rows: stage.prepared.rows,
            initial: stage.initial,
            handwiredRoot: resources.handwiredRoot,
            epochs: stage.epochs,
            learningRate: stage.learningRate,
          });
          diagnostics.fitTiming = fit.timing;
          return context.emit({ ...stage, fit });
        } catch (error) {
          if (error instanceof Error && "timing" in error) diagnostics.fitTiming = error.timing;
          throw error;
        }
      },
    },
    {
      operator: "cli.goal.training.evaluate",
      version: "0.1.0",
      inputPorts: [candidatePort],
      outputPort: evaluatedPort,
      effects: [],
      async execute(context) {
        const stage = readCandidate(context.inputs[0]!.payload);
        const evaluationStarted = performance.now();
        const frozen = await fitCliGoalPolicy({
          rows: stage.prepared.rows,
          initial: stage.initial,
          handwiredRoot: resources.handwiredRoot,
          epochs: 0,
          learningRate: stage.learningRate,
        });
        if (JSON.stringify(frozen.profile.weights) !== JSON.stringify(stage.initial.weights)) throw new Error("Frozen goal control changed weights");
        const comparison = {} as { train: CliGoalPartitionComparison; development: CliGoalPartitionComparison };
        for (const partition of ["train", "development"] as const) {
          const samples = stage.prepared[partition];
          const zero = await evaluateCliGoalSamples(samples, stage.initial, policyFor);
          const frozenEval = await evaluateCliGoalSamples(samples, frozen.profile, policyFor);
          const trained = await evaluateCliGoalSamples(samples, stage.fit.profile, policyFor);
          comparison[partition] = comparePartition(samples, zero, frozenEval, trained);
        }
        const evaluationMs = performance.now() - evaluationStarted;
        diagnostics.evaluationMs = evaluationMs;
        return context.emit({ ...stage, comparison, frozen, evaluationMs });
      },
    },
    {
      operator: "cli.goal.save",
      version: "0.1.0",
      inputPorts: [evaluatedPort],
      outputPort: port("goal_training_receipt", "cli.goal.training-receipt.v1", value => {
        const receipt = expectRecord(value, "goal training receipt");
        expectNonEmptyString(receipt.runId, "runId");
        expectRecord(receipt.paths, "paths");
        if (typeof receipt.accepted !== "boolean") throw new TypeError("Invalid goal training receipt");
        return value;
      }),
      effects: ["filesystem.write"],
      async execute(context) {
        const stage = readEvaluated(context.inputs[0]!.payload);
        if (!isAbsolute(resources.outputRoot)) throw new TypeError("outputRoot must be absolute");
        const root = await realpath(resources.outputRoot);
        const samplesDir = await ownedDirectory(root, ["samples", "observe-cwd", context.runId]);
        const weightsDir = await ownedDirectory(root, ["weights", "observe-cwd", context.runId]);
        const resultsDir = await ownedDirectory(root, ["results", "observe-cwd", context.runId]);
        const paths = {
          samples: join(samplesDir, "samples.json"),
          profile: join(weightsDir, "candidate.json"),
          report: join(resultsDir, "report.json"),
        };
        const candidateChanged = JSON.stringify(stage.fit.profile.weights) !== JSON.stringify(stage.initial.weights);
        const accepted = candidateChanged && Object.values(stage.comparison).every(part =>
          part.trained.correctActions === part.trained.sampleCount
          && part.trained.achievedGoals === part.trained.expectedAchievedGoals
          && part.regressed === 0
          && part.trained.guardRejections === 0);
        const save = async (key: keyof typeof paths, data: unknown) => {
          await writeFile(paths[key], JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
          diagnostics.partialPaths[key] = paths[key];
        };
        const saveStarted = performance.now();
        await save("samples", stage.prepared.dataset);
        await save("profile", stage.fit.profile);
        const saveMs = performance.now() - saveStarted;
        const receipt: CliGoalTrainingReceipt = {
          runId: context.runId,
          paths,
          accepted,
          comparison: stage.comparison,
          timing: stage.fit.timing,
          evaluationMs: stage.evaluationMs,
          saveMs,
          workflowMs: performance.now() - started,
        };
        await save("report", {
          ...receipt,
          initial: stage.initial,
          candidate: stage.fit.profile,
          trajectory: stage.fit.trajectory,
          frozen: { timing: stage.frozen.timing, parametersUnchanged: true },
          counts: {
            train: stage.prepared.train.length,
            development: stage.prepared.development.length,
            fitRows: stage.prepared.rows.length,
            uniqueTrainFeatureVectors: new Set(stage.prepared.rows.map(row => JSON.stringify(row.features))).size,
          },
          limits: [
            "only three semantic feature vectors",
            "12 train and 6 development records in the declared fixture",
            "no heldout data in fitting or development tuning",
            "observe_cwd to pwd only",
            "uncalibrated candidate",
            "not_applied candidate",
          ],
        });
        return context.emit({ ...receipt, workflowMs: performance.now() - started });
      },
    },
  ];
}
