import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeUnifiedCandidate } from "../dist/training/unified-encoder.js";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";

function declaration(overrides = {}) {
  return {
    declarationRef: "decl:closure.ts#top:base",
    moduleRef: "module:closure.ts",
    name: "base",
    role: "export",
    kind: "function",
    evidenceRefs: ["ev:decl"],
    ...overrides,
  };
}

function resolvedCurrentRelation(declaration, callSiteRef = "call:closure.ts:1") {
  return {
    pendingRelationRef: "relation:closure.ts:makeShadow:addOffset",
    callSiteRef,
    binding: {
      state: "known",
      value: {
        symbolRef: declaration.declarationRef,
        callSiteRef,
        role: declaration.role,
        bindingMode: "bound",
        resolution: {
          status: "resolved",
          declarationRef: declaration.declarationRef,
          moduleRef: declaration.moduleRef,
          evidenceRefs: declaration.evidenceRefs,
        },
        declarationRefs: [declaration],
        scopeRef: null,
        evidenceRefs: declaration.evidenceRefs,
      },
      evidenceRefs: ["ev:relation"],
    },
  };
}

function episode(overrides = {}) {
  const observedDeclarations = overrides.observedDeclarations ?? [
    declaration({ declarationRef: "decl:closure.ts:makeShadow:local:base", role: "shadow" }),
  ];
  return {
    sampleId: "typed-encoder",
    stepId: "step:0",
    requestId: "request:typed-encoder",
    sourceGroup: "source:typed-encoder",
    language: "ts",
    semanticStratum: "closure_call_site",
    partition: "train",
    entryFile: "sources/src/closure.ts",
    targetRef: "decl:irrelevant.ts#top:notTheAnswer",
    pendingRelationRef: "relation:closure.ts:makeShadow:addOffset",
    callSiteRef: "call:closure.ts:1",
    requestedDeclaration: declaration(),
    observedFacts: ["typed local observation"],
    observedDeclarations,
    currentRelation: resolvedCurrentRelation(observedDeclarations[0]),
    observedBindings: [],
    remainingObligations: [],
    evidenceRefs: ["ev:pre-state"],
    failureMode: null,
    derivationFamily: "family:typed-encoder",
    adapterRef: "tsjs-unified-adapter:ts",
    ...overrides,
  };
}

function judgeVector(context) {
  const candidate = context.candidateGroup.candidates.find(row => row.optionSemantics === "judge=true");
  assert.ok(candidate);
  return encodeUnifiedCandidate(context, candidate).vector;
}

test("judge identity slots compare explicit requestedDeclaration fields", () => {
  const context = relationStepContext(episode());
  const vector = judgeVector(context);
  assert.deepEqual(vector.slice(44, 48), [1, 1, 1, 0]);
  assert.deepEqual(vector.slice(60, 64), [1, 1, 0, 0]);

  const exact = relationStepContext(episode({
    requestedDeclaration: declaration(),
    observedDeclarations: [declaration()],
  }));
  assert.deepEqual(judgeVector(exact).slice(60, 64), [1, 1, 1, 0]);

  const different = relationStepContext(episode({
    requestedDeclaration: declaration({
      declarationRef: "decl:other.ts#top:other",
      moduleRef: "module:other.ts",
      name: "other",
      kind: "class",
    }),
    observedDeclarations: [declaration()],
  }));
  assert.deepEqual(judgeVector(different).slice(44, 48), [1, 0, 0, 0]);
  assert.deepEqual(judgeVector(different).slice(60, 64), [1, 0, 0, 0]);
});

test("allowedTargetKinds compares declaration kinds, not symbol text", () => {
  const context = relationStepContext(episode({
    requestedDeclaration: declaration({ kind: "property" }),
    observedDeclarations: [declaration({ kind: "function" })],
  }));
  const vector = judgeVector(context);
  assert.equal(vector[14], 0);
  assert.equal(vector[41], 1);
});
