import assert from "node:assert/strict";
import { test } from "node:test";
import {
  relationStepContext,
} from "../dist/training/unified-step-context-builder.js";
import {
  encodeUnifiedCandidateGroup,
} from "../dist/training/unified-encoder.js";

const TARGET = "decl:sources/src/impl.ts#top:helper";
const PENDING = "pending:four-mappings";
const E1 = "edge:sources/src/entry.ts:import:0";
const E2 = "edge:sources/src/util.ts:reexport:0";

function declaration(overrides = {}) {
  return {
    declarationRef: "decl:sources/src/impl.ts#top:helper",
    moduleRef: "mod:sources/src/impl.ts",
    name: "helper",
    role: "export",
    kind: "function",
    evidenceRefs: ["ev:decl"],
    ...overrides,
  };
}

function binding(edgeRef, sourceModule, sourceContentState = "not_requested", overrides = {}) {
  return {
    edgeRef,
    callSiteRef: null,
    fromNodeRef: `syntax:${edgeRef}`,
    edgeKind: edgeRef === E2 ? "re_export" : "import",
    sourceName: "helper",
    sourceModule: {
      state: "known",
      value: sourceModule,
      reason: null,
      evidenceRefs: [`ev:${edgeRef}:source`],
    },
    targetName: "helper",
    targetModule: {
      state: "known",
      value: "mod:sources/src/entry.ts",
      reason: null,
      evidenceRefs: [`ev:${edgeRef}:target`],
    },
    moduleSpecifierRaw: edgeRef === E2 ? "./impl" : "./util",
    sourceContent: {
      state: sourceContentState,
      resultRefs: sourceContentState === "observed" ? [E2] : [],
      reason: null,
      evidenceRefs: [`ev:${edgeRef}:source`],
    },
    visibility: {
      state: "known",
      value: "reachable",
      reason: null,
      evidenceRefs: [`ev:${edgeRef}:source`],
    },
    hopDepth: 0,
    evidenceRefs: [`ev:${edgeRef}:source`],
    ...overrides,
  };
}

function projection(status, declarationRefs, extra = {}) {
  const resolution = status === "resolved"
    ? {
        status,
        declarationRef: extra.declarationRef,
        moduleRef: extra.moduleRef ?? "mod:sources/src/impl.ts",
        evidenceRefs: ["ev:projection"],
      }
    : {
        status,
        declarationRefs: declarationRefs.map(item => item.declarationRef),
        evidenceRefs: ["ev:projection"],
      };
  return {
    symbolRef: declarationRefs[0]?.declarationRef ?? "sym:unknown",
    callSiteRef: "call:sources/src/entry.ts:0",
    role: "export",
    bindingMode: status === "resolved" ? "bound" : "ambiguous",
    resolution,
    declarationRefs,
    scopeRef: "scope:entry",
    evidenceRefs: ["ev:projection"],
  };
}

function episode(overrides = {}) {
  return {
    sampleId: "four-mappings",
    stepId: "step:0",
    requestId: "request:four-mappings",
    sourceGroup: "tsjs-four-mappings",
    language: "ts",
    semanticStratum: "module_export",
    partition: "train",
    entryFile: "sources/src/entry.ts",
    targetRef: TARGET,
    pendingRelationRef: PENDING,
    callSiteRef: "call:sources/src/entry.ts:0",
    requestedDeclaration: declaration(),
    observedFacts: ["entry imports helper"],
    evidenceRefs: ["ev:entry"],
    failureMode: null,
    derivationFamily: "four-mappings-v1",
    adapterRef: "tsjs-unified-adapter:ts",
    ...overrides,
  };
}

function gain(state, value, evidenceRefs = ["ev:gain"]) {
  return { state, ...(state === "known" ? { value } : {}), evidenceRefs };
}

test("typed information gain admits only positive known obligations and preserves unknown gaps", () => {
  const current = binding(E1, "mod:sources/src/util.ts");
  const context = relationStepContext(episode({
    observedBindings: [current],
    remainingObligations: [
      {
        kind: "advance",
        ref: E1,
        pendingRelationRef: PENDING,
        informationGain: gain("known", "advances_chain"),
      },
      {
        kind: "observe",
        ref: "obligation:none",
        pendingRelationRef: PENDING,
        informationGain: gain("known", "none"),
      },
      {
        kind: "observe",
        ref: "obligation:unknown",
        pendingRelationRef: PENDING,
        informationGain: gain("not_observed"),
      },
    ],
  }));
  const semantics = context.candidateGroup.candidates.map(candidate => candidate.optionSemantics);

  assert.equal(semantics.includes("advance"), true);
  assert.equal(semantics.includes("observe"), false);
  assert.equal(semantics.includes("DEFER"), true);
  assert.equal(
    context.missingProjections.some(item =>
      item.targetRef === "obligation:unknown"
      && item.state === "not_observed"
      && item.reason === "not_requested"
    ),
    true,
  );
  assert.equal(
    context.missingProjections.some(item => item.targetRef === "obligation:none"),
    false,
  );
  assert.equal(context.localCandidateCursor?.state, "open");
  assert.equal(context.candidateGroup.enumeration, "truncated");
});

test("known none alone cannot create DEFER", () => {
  const context = relationStepContext(episode({
    remainingObligations: [
      {
        kind: "observe",
        ref: "obligation:none",
        pendingRelationRef: PENDING,
        informationGain: gain("known", "none"),
      },
    ],
  }));
  const semantics = context.candidateGroup.candidates.map(candidate => candidate.optionSemantics);

  assert.equal(semantics.includes("observe"), false);
  assert.equal(semantics.includes("DEFER"), false);
  assert.equal(semantics.includes("RETURN"), true);
  assert.equal(context.localCandidateCursor?.state, "closed");
  assert.equal(context.candidateGroup.enumeration, "complete");
});

test("resolved declaration projection uses the exact declaration ref, never array order", () => {
  const unrelated = declaration({
    declarationRef: "decl:sources/src/other.ts#top:helper",
    moduleRef: "mod:sources/src/other.ts",
  });
  const expected = declaration();
  const context = relationStepContext(episode({
    observedDeclarations: [unrelated, expected],
    currentRelation: {
      pendingRelationRef: PENDING,
      callSiteRef: "call:sources/src/entry.ts:0",
      binding: {
        state: "known",
        value: projection("resolved", [unrelated, expected], {
          declarationRef: expected.declarationRef,
          moduleRef: expected.moduleRef,
        }),
        evidenceRefs: ["ev:projection"],
      },
    },
  }));
  const judges = context.candidateGroup.candidates.filter(candidate =>
    candidate.optionSemantics.startsWith("judge=")
  );

  assert.equal(judges.length, 3);
  for (const judge of judges) {
    assert.equal(judge.bindingProjection?.resolution.status, "resolved");
    assert.equal(judge.bindingProjection?.resolution.declarationRef, expected.declarationRef);
    assert.equal(
      judge.bindingProjection?.declarationRefs.filter(
        item => item.declarationRef === expected.declarationRef,
      ).length,
      1,
    );
  }
  const vectors = encodeUnifiedCandidateGroup(context);
  const judgeVectors = vectors.filter((_, index) =>
    context.candidateGroup.candidates[index]?.optionSemantics.startsWith("judge=")
  );
  assert.deepEqual(
    judgeVectors.map(result => result.vector[44]),
    [1, 1, 1],
  );
  assert.deepEqual(
    judgeVectors.map(result => result.vector[60]),
    [1, 1, 1],
  );
});

test("ambiguous declaration projection stays ambiguous and leaves comparison slots missing", () => {
  const first = declaration({
    declarationRef: "decl:sources/src/other.ts#top:helper",
    moduleRef: "mod:sources/src/other.ts",
  });
  const second = declaration();
  const current = projection("ambiguous", [first, second]);
  const context = relationStepContext(episode({
    observedDeclarations: [first, second],
    currentRelation: {
      pendingRelationRef: PENDING,
      callSiteRef: "call:sources/src/entry.ts:0",
      binding: {
        state: "known",
        value: current,
        evidenceRefs: ["ev:projection"],
      },
    },
  }));
  const judge = context.candidateGroup.candidates.find(candidate =>
    candidate.optionSemantics === "judge=true"
  );
  const encoded = encodeUnifiedCandidateGroup(context).find((_, index) =>
    context.candidateGroup.candidates[index]?.optionSemantics === "judge=true"
  );

  assert.equal(judge?.bindingProjection?.resolution.status, "ambiguous");
  assert.deepEqual(
    judge?.bindingProjection?.resolution.declarationRefs,
    [first.declarationRef, second.declarationRef],
  );
  assert.equal(encoded?.vector[44], 1);
  assert.equal(encoded?.vector[60], 0);
  assert.equal(encoded?.vector[61], -1);
  assert.equal(encoded?.vector[62], -1);
});

test("previous execution maps the receipt, outcome, and origin without future inference", () => {
  const previous = {
    actionRef: "act:entry:read",
    receiptRef: "receipt:entry:read",
    origin: "source_observation",
    fromStepId: null,
    pendingRelationRef: PENDING,
    optionSemantics: "observe",
    targetRef: E1,
    outcome: "success",
  };
  const context = relationStepContext(episode({
    previousExecution: {
      state: "known",
      value: previous,
      evidenceRefs: ["ev:receipt"],
    },
  }));

  assert.deepEqual(context.action, {
    previousActionRef: "act:entry:read",
    receiptRef: "receipt:entry:read",
    outcome: "success",
  });
  assert.equal(context.previousExecution?.value?.origin, "source_observation");

  const none = relationStepContext(episode({
    previousExecution: { state: "known", value: null, evidenceRefs: ["ev:none"] },
  }));
  assert.deepEqual(none.action, {
    previousActionRef: null,
    receiptRef: null,
    outcome: "none",
  });

  const unknown = relationStepContext(episode({
    previousExecution: { state: "not_observed", evidenceRefs: ["ev:unknown"] },
  }));
  assert.deepEqual(unknown.action, {
    previousActionRef: null,
    receiptRef: null,
    outcome: "unknown",
  });
  assert.equal(
    unknown.missingProjections.some(item =>
      item.fieldRef === "previousExecution" && item.state === "not_observed"
    ),
    true,
  );
});

test("advance candidates are limited to current, reachable, not-requested obligations", () => {
  const current = binding(E1, "mod:sources/src/util.ts");
  const unrelated = binding(E2, "mod:sources/src/impl.ts");
  const withUnrelated = relationStepContext(episode({
    observedBindings: [current, unrelated],
    remainingObligations: [
      {
        kind: "advance",
        ref: E1,
        pendingRelationRef: PENDING,
        informationGain: gain("known", "resolves_target"),
      },
    ],
  }));
  const advanceRefs = withUnrelated.candidateGroup.candidates
    .filter(candidate => candidate.optionSemantics === "advance")
    .map(candidate => candidate.targetRef);

  assert.deepEqual(advanceRefs, [E1]);
  assert.equal(withUnrelated.bindingEdges.some(edge => edge.edgeRef === E2), true);

  const consumed = relationStepContext(episode({
    observedBindings: [binding(E1, "mod:sources/src/util.ts", "observed")],
    remainingObligations: [
      {
        kind: "advance",
        ref: E1,
        pendingRelationRef: PENDING,
        informationGain: gain("known", "advances_chain"),
      },
    ],
  }));
  assert.equal(
    consumed.candidateGroup.candidates.some(candidate => candidate.optionSemantics === "advance"),
    false,
  );
  assert.equal(consumed.localCandidateCursor?.state, "open");
  assert.equal(
    consumed.candidateGroup.candidates.some(candidate => candidate.optionSemantics === "DEFER"),
    true,
  );
  assert.equal(
    consumed.candidateGroup.candidates.some(candidate => candidate.optionSemantics === "RETURN"),
    false,
  );
});

test("later observations cannot appear before their producing step", () => {
  const first = binding(E1, "mod:sources/src/util.ts");
  const step0 = relationStepContext(episode({
    stepId: "step-0",
    observedBindings: [first],
    observedDeclarations: [],
    remainingObligations: [
      {
        kind: "advance",
        ref: E1,
        pendingRelationRef: PENDING,
        informationGain: gain("known", "advances_chain"),
      },
    ],
  }));
  assert.deepEqual(
    step0.candidateGroup.candidates
      .filter(candidate => candidate.optionSemantics === "advance")
      .map(candidate => candidate.edgeRef),
    [E1],
  );
  assert.equal(step0.bindingEdges.some(edge => edge.edgeRef === E2), false);
  assert.deepEqual(step0.bindingProjections, []);

  const second = binding(E2, "mod:sources/src/impl.ts");
  const step2 = relationStepContext(episode({
    stepId: "step-2",
    observedBindings: [
      binding(E1, "mod:sources/src/util.ts", "observed"),
      { ...second, sourceContent: { ...second.sourceContent, state: "observed", resultRefs: [TARGET] } },
    ],
    observedDeclarations: [declaration()],
    remainingObligations: [],
  }));
  const step2Semantics = step2.candidateGroup.candidates.map(candidate => candidate.optionSemantics);
  assert.equal(step2Semantics.includes("advance"), false);
  assert.equal(step2Semantics.includes("RETURN"), true);
  assert.equal(step2.bindingProjections[0]?.resolution.status, "resolved");
});
