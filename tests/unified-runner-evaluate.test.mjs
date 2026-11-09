import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";

const here = new URL(".", import.meta.url);
const thresholdsFixture = resolve(
  here.pathname,
  "fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json",
);
const missingModeTableFixture = resolve(
  here.pathname,
  "fixtures/unified-64-slot/missing-mode-table.json",
);

const THRESHOLDS = {
  schema: "nnanything.feature-thresholds.v1",
  route: "r",
  encoderVersion: "nnanything.unified-step.encoder.v2",
  buckets: {
    constraints: [0, 1, 2, 4],
    knownFacts: [1, 2, 4, 8],
    missingFacts: [0, 1, 2, 4],
    objectRefs: [1, 2, 4, 8],
    requiredArgsRatio: [0, 0.25, 0.5, 1],
    requiredMissing: [0, 1, 2, 4],
  },
};

const MISSING_MODE = {
  schema: "nnanything.unified.missing-mode.v1",
  entries: [],
};

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path, rows) {
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function packageFor(route = { domain: "tsjs", decisionKind: "R" }, extraW1 = {}) {
  const tensors = zeroTensors();
  // x[36] is the judge=true feature slot in the unified R encoder. Prefer it
  // so a synthetic fixture produces a deterministic terminal judgement.
  tensors.W1[36] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  for (const [slot, value] of Object.entries(extraW1)) {
    tensors.W1[Number(slot)] = value;
  }
  return createUnifiedModelPackage({
    modelId: "unified-evaluate-synthetic",
    version: "1",
    route,
    tensors,
    resources: {
      thresholdsRef: "feature-thresholds.json",
      thresholdsSchema: THRESHOLDS.schema,
      missingModeTableRef: "missing-mode.json",
      missingModeSchema: MISSING_MODE.schema,
    },
    fixedStages: ["nnanything.unified-step.encoder.v2"],
  });
}

async function writePackage(root, pkg = packageFor()) {
  await writeJson(join(root, "feature-thresholds.json"), THRESHOLDS);
  await writeJson(join(root, "missing-mode.json"), MISSING_MODE);
  return saveUnifiedModelPackageAtomic(join(root, "package.json"), pkg);
}

function goldRow(sampleId, label) {
  return {
    sampleId,
    sourceGroup: "tsjs-evaluate-verification-fixture",
    partition: "verification",
    label,
    allowedEquivalentLabels: [label],
    labelAuthority: "researcher_structural_proof+typescript_compiler_api",
    labelMissing: false,
    unknownReason: null,
    oracleKind: "independent_tsc+typescript_compiler_api",
    goldAction: `c:judge:${label}`,
    candidateSet: [`c:judge:${label}`],
  };
}

function studentRecord(sampleId, {
  evidenceRefs = [`ev:${sampleId}:read`],
  steps,
  entryFile = "sources/src/helper.ts",
  declarationModuleRef = "mod:sources/src/helper.ts",
  declarationRef = "decl:sources/src/helper.ts#top:helper",
} = {}) {
  return {
    schemaVersion: "emma-tsjs-student-observation-v2",
    sampleId,
    family: "tsjs-evaluate-verification-fixture",
    partition: "verification",
    language: "ts",
    semanticStratum: "module_export",
    entryFile,
    request: {
      requestRef: `request:${sampleId}`,
      requestedDeclaration: {
        declarationRef,
        moduleRef: declarationModuleRef,
        name: "helper",
        kind: "function",
        sourceTargetRef: declarationRef,
      },
      relationObligation: {
        pendingRelationRef: `pending:${sampleId}`,
        callSiteRef: `call:${sampleId}`,
        calleeName: "helper",
      },
    },
    steps: steps ?? [
      advanceStep(sampleId, { evidenceRefs }),
      terminalStep("step:1", evidenceRefs, {
        previousExecution: previousExecutionLink(sampleId, {
          fromStepId: "step:0",
          targetRef: "sources/src/helper.ts",
          evidenceRefs,
        }),
      }),
    ],
  };
}

function terminalStep(stepId, evidenceRefs, { previousExecution } = {}) {
  return {
    stepId,
    observedAt: "current-step",
    localSyntax: {
      observedBindings: [],
      observedDeclarations: [],
      sourceContent: {
        state: "observed",
        resultRefs: [],
        reason: null,
        evidenceRefs,
      },
      shadowFacts: [],
    },
    remainingObligations: [],
    S_g: ["c:judge:true", "c:judge:false", "c:judge:unknown", "c:return"],
    receipts: [],
    coverage: null,
    notReady: false,
    ...(previousExecution === undefined ? {} : { previousExecution }),
  };
}

function importBinding(sampleId, {
  edgeRef = `edge:${sampleId}:helper`,
  sourceModule = "sources/src/helper.ts",
  targetModule = "sources/src/entry.ts",
  specifier = "./helper",
  evidenceRefs = [`ev:${sampleId}:read`],
} = {}) {
  return {
    edgeRef,
    callSiteRef: `call:${sampleId}`,
    fromNodeRef: `node:${sampleId}`,
    edgeKind: "import",
    sourceName: "helper",
    sourceModule: {
      state: "known",
      value: sourceModule,
      evidenceRefs,
    },
    targetName: "helper",
    targetModule: {
      state: "known",
      value: targetModule,
      evidenceRefs,
    },
    moduleSpecifierRaw: specifier,
    sourceContent: {
      state: "not_requested",
      resultRefs: [],
      reason: "not_requested",
      evidenceRefs,
    },
    visibility: {
      state: "known",
      value: "reachable",
      evidenceRefs,
    },
    hopDepth: 1,
    evidenceRefs,
  };
}

function advanceStep(sampleId, {
  stepId = "step:0",
  evidenceRefs = [`ev:${sampleId}:read`],
  binding = importBinding(sampleId, { evidenceRefs }),
  previousExecution,
} = {}) {
  return {
    stepId,
    observedAt: "current-step",
    localSyntax: {
      observedBindings: [binding],
      observedDeclarations: [],
      sourceContent: {
        state: "not_requested",
        resultRefs: [],
        reason: "not_requested",
        evidenceRefs,
      },
      shadowFacts: [],
    },
    remainingObligations: [{
      kind: "advance",
      ref: binding.edgeRef,
      pendingRelationRef: `pending:${sampleId}`,
      targetRef: binding.sourceModule.value,
      arguments: [{
        name: "target",
        type: "binding_edge",
        valueRef: binding.edgeRef,
      }],
      informationGain: { state: "known", value: "advances_chain", evidenceRefs: [`ev:${sampleId}:read`] },
      evidenceRefs,
    }],
    S_g: ["c:judge:true", "c:judge:false", "c:judge:unknown", "c:return"],
    receipts: [],
    coverage: null,
    notReady: false,
    ...(previousExecution === undefined ? {} : { previousExecution }),
  };
}

// Raw chain link the loader parses into `previousExecution`. The engine
// overwrites it with the real receipt; it only anchors which step follows.
function previousExecutionLink(sampleId, {
  fromStepId,
  targetRef,
  optionSemantics = "advance",
  evidenceRefs = [`ev:${sampleId}:read`],
} = {}) {
  return {
    state: "known",
    value: {
      actionRef: `action:${sampleId}:${fromStepId}`,
      receiptRef: null,
      origin: "source_observation",
      fromStepId,
      pendingRelationRef: `pending:${sampleId}`,
      optionSemantics,
      targetRef,
      outcome: "success",
    },
    evidenceRefs,
  };
}

async function makeFixture({
  samples = [],
  goldRows,
  studentRows,
  admissionsOverride,
  packageOverride,
  packageDir = false,
  extraW1,
  sourceFiles = true,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "unified-runner-evaluate-"));
  const familyDir = join(root, "verification-family");
  await mkdir(join(familyDir, "labels"), { recursive: true });
  await writeJson(join(familyDir, "manifest.json"), {
    schemaVersion: "neural-cli-source-family-v1",
    sourceGroup: "tsjs-evaluate-verification-fixture",
    language: "ts",
    semanticStratum: "module_export",
    partition: "verification",
    derivationFamily: {
      familyId: "tsjs-evaluate-fixture-v1",
      independentVerificationEligible: true,
    },
    sourceRefs: ["sources/src/entry.ts"],
    oracleRefs: [
      "evidence/manual-structural-proof.md",
      "evidence/tsc-receipt.txt",
      "evidence/oracle-receipt.json",
    ],
  });
  if (sourceFiles) {
    await mkdir(join(familyDir, "sources", "src"), { recursive: true });
    await writeFile(
      join(familyDir, "sources", "src", "helper.ts"),
      "export function helper() {\n  return 1;\n}\n",
      "utf8",
    );
    await writeFile(
      join(familyDir, "sources", "src", "entry.ts"),
      'import { helper } from "./helper";\nexport function caller() {\n  return helper();\n}\n',
      "utf8",
    );
  }
  await writeJsonl(
    join(familyDir, "labels", "gold.jsonl"),
    goldRows ?? samples.map(({ sampleId, label }) => goldRow(sampleId, label)),
  );
  await writeJsonl(
    join(familyDir, "student-observations.jsonl"),
    studentRows ?? samples.map(({ sampleId, evidenceRefs }) => studentRecord(sampleId, { evidenceRefs })),
  );

  const admissionsPath = join(root, "corpus-admissions-v1.json");
  await writeJson(admissionsPath, admissionsOverride ?? {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [
      {
        sourceGroup: "tsjs-evaluate-verification-fixture",
        partition: "verification",
        usableForTrainingSupervision: false,
        usableForIndependentVerification: true,
        evidence: "evidence/oracle-receipt.json",
      },
    ],
  });

  let packagePath;
  if (packageOverride !== undefined) {
    packagePath = packageOverride;
  } else if (packageDir) {
    const dir = join(root, "packages");
    await mkdir(dir, { recursive: true });
    packagePath = dir;
  } else {
    packagePath = await writePackage(root, packageFor(undefined, extraW1));
  }

  const outputDir = join(root, "out");
  const configPath = join(root, "runner-config.json");
  await writeJson(configPath, {
    schema: "nnanything.unified.runner-config.v1",
    command: "evaluate",
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "evaluation",
    encoderVersion: "nnanything.unified-step.encoder.v2",
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "VERIFICATION",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      thresholdsPath: thresholdsFixture,
      rowsPath: join(outputDir, "unused-rows.jsonl"),
    },
    outputDir,
    evaluate: {
      schema: "nnanything.unified.evaluate-config.v1",
      candidatePackagePath: packagePath,
      independentFamilyPath: familyDir,
      admissionsPath,
      consumerEntry: "tsjs-unified-recursive:runTsJsUnifiedMultiStepDecision",
      runId: "evaluate-fixture",
    },
  });

  return { root, familyDir, admissionsPath, packagePath, outputDir, configPath };
}

async function readReport(outputDir) {
  return JSON.parse(await readFile(join(outputDir, "run-report.json"), "utf8"));
}

test("evaluate route runs a synthetic admitted fixture and writes an evaluate report", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
    extraW1: { 53: 2 },
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      0,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.schema, "nnanything.unified.evaluate-report.v1");
    assert.equal(report.command, "evaluate");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate rejects a missing candidate package with a typed non-zero exit", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
    packageOverride: join(tmpdir(), "definitely-missing-evaluate-package.json"),
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      1,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.error.code, "CANDIDATE_MISSING");
    assert.equal(report.candidateOutput.emitted, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate rejects non-independent source partitions and TRAIN/DEV families", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "train-source", label: "true" }],
    admissionsOverride: {
      schemaVersion: "neural-cli-corpus-admissions-v1",
      familyAdmissions: [
        {
          sourceGroup: "tsjs-evaluate-verification-fixture",
          partition: "train",
          usableForTrainingSupervision: true,
          usableForIndependentVerification: false,
        },
      ],
    },
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      1,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.error.code, "ADMISSION_NOT_INDEPENDENT");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate rejects ambiguous independent admission", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
    admissionsOverride: {
      schemaVersion: "neural-cli-corpus-admissions-v1",
      familyAdmissions: [
        {
          sourceGroup: "tsjs-evaluate-verification-fixture",
          partition: "verification",
          usableForIndependentVerification: true,
        },
        {
          sourceGroup: "tsjs-evaluate-verification-fixture",
          partition: "verification",
          usableForIndependentVerification: true,
        },
      ],
    },
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      1,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.error.code, "ADMISSION_AMBIGUOUS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate counts gold and student denominators without synthesizing a package", async () => {
  const fixture = await makeFixture({
    samples: [
      { sampleId: "known-true", label: "true" },
      { sampleId: "known-false", label: "false" },
      { sampleId: "valid-unknown", label: "unknown" },
    ],
    extraW1: { 53: 2 },
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      0,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.gold.total, 3);
    assert.equal(report.studentPrediction.total, 3);
    assert.equal(report.candidateOutput.emitted, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate machine and human receipts expose the same fixed-engine evidence fields", async () => {
  const fixture = await makeFixture({
    samples: [
      { sampleId: "known-true", label: "true" },
      { sampleId: "known-false", label: "false" },
      { sampleId: "valid-unknown", label: "unknown" },
    ],
    extraW1: { 53: 2 },
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      0,
    );
    const report = await readReport(fixture.outputDir);
    const markdown = await readFile(join(fixture.outputDir, "run-report.md"), "utf8");
    assert.equal(report.consumerEntry, "tsjs-unified-recursive:runTsJsUnifiedMultiStepDecision");
    assert.equal(report.executionEntries.length, 6);
    assert.ok(report.executionEntries.every(entry =>
      entry.candidateRef !== undefined
      && entry.optionSemantics !== undefined
      && entry.score !== undefined
      && entry.executionReceiptRef !== undefined
      && entry.postStateRef !== undefined
      && entry.newStateRef !== undefined
      && entry.outcome !== undefined
      && entry.nextStepId !== undefined
      && entry.previousActionRef !== undefined
      && entry.failure !== undefined
    ));
    assert.ok(markdown.includes(`Unified Runner Evaluate Report (${report.runId})`));
    assert.ok(markdown.includes(`Consumer Entry: \`${report.consumerEntry}\``));
    assert.ok(markdown.includes(`Candidate Output Emitted: \`false\``));
    assert.ok(markdown.includes(`Gold: \`${report.gold.total}\``));
    assert.ok(markdown.includes(`Student Predictions: \`${report.studentPrediction.total}\``));
    assert.ok(markdown.includes(`Per-Step: \`${report.perStepEvaluation.correct}/${report.perStepEvaluation.unknown}/${report.perStepEvaluation.incorrect}\``));
    assert.ok(markdown.includes(`Root: \`${report.rootEvaluation.evaluated}/${report.rootEvaluation.satisfied}/${report.rootEvaluation.unsatisfied}/${report.rootEvaluation.unknown}\``));
    assert.ok(markdown.includes(`Unknown Recall: \`${report.unknownRecall.toFixed(4)}\``));
    assert.ok(markdown.includes(`Overall: \`${report.overall}\``));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate failure never emits a candidate package and has no fallback", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
    packageOverride: join(tmpdir(), "absent-evaluate-package.json"),
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      1,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.error.code, "CANDIDATE_MISSING");
    await assert.rejects(
      readFile(join(fixture.outputDir, "package.json"), "utf8"),
      error => error.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate drives one multi-step trajectory per sample instead of replaying episodes independently", async () => {
  const multiStep = studentRecord("known-true");
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
    studentRows: [multiStep],
    extraW1: { 53: 2 },
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      0,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.consumerEntry, "tsjs-unified-recursive:runTsJsUnifiedMultiStepDecision");
    assert.equal(report.sampleDetails.length, 1);
    assert.equal(report.sampleDetails[0].sampleId, "known-true");
    assert.equal(report.executionEntries.length, 2);
    assert.equal(report.executionEntries[0].optionSemantics, "advance");
    assert.equal(report.executionEntries[0].nextStepId, "step:1");
    assert.equal(report.executionEntries[0].failure, null);
    assert.equal(report.executionEntries[1].optionSemantics, "judge=true");
    assert.notEqual(report.executionEntries[1].previousActionRef, null);
    assert.equal(report.sampleDetails[0].root, "satisfied");
    assert.ok(report.sampleDetails[0].rootEvidenceRefs.length > 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate retains a failed sample's completed and failed steps with the original error", async () => {
  const readEvidence = ["ev:failed-second:read"];
  const readStep = advanceStep("failed-second", {
    stepId: "step:0",
    evidenceRefs: readEvidence,
  });
  const failedReadStep = advanceStep("failed-second", {
    stepId: "step:1",
    evidenceRefs: readEvidence,
    binding: importBinding("failed-second", {
      edgeRef: "edge:failed-second:absent-module",
      sourceModule: "sources/src/absent.ts",
      specifier: "./absent",
      evidenceRefs: readEvidence,
    }),
    previousExecution: previousExecutionLink("failed-second", {
      fromStepId: "step:0",
      targetRef: "sources/src/helper.ts",
      evidenceRefs: readEvidence,
    }),
  });
  const failedSample = studentRecord("failed-second", {
    steps: [readStep, failedReadStep],
  });
  const fixture = await makeFixture({
    samples: [{ sampleId: "failed-second", label: "false" }],
    studentRows: [failedSample],
    extraW1: { 53: 2 },
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      1,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.status, "failed");
    assert.equal(report.gold.total, 1);
    assert.equal(report.studentPrediction.total, 0);
    assert.equal(report.executionEntries.length, 2);
    assert.deepEqual(
      report.executionEntries.map(entry => [entry.stepId, entry.optionSemantics, entry.outcome]),
      [
        ["step:0", "advance", "success"],
        ["step:1", "advance", "failed"],
      ],
    );
    assert.equal(report.executionEntries[0].nextStepId, "step:1");
    assert.equal(report.executionEntries[1].failure.code, "MODULE_UNRESOLVED");
    assert.equal(report.executionEntries[1].failure.nativeCode, null);
    assert.equal(report.error.detail.affectedSampleId, "failed-second");
    assert.equal(report.error.detail.affectedStepId, "step:1");
    assert.equal(report.error.detail.executionFailure.code, "MODULE_UNRESOLVED");
    assert.equal(report.sampleDetails[0].steps.length, 2);
    assert.ok(report.sampleDetails[0].steps[1].evidenceRefs.includes("failure:MODULE_UNRESOLVED"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate rejects an evaluated root with no root evidence", async () => {
  const terminalOnly = studentRecord("known-true", {
    steps: [terminalStep("step:0", ["ev:known-true:read"])],
  });
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
    studentRows: [terminalOnly],
  });
  try {
    assert.equal(await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]), 1);
    const report = await readReport(fixture.outputDir);
    assert.equal(report.status, "failed");
    assert.equal(report.error.code, "ROOT_EVIDENCE_MISSING");
    assert.equal(report.error.detail.affectedSampleId, "known-true");
    assert.deepEqual(report.error.detail.rootEvidenceRefs, []);
    assert.equal(report.sampleDetails[0].root, "unsatisfied");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate keeps independent gold obligations when a student episode is missing", async () => {
  const fixture = await makeFixture({
    samples: [],
    goldRows: [
      goldRow("known-true", "true"),
      goldRow("orphan-gold", "false"),
    ],
    studentRows: [studentRecord("known-true")],
  });
  try {
    assert.equal(await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]), 1);
    const report = await readReport(fixture.outputDir);
    assert.equal(report.error.code, "GOLD_MISSING");
    assert.equal(report.gold.total, 2);
    assert.ok(report.missingRun.includes("orphan-gold"));
    assert.deepEqual(
      report.sampleDetails.map(sample => sample.sampleId),
      ["known-true", "orphan-gold"],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate rejects omitted, duplicate, and family-mismatched gold explicitly", async () => {
  const student = studentRecord("known-true");
  const omitted = await makeFixture({
    samples: [],
    goldRows: [],
    studentRows: [student],
  });
  try {
    assert.equal(await runStandardRunnerCli(["evaluate", "--config", omitted.configPath]), 1);
    const report = await readReport(omitted.outputDir);
    assert.equal(report.error.code, "GOLD_MISSING");
  } finally {
    await rm(omitted.root, { recursive: true, force: true });
  }

  const duplicate = await makeFixture({
    samples: [],
    goldRows: [goldRow("known-true", "true"), goldRow("known-true", "false")],
    studentRows: [student],
  });
  try {
    assert.equal(await runStandardRunnerCli(["evaluate", "--config", duplicate.configPath]), 1);
    const report = await readReport(duplicate.outputDir);
    assert.equal(report.error.code, "GOLD_INVALID");
  } finally {
    await rm(duplicate.root, { recursive: true, force: true });
  }

  const mismatched = await makeFixture({
    samples: [],
    goldRows: [{
      ...goldRow("known-true", "true"),
      sourceGroup: "another-family",
    }],
    studentRows: [student],
  });
  try {
    assert.equal(await runStandardRunnerCli(["evaluate", "--config", mismatched.configPath]), 1);
    const report = await readReport(mismatched.outputDir);
    assert.equal(report.error.code, "GOLD_INVALID");
  } finally {
    await rm(mismatched.root, { recursive: true, force: true });
  }
});

test("evaluate exposes per-sample gold/prediction/root and step evidence in both reports", async () => {
  const fixture = await makeFixture({
    samples: [
      { sampleId: "known-true", label: "true" },
      { sampleId: "known-false", label: "false" },
      { sampleId: "valid-unknown", label: "unknown" },
    ],
    extraW1: { 53: 2 },
  });
  try {
    assert.equal(await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]), 0);
    const report = await readReport(fixture.outputDir);
    const markdown = await readFile(join(fixture.outputDir, "run-report.md"), "utf8");
    assert.equal(report.sampleDetails.length, 3);
    for (const sample of report.sampleDetails) {
      assert.ok(sample.sampleId);
      assert.ok(sample.gold);
      assert.ok(sample.predicted);
      assert.ok(sample.steps.length >= 1);
      assert.ok(sample.steps.every(step => Array.isArray(step.evidenceRefs)));
    }
    assert.ok(markdown.includes("## Sample Details"));
    assert.ok(markdown.includes("known-true: gold=true"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
