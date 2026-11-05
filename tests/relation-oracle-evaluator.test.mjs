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
  return {
    sampleId: "sample-1",
    steps: [
      {
        stepId: "s1",
        optionSemantics: "judge=true",
        executionReceiptRef: "r1",
        postStateRef: "p1",
        evidenceRefs: ["e1"],
      },
    ],
    rootConditionStates: [{ conditionRef: "c1", state: "satisfied" }],
    rootGaps: [],
    rootSatisfied: true,
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
  assert.match(report.violations[0], /rootSatisfied=true conflicts/);
});

test("missing student run is explicit and not a false guess", () => {
  const samples = [sample({ sampleId: "no-run" })];
  const runs = [];

  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.studentPrediction.missing, 1);
  assert.equal(report.rootEvaluation.unknown, 1);
  assert.equal(report.overall, "incomplete");
});
