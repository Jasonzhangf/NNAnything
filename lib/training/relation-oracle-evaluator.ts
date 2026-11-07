// Independent relation-oracle evaluator.
//
// This module consumes an independently produced gold sample set and a student
// step trajectory. It never calls the student forward path and never derives
// gold from model scores. Gold, student prediction, per-step evaluation and
// root evaluation stay physically separate so a single boolean cannot stand in
// for all evidence.

export type OracleJudgement = "true" | "false" | "unknown";
export type StepOutcome = "correct" | "unknown" | "incorrect";
export type RootOutcome = "satisfied" | "unsatisfied" | "unknown";

export const RELATION_ORACLE_GOLD_SOURCES = [
  "tsc",
  "typescript-language-service",
  "manual-structural-proof",
] as const;
export type RelationOracleGoldSource = (typeof RELATION_ORACLE_GOLD_SOURCES)[number];

export interface OracleGoldEvidence {
  readonly evidenceRef: string;
  readonly typeStep: "syntax" | "scope" | "type" | "binding" | "receipt";
}

export interface IndependentOracleSample {
  readonly sampleId: string;
  readonly targetRef: string;
  readonly gold: OracleJudgement;
  readonly goldSource: RelationOracleGoldSource;
  readonly goldEvidence: readonly OracleGoldEvidence[];
  /**
   * A sample with a missing label is excluded from the correctness
   * denominator. It is neither a negative example nor a false observation.
   */
  readonly labelMissing: boolean;
}

export interface StudentRelationStep {
  readonly stepId: string;
  /** Terminal judge options are exactly `judge=true|false|unknown`. */
  readonly optionSemantics: string;
  readonly executionReceiptRef: string | null;
  readonly postStateRef: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface StudentRootConditionState {
  readonly conditionRef: string;
  readonly state: "satisfied" | "unsatisfied" | "unknown" | "not_applicable";
}

export interface StudentRelationRun {
  readonly sampleId: string;
  readonly steps: readonly StudentRelationStep[];
  readonly rootConditionStates: readonly StudentRootConditionState[];
  readonly rootGaps: readonly string[];
  /** Independent root evaluation; never inferred from per-step correctness. */
  readonly rootSatisfied: boolean | null;
}

export interface GoldDenominator {
  readonly total: number;
  readonly true: number;
  readonly false: number;
  readonly unknown: number;
  readonly labelMissingExcluded: number;
}

export interface StudentPredictionDenominator {
  readonly total: number;
  readonly true: number;
  readonly false: number;
  readonly unknown: number;
  readonly missing: number;
}

export interface PerStepEvaluationEntry {
  readonly sampleId: string;
  readonly stepId: string;
  readonly predicted: OracleJudgement;
  readonly gold: OracleJudgement;
  readonly outcome: StepOutcome;
}

export interface PerStepEvaluation {
  readonly correct: number;
  readonly unknown: number;
  readonly incorrect: number;
  readonly entries: readonly PerStepEvaluationEntry[];
}

export interface RootEvaluationEntry {
  readonly sampleId: string;
  readonly outcome: RootOutcome;
  readonly rootSatisfied: boolean | null;
  readonly gaps: readonly string[];
}

export interface RootEvaluation {
  readonly evaluated: number;
  readonly satisfied: number;
  readonly unsatisfied: number;
  readonly unknown: number;
  readonly entries: readonly RootEvaluationEntry[];
}

export interface RelationOracleReport {
  readonly gold: GoldDenominator;
  readonly studentPrediction: StudentPredictionDenominator;
  readonly perStepEvaluation: PerStepEvaluation;
  readonly rootEvaluation: RootEvaluation;
  readonly overall: "pass" | "incomplete" | "invalid";
  readonly unknownRecall: number;
  readonly validUnknown: {
    readonly correct: number;
    readonly missed: number;
    readonly wrongTrueOrFalse: number;
    readonly finalUnknown: number;
  };
  readonly violations: readonly string[];
}

export class RelationOracleInputError extends Error {
  readonly code = "RELATION_ORACLE_INPUT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "RelationOracleInputError";
  }
}

const JUDGE_PREFIX = "judge=";

function judgeOf(step: StudentRelationStep): OracleJudgement | null {
  if (!step.optionSemantics.startsWith(JUDGE_PREFIX)) return null;
  const value = step.optionSemantics.slice(JUDGE_PREFIX.length);
  if (value === "true" || value === "false" || value === "unknown") return value;
  return null;
}

function assertIndependentGold(sample: IndependentOracleSample): void {
  if (sample.labelMissing) return;
  if (sample.goldEvidence.length === 0) {
    throw new RelationOracleInputError(
      `sample ${sample.sampleId} has gold ${sample.gold} but no independent evidence`,
    );
  }
  for (const evidence of sample.goldEvidence) {
    const independentSteps = new Set(["syntax", "scope", "type", "binding", "receipt"]);
    if (!independentSteps.has(evidence.typeStep)) {
      throw new RelationOracleInputError(
        `sample ${sample.sampleId} gold evidence type ${evidence.typeStep} is not independent`,
      );
    }
  }
}

function rootOutcome(run: StudentRelationRun): RootOutcome {
  if (run.rootSatisfied === null) return "unknown";
  return run.rootSatisfied ? "satisfied" : "unsatisfied";
}

export function evaluateRelationOracle(
  samples: readonly IndependentOracleSample[],
  runs: readonly StudentRelationRun[],
): RelationOracleReport {
  const runsBySample = new Map<string, StudentRelationRun>();
  for (const run of runs) {
    if (runsBySample.has(run.sampleId)) {
      throw new RelationOracleInputError(`duplicate student run for sample ${run.sampleId}`);
    }
    runsBySample.set(run.sampleId, run);
  }

  const violations: string[] = [];
  let goldTotal = 0;
  let goldTrue = 0;
  let goldFalse = 0;
  let goldUnknown = 0;
  let labelMissingExcluded = 0;
  let predictionTotal = 0;
  let predictionTrue = 0;
  let predictionFalse = 0;
  let predictionUnknown = 0;
  let predictionMissing = 0;
  let validUnknownCorrect = 0;
  let validUnknownMissed = 0;
  let validUnknownWrongTrueOrFalse = 0;
  let validUnknownFinalUnknown = 0;
  const stepEntries: PerStepEvaluationEntry[] = [];
  const rootEntries: RootEvaluationEntry[] = [];

  for (const sample of samples) {
    assertIndependentGold(sample);
    if (sample.labelMissing) {
      labelMissingExcluded += 1;
      continue;
    }

    goldTotal += 1;
    if (sample.gold === "true") goldTrue += 1;
    else if (sample.gold === "false") goldFalse += 1;
    else goldUnknown += 1;

    const run = runsBySample.get(sample.sampleId);
    const judgeSteps: { step: StudentRelationStep; judge: OracleJudgement }[] = [];
    if (run) {
      for (const step of run.steps) {
        const judge = judgeOf(step);
        if (judge !== null) judgeSteps.push({ step, judge });
      }
    }

    for (const { step, judge } of judgeSteps) {
      const outcome: StepOutcome =
        judge === sample.gold ? "correct" : judge === "unknown" ? "unknown" : "incorrect";
      stepEntries.push({
        sampleId: sample.sampleId,
        stepId: step.stepId,
        predicted: judge,
        gold: sample.gold,
        outcome,
      });
      if (outcome === "unknown") {
        violations.push(
          `sample ${sample.sampleId} step ${step.stepId} reported unknown while gold is ${sample.gold}`,
        );
      } else if (outcome === "incorrect") {
        violations.push(
          `sample ${sample.sampleId} step ${step.stepId} reported ${judge} while gold is ${sample.gold}`,
        );
      }
    }

    const judgeEntry = judgeSteps[judgeSteps.length - 1];
    if (judgeEntry === undefined) {
      predictionMissing += 1;
      violations.push(`sample ${sample.sampleId} has no terminal judge step`);
      if (sample.gold === "unknown") validUnknownMissed += 1;
    } else {
      predictionTotal += 1;
      const judge = judgeEntry.judge;
      if (judge === "true") predictionTrue += 1;
      else if (judge === "false") predictionFalse += 1;
      else predictionUnknown += 1;
      const outcome: StepOutcome =
        judge === sample.gold ? "correct" : judge === "unknown" ? "unknown" : "incorrect";
      if (sample.gold === "unknown") {
        if (judge === "unknown") {
          validUnknownCorrect += 1;
          validUnknownFinalUnknown += 1;
        } else {
          validUnknownWrongTrueOrFalse += 1;
        }
      }
      if (outcome === "unknown") {
        violations.push(
          `sample ${sample.sampleId} final judge unknown but gold is ${sample.gold}`,
        );
      } else if (outcome === "incorrect") {
        violations.push(
          `sample ${sample.sampleId} final judge ${judge} but gold is ${sample.gold}`,
        );
      }
    }

    if (!run) {
      rootEntries.push({
        sampleId: sample.sampleId,
        outcome: "unknown",
        rootSatisfied: null,
        gaps: [],
      });
      violations.push(`sample ${sample.sampleId} has no student run for root evaluation`);
      const stepOutcome: StepOutcome = "unknown";
      stepEntries.push({
        sampleId: sample.sampleId,
        stepId: "(missing)",
        predicted: "unknown",
        gold: sample.gold,
        outcome: stepOutcome,
      });
      continue;
    }

    const outcome = rootOutcome(run);
    rootEntries.push({
      sampleId: sample.sampleId,
      outcome,
      rootSatisfied: run.rootSatisfied,
      gaps: run.rootGaps,
    });
    if (run.rootSatisfied === true) {
      const blocked = run.rootConditionStates.some(
        condition => condition.state === "unsatisfied" || condition.state === "unknown",
      );
      if (blocked || run.rootGaps.length > 0) {
        violations.push(
          `sample ${sample.sampleId} rootSatisfied=true conflicts with independent condition states or gaps`,
        );
      }
    }
    if (run.rootSatisfied === false && run.rootGaps.length === 0) {
      violations.push(
        `sample ${sample.sampleId} rootSatisfied=false must expose at least one gap`,
      );
    }
  }

  const perStepCorrect = stepEntries.filter(entry => entry.outcome === "correct").length;
  const perStepUnknown = stepEntries.filter(entry => entry.outcome === "unknown").length;
  const perStepIncorrect = stepEntries.filter(entry => entry.outcome === "incorrect").length;
  const rootSatisfied = rootEntries.filter(entry => entry.outcome === "satisfied").length;
  const rootUnsatisfied = rootEntries.filter(entry => entry.outcome === "unsatisfied").length;
  const rootUnknown = rootEntries.filter(entry => entry.outcome === "unknown").length;

  const unknownRecall = goldUnknown === 0
    ? 1
    : validUnknownCorrect
      / (validUnknownCorrect + validUnknownMissed + validUnknownWrongTrueOrFalse);
  const overall =
    violations.length === 0 &&
    predictionMissing === 0 &&
    perStepIncorrect === 0 &&
    perStepUnknown === 0 &&
    unknownRecall === 1
      ? "pass"
      : "incomplete";

  return {
    gold: {
      total: goldTotal,
      true: goldTrue,
      false: goldFalse,
      unknown: goldUnknown,
      labelMissingExcluded,
    },
    studentPrediction: {
      total: predictionTotal,
      true: predictionTrue,
      false: predictionFalse,
      unknown: predictionUnknown,
      missing: predictionMissing,
    },
    perStepEvaluation: {
      correct: perStepCorrect,
      unknown: perStepUnknown,
      incorrect: perStepIncorrect,
      entries: Object.freeze(stepEntries),
    },
    rootEvaluation: {
      evaluated: rootEntries.length,
      satisfied: rootSatisfied,
      unsatisfied: rootUnsatisfied,
      unknown: rootUnknown,
      entries: Object.freeze(rootEntries),
    },
    overall,
    unknownRecall,
    validUnknown: {
      correct: validUnknownCorrect,
      missed: validUnknownMissed,
      wrongTrueOrFalse: validUnknownWrongTrueOrFalse,
      finalUnknown: validUnknownFinalUnknown,
    },
    violations: Object.freeze(violations),
  };
}
