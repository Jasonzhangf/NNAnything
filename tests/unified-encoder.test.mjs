import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeUnifiedCandidate,
  encodeUnifiedCandidateGroup,
  bucket,
  UNIFIED_INPUT_SCHEMA,
} from "../dist/training/unified-encoder.js";

const TARGET = "decl:impl.ts#top:helper";

function evidence(ref) {
  return {
    evidenceRef: ref,
    typeStep: "binding",
    scopeRef: null,
    observedRevision: 1,
    resultRef: null,
  };
}

function skill() {
  return {
    skillRef: "skill:read",
    skillKey: "read",
    contractVersion: "1.0.0",
    semanticClass: "read",
    parameterSchema: {
      schemaVersion: "1",
      parameters: [
        { name: "target", type: "declaration", required: true, allowedTargetKinds: ["function", "class"], cardinality: "one" },
      ],
    },
    capabilities: ["read"],
    effects: ["read_only"],
    executorRef: "exec:read",
    ordering: "unordered",
  };
}

function declaration({ declarationRef, moduleRef, name, kind = "function" }) {
  return {
    declarationRef,
    moduleRef,
    name,
    role: "export",
    kind,
    evidenceRefs: ["ev:decl"],
  };
}

function bindingProjection(decl) {
  return {
    symbolRef: "sym:helper",
    callSiteRef: "call:0",
    role: "import",
    bindingMode: "bound",
    resolution: {
      status: "resolved",
      declarationRef: decl.declarationRef,
      moduleRef: decl.moduleRef,
      evidenceRefs: ["ev:decl"],
    },
    declarationRefs: [decl],
    scopeRef: "scope:0",
    evidenceRefs: ["ev:proj"],
  };
}

function candidate(optionSemantics, decl) {
  return {
    candidateRef: `cand:${optionSemantics}`,
    goalRef: "goal:verify",
    skillRef: "skill:read",
    candidateKind: "relation",
    optionSemantics,
    arguments: [{ name: "target", type: "declaration", valueRef: TARGET }],
    targetRef: TARGET,
    bindingProjection: decl ? bindingProjection(decl) : null,
    edgeRef: null,
    parameterProjection: [],
    evidenceRefs: ["ev:cand"],
  };
}

function context({ currentDecl, outcome = "success", candidates }) {
  return {
    contextId: "ctx:1",
    requestRef: "req:1",
    stepId: "step:0",
    route: { domain: "tsjs", decisionKind: "R" },
    goal: {
      goalRef: "goal:verify",
      kind: "verify",
      targetRef: TARGET,
      requestedDeclaration: declaration({ declarationRef: TARGET, moduleRef: "module:impl.ts", name: "helper" }),
      satisfactionThreshold: { state: "known", value: 50, evidenceRefs: ["ev:goal"] },
      constraints: [],
    },
    state: {
      stateRef: "state:1",
      revision: 1,
      facts: [
        { factRef: "fact:1", predicateRef: "pred:known", value: { state: "known", value: "v1", evidenceRefs: ["ev:fact"] }, evidence: [evidence("ev:fact")] },
        { factRef: "fact:2", predicateRef: "pred:known", value: { state: "known", value: "v2", evidenceRefs: ["ev:fact"] }, evidence: [evidence("ev:fact")] },
      ],
      objectRefs: ["obj:1", "obj:2"],
      evidence: [evidence("ev:state")],
      conflicts: [],
    },
    action: {
      previousActionRef: "act:prev",
      receiptRef: "receipt:prev",
      outcome,
    },
    evaluation: { conditionStates: [], gaps: ["gap:1"] },
    skills: [skill()],
    candidateGroup: {
      candidateGroupRef: "group:1",
      count: candidates.length,
      enumeration: "complete",
      candidates,
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

const G0 = [0, 0, 1, 0, 1, 1, 0, 0];
const G1 = [0.25, 0, 0, 1, 0.25, 1, 1, 0];
const G3 = [0, 0, 0, 0, 0, 0, 1, 0];
const G6_JUDGE = [0, 0, 0, 3 / 39, 0, 0, 1, 0];
const G4 = {
  "judge=true": [0.75, 0, 0, 1, 1, 0, 0, 0],
  "judge=false": [0.75, 0, 0, 1, 0, 1, 0, 0],
  "judge=unknown": [0.75, 0, 0, 1, 0, 0, 1, 0],
};

function vec(blocks) {
  return blocks.flat();
}

function expectVectors(kind) {
  const trueDecl = declaration({ declarationRef: "decl:impl.ts#top:helper", moduleRef: "module:impl.ts", name: "helper" });
  const otherDiff = declaration({ declarationRef: "decl:other-different.ts#top:helper", moduleRef: "module:other-different.ts", name: "helper" });
  const sameModuleDiff = declaration({ declarationRef: "decl:impl.ts#top:otherHelper", moduleRef: "module:impl.ts", name: "otherHelper" });
  const groups = {
    "entry-pos": {
      currentDecl: trueDecl,
      outcome: "success",
      G2: [1, 1, 1, 0, 0, 0, 0, 0],
      G5: [1, 1, 1, 1, 1, 1, 1, 0],
      G7: [1, 0, 0, 0, 1, 1, 1, 0],
    },
    "entry-other-different": {
      currentDecl: otherDiff,
      outcome: "success",
      G2: [1, 1, 1, 0, 0, 0, 0, 0],
      G5: [1, 1, 1, 1, 1, 1, 1, 0],
      G7: [1, 0, 0, 0, 1, 0, 0, 0],
    },
    "entry-same-module-different": {
      currentDecl: sameModuleDiff,
      outcome: "success",
      G2: [1, 1, 1, 0, 0, 0, 0, 0],
      G5: [1, 1, 1, 1, 1, 0, 1, 0],
      G7: [1, 0, 0, 0, 1, 1, 0, 0],
    },
    "entry-missing": {
      currentDecl: null,
      outcome: "failed",
      G2: [1, 1, 0, 0, 1, 0, 0, 0],
      G5: [1, 0, 1, 1, 0, -1, -1, 0.5],
      G7: [1, 0, 0, 0, 0, -1, -1, 0.5],
    },
  };
  const option = Object.keys(G4);
  const result = [];
  for (const [groupName, group] of Object.entries(groups)) {
    const candidateGroup = option.map(o => candidate(o, group.currentDecl));
    const ctx = context({ currentDecl: group.currentDecl, outcome: group.outcome, candidates: candidateGroup });
    for (const o of option) {
      const c = candidateGroup.find(x => x.optionSemantics === o);
      const encoded = encodeUnifiedCandidate(ctx, c);
      result.push({
        label: `${groupName}/${o}`,
        expected: vec([G0, G1, group.G2, G3, G4[o], group.G5, G6_JUDGE, group.G7]),
        actual: encoded.vector,
      });
    }
  }
  return result;
}

test("encoder reproduces accepted v0.9 terminal vectors for four groups", () => {
  for (const row of expectVectors()) {
    assert.equal(row.actual.length, 64, `${row.label}: 64 entries`);
    for (let i = 0; i < 64; i += 1) {
      assert.equal(
        row.actual[i],
        row.expected[i],
        `${row.label}: slot ${i} (block G${Math.floor(i / 8)} index ${i % 8}) expected ${row.expected[i]} got ${row.actual[i]}`,
      );
    }
  }
});

test("encoder emits one vector per candidate with 8 blocks", () => {
  const decl = declaration({ declarationRef: "decl:impl.ts#top:helper", moduleRef: "module:impl.ts", name: "helper" });
  const group = ["judge=true", "judge=false", "judge=unknown"].map(o => candidate(o, decl));
  const ctx = context({ currentDecl: decl, candidates: group });
  const encoded = encodeUnifiedCandidateGroup(ctx);
  assert.equal(encoded.length, 3);
  for (const row of encoded) assert.equal(row.vector.length, 64);
});

test("bucket formula matches accepted ratio thresholds", () => {
  assert.equal(bucket(0, [0, 0.25, 0.5, 1]), 0);
  assert.equal(bucket(0.25, [0, 0.25, 0.5, 1]), 0.25);
  assert.equal(bucket(0.5, [0, 0.25, 0.5, 1]), 0.5);
  assert.equal(bucket(0.75, [0, 0.25, 0.5, 1]), 0.75);
  assert.equal(bucket(1, [0, 0.25, 0.5, 1]), 0.75);
});

test("incomplete candidate groups are rejected, never encoded", () => {
  const decl = declaration({ declarationRef: "decl:impl.ts#top:helper", moduleRef: "module:impl.ts", name: "helper" });
  const group = ["judge=true", "judge=false", "judge=unknown"].map(o => candidate(o, decl));
  const ctx = context({ currentDecl: decl, candidates: group });
  const truncated = { ...ctx, candidateGroup: { ...ctx.candidateGroup, enumeration: "truncated" } };
  assert.throws(() => encodeUnifiedCandidateGroup(truncated));
});

test("advance step0 matches accepted v0.9 vector", () => {
  const decl = null;
  const candidates = [{
    candidateRef: "cand:advance",
    goalRef: "goal:verify",
    skillRef: "skill:read",
    candidateKind: "action",
    optionSemantics: "advance",
    arguments: [{ name: "target", type: "declaration", valueRef: TARGET }],
    targetRef: TARGET,
    bindingProjection: null,
    edgeRef: "edge:0",
    parameterProjection: [],
    evidenceRefs: ["ev:cand"],
  }];
  const ctx = context({ currentDecl: decl, outcome: "none", candidates });
  ctx.action = { previousActionRef: null, receiptRef: null, outcome: "none" };
  ctx.bindingEdges = [{
    edgeRef: "edge:0",
    callSiteRef: null,
    fromNodeRef: "node:0",
    edgeKind: "import",
    sourceName: "helper",
    sourceModule: { state: "known", value: "module:util.ts", evidenceRefs: [] },
    targetName: "helper",
    targetModule: { state: "known", value: "module:impl.ts", evidenceRefs: [] },
    moduleSpecifierRaw: "./util",
    sourceContent: { state: "observed", resultRefs: [], reason: null, evidenceRefs: [] },
    visibility: { state: "known", value: "reachable", evidenceRefs: [] },
    hopDepth: 1,
    evidenceRefs: ["ev:edge"],
  }];
  const encoded = encodeUnifiedCandidate(ctx, candidates[0]);
  assert.deepEqual(encoded.vector, vec([
    [0, 0, 1, 0, 1, 1, 0, 0],
    [0.25, 0, 0, 1, 0.25, 1, 1, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 1, 0],
    [0.75, 0, 0, 1, 0, 0, 0, 0],
    [1, 0, 1, 1, 1, 1, -1, 0.5],
    [0, 0, 0, 3 / 39, 0, 1, 1, 0],
    [1, 0, 0, 0, 0, -1, -1, 0.5],
  ]));
});
