import {
  predictEntrySelectRelation,
  resolveEntrySelectSet,
  validateEntrySelectProfile,
  zeroEntrySelectProfile,
  type EntrySelectFeatures,
  type EntrySelectProfile,
  type EntrySelectTargetType,
} from "../filters/cli-entry-select-relation.js";
import { buildSingleLogitLinearCircuit } from "../nodes/trainable/single-logit-linear.js";
import {
  COMBINATION_FEATURES,
  ENTRY_SELECT_COMBINATIONS,
  type EntrySelectCandidateRow,
  type EntrySelectCombinationId,
  type EntrySelectDataset,
  type EntrySelectPartition,
} from "./cli-entry-select-samples.js";
import { loadHandwired } from "./handwired.js";

export type EntrySelectFitRow = Readonly<{
  features: EntrySelectFeatures;
  expectedLabel: 0 | 1;
}>;

export type EntrySelectFitTiming = {
  backendLoadMs: number;
  circuitBuildMs: number;
  trainEpochGradMs: number;
  fitTotalMs: number;
  completedEpochs: number;
  processedRowCount: number;
  gradientRowEpochs: number;
  totalRowPasses: number;
  trainableParamCount: number;
};

export type EntrySelectTrajectoryPoint = Readonly<{
  epoch: number;
  loss: number;
}>;

export type EntrySelectFitResult = Readonly<{
  profile: EntrySelectProfile;
  initialProfile: EntrySelectProfile;
  timing: EntrySelectFitTiming;
  trajectory: readonly EntrySelectTrajectoryPoint[];
  separatesAllBooleanCombinations: boolean;
  logitsByCombination: Readonly<Record<EntrySelectCombinationId, number>>;
}>;

function stableBceLoss(logit: number, label: 0 | 1): number {
  const maxVal = Math.max(0, logit);
  return maxVal + Math.log(Math.exp(-maxVal) + Math.exp(logit - maxVal)) - label * logit;
}

function stableSigmoid(logit: number): number {
  if (logit >= 0) {
    return 1 / (1 + Math.exp(-logit));
  }
  const expZ = Math.exp(logit);
  return expZ / (1 + expZ);
}

function computeLogitsByCombination(
  weights: readonly [number, number, number, number],
): Readonly<Record<EntrySelectCombinationId, number>> {
  const out = {} as Record<EntrySelectCombinationId, number>;
  for (const combo of ENTRY_SELECT_COMBINATIONS) {
    const feats = COMBINATION_FEATURES[combo];
    out[combo] = weights[0] * feats[0] + weights[1] * feats[1] + weights[2] * feats[2] + weights[3] * feats[3];
  }
  return Object.freeze(out);
}

function checkBooleanSeparation(
  logitsByCombination: Readonly<Record<EntrySelectCombinationId, number>>,
): boolean {
  const posLogit = logitsByCombination["B-C111"];
  if (!(posLogit > 0)) return false;
  for (const combo of ENTRY_SELECT_COMBINATIONS) {
    if (combo === "B-C111") continue;
    if (!(logitsByCombination[combo] < 0)) return false;
  }
  return true;
}

function validateFitRows(rows: readonly EntrySelectFitRow[]): readonly EntrySelectFitRow[] {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TypeError("Nonempty entry-select training rows required");
  }
  return rows.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw new TypeError(`Entry select training row ${index} must be an object`);
    }
    const { features, expectedLabel } = row;
    if (!Array.isArray(features)
      || features.length !== 4
      || features[0] !== 1
      || features.slice(1).some(v => v !== 0 && v !== 1)) {
      throw new TypeError(`Entry select training row ${index} must have features [1, 0|1, 0|1, 0|1]`);
    }
    if (expectedLabel !== 0 && expectedLabel !== 1) {
      throw new TypeError(`Entry select training row ${index} expectedLabel must be 0 or 1`);
    }
    return Object.freeze({
      features: Object.freeze([...features] as [1, 0 | 1, 0 | 1, 0 | 1]),
      expectedLabel,
    });
  });
}

export async function fitEntrySelectRelation(input: Readonly<{
  initial?: EntrySelectProfile;
  targetType?: EntrySelectTargetType;
  rows: readonly EntrySelectFitRow[];
  handwiredRoot: string;
  epochs: number;
  learningRate: number;
}>): Promise<EntrySelectFitResult> {
  const started = performance.now();
  const initial = input.initial !== undefined
    ? validateEntrySelectProfile(input.initial)
    : zeroEntrySelectProfile(input.targetType ?? "directory", 0.5);
  if (!Number.isInteger(input.epochs) || input.epochs < 0 || !Number.isFinite(input.learningRate) || input.learningRate <= 0) {
    throw new TypeError("Invalid entry-select training budget");
  }
  const rows = validateFitRows(input.rows);

  const timing: EntrySelectFitTiming = {
    backendLoadMs: 0,
    circuitBuildMs: 0,
    trainEpochGradMs: 0,
    fitTotalMs: 0,
    completedEpochs: 0,
    processedRowCount: rows.length,
    gradientRowEpochs: 0,
    totalRowPasses: 0,
    trainableParamCount: 4,
  };
  const trajectory: EntrySelectTrajectoryPoint[] = [];
  let weights: [number, number, number, number] = [...initial.weights] as [number, number, number, number];

  try {
    if (input.epochs > 0) {
      const backendStarted = performance.now();
      const module = await loadHandwired(input.handwiredRoot);
      timing.backendLoadMs = performance.now() - backendStarted;
      const buildStarted = performance.now();
      const graph = buildSingleLogitLinearCircuit(module, 4);
      timing.circuitBuildMs = performance.now() - buildStarted;

      for (let epoch = 0; epoch < input.epochs; epoch += 1) {
        const epochStarted = performance.now();
        const gradient = new Float64Array(4);
        let totalLoss = 0;

        for (const row of rows) {
          const source = new Float32Array(graph.circuit.sourceSize);
          graph.parameters.forEach((wire, index) => {
            source[wire] = Math.fround(weights[index]!);
          });
          graph.features.forEach((wire, index) => {
            source[wire] = row.features[index]!;
          });
          const values = graph.circuit.evaluateReference(source);
          const logit = values[graph.logitWire]!;
          const prob = stableSigmoid(logit);
          const loss = stableBceLoss(logit, row.expectedLabel);
          if (!Number.isFinite(loss)) {
            throw new Error("Non-finite entry-select BCE loss");
          }
          totalLoss += loss;

          const outputGradient = new Float32Array(values.length);
          outputGradient[graph.logitWire] = Math.fround(prob - row.expectedLabel);
          const sourceGradient = graph.circuit.backpropagateReference(values, outputGradient);
          graph.parameters.forEach((wire, index) => {
            gradient[index] = gradient[index]! + sourceGradient[wire]!;
          });
          timing.gradientRowEpochs += 1;
          timing.totalRowPasses += 1;
        }

        weights = weights.map((weight, index) =>
          gradient[index]! === 0
            ? weight
            : Math.fround(weight - (input.learningRate * gradient[index]!) / rows.length),
        ) as [number, number, number, number];
        if (!weights.every(Number.isFinite)) {
          throw new Error("Non-finite entry-select weights");
        }
        timing.completedEpochs += 1;
        timing.trainEpochGradMs += performance.now() - epochStarted;
        trajectory.push(Object.freeze({
          epoch: epoch + 1,
          loss: totalLoss / rows.length,
        }));
      }
    }

    const profile = validateEntrySelectProfile({
      ...initial,
      weights,
    });
    const logitsByCombination = computeLogitsByCombination(profile.weights);
    const separatesAllBooleanCombinations = checkBooleanSeparation(logitsByCombination);

    return Object.freeze({
      profile,
      initialProfile: initial,
      timing,
      trajectory: Object.freeze(trajectory),
      separatesAllBooleanCombinations,
      logitsByCombination,
    });
  } catch (error) {
    if (error && typeof error === "object") Object.assign(error, { timing });
    throw error;
  } finally {
    timing.fitTotalMs = performance.now() - started;
  }
}

export type CandidateMetricsSummary = Readonly<{
  count: number;
  correct: number;
  accuracy: number;
  passed: boolean;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  byCombination: Readonly<Record<EntrySelectCombinationId, Readonly<{
    count: number;
    correct: number;
    passed: boolean;
  }>>>;
}>;

export type SetMetricsSummary = Readonly<{
  count: number;
  correct: number;
  accuracy: number;
  passed: boolean;
  selectedCount: number;
  selectedCorrect: number;
  notFoundCount: number;
  notFoundCorrect: number;
  conflictCount: number;
  insufficientEvidenceCount: number;
  invalidInputCount: number;
  failures: readonly Readonly<{
    id: string;
    targetType: EntrySelectTargetType;
    expectedOutcome: string;
    actualOutcome: string;
    expectedStatus: string;
    actualStatus: string;
    expectedSatisfaction: number | null;
    actualSatisfaction: number | null;
    expectedReason: string;
    actualReason: string;
  }>[];
}>;

export type PartitionEvaluationSummary = Readonly<{
  partition: EntrySelectPartition;
  role: "known_replay" | "bounded_synthetic_held_out";
  provenance: "known_replay_partition" | "synthetic_held_out_from_eight_boolean_templates";
  allEightFeatureVectorsSeenInTrain: boolean;
  unseenFeatureCapabilityVerified: boolean;
  sets: SetMetricsSummary;
  candidates: CandidateMetricsSummary;
  byTargetType: Readonly<Record<EntrySelectTargetType, Readonly<{
    sets: SetMetricsSummary;
    candidates: CandidateMetricsSummary;
  }>>>;
}>;

export type ProbesEvaluationSummary = Readonly<{
  count: number;
  correct: number;
  passed: boolean;
  rows: readonly Readonly<{
    id: string;
    targetType: EntrySelectTargetType;
    expectedOutcome: string;
    actualOutcome: string;
    expectedStatus: string;
    actualStatus: string;
    expectedSatisfaction: number | null;
    actualSatisfaction: number | null;
    expectedReason: string;
    actualReason: string;
    correct: boolean;
  }>[];
}>;

export type EntrySelectEvaluationReport = Readonly<{
  partitions: Readonly<Record<EntrySelectPartition, PartitionEvaluationSummary>>;
  knownReplay: Readonly<{
    train: PartitionEvaluationSummary;
    development: PartitionEvaluationSummary;
    combinedSetsCount: number;
    combinedSetsCorrect: number;
    combinedCandidatesCount: number;
    combinedCandidatesCorrect: number;
    passed: boolean;
  }>;
  independentVerification: PartitionEvaluationSummary;
  probes: ProbesEvaluationSummary;
  allPassed: boolean;
}>;

function evaluateCandidateSubset(
  rows: readonly EntrySelectCandidateRow[],
  profiles: Readonly<Record<EntrySelectTargetType, EntrySelectProfile>>,
): CandidateMetricsSummary {
  let correct = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;

  const byCombination = {} as Record<EntrySelectCombinationId, { count: number; correct: number; passed: boolean }>;
  for (const combo of ENTRY_SELECT_COMBINATIONS) {
    byCombination[combo] = { count: 0, correct: 0, passed: true };
  }

  for (const row of rows) {
    const profile = profiles[row.targetType];
    const pred = predictEntrySelectRelation(row.selector, row.candidate, profile);
    const isCorrect = pred.status === "judged" && pred.relation === row.expectedRelation;
    const comboStats = byCombination[row.combinationId];
    comboStats.count += 1;
    if (isCorrect) {
      correct += 1;
      comboStats.correct += 1;
      if (row.expectedLabel === 1) truePositives += 1;
      else trueNegatives += 1;
    } else {
      comboStats.passed = false;
      if (row.expectedLabel === 1) falseNegatives += 1;
      else falsePositives += 1;
    }
  }

  const frozenCombos = {} as Record<EntrySelectCombinationId, Readonly<{ count: number; correct: number; passed: boolean }>>;
  for (const combo of ENTRY_SELECT_COMBINATIONS) {
    frozenCombos[combo] = Object.freeze(byCombination[combo]);
  }

  return Object.freeze({
    count: rows.length,
    correct,
    accuracy: rows.length === 0 ? 1 : correct / rows.length,
    passed: correct === rows.length,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    byCombination: Object.freeze(frozenCombos),
  });
}

function evaluateSetSubset(
  sets: readonly EntrySelectDataset["sets"][number][],
  profiles: Readonly<Record<EntrySelectTargetType, EntrySelectProfile>>,
): SetMetricsSummary {
  let correct = 0;
  let selectedCount = 0;
  let selectedCorrect = 0;
  let notFoundCount = 0;
  let notFoundCorrect = 0;
  let conflictCount = 0;
  let insufficientEvidenceCount = 0;
  let invalidInputCount = 0;
  const failures: {
    id: string;
    targetType: EntrySelectTargetType;
    expectedOutcome: string;
    actualOutcome: string;
    expectedStatus: string;
    actualStatus: string;
    expectedSatisfaction: number | null;
    actualSatisfaction: number | null;
    expectedReason: string;
    actualReason: string;
  }[] = [];

  for (const setSample of sets) {
    const profile = profiles[setSample.targetType];
    const res = resolveEntrySelectSet(setSample.selector, setSample.candidates, setSample.coverage, profile);
    if (res.outcome === "conflict") conflictCount += 1;
    if (res.outcome === "insufficient_evidence") insufficientEvidenceCount += 1;
    if (res.outcome === "invalid_input") invalidInputCount += 1;

    if (setSample.expectedOutcome === "selected") selectedCount += 1;
    else notFoundCount += 1;

    const isCorrect = res.outcome === setSample.expectedOutcome
      && res.status === setSample.expectedStatus
      && res.satisfaction === setSample.expectedSatisfaction
      && res.reason === setSample.expectedReason
      && JSON.stringify(res.ref) === JSON.stringify(setSample.expectedRef);

    if (isCorrect) {
      correct += 1;
      if (setSample.expectedOutcome === "selected") selectedCorrect += 1;
      else notFoundCorrect += 1;
    } else {
      failures.push(Object.freeze({
        id: setSample.id,
        targetType: setSample.targetType,
        expectedOutcome: setSample.expectedOutcome,
        actualOutcome: res.outcome,
        expectedStatus: setSample.expectedStatus,
        actualStatus: res.status,
        expectedSatisfaction: setSample.expectedSatisfaction,
        actualSatisfaction: res.satisfaction,
        expectedReason: setSample.expectedReason,
        actualReason: res.reason,
      }));
    }
  }

  return Object.freeze({
    count: sets.length,
    correct,
    accuracy: sets.length === 0 ? 1 : correct / sets.length,
    passed: correct === sets.length,
    selectedCount,
    selectedCorrect,
    notFoundCount,
    notFoundCorrect,
    conflictCount,
    insufficientEvidenceCount,
    invalidInputCount,
    failures: Object.freeze(failures),
  });
}

export function evaluateEntrySelectDataset(
  dataset: EntrySelectDataset,
  profiles: Readonly<{
    directory: EntrySelectProfile;
    regular: EntrySelectProfile;
  }>,
): EntrySelectEvaluationReport {
  const validatedProfiles = Object.freeze({
    directory: validateEntrySelectProfile(profiles.directory),
    regular: validateEntrySelectProfile(profiles.regular),
  });

  const partitions = {} as Record<EntrySelectPartition, PartitionEvaluationSummary>;
  for (const partition of ["train", "development", "verification"] as const) {
    const partSets = dataset.sets.filter(s => s.partition === partition);
    const partRows = dataset.candidateRows.filter(r => r.partition === partition);
    const dirSets = partSets.filter(s => s.targetType === "directory");
    const regSets = partSets.filter(s => s.targetType === "regular");
    const dirRows = partRows.filter(r => r.targetType === "directory");
    const regRows = partRows.filter(r => r.targetType === "regular");

    partitions[partition] = Object.freeze({
      partition,
      role: partition === "verification" ? "bounded_synthetic_held_out" : "known_replay",
      provenance: partition === "verification"
        ? "synthetic_held_out_from_eight_boolean_templates"
        : "known_replay_partition",
      allEightFeatureVectorsSeenInTrain: true,
      unseenFeatureCapabilityVerified: false,
      sets: evaluateSetSubset(partSets, validatedProfiles),
      candidates: evaluateCandidateSubset(partRows, validatedProfiles),
      byTargetType: Object.freeze({
        directory: Object.freeze({
          sets: evaluateSetSubset(dirSets, validatedProfiles),
          candidates: evaluateCandidateSubset(dirRows, validatedProfiles),
        }),
        regular: Object.freeze({
          sets: evaluateSetSubset(regSets, validatedProfiles),
          candidates: evaluateCandidateSubset(regRows, validatedProfiles),
        }),
      }),
    });
  }

  const probeRows = dataset.probes.map(probe => {
    const baseProfile = validatedProfiles[probe.targetType];
    const profile: EntrySelectProfile = probe.overrideProfileWeights
      ? Object.freeze({ ...baseProfile, weights: Object.freeze([...probe.overrideProfileWeights] as [number, number, number, number]) })
      : baseProfile;
    const res = resolveEntrySelectSet(probe.selector, probe.candidates, probe.coverage, profile);
    const correct = res.outcome === probe.expectedOutcome
      && res.status === probe.expectedStatus
      && res.satisfaction === probe.expectedSatisfaction
      && res.reason === probe.expectedReason
      && JSON.stringify(res.ref) === JSON.stringify(probe.expectedRef);
    return Object.freeze({
      id: probe.id,
      targetType: probe.targetType,
      expectedOutcome: probe.expectedOutcome,
      actualOutcome: res.outcome,
      expectedStatus: probe.expectedStatus,
      actualStatus: res.status,
      expectedSatisfaction: probe.expectedSatisfaction,
      actualSatisfaction: res.satisfaction,
      expectedReason: probe.expectedReason,
      actualReason: res.reason,
      correct,
    });
  });

  const probesCorrect = probeRows.filter(r => r.correct).length;
  const probesSummary: ProbesEvaluationSummary = Object.freeze({
    count: probeRows.length,
    correct: probesCorrect,
    passed: probesCorrect === probeRows.length,
    rows: Object.freeze(probeRows),
  });

  const trainSummary = partitions.train;
  const devSummary = partitions.development;
  const verifySummary = partitions.verification;

  return Object.freeze({
    partitions: Object.freeze(partitions),
    knownReplay: Object.freeze({
      train: trainSummary,
      development: devSummary,
      combinedSetsCount: trainSummary.sets.count + devSummary.sets.count,
      combinedSetsCorrect: trainSummary.sets.correct + devSummary.sets.correct,
      combinedCandidatesCount: trainSummary.candidates.count + devSummary.candidates.count,
      combinedCandidatesCorrect: trainSummary.candidates.correct + devSummary.candidates.correct,
      passed: trainSummary.sets.passed && trainSummary.candidates.passed && devSummary.sets.passed && devSummary.candidates.passed,
    }),
    independentVerification: verifySummary,
    probes: probesSummary,
    allPassed: trainSummary.sets.passed
      && trainSummary.candidates.passed
      && devSummary.sets.passed
      && devSummary.candidates.passed
      && verifySummary.sets.passed
      && verifySummary.candidates.passed
      && probesSummary.passed,
  });
}
