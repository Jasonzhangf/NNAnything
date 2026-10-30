import { performance } from "node:perf_hooks";

import {
  BROWSER_INPUT_POLICY_HEADS,
  BROWSER_INPUT_POLICY_WIRES,
  BROWSER_QUERY_RELATION_HEADS,
  BROWSER_QUERY_RELATION_WIRES,
  BROWSER_STEP_POLICY_HEADS,
  BROWSER_STEP_POLICY_WIRES,
  createBrowserInputPolicyProfile,
  createBrowserQueryRelationProfile,
  createBrowserStepPolicyProfile,
  extractBrowserInputPolicyWires,
  extractBrowserQueryRelationWires,
  extractBrowserStepPolicyWires,
  predictBrowserInputPolicy,
  predictBrowserQueryRelation,
  predictBrowserSearchStepPolicy,
  type BrowserInputPolicyHead,
  type BrowserInputPolicyProfile,
  type BrowserQueryRelationHead,
  type BrowserQueryRelationProfile,
  type BrowserStepPolicyHead,
  type BrowserStepPolicyProfile
} from "../filters/browser-stage1-policy.js";
import type { BrowserInputObservation } from "../adapters/browser/input-contract.js";
import type { BrowserSearchGoal, BrowserSearchState } from "../adapters/browser/search-contract.js";
import {
  buildLinearPolicyCircuit,
  type LinearPolicyCircuit
} from "../nodes/trainable/linear-policy.js";
import type {
  BrowserStage1InputSampleRow,
  BrowserStage1RelationSampleRow,
  BrowserStage1SplitSlice,
  BrowserStage1StepSampleRow
} from "./browser-stage1-samples.js";
import { loadHandwired, type HandwiredModule } from "./handwired.js";

export interface BrowserStage1UnitFitTiming {
  readonly backendLoadMs: number;
  readonly circuitBuildMs: number;
  readonly epochLoopMs: number;
  readonly totalFitMs: number;
  readonly evaluationMs: number;
  readonly completedEpochs: number;
  readonly rowCount: number;
  readonly rowEpochs: number;
  readonly handwiredLoaded: boolean;
  readonly parameterCount: number;
  readonly parameterUpdateCount: number;
  readonly nonZeroWeightCount: number;
}

export type BrowserStage1UnitTimingReport = BrowserStage1UnitFitTiming;

export interface BrowserStage1RowPrediction {
  readonly id: string;
  readonly goldHead: string;
  readonly predictedHead: string;
  readonly correct: boolean;
}

export interface BrowserStage1UnitAccuracySummary {
  readonly total: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly loss: number;
  readonly byGoldHead: Record<string, { total: number; correct: number; accuracy: number }>;
  readonly predictions: readonly BrowserStage1RowPrediction[];
}

export interface BrowserStage1CascadeEvaluation {
  readonly source: "learned_candidate" | "zero_weights" | "handwired";
  readonly inputPolicy: BrowserStage1UnitAccuracySummary;
  readonly queryRelation: BrowserStage1UnitAccuracySummary;
  readonly stepPolicyCascade: BrowserStage1UnitAccuracySummary;
  readonly stepPolicyGoldUpstreamOracle: BrowserStage1UnitAccuracySummary;
  readonly evaluationMs: {
    readonly inputPolicy: number;
    readonly queryRelation: number;
    readonly stepPolicy: number;
  };
}

export interface BrowserStage1HandwiredControlEvaluation extends BrowserStage1CascadeEvaluation {
  readonly source: "handwired";
  readonly decisionIds: {
    readonly "B-S1.1": "browser.input.handwired.v1";
    readonly "B-S1.2": "browser.search.query-relation.handwired.v1";
    readonly "B-S1.3": "browser.search.step.handwired.v1";
  };
}

export interface BrowserStage1FitOptions {
  readonly handwiredRoot?: string;
  readonly epochs?: number;
  readonly learningRate?: number;
  readonly initialProfiles?: {
    readonly inputPolicy?: BrowserInputPolicyProfile;
    readonly queryRelation?: BrowserQueryRelationProfile;
    readonly stepPolicy?: BrowserStepPolicyProfile;
  };
}

export interface BrowserStage1CascadeFitResult {
  readonly profiles: {
    readonly inputPolicy: BrowserInputPolicyProfile;
    readonly queryRelation: BrowserQueryRelationProfile;
    readonly stepPolicy: BrowserStepPolicyProfile;
  };
  readonly initialProfiles: {
    readonly inputPolicy: BrowserInputPolicyProfile;
    readonly queryRelation: BrowserQueryRelationProfile;
    readonly stepPolicy: BrowserStepPolicyProfile;
  };
  readonly fitted: {
    readonly inputPolicy: boolean;
    readonly queryRelation: boolean;
    readonly stepPolicy: boolean;
  };
  readonly lossHistory: {
    readonly inputPolicy: readonly number[];
    readonly queryRelation: readonly number[];
    readonly stepPolicy: readonly number[];
  };
  readonly timing: {
    readonly inputPolicy: BrowserStage1UnitTimingReport;
    readonly queryRelation: BrowserStage1UnitTimingReport;
    readonly stepPolicy: BrowserStage1UnitTimingReport;
  };
}

function zeroMatrix(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
}

export function createZeroBrowserInputPolicyProfile(): BrowserInputPolicyProfile {
  return createBrowserInputPolicyProfile(
    zeroMatrix(BROWSER_INPUT_POLICY_HEADS.length, BROWSER_INPUT_POLICY_WIRES.length)
  );
}

export function createZeroBrowserQueryRelationProfile(): BrowserQueryRelationProfile {
  return createBrowserQueryRelationProfile(
    zeroMatrix(BROWSER_QUERY_RELATION_HEADS.length, BROWSER_QUERY_RELATION_WIRES.length)
  );
}

export function createZeroBrowserStepPolicyProfile(): BrowserStepPolicyProfile {
  return createBrowserStepPolicyProfile(
    zeroMatrix(BROWSER_STEP_POLICY_HEADS.length, BROWSER_STEP_POLICY_WIRES.length)
  );
}

function flattenMatrix(weights: readonly (readonly number[])[]): number[] {
  const flat: number[] = [];
  for (const row of weights) {
    for (const v of row) {
      flat.push(v);
    }
  }
  return flat;
}

function unflattenMatrix(
  rows: number,
  cols: number,
  flat: readonly number[]
): readonly (readonly number[])[] {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (__, c) => flat[r * cols + c] ?? 0)
  );
}

function countNonZeroFlat(values: readonly number[]): number {
  let count = 0;
  for (const v of values) {
    if (v !== 0) {
      count += 1;
    }
  }
  return count;
}

function sourceFor(
  circuit: LinearPolicyCircuit,
  weights: readonly number[],
  features: readonly number[]
): Float32Array {
  const source = new Float32Array(circuit.circuit.sourceSize);
  circuit.parameters.forEach((wire, index) => {
    source[wire] = Math.fround(weights[index]!);
  });
  circuit.features.forEach((wire, index) => {
    source[wire] = Math.fround(features[index]!);
  });
  return source;
}

function softmaxCrossEntropy(
  logits: readonly number[],
  expectedIndex: number
): { readonly loss: number; readonly probabilities: readonly number[] } {
  const maximum = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp(logit - maximum));
  const denominator = exps.reduce((left, right) => left + right, 0);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new Error("Non-finite Browser Stage 1 softmax denominator");
  }
  const loss = Math.log(denominator) + maximum - logits[expectedIndex]!;
  if (!Number.isFinite(loss)) {
    throw new Error("Non-finite Browser Stage 1 cross-entropy loss");
  }
  return {
    loss,
    probabilities: exps.map((value) => value / denominator)
  };
}

function computeMatrixCrossEntropyLoss(
  heads: readonly string[],
  weights: readonly (readonly number[])[],
  rows: ReadonlyArray<{ readonly wires: readonly number[]; readonly goldHead: string }>
): number {
  if (rows.length === 0) {
    return 0;
  }
  let totalLoss = 0;
  for (const row of rows) {
    const logits = weights.map((weightRow) =>
      weightRow.reduce((sum, w, idx) => sum + w * (row.wires[idx] ?? 0), 0)
    );
    const expectedIndex = Math.max(0, heads.indexOf(row.goldHead));
    totalLoss += softmaxCrossEntropy(logits, expectedIndex).loss;
  }
  return totalLoss / rows.length;
}

async function fitLinearUnitWithHandwired(params: {
  readonly heads: readonly string[];
  readonly wires: readonly string[];
  readonly initialWeights: readonly (readonly number[])[];
  readonly rows: ReadonlyArray<{ readonly wires: readonly number[]; readonly goldHead: string }>;
  readonly epochs: number;
  readonly learningRate: number;
  readonly handwiredRoot?: string;
}): Promise<{
  readonly weights: readonly (readonly number[])[];
  readonly lossHistory: readonly number[];
  readonly timing: Omit<BrowserStage1UnitFitTiming, "evaluationMs">;
}> {
  const fitStart = performance.now();
  const classCount = params.heads.length;
  const featureCount = params.wires.length;
  const parameterCount = classCount * featureCount;
  const flatInitial = flattenMatrix(params.initialWeights);

  if (params.epochs <= 0) {
    const totalFitMs = performance.now() - fitStart;
    return {
      weights: unflattenMatrix(classCount, featureCount, flatInitial),
      lossHistory: [],
      timing: {
        backendLoadMs: 0,
        circuitBuildMs: 0,
        epochLoopMs: 0,
        totalFitMs,
        completedEpochs: 0,
        rowCount: params.rows.length,
        rowEpochs: 0,
        handwiredLoaded: false,
        parameterCount,
        parameterUpdateCount: 0,
        nonZeroWeightCount: countNonZeroFlat(flatInitial)
      }
    };
  }

  if (!params.handwiredRoot || typeof params.handwiredRoot !== "string") {
    throw new TypeError("Explicit handwiredRoot is required when epochs > 0");
  }

  const loadStart = performance.now();
  const handwired: HandwiredModule = await loadHandwired(params.handwiredRoot);
  const backendLoadMs = performance.now() - loadStart;

  const buildStart = performance.now();
  const built = buildLinearPolicyCircuit(handwired, classCount, featureCount);
  const circuitBuildMs = performance.now() - buildStart;

  let currentWeights = [...flatInitial];
  const lossHistory: number[] = [];
  let parameterUpdateCount = 0;

  const loopStart = performance.now();
  for (let epoch = 0; epoch < params.epochs; epoch += 1) {
    const gradAccum = new Float64Array(parameterCount);
    let epochLoss = 0;

    for (const row of params.rows) {
      const expectedIndex = Math.max(0, params.heads.indexOf(row.goldHead));
      const values = built.circuit.evaluateReference(
        sourceFor(built, currentWeights, row.wires)
      );
      const logits = built.logits.map((wire) => values[wire]!);
      const evaluated = softmaxCrossEntropy(logits, expectedIndex);
      epochLoss += evaluated.loss;

      const outputGradients = new Float32Array(values.length);
      built.logits.forEach((wire, index) => {
        outputGradients[wire] = Math.fround(
          evaluated.probabilities[index]! - (index === expectedIndex ? 1 : 0)
        );
      });
      const sourceGradients = built.circuit.backpropagateReference(values, outputGradients);
      built.parameters.forEach((wire, index) => {
        gradAccum[index] = (gradAccum[index] ?? 0) + (sourceGradients[wire] ?? 0) / params.rows.length;
      });
    }

    lossHistory.push(epochLoss / Math.max(1, params.rows.length));
    currentWeights = currentWeights.map((value, idx) => {
      const g = gradAccum[idx] ?? 0;
      if (g === 0) {
        return value;
      }
      parameterUpdateCount += 1;
      return value - params.learningRate * g;
    });
  }
  const epochLoopMs = performance.now() - loopStart;
  const totalFitMs = performance.now() - fitStart;

  return {
    weights: unflattenMatrix(classCount, featureCount, currentWeights),
    lossHistory,
    timing: {
      backendLoadMs,
      circuitBuildMs,
      epochLoopMs,
      totalFitMs,
      completedEpochs: params.epochs,
      rowCount: params.rows.length,
      rowEpochs: params.epochs * params.rows.length,
      handwiredLoaded: true,
      parameterCount,
      parameterUpdateCount,
      nonZeroWeightCount: countNonZeroFlat(currentWeights)
    }
  };
}

export async function fitBrowserStage1Cascade(
  trainSlice: BrowserStage1SplitSlice,
  options: BrowserStage1FitOptions = {}
): Promise<BrowserStage1CascadeFitResult> {
  const epochs = options.epochs ?? 200;
  const learningRate = options.learningRate ?? 0.1;

  const initialInput =
    options.initialProfiles?.inputPolicy ?? createZeroBrowserInputPolicyProfile();
  const initialRelation =
    options.initialProfiles?.queryRelation ?? createZeroBrowserQueryRelationProfile();
  const initialStep =
    options.initialProfiles?.stepPolicy ?? createZeroBrowserStepPolicyProfile();

  const inputFit = await fitLinearUnitWithHandwired({
    heads: BROWSER_INPUT_POLICY_HEADS,
    wires: BROWSER_INPUT_POLICY_WIRES,
    initialWeights: initialInput.weights,
    rows: trainSlice.inputRows,
    epochs,
    learningRate,
    ...(options.handwiredRoot ? { handwiredRoot: options.handwiredRoot } : {})
  });
  const fittedInputProfile = createBrowserInputPolicyProfile(inputFit.weights);

  const relationFit = await fitLinearUnitWithHandwired({
    heads: BROWSER_QUERY_RELATION_HEADS,
    wires: BROWSER_QUERY_RELATION_WIRES,
    initialWeights: initialRelation.weights,
    rows: trainSlice.relationRows,
    epochs,
    learningRate,
    ...(options.handwiredRoot ? { handwiredRoot: options.handwiredRoot } : {})
  });
  const fittedRelationProfile = createBrowserQueryRelationProfile(relationFit.weights);

  const cascadeStepRows = trainSlice.stepRows.map((row) => {
    const predInput = predictBrowserInputPolicy(
      row.inputObservation,
      row.targetText,
      row.sensitive,
      fittedInputProfile
    ).head;
    const predRelation = predictBrowserQueryRelation(
      row.state,
      row.goal,
      fittedRelationProfile
    ).head;
    const cascadeWires = extractBrowserStepPolicyWires(
      row.state,
      row.goal,
      predInput,
      predRelation
    );
    return {
      wires: cascadeWires,
      goldHead: row.goldHead
    };
  });

  const stepFit = await fitLinearUnitWithHandwired({
    heads: BROWSER_STEP_POLICY_HEADS,
    wires: BROWSER_STEP_POLICY_WIRES,
    initialWeights: initialStep.weights,
    rows: cascadeStepRows,
    epochs,
    learningRate,
    ...(options.handwiredRoot ? { handwiredRoot: options.handwiredRoot } : {})
  });
  const fittedStepProfile = createBrowserStepPolicyProfile(stepFit.weights);

  const isFitted = epochs > 0;
  return {
    profiles: {
      inputPolicy: fittedInputProfile,
      queryRelation: fittedRelationProfile,
      stepPolicy: fittedStepProfile
    },
    initialProfiles: {
      inputPolicy: initialInput,
      queryRelation: initialRelation,
      stepPolicy: initialStep
    },
    fitted: {
      inputPolicy: isFitted,
      queryRelation: isFitted,
      stepPolicy: isFitted
    },
    lossHistory: {
      inputPolicy: inputFit.lossHistory,
      queryRelation: relationFit.lossHistory,
      stepPolicy: stepFit.lossHistory
    },
    timing: {
      inputPolicy: { ...inputFit.timing, evaluationMs: 0 },
      queryRelation: { ...relationFit.timing, evaluationMs: 0 },
      stepPolicy: { ...stepFit.timing, evaluationMs: 0 }
    }
  };
}

function summarizePredictions<
  T extends { readonly id: string; readonly wires: readonly number[]; readonly goldHead: string }
>(
  heads: readonly string[],
  weights: readonly (readonly number[])[] | null,
  rows: readonly T[],
  predictFn: (row: T) => string
): BrowserStage1UnitAccuracySummary {
  const byGoldHead: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const h of heads) {
    byGoldHead[h] = { total: 0, correct: 0, accuracy: 0 };
  }
  const predictions: BrowserStage1RowPrediction[] = [];
  let correct = 0;
  for (const row of rows) {
    const pred = predictFn(row);
    const isCorrect = pred === row.goldHead;
    predictions.push({
      id: row.id,
      goldHead: row.goldHead,
      predictedHead: pred,
      correct: isCorrect
    });
    const bucket = byGoldHead[row.goldHead] ?? { total: 0, correct: 0, accuracy: 0 };
    bucket.total += 1;
    if (isCorrect) {
      correct += 1;
      bucket.correct += 1;
    }
    byGoldHead[row.goldHead] = bucket;
  }
  for (const bucket of Object.values(byGoldHead)) {
    bucket.accuracy = bucket.total > 0 ? bucket.correct / bucket.total : 1;
  }
  return {
    total: rows.length,
    correct,
    accuracy: rows.length > 0 ? correct / rows.length : 1,
    loss: weights ? computeMatrixCrossEntropyLoss(heads, weights, rows) : 0,
    byGoldHead,
    predictions
  };
}

export function evaluateHandwiredInputPolicy(
  observation: BrowserInputObservation,
  targetText: string,
  sensitive: boolean
): BrowserInputPolicyHead {
  const wires = extractBrowserInputPolicyWires(observation, targetText, sensitive);
  const [, tk, tv, enk, env, edk, edv, rok, rov, vek, vev, ehk, ehv] = wires;
  if (vek === 1 && vev === 1 && tk === 1 && tv === 1) {
    return "NOOP";
  }
  if (
    tk === 1 &&
    tv === 1 &&
    enk === 1 &&
    env === 1 &&
    edk === 1 &&
    edv === 1 &&
    rok === 1 &&
    rov === 0 &&
    vek === 1 &&
    vev === 0 &&
    ehk === 1 &&
    ehv === 1
  ) {
    return "INPUT";
  }
  return "DEFER";
}

export function evaluateHandwiredQueryRelation(
  state: BrowserSearchState,
  goal: BrowserSearchGoal
): BrowserQueryRelationHead {
  const wires = extractBrowserQueryRelationWires(state, goal);
  const [
    ,
    iqk,
    iqv,
    nsk,
    nsv,
    rmk,
    rmv,
    reqKnown,
    reqSettled,
    reqLoading,
    ack,
    acv,
    ,
    assoc
  ] = wires;
  if (iqk === 1 && iqv === 1 && assoc === 1) {
    return "results_associated_active";
  }
  if (
    iqk === 1 &&
    iqv === 1 &&
    ack === 1 &&
    acv === 1 &&
    (nsv === 0 || (nsk === 0 && reqKnown === 0))
  ) {
    return "input_only_unsubmitted";
  }
  if (
    iqk === 1 &&
    iqv === 1 &&
    nsk === 1 &&
    nsv === 1 &&
    ack === 1 &&
    acv === 1 &&
    (reqLoading === 1 || (reqSettled === 1 && rmv === 0 && rmk === 1))
  ) {
    return "submitted_pending_or_stale";
  }
  return "insufficient_or_conflict";
}

export function evaluateHandwiredStepPolicy(
  state: BrowserSearchState,
  goal: BrowserSearchGoal,
  inputHead: BrowserInputPolicyHead | null,
  relationHead: BrowserQueryRelationHead | null
): BrowserStepPolicyHead {
  const wires = extractBrowserStepPolicyWires(state, goal, inputHead, relationHead);
  const [
    ,
    pIn,
    pSub,
    pRes,
    inInput,
    inNoop,
    ,
    relUnsub,
    relPending,
    relAssoc,
    ,
    checkedCur,
    contentKnown,
    contentSat,
    canExpKnown,
    canExpVal,
    termConf,
    unreadCur
  ] = wires;
  if (pIn === 1) {
    if (inInput === 1) return "input";
    if (inNoop === 1) return "NOOP";
    return "DEFER";
  }
  if (pSub === 1) {
    if (relUnsub === 1) return "submit";
    if (relPending === 1 || relAssoc === 1) return "NOOP";
    return "DEFER";
  }
  if (pRes === 1) {
    if (relPending === 1) return "read_or_reobserve";
    if (relAssoc === 1 && unreadCur === 1) return "read_or_reobserve";
    if (relAssoc === 1 && checkedCur === 1 && contentKnown === 1 && contentSat === 1) {
      return "NOOP";
    }
    if (relAssoc === 1 && checkedCur === 1 && contentKnown === 1 && contentSat === 0 && termConf === 1) {
      return "NOOP";
    }
    if (
      relAssoc === 1 &&
      checkedCur === 1 &&
      contentKnown === 1 &&
      contentSat === 0 &&
      canExpKnown === 1 &&
      canExpVal === 1 &&
      termConf === 0
    ) {
      return "expand_range";
    }
    return "DEFER";
  }
  return "DEFER";
}

export function evaluateBrowserStage1HandwiredRuleControl(
  slice: BrowserStage1SplitSlice
): BrowserStage1HandwiredControlEvaluation {
  const t0 = performance.now();
  const inputPolicy = summarizePredictions(
    BROWSER_INPUT_POLICY_HEADS,
    null,
    slice.inputRows,
    (row: BrowserStage1InputSampleRow) =>
      evaluateHandwiredInputPolicy(row.observation, row.targetText, row.sensitive)
  );
  const t1 = performance.now();

  const queryRelation = summarizePredictions(
    BROWSER_QUERY_RELATION_HEADS,
    null,
    slice.relationRows,
    (row: BrowserStage1RelationSampleRow) =>
      evaluateHandwiredQueryRelation(row.state, row.goal)
  );
  const t2 = performance.now();

  const stepPolicyCascade = summarizePredictions(
    BROWSER_STEP_POLICY_HEADS,
    null,
    slice.stepRows,
    (row: BrowserStage1StepSampleRow) => {
      const handwiredInput = evaluateHandwiredInputPolicy(
        row.inputObservation,
        row.targetText,
        row.sensitive
      );
      const handwiredRelation = evaluateHandwiredQueryRelation(row.state, row.goal);
      return evaluateHandwiredStepPolicy(row.state, row.goal, handwiredInput, handwiredRelation);
    }
  );

  const stepPolicyGoldUpstreamOracle = summarizePredictions(
    BROWSER_STEP_POLICY_HEADS,
    null,
    slice.stepRows,
    (row: BrowserStage1StepSampleRow) =>
      evaluateHandwiredStepPolicy(row.state, row.goal, row.goldInputHead, row.goldRelationHead)
  );
  const t3 = performance.now();

  return {
    source: "handwired",
    decisionIds: {
      "B-S1.1": "browser.input.handwired.v1",
      "B-S1.2": "browser.search.query-relation.handwired.v1",
      "B-S1.3": "browser.search.step.handwired.v1"
    },
    inputPolicy,
    queryRelation,
    stepPolicyCascade,
    stepPolicyGoldUpstreamOracle,
    evaluationMs: {
      inputPolicy: t1 - t0,
      queryRelation: t2 - t1,
      stepPolicy: t3 - t2
    }
  };
}

export function evaluateBrowserStage1Cascade(
  slice: BrowserStage1SplitSlice,
  profiles: {
    readonly inputPolicy: BrowserInputPolicyProfile;
    readonly queryRelation: BrowserQueryRelationProfile;
    readonly stepPolicy: BrowserStepPolicyProfile;
  },
  source: "learned_candidate" | "zero_weights" = "learned_candidate"
): BrowserStage1CascadeEvaluation {
  const t0 = performance.now();
  const inputPolicy = summarizePredictions(
    BROWSER_INPUT_POLICY_HEADS,
    profiles.inputPolicy.weights,
    slice.inputRows,
    (row: BrowserStage1InputSampleRow) =>
      predictBrowserInputPolicy(
        row.observation,
        row.targetText,
        row.sensitive,
        profiles.inputPolicy
      ).head
  );
  const t1 = performance.now();

  const queryRelation = summarizePredictions(
    BROWSER_QUERY_RELATION_HEADS,
    profiles.queryRelation.weights,
    slice.relationRows,
    (row: BrowserStage1RelationSampleRow) =>
      predictBrowserQueryRelation(row.state, row.goal, profiles.queryRelation).head
  );
  const t2 = performance.now();

  const stepPolicyCascade = summarizePredictions(
    BROWSER_STEP_POLICY_HEADS,
    profiles.stepPolicy.weights,
    slice.stepRows,
    (row: BrowserStage1StepSampleRow) => {
      const predInput: BrowserInputPolicyHead = predictBrowserInputPolicy(
        row.inputObservation,
        row.targetText,
        row.sensitive,
        profiles.inputPolicy
      ).head;
      const predRelation: BrowserQueryRelationHead = predictBrowserQueryRelation(
        row.state,
        row.goal,
        profiles.queryRelation
      ).head;
      return predictBrowserSearchStepPolicy(
        row.state,
        row.goal,
        predInput,
        predRelation,
        profiles.stepPolicy
      ).head;
    }
  );

  const stepPolicyGoldUpstreamOracle = summarizePredictions(
    BROWSER_STEP_POLICY_HEADS,
    profiles.stepPolicy.weights,
    slice.stepRows,
    (row: BrowserStage1StepSampleRow) =>
      predictBrowserSearchStepPolicy(
        row.state,
        row.goal,
        row.goldInputHead,
        row.goldRelationHead,
        profiles.stepPolicy
      ).head
  );
  const t3 = performance.now();

  return {
    source,
    inputPolicy,
    queryRelation,
    stepPolicyCascade,
    stepPolicyGoldUpstreamOracle,
    evaluationMs: {
      inputPolicy: t1 - t0,
      queryRelation: t2 - t1,
      stepPolicy: t3 - t2
    }
  };
}
