import assert from "node:assert/strict";
import { test } from "node:test";
import {
  relationStepContext,
} from "../dist/training/unified-step-context-builder.js";

const TARGET = "decl:closure.ts#top:base";
const PENDING = "relation:closure.ts:makeShadow:addOffset";

function evidence(ref) {
  return {
    evidenceRef: ref,
    typeStep: "binding",
    scopeRef: null,
    observedRevision: 1,
    resultRef: null,
  };
}

function declaration(overrides = {}) {
  return {
    declarationRef: TARGET,
    moduleRef: "module:closure.ts",
    name: "base",
    role: "export",
    kind: "function",
    evidenceRefs: ["ev:decl"],
    ...overrides,
  };
}

function edge(overrides = {}) {
  return {
    edgeRef: "edge:closure.ts:import:1",
    callSiteRef: "call:closure.ts:1",
    fromNodeRef: "module:entry.ts",
    edgeKind: "import",
    sourceName: "base",
    sourceModule: { state: "known", value: "module:entry.ts", evidenceRefs: ["ev:edge"] },
    targetName: "base",
    targetModule: { state: "known", value: "module:closure.ts", evidenceRefs: ["ev:edge"] },
    moduleSpecifierRaw: "./closure",
    sourceContent: {
      state: "observed",
      resultRefs: ["source:closure.ts"],
      reason: null,
      evidenceRefs: ["ev:edge"],
    },
    visibility: { state: "known", value: "reachable", evidenceRefs: ["ev:edge"] },
    hopDepth: 1,
    evidenceRefs: ["ev:edge"],
    ...overrides,
  };
}

function episode(overrides = {}) {
  return {
    sampleId: "typed-sample",
    stepId: "step:0",
    requestId: "request:typed",
    sourceGroup: "source:typed",
    language: "ts",
    semanticStratum: "closure_call_site",
    partition: "train",
    entryFile: "sources/src/closure.ts",
    targetRef: TARGET,
    pendingRelationRef: PENDING,
    callSiteRef: "call:closure.ts:1",
    calleeName: "base",
    requestedDeclaration: declaration(),
    observedFacts: ["makeShadow declares local base at line 12", "inner addOffset calls local base"],
    observedDeclarations: [declaration({ role: "shadow", declarationRef: "decl:closure.ts:makeShadow:local:base" })],
    observedBindings: [edge()],
    remainingObligations: [{ kind: "observe", ref: "obligation:registry", informationGain: 1 }],
    evidenceRefs: ["evidence/pre-state.jsonl#typed-sample"],
    failureMode: null,
    derivationFamily: "family:typed",
    adapterRef: "tsjs-unified-adapter:ts",
    ...overrides,
  };
}

test("typed observations project field-for-field into StepContext", () => {
  const requested = declaration();
  const observed = declaration({ declarationRef: "decl:closure.ts:makeShadow:local:base", role: "shadow" });
  const observedEdge = edge();
  const context = relationStepContext(episode({
    requestedDeclaration: requested,
    observedDeclarations: [observed],
    observedBindings: [observedEdge],
  }));

  assert.deepEqual(context.goal.requestedDeclaration, requested);
  assert.deepEqual(context.bindingEdges, [observedEdge]);
  assert.equal(context.bindingProjections.length, 1);
  assert.deepEqual(context.bindingProjections[0].declarationRefs, [observed]);
  assert.deepEqual(context.bindingProjections[0].resolution, {
    status: "resolved",
    declarationRef: observed.declarationRef,
    moduleRef: observed.moduleRef,
    evidenceRefs: observed.evidenceRefs,
  });

  const judges = context.candidateGroup.candidates.filter(candidate =>
    candidate.optionSemantics.startsWith("judge=")
  );
  assert.deepEqual(judges.map(candidate => candidate.optionSemantics), [
    "judge=true",
    "judge=false",
    "judge=unknown",
  ]);
  for (const judge of judges) {
    assert.equal(judge.targetRef, PENDING);
    assert.equal(judge.arguments[0].valueRef, PENDING);
    assert.equal(judge.bindingProjection?.declarationRefs[0]?.declarationRef, observed.declarationRef);
  }
  assert.deepEqual(
    context.candidateGroup.candidates.map(candidate => candidate.optionSemantics),
    ["judge=true", "judge=false", "judge=unknown", "advance", "observe", "DEFER"],
  );
});

test("dynamic candidates follow typed State instead of a fixed judge-only group", () => {
  const context = relationStepContext(episode());
  const advance = context.candidateGroup.candidates.find(candidate => candidate.optionSemantics === "advance");
  const observe = context.candidateGroup.candidates.find(candidate => candidate.optionSemantics === "observe");
  const defer = context.candidateGroup.candidates.find(candidate => candidate.optionSemantics === "DEFER");

  assert.equal(advance?.edgeRef, "edge:closure.ts:import:1");
  assert.equal(advance?.candidateKind, "action");
  assert.equal(observe?.targetRef, "obligation:registry");
  assert.equal(observe?.skillRef, "skill:relation.observe");
  assert.equal(defer?.candidateKind, "control");

  const terminal = relationStepContext(episode({
    observedBindings: [],
    remainingObligations: [],
  }));
  assert.equal(
    terminal.candidateGroup.candidates.some(candidate => candidate.optionSemantics === "RETURN"),
    true,
  );
});

test("enumeration exposes complete, truncated, and enumeration_failed from real State", () => {
  assert.equal(relationStepContext(episode()).candidateGroup.enumeration, "complete");
  assert.equal(
    relationStepContext(episode({ cursorOpen: true })).candidateGroup.enumeration,
    "truncated",
  );
  assert.equal(
    relationStepContext(episode({ enumerationFailure: true })).candidateGroup.enumeration,
    "enumeration_failed",
  );
});

test("missing requestedDeclaration stays explicit instead of being rebuilt from strings", () => {
  const context = relationStepContext(episode({
    requestedDeclaration: null,
    observedDeclarations: [],
    observedBindings: [],
    remainingObligations: [],
  }));
  assert.equal(context.goal.requestedDeclaration, null);
  assert.deepEqual(context.bindingEdges, []);
  assert.deepEqual(context.bindingProjections, []);
  assert.equal(context.missingProjections.some(projection =>
    projection.fieldRef === "goal.requestedDeclaration" && projection.state === "missing"
  ), true);
});

test("zero-gain observe obligation must not produce observe or DEFER candidates", () => {
  const context = relationStepContext(episode({
    observedDeclarations: [],
    observedBindings: [],
    remainingObligations: [{ kind: "observe", ref: "obligation:zero-gain", informationGain: 0 }],
  }));
  const semantics = context.candidateGroup.candidates.map(candidate => candidate.optionSemantics);
  assert.ok(!semantics.includes("observe"), "zero-gain observe must not generate observe candidate");
  assert.ok(!semantics.includes("DEFER"), "zero-gain observe must not generate DEFER candidate");
  assert.equal(
    context.candidateGroup.candidates.some(candidate => candidate.optionSemantics === "RETURN"),
    true,
    "terminal state without legal observation must still emit RETURN",
  );
});

test("empty terminal step must emit RETURN control candidate", () => {
  const context = relationStepContext(episode({
    observedDeclarations: [],
    observedBindings: [],
    remainingObligations: [],
  }));
  const semantics = context.candidateGroup.candidates.map(candidate => candidate.optionSemantics);
  assert.ok(!semantics.includes("observe"), "empty terminal must not generate observe candidate");
  assert.ok(!semantics.includes("advance"), "empty terminal must not generate advance candidate");
  assert.ok(!semantics.includes("DEFER"), "empty terminal must not generate DEFER candidate");
  assert.ok(
    context.candidateGroup.candidates.some(candidate => candidate.optionSemantics === "RETURN"),
    "empty terminal S_g must contain RETURN",
  );
});

test("advance obligation must be consumed as an advance candidate", () => {
  const context = relationStepContext(episode({
    observedDeclarations: [],
    observedBindings: [],
    remainingObligations: [{ kind: "advance", ref: "obligation:advance", informationGain: 1 }],
  }));
  const semantics = context.candidateGroup.candidates.map(candidate => candidate.optionSemantics);
  assert.ok(semantics.includes("advance"), "positive advance obligation must generate advance candidate");
  const advance = context.candidateGroup.candidates.find(candidate => candidate.optionSemantics === "advance");
  assert.equal(advance?.candidateKind, "action");
  assert.equal(advance?.targetRef, "obligation:advance");
  assert.equal(
    context.candidateGroup.candidates.some(candidate => candidate.optionSemantics === "DEFER"),
    true,
    "remaining legal continuation must also expose DEFER",
  );
});
