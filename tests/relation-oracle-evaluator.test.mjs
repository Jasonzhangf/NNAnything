import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateRelationOracle,
  RelationOracleInputError,
} from "../dist/training/relation-oracle-evaluator.js";

function sample(overrides = {}) {
  return {
    sampleId: "sample-1",
    targetRef: "decl:impl.ts#top:helper",
    gold: "true",
    goldSource: "tsc",
    goldEvidence: [{ evidenceRef: "tsc:sample-1", typeStep: "type" }],
    labelMissing: false,
    ...overrides,
  };
}

function run(overrides = {}) {
  const steps = overrides.steps ?? [
    {
      stepId: "s1",
      optionSemantics: "judge=true",
      executionReceiptRef: "r1",
      postStateRef: "p1",
      evidenceRefs: ["e1"],
    },
  ];
  const terminal = [...steps]
    .reverse()
    .map(step => step.optionSemantics)
    .find(option => option === "judge=true" || option === "judge=false" || option === "judge=unknown");
  const predicted =
    terminal === "judge=true" ? "true"
      : terminal === "judge=false" ? "false"
        : terminal === "judge=unknown" ? "unknown"
          : null;
  return {
    sampleId: "sample-1",
    steps,
    rootConditionStates: [{ conditionRef: "c1", state: "satisfied" }],
    rootGaps: [],
    rootSatisfied: true,
    predictedJudgement: predicted,
    positiveRootSatisfied: predicted === "true",
    queryCompletion: predicted === null ? "incomplete" : `complete_${predicted}`,
    ...overrides,
  };
}

test("known and unknown relations all correct yield pass", () => {
  const samples = [
    sample({ sampleId: "known-true", gold: "true" }),
    sample({ sampleId: "known-false", gold: "false" }),
    sample({ sampleId: "unknown", gold: "unknown" }),
  ];
  const runs = [
    run({
      sampleId: "known-true",
      steps: [
        { stepId: "s1", optionSemantics: "judge=true", executionReceiptRef: null, postStateRef: null, evidenceRefs: [] },
      ],
    }),
    run({
      sampleId: "known-false",
      steps: [
        { stepId: "s1", optionSemantics: "judge=false", executionReceiptRef: null, postStateRef: null, evidenceRefs: [] },
      ],
    }),
    run({
      sampleId: "unknown",
      steps: [
        { stepId: "s1", optionSemantics: "judge=unknown", executionReceiptRef: null, postStateRef: null, evidenceRefs: [] },
      ],
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "pass");
  assert.equal(report.studentPrediction.true, 1);
  assert.equal(report.studentPrediction.false, 1);
  assert.equal(report.studentPrediction.unknown, 1);
  assert.equal(report.unknownRecall, 1);
  assert.equal(report.violations.length, 0);
});

test("known relation miss makes report incomplete with exact violation", () => {
  const samples = [sample({ sampleId: "known-true" })];
  const runs = [
    run({
      sampleId: "known-true",
      steps: [
        { stepId: "s1", optionSemantics: "judge=false", executionReceiptRef: null, postStateRef: null, evidenceRefs: [] },
      ],
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "incomplete");
  assert.equal(report.perStepEvaluation.incorrect, 1);
  assert.ok(
    report.violations.some(violation => /final judge false but gold is true/.test(violation)),
  );
});

test("unknown gold guessed as true is not accepted", () => {
  const samples = [sample({ sampleId: "unknown", gold: "unknown" })];
  const runs = [
    run({
      sampleId: "unknown",
      steps: [
        { stepId: "s1", optionSemantics: "judge=true", executionReceiptRef: null, postStateRef: null, evidenceRefs: [] },
      ],
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "incomplete");
  assert.equal(report.perStepEvaluation.incorrect, 1);
  assert.equal(report.unknownRecall, 0);
});

test("known-gold unknown must not count toward valid unknown recall", () => {
  const samples = [
    sample({ sampleId: "known-true", gold: "true" }),
    sample({ sampleId: "valid-unknown", gold: "unknown" }),
  ];
  const runs = [
    run({
      sampleId: "known-true",
      steps: [
        { stepId: "s1", optionSemantics: "judge=unknown", executionReceiptRef: null, postStateRef: null, evidenceRefs: [] },
      ],
    }),
    run({
      sampleId: "valid-unknown",
      steps: [
        { stepId: "s1", optionSemantics: "judge=unknown", executionReceiptRef: null, postStateRef: null, evidenceRefs: [] },
      ],
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "incomplete");
  assert.equal(report.unknownRecall, 1);
  assert.deepEqual(report.validUnknown, {
    correct: 1,
    missed: 0,
    wrongTrueOrFalse: 0,
    finalUnknown: 1,
  });
});

test("unknown gold with a run but no terminal judge counts as missed, not NaN", () => {
  const samples = [sample({ sampleId: "unknown-no-judge", gold: "unknown" })];
  const runs = [
    run({
      sampleId: "unknown-no-judge",
      steps: [],
      rootConditionStates: [],
      rootSatisfied: null,
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "incomplete");
  assert.equal(report.studentPrediction.total, 0);
  assert.equal(report.studentPrediction.missing, 1);
  assert.equal(Number.isNaN(report.unknownRecall), false);
  assert.equal(report.unknownRecall, 0);
  assert.deepEqual(report.validUnknown, {
    correct: 0,
    missed: 1,
    wrongTrueOrFalse: 0,
    finalUnknown: 0,
  });
});

test("unknown recall keeps an absent run in the denominator exactly once", () => {
  const samples = [sample({ sampleId: "unknown-no-run", gold: "unknown" })];
  const report = evaluateRelationOracle(samples, []);

  assert.equal(report.unknownRecall, 0);
  assert.deepEqual(report.validUnknown, {
    correct: 0,
    missed: 1,
    wrongTrueOrFalse: 0,
    finalUnknown: 0,
  });
});

test("a missed unknown and a correct unknown do not overstate recall", () => {
  const samples = [
    sample({ sampleId: "correct-unknown", gold: "unknown" }),
    sample({ sampleId: "missed-unknown", gold: "unknown" }),
  ];
  const runs = [
    run({
      sampleId: "correct-unknown",
      steps: [
        { stepId: "s1", optionSemantics: "judge=unknown", executionReceiptRef: null, postStateRef: null, evidenceRefs: [] },
      ],
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.unknownRecall, 0.5);
  assert.deepEqual(report.validUnknown, {
    correct: 1,
    missed: 1,
    wrongTrueOrFalse: 0,
    finalUnknown: 1,
  });
});

test("label missing is excluded from the correctness denominator", () => {
  const samples = [sample({ sampleId: "missing", labelMissing: true })];
  const runs = [];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.gold.labelMissingExcluded, 1);
  assert.equal(report.gold.total, 0);
  assert.equal(report.studentPrediction.total, 0);
  assert.equal(report.rootEvaluation.evaluated, 0);
  assert.equal(report.overall, "pass");
});

test("gold evidence from model judgment is rejected", () => {
  assert.throws(
    () =>
      evaluateRelationOracle(
        [sample({ goldEvidence: [{ evidenceRef: "model", typeStep: "model_judgment" }] })],
        [],
      ),
    RelationOracleInputError,
  );
});

test("root satisfied without independent condition evidence is a violation", () => {
  const samples = [sample({ sampleId: "root-conflict" })];
  const runs = [
    run({
      sampleId: "root-conflict",
      rootConditionStates: [{ conditionRef: "c1", state: "unknown" }],
      rootGaps: ["gap-1"],
      rootSatisfied: true,
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "incomplete");
  assert.ok(report.violations.some(violation => /rootSatisfied=true conflicts/.test(violation)));
});

test("missing student run is explicit and not a false guess", () => {
  const samples = [sample({ sampleId: "no-run" })];
  const runs = [];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.studentPrediction.missing, 1);
  assert.equal(report.rootEvaluation.unknown, 1);
  assert.equal(report.overall, "incomplete");
});

test("missing query completion is not upgraded to a completed judgement", () => {
  const samples = [sample({ sampleId: "gap-only", gold: "true" })];
  const runs = [
    run({
      sampleId: "gap-only",
      rootGaps: ["ROOT_EVIDENCE_MISSING"],
      rootSatisfied: false,
      queryCompletion: undefined,
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.incompleteCompletions, 1);
  assert.equal(report.rootEvaluation.entries[0].goldComparison, "unsupported");
  assert.equal(report.overall, "incomplete");
});

test("contradictory completion and predicted judgement are rejected", () => {
  const samples = [sample({ sampleId: "contradictory", gold: "false" })];
  const runs = [
    run({
      sampleId: "contradictory",
      queryCompletion: "complete_true",
      predictedJudgement: "false",
      rootGaps: ["ROOT_EVIDENCE_MISSING"],
      rootSatisfied: false,
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "incomplete");
  assert.ok(report.violations.some(violation => /queryCompletion complete_true conflicts/.test(violation)));
});

test("complete_false with explicit terminal judge consistency passes gold comparison", () => {
  const samples = [sample({ sampleId: "explicit-false", gold: "false" })];
  const runs = [
    run({
      sampleId: "explicit-false",
      steps: [
        {
          stepId: "s1",
          optionSemantics: "judge=false",
          executionReceiptRef: "r1",
          postStateRef: "p1",
          evidenceRefs: ["e1"],
        },
      ],
      queryCompletion: "complete_false",
      predictedJudgement: "false",
      rootGaps: ["POSITIVE_RELATION_NOT_ESTABLISHED"],
      rootSatisfied: false,
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "pass");
  assert.equal(report.rootEvaluation.entries[0].goldComparison, "correct");
});

test("explicit predicted judgement cannot be substituted for an inconsistent terminal step", () => {
  const samples = [sample({ sampleId: "substituted", gold: "false" })];
  const runs = [
    run({
      sampleId: "substituted",
      steps: [
        {
          stepId: "s1",
          optionSemantics: "judge=true",
          executionReceiptRef: "r1",
          postStateRef: "p1",
          evidenceRefs: ["e1"],
        },
      ],
      queryCompletion: "complete_false",
      predictedJudgement: "false",
      rootGaps: ["POSITIVE_RELATION_NOT_ESTABLISHED"],
      rootSatisfied: false,
    }),
  ];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "incomplete");
  assert.ok(report.violations.some(violation =>
    /queryCompletion complete_false conflicts/.test(violation),
  ));
});
