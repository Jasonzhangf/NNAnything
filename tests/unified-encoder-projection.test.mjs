// Red tests for shared value-flow relationshipProjection encoding (Stage B).
// These encode raw observed facts only: never gold, analyzer truth, A_g, or future receipts.
// They assert x[15]/x[23]/x[31]/x[51]/x[55] and missingMode per the accepted Stage A typed contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeUnifiedCandidate,
  UNIFIED_INPUT_SCHEMA,
  UNIFIED_ENCODER_VERSION,
} from "../dist/training/unified-encoder.js";

function knownValue(v) {
  return { state: "known", value: v, evidenceRefs: ["ev:obs"] };
}

function notObservedValue() {
  return { state: "not_observed", reason: "not_requested", value: undefined, evidenceRefs: ["ev:obs"] };
}

function conflictingValue(reason) {
  return { state: "conflicting", reason, value: undefined, evidenceRefs: ["ev:obs"] };
}

function unsupportedValue(v, reason) {
  return { state: "unsupported", reason, value: v, evidenceRefs: ["ev:obs"] };
}

function role(roleIndex, ordinalIndex) {
  return { roleIndex, ordinalIndex };
}

function binding(code) {
  // Numeric slot code -> typed BindingResolutionCode union consumed by the encoder.
  const kinds = {
    0: "not_applicable",
    0.25: "unresolved",
    0.5: "same_callee",
    0.75: "different_callee",
    1: "ambiguous_dynamic",
  };
  return kinds[code];
}

function baseContext() {
  return {
    contextId: "ctx:1",
    requestRef: "req:1",
    stepId: "step:0",
    route: { domain: "tsjs", decisionKind: "R" },
    goal: {
      goalRef: "goal:verify",
      kind: "verify",
      targetRef: "target:1",
      satisfactionThreshold: { state: "known", value: 50, evidenceRefs: ["ev:goal"] },
      constraints: [],
    },
    state: {
      stateRef: "state:1",
      revision: 1,
      facts: [],
      objectRefs: [],
      evidence: [],
      conflicts: [],
    },
    action: { previousActionRef: null, receiptRef: null, outcome: "none" },
    evaluation: { conditionStates: [], gaps: [] },
    skills: [],
    candidateGroup: {
      candidateGroupRef: "group:1",
      count: 1,
      enumeration: "complete",
      candidates: [
        {
          candidateRef: "cand:1",
          goalRef: "goal:verify",
          skillRef: "skill:relation.judge",
          candidateKind: "relation",
          optionSemantics: "judge=unknown",
          arguments: [],
          targetRef: null,
          bindingProjection: null,
          edgeRef: null,
          parameterProjection: [],
          evidenceRefs: [],
        },
      ],
    },
    executionPolicy: {
      remainingBudget: { state: "known", value: 3, evidenceRefs: [] },
      allowedEffects: ["read_only"],
      authorizationRevision: 1,
    },
    missingProjections: [],
    bindingProjections: [],
    bindingEdges: [],
    inputSchema: UNIFIED_INPUT_SCHEMA,
  };
}

function encode(ctx) {
  const candidate = ctx.candidateGroup.candidates[0];
  return encodeUnifiedCandidate(ctx, candidate);
}

test("UNIFIED_ENCODER_VERSION is v2 and input schema unchanged", () => {
  assert.equal(UNIFIED_ENCODER_VERSION, "nnanything.unified-step.encoder.v2");
  assert.equal(UNIFIED_INPUT_SCHEMA, "nnanything.unified-step.v1");
});

test("not_applicable default: absent relationshipProjection fills legal non--1 codes", () => {
  const ctx = baseContext();
  const res = encode(ctx);
  assert.equal(res.vector[15], 0);
  assert.equal(res.vector[23], 0);
  assert.equal(res.vector[31], 0);
  assert.equal(res.vector[51], 3 / 39); // orderFlow 0 + coverage 3 not_applicable
  assert.equal(res.vector[55], 0);
  assert.deepEqual(res.missingMode, []);
});

test("r_kill_neg: same-decl unconditional intervening write", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)), // d0=write
    sinkRoleAndOrdinal: knownValue(role(1, 0)),   // u0=read
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 2, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0)), // no callee
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[15], 3 / 7);
  assert.equal(res.vector[23], 4 / 19);
  assert.equal(res.vector[31], 4 / 19);
  assert.equal(res.vector[51], 10 / 39); // (2*4+2)/39
  assert.equal(res.vector[55], 0);
  assert.deepEqual(res.missingMode, []);
});

test("r_kill_pos: ordered before no intervening write", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 1, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[51], 6 / 39); // (1*4+2)/39
  assert.equal(res.vector[55], 0);
});

test("r_arg0_pos: arg_to_param same callee matching ordinal", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("arg_to_param"),
    sourceRoleAndOrdinal: knownValue(role(2, 0)), // argument ordinal0
    sinkRoleAndOrdinal: knownValue(role(2, 0)),   // parameter ordinal0
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0.5)), // same callee
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[15], 5 / 7);
  assert.equal(res.vector[23], 8 / 19); // (2*4+0)/19
  assert.equal(res.vector[31], 8 / 19);
  assert.equal(res.vector[51], 30 / 39); // (7*4+2)/39
  assert.equal(res.vector[55], 0.5);
  assert.deepEqual(res.missingMode, []);
});

test("r_arg_swap: argument ordinal1 bound to parameter ordinal0", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("arg_to_param"),
    sourceRoleAndOrdinal: knownValue(role(2, 1)), // argument ordinal1
    sinkRoleAndOrdinal: knownValue(role(2, 0)),   // parameter ordinal0
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0.5)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[23], 9 / 19); // (2*4+1)/19
  assert.equal(res.vector[31], 8 / 19);
  assert.equal(res.vector[55], 0.5);
});

test("r_arg_other_callee: different callee", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("arg_to_param"),
    sourceRoleAndOrdinal: knownValue(role(2, 0)),
    sinkRoleAndOrdinal: knownValue(role(2, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0.75)), // different callee
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[55], 0.75);
});

test("r_arg_missing_arg: source argument coverage missing", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("arg_to_param"),
    sourceRoleAndOrdinal: knownValue(role(0, 0)), // unknown role, observed
    sinkRoleAndOrdinal: knownValue(role(2, 1)),   // parameter ordinal1
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 0 }),
    bindingResolution: knownValue(binding(0.25)), // unresolved
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[23], 0); // roleIndex=0 unknown, observed -> 0, not -1
  assert.equal(res.vector[31], 9 / 19);
  assert.equal(res.vector[51], 28 / 39); // (7*4+0)/39
  assert.equal(res.vector[55], 0.25);
  assert.deepEqual(res.missingMode, []);
});

test("r_arg_missing_param: target parameter coverage missing", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("arg_to_param"),
    sourceRoleAndOrdinal: knownValue(role(2, 1)),
    sinkRoleAndOrdinal: knownValue(role(0, 0)), // unknown role, observed
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 0 }),
    bindingResolution: knownValue(binding(0.25)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[23], 9 / 19);
  assert.equal(res.vector[31], 0);
  assert.equal(res.vector[51], 28 / 39);
  assert.equal(res.vector[55], 0.25);
  assert.deepEqual(res.missingMode, []);
});

test("r_branch_kill: conditional writes cover all feasible branches", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 8, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[51], 34 / 39); // (8*4+2)/39
});

test("r_branch_may: conditional writes cover only one feasible branch", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 9, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[51], 38 / 39); // (9*4+2)/39
});

test("r_cond_missing_body: condition write seen, branch body missing", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 3, coverageIndex: 0 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[51], 12 / 39); // (3*4+0)/39
  assert.deepEqual(res.missingMode, []);
});

test("r_cond_missing_order: order undetermined, coverage missing", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 0, coverageIndex: 0 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[51], 0); // orderFlow 0 + coverage 0 -> 0, legal, not -1
  assert.deepEqual(res.missingMode, []);
});

test("whole-field missing: relationKind not observed -> -1 + missingMode G1 slot 15", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: notObservedValue(),
    sourceRoleAndOrdinal: knownValue(role(0, 0)),
    sinkRoleAndOrdinal: knownValue(role(0, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 0, coverageIndex: 3 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[15], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G1", fieldRef: "x[15].relationKind", reason: "not_requested", slotIndex: 15, fill: -1 },
  ]);
});

test("conflicting binding: x[55] -> -1 + missingMode G6 slot 55 with contract_mismatch", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 0, coverageIndex: 2 }),
    bindingResolution: conflictingValue("contract_mismatch"),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[55], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G6", fieldRef: "x[55].bindingResolution", reason: "contract_mismatch", slotIndex: 55, fill: -1 },
  ]);
});

test("unsupported control flow keeps legal value, no missingMode entry", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: unsupportedValue({ orderFlowIndex: 0, coverageIndex: 2 }, "unsupported_pattern"),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[51], 2 / 39); // orderFlow 0 + coverage 2 -> 2/39, legal value kept
  assert.deepEqual(res.missingMode, []);
});

test("read failure maps to missing + observation_failed, no failed state", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: { state: "missing", reason: "observation_failed", value: undefined, evidenceRefs: ["ev:obs"] },
    sinkRoleAndOrdinal: knownValue(role(2, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0.5)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[23], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G2", fieldRef: "x[23].sourceRoleAndOrdinal", reason: "observation_failed", slotIndex: 23, fill: -1 },
  ]);
});

test("unsupported ordinal with no legal role code -> -1 + unsupported_pattern", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("arg_to_param"),
    sourceRoleAndOrdinal: knownValue(role(2, 3)), // ordinal 3 is out of the accepted 0/1 slice
    sinkRoleAndOrdinal: knownValue(role(2, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0.5)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[23], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G2", fieldRef: "x[23].sourceRoleAndOrdinal", reason: "unsupported_pattern", slotIndex: 23, fill: -1 },
  ]);
});

test("unsupported x[51] with out-of-slice enum keeps -1 + unsupported_pattern", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: unsupportedValue({ orderFlowIndex: 10, coverageIndex: 2 }, "unsupported_pattern"),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[51], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G6", fieldRef: "x[51].orderFlowAndCoverage", reason: "unsupported_pattern", slotIndex: 51, fill: -1 },
  ]);
});

test("unsupported whole-field values on x[15]/x[23]/x[31]/x[55] fall back to -1 + missingMode", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: unsupportedValue("local_assign", "unsupported_pattern"),
    sourceRoleAndOrdinal: unsupportedValue(role(1, 0), "unsupported_pattern"),
    sinkRoleAndOrdinal: unsupportedValue(role(2, 0), "unsupported_pattern"),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 2 }),
    bindingResolution: unsupportedValue(binding(0.5), "unsupported_pattern"),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[15], -1);
  assert.equal(res.vector[23], -1);
  assert.equal(res.vector[31], -1);
  assert.equal(res.vector[55], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G1", fieldRef: "x[15].relationKind", reason: "unsupported_pattern", slotIndex: 15, fill: -1 },
    { block: "G2", fieldRef: "x[23].sourceRoleAndOrdinal", reason: "unsupported_pattern", slotIndex: 23, fill: -1 },
    { block: "G3", fieldRef: "x[31].sinkRoleAndOrdinal", reason: "unsupported_pattern", slotIndex: 31, fill: -1 },
    { block: "G6", fieldRef: "x[55].bindingResolution", reason: "unsupported_pattern", slotIndex: 55, fill: -1 },
  ]);
});

test("legal enum endpoints encode exact codes on all five slots", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("return_to_call_lhs"),
    sourceRoleAndOrdinal: knownValue(role(4, 1)),
    sinkRoleAndOrdinal: knownValue(role(0, 1)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 9, coverageIndex: 3 }),
    bindingResolution: knownValue(binding(1)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[15], 1);
  assert.equal(res.vector[23], 17 / 19);
  assert.equal(res.vector[31], 1 / 19);
  assert.equal(res.vector[51], 1);
  assert.equal(res.vector[55], 1);
  assert.deepEqual(res.missingMode, []);
});

test("negative roleIndex maps x[23] to -1 + unsupported_pattern", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(-1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[23], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G2", fieldRef: "x[23].sourceRoleAndOrdinal", reason: "unsupported_pattern", slotIndex: 23, fill: -1 },
  ]);
});

test("out-of-range roleIndex maps x[23] to -1 + unsupported_pattern", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(5, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[23], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G2", fieldRef: "x[23].sourceRoleAndOrdinal", reason: "unsupported_pattern", slotIndex: 23, fill: -1 },
  ]);
});

test("decimal ordinalIndex maps x[31] to -1 + unsupported_pattern", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(2, 0.5)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: 7, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[31], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G3", fieldRef: "x[31].sinkRoleAndOrdinal", reason: "unsupported_pattern", slotIndex: 31, fill: -1 },
  ]);
});

test("non-finite orderFlowIndex maps x[51] to -1 + unsupported_pattern", () => {
  const ctx = baseContext();
  ctx.relationshipProjection = {
    relationKind: knownValue("local_assign"),
    sourceRoleAndOrdinal: knownValue(role(1, 0)),
    sinkRoleAndOrdinal: knownValue(role(1, 0)),
    orderFlowAndCoverage: knownValue({ orderFlowIndex: Number.NaN, coverageIndex: 2 }),
    bindingResolution: knownValue(binding(0)),
    evidenceRefs: ["ev:rp"],
  };
  const res = encode(ctx);
  assert.equal(res.vector[51], -1);
  assert.deepEqual(res.missingMode, [
    { block: "G6", fieldRef: "x[51].orderFlowAndCoverage", reason: "unsupported_pattern", slotIndex: 51, fill: -1 },
  ]);
});
