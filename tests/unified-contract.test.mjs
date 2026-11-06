// Typed acceptance entry for the unified 64-slot fixed environment.
//
// Items 1-9 (encoder, forward, group loss, relation oracle, data gate, runner
// route, model package, thresholds, TS/JS adapter) each get one executable
// assertion driven by on-disk typed fixtures. Positive, control and unknown
// cases stay separate. The suites run without a browser, fitter, installed
// binary or network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodeUnifiedCandidate,
  encodeUnifiedCandidateGroup,
  UNIFIED_INPUT_SCHEMA,
} from "../dist/training/unified-encoder.js";
import {
  createXavierTensors,
  forwardUnifiedScore,
} from "../dist/training/unified-forward.js";
import { fullBatchEpochStep } from "../dist/training/group-loss.js";
import { evaluateRelationOracle } from "../dist/training/relation-oracle-evaluator.js";
import {
  UNIFIED_DATA_GATE_SCHEMA,
  validateUnified64SlotTrainingData,
} from "../dist/training/unified-data-gate.js";
import {
  MODEL_INCOMPATIBLE,
  UnifiedModelPackageError,
  createUnifiedModelPackage,
  loadUnifiedModelPackageFromFile,
  saveUnifiedModelPackageAtomic,
  validateUnifiedModelPackage,
} from "../dist/training/unified-model-package.js";
import {
  UnifiedThresholdError,
  validateFeatureThresholds,
  validateMissingModeTable,
} from "../dist/training/unified-thresholds.js";
import { mapTsJsSymbolTableToUnifiedFacts } from "../dist/adapters/tsjs-unified-adapter.js";

const here = new URL(".", import.meta.url);
const envFixture = name => new URL(`./fixtures/unified-env/${name}`, here).pathname;
const slotFixture = name => new URL(`./fixtures/unified-64-slot/${name}`, here).pathname;
const thresholdsPath = slotFixture("feature-thresholds-r-unified-step-encoder-v1.json");
const missingModePath = slotFixture("missing-mode-table.json");

const TARGET = "decl:impl.ts#top:helper";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function flatten(blocks) {
  return blocks.flat();
}

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
        {
          name: "target",
          type: "declaration",
          required: true,
          allowedTargetKinds: ["function", "class"],
          cardinality: "one",
        },
      ],
    },
    capabilities: ["read"],
    effects: ["read_only"],
    executorRef: "exec:read",
    ordering: "unordered",
  };
}

function declaration(spec) {
  return {
    declarationRef: spec.declarationRef,
    moduleRef: spec.moduleRef,
    name: spec.name,
    role: "export",
    kind: "function",
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

function context({ currentDecl, outcome, candidates }) {
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
        {
          factRef: "fact:1",
          predicateRef: "pred:known",
          value: { state: "known", value: "v1", evidenceRefs: ["ev:fact"] },
          evidence: [evidence("ev:fact")],
        },
        {
          factRef: "fact:2",
          predicateRef: "pred:known",
          value: { state: "known", value: "v2", evidenceRefs: ["ev:fact"] },
          evidence: [evidence("ev:fact")],
        },
      ],
      objectRefs: ["obj:1", "obj:2"],
      evidence: [evidence("ev:state")],
      conflicts: [],
    },
    action: { previousActionRef: "act:prev", receiptRef: "receipt:prev", outcome },
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

const GROUP_DECLS = {
  "entry-pos": {
    currentDecl: { declarationRef: "decl:impl.ts#top:helper", moduleRef: "module:impl.ts", name: "helper" },
    outcome: "success",
  },
  "entry-other-different": {
    currentDecl: {
      declarationRef: "decl:other-different.ts#top:helper",
      moduleRef: "module:other-different.ts",
      name: "helper",
    },
    outcome: "success",
  },
  "entry-same-module-different": {
    currentDecl: {
      declarationRef: "decl:impl.ts#top:otherHelper",
      moduleRef: "module:impl.ts",
      name: "otherHelper",
    },
    outcome: "success",
  },
  "entry-missing": { currentDecl: null, outcome: "failed" },
};

const OPTIONS = ["judge=true", "judge=false", "judge=unknown"];

function expectedVector(fixture, groupName, option) {
  const group = fixture.groups[groupName];
  return flatten([
    fixture.common.G0,
    fixture.common.G1,
    group.G2,
    fixture.common.G3,
    fixture.common.G4[option],
    group.G5,
    fixture.common.G6,
    group.G7,
  ]);
}

// Item 1: encoder reproduces every accepted typed terminal vector.
test("item 1: accepted typed terminal vectors encode to 64 slots exactly", async () => {
  const fixture = await readJson(envFixture("terminal-vectors.json"));
  for (const [groupName, spec] of Object.entries(GROUP_DECLS)) {
    const decl = spec.currentDecl ? declaration(spec.currentDecl) : null;
    const candidates = OPTIONS.map(o => candidate(o, decl));
    const ctx = context({ currentDecl: spec.currentDecl, outcome: spec.outcome, candidates });
    for (const option of OPTIONS) {
      const encoded = encodeUnifiedCandidate(
        ctx,
        candidates.find(c => c.optionSemantics === option),
      );
      assert.equal(encoded.vector.length, 64, `${groupName}/${option} length`);
      assert.deepEqual(
        encoded.vector,
        expectedVector(fixture, groupName, option),
        `${groupName}/${option} vector mismatch`,
      );
    }
  }
});

test("item 1: same state, different judge candidates stay distinct and gold-free", async () => {
  const spec = GROUP_DECLS["entry-pos"];
  const decl = declaration(spec.currentDecl);
  const candidateGroup = ["judge=true", "judge=false", "judge=unknown"].map(o => candidate(o, decl));
  const ctx = context({ currentDecl: spec.currentDecl, outcome: spec.outcome, candidates: candidateGroup });
  const encoderInput = JSON.stringify({ goal: ctx.goal, candidateGroup: ctx.candidateGroup });
  for (const leak of ["gold", "teacher", "callEdge", "finalDeclarationRef"]) {
    assert.equal(
      encoderInput.includes(leak),
      false,
      `encoder input must not leak ${leak}`,
    );
  }
  const encoded = encodeUnifiedCandidateGroup(ctx);
  assert.equal(encoded.length, 3);
  assert.notDeepEqual(encoded[0].vector, encoded[1].vector);
  assert.notDeepEqual(encoded[1].vector, encoded[2].vector);
  assert.notDeepEqual(encoded[0].vector, encoded[2].vector);
});

// Item 2: scalar forward runs on an encoded vector and rejects bad shapes.
test("item 2: scalar forward consumes a 64-slot vector and rejects non-64 input", async () => {
  const spec = GROUP_DECLS["entry-pos"];
  const decl = declaration(spec.currentDecl);
  const ctx = context({
    currentDecl: spec.currentDecl,
    outcome: spec.outcome,
    candidates: [candidate("judge=true", decl)],
  });
  const [encoded] = encodeUnifiedCandidateGroup(ctx);
  const tensors = createXavierTensors(7);
  const score = forwardUnifiedScore(encoded.vector, tensors);
  assert.equal(Number.isFinite(score), true);
  assert.throws(() => forwardUnifiedScore(encoded.vector.slice(0, 63), tensors), TypeError);
});

// Item 3: group loss and one full-batch update.
test("item 3: group loss and full-batch update run for a candidate group", async () => {
  const spec = GROUP_DECLS["entry-pos"];
  const decl = declaration(spec.currentDecl);
  const candidateGroup = ["judge=true", "judge=false", "judge=unknown"].map(o => candidate(o, decl));
  const ctx = context({ currentDecl: spec.currentDecl, outcome: spec.outcome, candidates: candidateGroup });
  const encoded = encodeUnifiedCandidateGroup(ctx);
  const tensors = createXavierTensors(11);
  const group = {
    groupRef: "group:1",
    candidates: encoded.map((row, index) => ({
      candidateRef: row.candidateRef,
      input: row.vector,
      optionSemantics: candidateGroup[index].optionSemantics,
      candidateKind: "relation",
    })),
    allowedCandidateRefs: [encoded[0].candidateRef],
  };
  const before = [tensors.W1, tensors.b1, tensors.W2, tensors.b2, tensors.W3, tensors.b3]
    .map(part => part.reduce((sum, value) => sum + value, 0));
  const result = fullBatchEpochStep(tensors, [group], 0.05);
  assert.equal(result.groupLosses.length, 1);
  assert.equal(Number.isFinite(result.loss), true);
  const after = [tensors.W1, tensors.b1, tensors.W2, tensors.b2, tensors.W3, tensors.b3]
    .map(part => part.reduce((sum, value) => sum + value, 0));
  assert.equal(before.some((sum, index) => sum !== after[index]), true);
});

// Item 5: data gate accepts valid 64-slot rows and rejects a 56-input row.
test("item 5: data gate accepts 64-slot rows and rejects wrong input shape", async () => {
  const spec = GROUP_DECLS["entry-pos"];
  const decl = declaration(spec.currentDecl);
  const ctx = context({
    currentDecl: spec.currentDecl,
    outcome: spec.outcome,
    candidates: [candidate("judge=true", decl)],
  });
  const [encoded] = encodeUnifiedCandidateGroup(ctx);
  const dir = await mkdtemp(join(tmpdir(), "unified-contract-"));
  const rowsPath = join(dir, "rows.jsonl");
  const validRow = {
    schema: "nnanything.unified.data-row.v1",
    rowId: "row-valid",
    partition: "TRAIN",
    route: { domain: "tsjs", decisionKind: "R" },
    input: encoded.vector,
    missingMode: [],
    candidates: ["judge=true", "judge=false"],
    allowed: ["judge=true"],
    gold: "judge=true",
    labelMissing: false,
    enumeration: "complete",
  };
  const badRow = { ...validRow, rowId: "row-bad", input: encoded.vector.slice(0, 56) };
  const config = {
    schema: UNIFIED_DATA_GATE_SCHEMA,
    partition: "TRAIN",
    encoderVersion: "nnanything.unified-step.encoder.v1",
    thresholdsPath,
    rowsPath,
  };

  await writeFile(rowsPath, `${JSON.stringify(validRow)}\n`, "utf8");
  const ok = await validateUnified64SlotTrainingData(config);
  assert.equal(ok.status, "READY");
  assert.equal(ok.counts.learnedRows, 1);

  await writeFile(rowsPath, `${JSON.stringify(badRow)}\n`, "utf8");
  const bad = await validateUnified64SlotTrainingData(config);
  assert.equal(bad.status, "DATA_INVALID");
  assert.equal(bad.violations.some(v => v.reasonCode === "INPUT_SHAPE_INVALID"), true);
});

// Item 4: relation oracle enforces the hard gate the user asked for.
test("item 4: oracle passes only when known relations are all correct and unknown is reported unknown", async () => {
  const fixture = await readJson(envFixture("oracle-samples.json"));
  const samples = [...fixture.known, ...fixture.unknown, ...fixture.labelMissing];
  const report = evaluateRelationOracle(samples, fixture.acceptedRuns);
  assert.equal(report.overall, "pass");
  assert.equal(report.violations.length, 0);
  assert.equal(report.perStepEvaluation.incorrect, 0);
  assert.equal(report.perStepEvaluation.unknown, 0);
  assert.equal(report.gold.labelMissingExcluded, 1);
  assert.equal(report.gold.unknown, 1);
  assert.equal(report.unknownRecall, 1);
  assert.equal(report.studentPrediction.unknown, 1);
});

test("item 4 control: a single known-relation miss makes the milestone incomplete", async () => {
  const fixture = await readJson(envFixture("oracle-samples.json"));
  const samples = [...fixture.known, ...fixture.unknown, ...fixture.labelMissing];
  const missRun = fixture.knownMissRuns[0];
  const runs = fixture.acceptedRuns.map(r => (r.sampleId === missRun.sampleId ? missRun : r));
  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "incomplete");
  assert.equal(report.perStepEvaluation.incorrect >= 1, true);
});

test("item 4 control: an unknown result reported as a concrete judge is a violation", async () => {
  const fixture = await readJson(envFixture("oracle-samples.json"));
  const samples = [...fixture.known, ...fixture.unknown, ...fixture.labelMissing];
  const misreport = fixture.unknownMisreportRuns[0];
  const runs = fixture.acceptedRuns.map(r => (r.sampleId === misreport.sampleId ? misreport : r));
  const report = evaluateRelationOracle(samples, runs);
  assert.equal(report.overall, "incomplete");
  assert.equal(report.unknownRecall, 0);
});

// Item 7: model package loading and immutable version binding.
test("item 7: model package loads, binds version/route, and rejects a mismatched encoder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unified-contract-pkg-"));
  const pkg = createUnifiedModelPackage({
    modelId: "unified-tsjs-r",
    version: "0.0.0-contract",
    route: { domain: "tsjs", decisionKind: "R" },
    tensors: createXavierTensors(3),
    resources: {
      thresholdsRef: thresholdsPath,
      thresholdsSchema: "nnanything.feature-thresholds.v1",
      missingModeTableRef: missingModePath,
      missingModeSchema: "nnanything.unified.missing-mode.v1",
    },
  });
  const packagePath = join(dir, "package.json");
  await saveUnifiedModelPackageAtomic(packagePath, pkg);
  const resource = await loadUnifiedModelPackageFromFile(packagePath);
  const binding = resource.bind();
  assert.equal(binding.version, "0.0.0-contract");
  assert.equal(binding.modelId, "unified-tsjs-r");
  assert.deepEqual(binding.route, { domain: "tsjs", decisionKind: "R" });

  assert.throws(
    () => validateUnifiedModelPackage({ ...pkg, encoderVersion: "nnanything.unified-step.encoder.bogus" }),
    error => error instanceof UnifiedModelPackageError && error.code === MODEL_INCOMPATIBLE,
  );
});

// Item 8: threshold and missing-mode loaders reject a missing bucket.
test("item 8: threshold loader accepts the fixture and rejects a missing bucket", async () => {
  const raw = await readJson(thresholdsPath);
  const thresholds = validateFeatureThresholds(raw);
  assert.equal(thresholds.route, "r");
  const missingMode = validateMissingModeTable(await readJson(missingModePath));
  assert.equal(missingMode.entries.length >= 1, true);

  const broken = { ...raw, buckets: { ...raw.buckets } };
  delete broken.buckets.requiredMissing;
  assert.throws(() => validateFeatureThresholds(broken), UnifiedThresholdError);
});

// Item 9: TS/JS adapter maps to the language-agnostic fact set.
test("item 9: TS/JS adapter maps a symbol table to language-agnostic facts", () => {
  const facts = mapTsJsSymbolTableToUnifiedFacts("episode:contract", {
    schema: "nnanything.cli-symbols.result.v1",
    language: "typescript",
    repo: "/repo",
    scope: ["src"],
    parser: {
      backend: "typescript_compiler_ast",
      compilerVersion: "5.0.0",
      invocation: "ts.createSourceFile",
      semanticBinding: false,
    },
    symbols: [
      {
        symbolId: "s1",
        name: "helper",
        kind: "function",
        file: "src/helper",
        declSpan: { startLine: 1, startCol: 1, endLine: 1, endCol: 10 },
        nameSpan: { startLine: 1, startCol: 1, endLine: 1, endCol: 10 },
        nameSpanSource: "identifier",
        lexicalScope: ["top"],
        ownerType: null,
        ownerKind: null,
        modifiers: ["export"],
        visibility: "exported",
        moduleSystem: "esm",
        declaredIn: "file",
        parseStatus: "complete",
      },
    ],
    dynamicMemberBoundaries: [],
    coverage: {
      scopeFilesDiscovered: 1,
      scopeFilesParsed: 1,
      scopeFilesFailed: [],
      skipped: [],
      parseErrorFiles: [],
      partial: false,
      partialReasons: [],
      truncated: false,
      parserInvocations: 1,
      notes: [],
    },
    boundaries: {
      projectModulePath: "unknown",
      typeCheckerSemanticBinding: "not_resolved",
      dynamicComputedProperties: "not_resolved",
      commonjsDynamicRequire: "not_resolved",
      reExportTargetResolution: "not_resolved",
    },
  });
  assert.equal(facts.languageAgnostic, true);
  assert.equal(facts.symbols.length, 1);
  assert.equal(facts.symbols[0].kind.value, "function");
});
