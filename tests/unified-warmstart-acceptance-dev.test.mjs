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

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(path, rows) {
  return writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function packageFor(extraW1 = {}) {
  const tensors = zeroTensors();
  tensors.W1[36] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  for (const [slot, value] of Object.entries(extraW1)) {
    tensors.W1[Number(slot)] = value;
  }
  return createUnifiedModelPackage({
    modelId: "unified-evaluate-synthetic",
    version: "1",
    route: { domain: "tsjs", decisionKind: "R" },
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

async function writePackage(root) {
  await writeJson(join(root, "feature-thresholds.json"), THRESHOLDS);
  await writeJson(join(root, "missing-mode.json"), MISSING_MODE);
  return saveUnifiedModelPackageAtomic(join(root, "package.json"), packageFor({ 53: 2 }));
}

function vector(pattern, salt = 0) {
  return Array.from({ length: 64 }, (_, index) => (index % pattern) + salt);
}

function trainStudentRow(groupId, candidateRef, x) {
  return {
    schema: "nnanything.unified.student-row.v1",
    group_id: groupId,
    sampleId: "sample-1",
    requestRef: "request-1",
    stepId: "step-1",
    targetRef: "target-1",
    pendingRelationRef: null,
    sourceGroup: "tests",
    language: "ts",
    adapterRef: "test-adapter",
    derivationFamily: "test-family",
    semanticStratum: "module_export",
    stepContextRef: `ctx:${groupId}`,
    candidateGroupRef: `candidate-group:${groupId}`,
    featureSchemaVersion: "v1",
    encoderVersion: "nnanything.unified-step.encoder.v2",
    partition: "TRAIN",
    candidateEnumeration: "complete",
    coverageCursorRef: "cursor:complete",
    evidenceRefs: [],
    failureMode: null,
    candidateRef,
    optionSemantics: candidateRef,
    candidateKind: "action",
    x,
    missingMode: [],
  };
}

function trainSupervisionRow(groupId) {
  return {
    schema: "nnanything.unified.supervision-row.v1",
    group_id: groupId,
    sampleId: "sample-1",
    sourceGroup: "tests",
    partition: "TRAIN",
    goldAllowedCandidateRefs: ["c:judge:true"],
    labelMissing: false,
    unknownReason: null,
    labelAuthority: "researcher_structural_proof",
    oracleKind: "independent_tsc",
    teacherResolutionRef: "teacher:sample-1",
    trainingEligible: true,
  };
}

function trainGateRow(groupId, candidateInputs) {
  return {
    schema: "nnanything.unified.data-row.v1",
    rowId: groupId,
    sourceGroup: "tests",
    partition: "TRAIN",
    route: { domain: "tsjs", decisionKind: "R" },
    input: candidateInputs[0].input,
    candidateInputs,
    missingMode: [],
    candidates: candidateInputs.map(candidate => candidate.candidateRef),
    allowed: ["c:judge:true"],
    gold: "c:judge:true",
    labelMissing: false,
    enumeration: "complete",
  };
}

async function makeTrainFixture(root) {
  const studentRowsPath = join(root, "student-rows", "student-rows.jsonl");
  const supervisionRowsPath = join(root, "labels", "supervision.jsonl");
  const gateRowsPath = join(root, "data-rows.jsonl");
  await mkdir(join(root, "student-rows"), { recursive: true });
  await mkdir(join(root, "labels"), { recursive: true });

  const xA0 = vector(5, 0);
  const xA1 = vector(7, 1);
  const xB0 = vector(11, 0);
  const xB1 = vector(13, 1);
  await writeJsonl(studentRowsPath, [
    trainStudentRow("group-a", "c:judge:true", xA0),
    trainStudentRow("group-a", "c:judge:false", xA1),
    trainStudentRow("group-b", "c:judge:true", xB0),
    trainStudentRow("group-b", "c:judge:false", xB1),
  ]);
  await writeJsonl(supervisionRowsPath, [
    trainSupervisionRow("group-a"),
    trainSupervisionRow("group-b"),
  ]);
  await writeJsonl(gateRowsPath, [
    trainGateRow("group-a", [
      { candidateRef: "c:judge:true", input: xA0 },
      { candidateRef: "c:judge:false", input: xA1 },
    ]),
    trainGateRow("group-b", [
      { candidateRef: "c:judge:true", input: xB0 },
      { candidateRef: "c:judge:false", input: xB1 },
    ]),
  ]);
  await writeJson(join(root, "corpus-admissions-v1.json"), {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [{
      sourceGroup: "tests",
      partition: "train",
      usableForTrainingSupervision: true,
    }],
  });
  return { studentRowsPath, supervisionRowsPath, gateRowsPath };
}

async function makeTrainConfig(root) {
  const { studentRowsPath, supervisionRowsPath, gateRowsPath } = await makeTrainFixture(root);
  const outputDir = join(root, "out");
  const packagePath = join(outputDir, "package.json");
  await mkdir(outputDir, { recursive: true });
  const config = {
    schema: "nnanything.unified.runner-config.v1",
    command: "train",
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "pretraining",
    encoderVersion: "nnanything.unified-step.encoder.v2",
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "TRAIN",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      thresholdsPath: thresholdsFixture,
      rowsPath: gateRowsPath,
    },
    outputDir,
    corpus: {
      root,
      admissionsPath: join(root, "corpus-admissions-v1.json"),
      studentRowsPath,
      supervisionRowsPath,
      packagePath,
      missingModeTablePath: missingModeTableFixture,
    },
    training: {
      modelId: "tests.unified-warmstart",
      version: "0.0.1-test",
      optimizer: "full_batch_sgd",
      learningRate: 0.1,
      maxEpochs: 24,
      seed: 20261104,
      init: "xavier_uniform",
    },
  };
  const configPath = join(root, "runner-config.json");
  await writeJson(configPath, config);
  return {
    configPath,
    outputDir,
    packagePath,
    gateRowsPath,
    admissionsPath: join(root, "corpus-admissions-v1.json"),
  };
}

async function prepareWarmAcceptanceFixture() {
  const sourceRoot = await mkdtemp(join(tmpdir(), "unified-wa-dev-source-"));
  const warmRoot = await mkdtemp(join(tmpdir(), "unified-wa-dev-target-"));
  const source = await makeTrainConfig(sourceRoot);
  assert.equal(await runStandardRunnerCli(["train", "--config", source.configPath]), 0);

  const base = await readJson(source.configPath);
  const warmOutputDir = join(warmRoot, "warm-out");
  const targetPackagePath = join(warmOutputDir, "package.json");
  const targetCheckpointPath = join(warmOutputDir, "checkpoint.json");
  await mkdir(warmOutputDir, { recursive: true });
  const warmConfig = {
    ...base,
    command: "warmstart",
    phase: "posttraining",
    outputDir: warmOutputDir,
    corpus: {
      ...base.corpus,
      packagePath: targetPackagePath,
    },
    training: {
      ...base.training,
      maxEpochs: 24,
      epochsThisRun: 24,
      checkpointPath: targetCheckpointPath,
    },
    warmStart: { sourcePackagePath: source.packagePath },
  };
  const warmConfigPath = join(warmRoot, "warm-config.json");
  await writeJson(warmConfigPath, warmConfig);
  assert.equal(await runStandardRunnerCli(["warmstart", "--config", warmConfigPath]), 0);

  const acceptanceOutputDir = join(warmRoot, "acceptance-out");
  const acceptanceConfig = {
    schema: "nnanything.unified.runner-config.v1",
    command: "warmstart-acceptance",
    route: base.route,
    phase: "evaluation",
    encoderVersion: base.encoderVersion,
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "TRAIN",
      encoderVersion: base.encoderVersion,
      thresholdsPath: thresholdsFixture,
      rowsPath: join(acceptanceOutputDir, "unused-rows.jsonl"),
    },
    outputDir: acceptanceOutputDir,
    warmstartAcceptance: {
      schema: "nnanything.unified.warmstart-acceptance-config.v1",
      rowsReportPath: join(warmOutputDir, "run-report.json"),
      sourcePackagePath: source.packagePath,
      candidatePackagePath: targetPackagePath,
      candidateCheckpointPath: targetCheckpointPath,
      rawWarmStartReportPath: join(warmOutputDir, "run-report.json"),
      tau: 0.1,
    },
  };
  const acceptanceConfigPath = join(warmRoot, "acceptance-config.json");
  await writeJson(acceptanceConfigPath, acceptanceConfig);
  return {
    roots: [sourceRoot, warmRoot],
    sourcePackagePath: source.packagePath,
    candidatePackagePath: targetPackagePath,
    candidateCheckpointPath: targetCheckpointPath,
    rawReportPath: join(warmOutputDir, "run-report.json"),
    warmConfigPath,
    acceptanceConfigPath,
    acceptanceConfig,
    acceptanceOutputDir,
  };
}

function devGoldRow(sampleId, label) {
  return {
    sampleId,
    sourceGroup: "tsjs-evaluate-dev-fixture",
    partition: "dev",
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

function previousExecutionLink(sampleId, {
  fromStepId,
  targetRef,
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
      optionSemantics: "advance",
      targetRef,
      outcome: "success",
    },
    evidenceRefs,
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

function importBinding(sampleId, { evidenceRefs = [`ev:${sampleId}:read`] } = {}) {
  return {
    edgeRef: `edge:${sampleId}:helper`,
    callSiteRef: `call:${sampleId}`,
    fromNodeRef: `node:${sampleId}`,
    edgeKind: "import",
    sourceName: "helper",
    sourceModule: {
      state: "known",
      value: "sources/src/helper.ts",
      evidenceRefs,
    },
    targetName: "helper",
    targetModule: {
      state: "known",
      value: "sources/src/entry.ts",
      evidenceRefs,
    },
    moduleSpecifierRaw: "./helper",
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

function advanceStep(sampleId, { evidenceRefs = [`ev:${sampleId}:read`] } = {}) {
  const binding = importBinding(sampleId, { evidenceRefs });
  return {
    stepId: "step:0",
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
      informationGain: { state: "known", value: "advances_chain", evidenceRefs },
      evidenceRefs,
    }],
    S_g: ["c:judge:true", "c:judge:false", "c:judge:unknown", "c:return"],
    receipts: [],
    coverage: null,
    notReady: false,
  };
}

function devStudentRecord(sampleId, { evidenceRefs = [`ev:${sampleId}:read`] } = {}) {
  return {
    schemaVersion: "emma-tsjs-student-observation-v2",
    sampleId,
    family: "tsjs-evaluate-dev-fixture",
    partition: "dev",
    language: "ts",
    semanticStratum: "module_export",
    entryFile: "sources/src/helper.ts",
    request: {
      requestRef: `request:${sampleId}`,
      requestedDeclaration: {
        declarationRef: "decl:sources/src/helper.ts#top:helper",
        moduleRef: "mod:sources/src/helper.ts",
        name: "helper",
        kind: "function",
        sourceTargetRef: "decl:sources/src/helper.ts#top:helper",
      },
      relationObligation: {
        pendingRelationRef: `pending:${sampleId}`,
        callSiteRef: `call:${sampleId}`,
        calleeName: "helper",
      },
    },
    steps: [
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

async function makeDevFixture({
  admissionsOverride,
  manifestOverride,
  command = "evaluate-dev",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "unified-dev-evaluate-"));
  const familyDir = join(root, "dev-family");
  await mkdir(join(familyDir, "labels"), { recursive: true });
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
  await writeJson(join(familyDir, "manifest.json"), manifestOverride ?? {
    schemaVersion: "neural-cli-source-family-v1",
    sourceGroup: "tsjs-evaluate-dev-fixture",
    language: "ts",
    semanticStratum: "module_export",
    partition: "dev",
    derivationFamily: {
      familyId: "tsjs-evaluate-dev-fixture-v1",
      independentVerificationEligible: false,
    },
    sourceRefs: ["sources/src/entry.ts"],
    oracleRefs: [
      "evidence/manual-structural-proof.md",
      "evidence/tsc-receipt.txt",
      "evidence/oracle-receipt.json",
    ],
  });
  await writeJsonl(join(familyDir, "labels", "gold.jsonl"), [
    devGoldRow("dev-known-true", "true"),
  ]);
  await writeJsonl(join(familyDir, "student-observations.jsonl"), [
    devStudentRecord("dev-known-true"),
  ]);

  const admissionsPath = join(root, "corpus-admissions-v1.json");
  await writeJson(admissionsPath, admissionsOverride ?? {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [
      {
        sourceGroup: "tsjs-evaluate-dev-fixture",
        partition: "dev",
        usableForTrainingSupervision: false,
        usableForIndependentVerification: false,
        evidence: "evidence/oracle-receipt.json",
      },
    ],
  });

  const packagePath = await writePackage(root);
  const outputDir = join(root, "out");
  const config = {
    schema: "nnanything.unified.runner-config.v1",
    command,
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "evaluation",
    encoderVersion: "nnanything.unified-step.encoder.v2",
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "DEV",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      thresholdsPath: thresholdsFixture,
      rowsPath: join(outputDir, "unused-rows.jsonl"),
    },
    outputDir,
    ...(command === "evaluate-dev"
      ? {
          evaluateDev: {
            schema: "nnanything.unified.dev-evaluate-config.v1",
            candidatePackagePath: packagePath,
            devFamilyPath: familyDir,
            admissionsPath,
            consumerEntry: "tsjs-unified-recursive:runTsJsUnifiedMultiStepDecision",
            runId: "evaluate-dev-fixture",
          },
        }
      : {
          evaluate: {
            schema: "nnanything.unified.evaluate-config.v1",
            candidatePackagePath: packagePath,
            independentFamilyPath: familyDir,
            admissionsPath,
            consumerEntry: "tsjs-unified-recursive:runTsJsUnifiedMultiStepDecision",
            runId: "evaluate-dev-rejected",
          },
        }),
  };
  const configPath = join(root, "runner-config.json");
  await writeJson(configPath, config);
  return { root, familyDir, admissionsPath, packagePath, outputDir, configPath };
}

test("warmstart-acceptance accepts real lineage and rejects controlled corruptions", async () => {
  const fixture = await prepareWarmAcceptanceFixture();
  try {
    const acceptanceExitCode = await runStandardRunnerCli([
      "warmstart-acceptance",
      "--config",
      fixture.acceptanceConfigPath,
    ]);
    assert.equal(acceptanceExitCode, 0);
    const report = await readJson(join(fixture.acceptanceOutputDir, "run-report.json"));
    assert.equal(report.schema, "nnanything.unified.warmstart-acceptance-report.v1");
    assert.equal(report.command, "warmstart-acceptance");
    assert.equal(report.status, "accepted");
    assert.equal(report.tau, 0.1);
    assert.equal(report.lineage.sourcePackagePathMatch, true);
    assert.equal(report.lineage.sourceModelIdMatch, true);
    assert.equal(report.lineage.sourceVersionMatch, true);
    assert.equal(report.lineage.sourceRouteMatch, true);
    assert.equal(report.lineage.sourceEncoderVersionMatch, true);
    assert.equal(report.lineage.rawWarmStartCopyMatch, true);
    assert.deepEqual(report.lineage.epochZero, {
      exact: true,
      tensorEquality: true,
      checkedInputs: 4,
      maxAbsDelta: 0,
    });
    assert.equal(report.execution.checkpointReloadMatches, true);
    assert.equal(report.execution.packageReloadMatches, true);
    assert.equal(report.execution.timingReceiptComplete, true);
    assert.equal(report.execution.failureReceiptPresent, true);
    assert.equal(report.groups.length, 2);
    assert.equal(report.aggregation.rowCount, 2);
    assert.ok(report.aggregation.buckets.length > 0);
    assert.ok(report.groups.every(group => group.candidate.correct && group.marginOk));

    const invalidTauConfig = {
      ...fixture.acceptanceConfig,
      warmstartAcceptance: {
        ...fixture.acceptanceConfig.warmstartAcceptance,
        tau: 0.2,
      },
    };
    const invalidTauPath = join(fixture.roots[1], "invalid-tau-config.json");
    await writeJson(invalidTauPath, invalidTauConfig);
    assert.equal(
      await runStandardRunnerCli(["warmstart-acceptance", "--config", invalidTauPath]),
      1,
    );
    const invalidTauReport = await readJson(join(fixture.acceptanceOutputDir, "run-report.json"));
    assert.equal(invalidTauReport.error.code, "CONFIG_INVALID");
    assert.match(invalidTauReport.error.message, /fixed 0\.1 margin/);

    const mismatchedSource = JSON.parse(JSON.stringify(
      await readJson(fixture.sourcePackagePath),
    ));
    mismatchedSource.modelId = "not-the-warmstart-source";
    const mismatchedSourcePath = join(fixture.roots[1], "mismatched-source.json");
    await writeJson(mismatchedSourcePath, mismatchedSource);
    const mismatchedConfig = {
      ...fixture.acceptanceConfig,
      warmstartAcceptance: {
        ...fixture.acceptanceConfig.warmstartAcceptance,
        sourcePackagePath: mismatchedSourcePath,
      },
    };
    const mismatchedConfigPath = join(fixture.roots[1], "mismatched-config.json");
    await writeJson(mismatchedConfigPath, mismatchedConfig);
    assert.equal(
      await runStandardRunnerCli(["warmstart-acceptance", "--config", mismatchedConfigPath]),
      1,
    );
    const mismatchedReport = await readJson(join(fixture.acceptanceOutputDir, "run-report.json"));
    assert.equal(mismatchedReport.error.code, "WARMSTART_LINEAGE_INVALID");

    const fabricatedRaw = JSON.parse(JSON.stringify(await readJson(fixture.rawReportPath)));
    fabricatedRaw.resumedFromEpoch = 24;
    delete fabricatedRaw.warmStart;
    const fabricatedRawPath = join(fixture.roots[1], "fabricated-raw.json");
    await writeJson(fabricatedRawPath, fabricatedRaw);
    const fabricatedConfig = {
      ...fixture.acceptanceConfig,
      warmstartAcceptance: {
        ...fixture.acceptanceConfig.warmstartAcceptance,
        rawWarmStartReportPath: fabricatedRawPath,
      },
    };
    const fabricatedConfigPath = join(fixture.roots[1], "fabricated-config.json");
    await writeJson(fabricatedConfigPath, fabricatedConfig);
    assert.equal(
      await runStandardRunnerCli(["warmstart-acceptance", "--config", fabricatedConfigPath]),
      1,
    );
    const fabricatedReport = await readJson(join(fixture.acceptanceOutputDir, "run-report.json"));
    assert.equal(fabricatedReport.error.code, "WARMSTART_RAW_REPORT_INVALID");

    const missingEpochCheckpoint = JSON.parse(JSON.stringify(
      await readJson(fixture.candidateCheckpointPath),
    ));
    delete missingEpochCheckpoint.warmStart.epochZero;
    const missingEpochPath = join(fixture.roots[1], "missing-epoch-zero-checkpoint.json");
    await writeJson(missingEpochPath, missingEpochCheckpoint);
    const missingEpochConfig = {
      ...fixture.acceptanceConfig,
      warmstartAcceptance: {
        ...fixture.acceptanceConfig.warmstartAcceptance,
        candidateCheckpointPath: missingEpochPath,
      },
    };
    const missingEpochConfigPath = join(fixture.roots[1], "missing-epoch-config.json");
    await writeJson(missingEpochConfigPath, missingEpochConfig);
    assert.equal(
      await runStandardRunnerCli(["warmstart-acceptance", "--config", missingEpochConfigPath]),
      1,
    );
    const missingEpochReport = await readJson(join(fixture.acceptanceOutputDir, "run-report.json"));
    assert.equal(missingEpochReport.status, "rejected");
    assert.match(missingEpochReport.error.message, /epochZero/);

    const missingReloadRaw = JSON.parse(JSON.stringify(await readJson(fixture.rawReportPath)));
    delete missingReloadRaw.checkpointReload;
    const missingReloadRawPath = join(fixture.roots[1], "missing-reload-raw.json");
    await writeJson(missingReloadRawPath, missingReloadRaw);
    const missingReloadConfig = {
      ...fixture.acceptanceConfig,
      warmstartAcceptance: {
        ...fixture.acceptanceConfig.warmstartAcceptance,
        rawWarmStartReportPath: missingReloadRawPath,
      },
    };
    const missingReloadConfigPath = join(fixture.roots[1], "missing-reload-config.json");
    await writeJson(missingReloadConfigPath, missingReloadConfig);
    assert.equal(
      await runStandardRunnerCli(["warmstart-acceptance", "--config", missingReloadConfigPath]),
      1,
    );
    const missingReloadReport = await readJson(join(fixture.acceptanceOutputDir, "run-report.json"));
    assert.equal(missingReloadReport.error.code, "WARMSTART_RAW_REPORT_INVALID");

    const missingTimingRaw = JSON.parse(JSON.stringify(await readJson(fixture.rawReportPath)));
    delete missingTimingRaw.thisRun.totalWallSeconds;
    const missingTimingRawPath = join(fixture.roots[1], "missing-timing-raw.json");
    await writeJson(missingTimingRawPath, missingTimingRaw);
    const missingTimingConfig = {
      ...fixture.acceptanceConfig,
      warmstartAcceptance: {
        ...fixture.acceptanceConfig.warmstartAcceptance,
        rawWarmStartReportPath: missingTimingRawPath,
      },
    };
    const missingTimingConfigPath = join(fixture.roots[1], "missing-timing-config.json");
    await writeJson(missingTimingConfigPath, missingTimingConfig);
    assert.equal(
      await runStandardRunnerCli(["warmstart-acceptance", "--config", missingTimingConfigPath]),
      1,
    );
    const missingTimingReport = await readJson(join(fixture.acceptanceOutputDir, "run-report.json"));
    assert.equal(missingTimingReport.error.code, "WARMSTART_TIMING_INVALID");
  } finally {
    for (const root of fixture.roots) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("evaluate-dev admits a DEV fixture and generic evaluate still rejects it", async () => {
  const devFixture = await makeDevFixture({ command: "evaluate-dev" });
  try {
    assert.equal(
      await runStandardRunnerCli([
        "evaluate-dev",
        "--config",
        devFixture.configPath,
      ]),
      0,
    );
    const report = await readJson(join(devFixture.outputDir, "run-report.json"));
    assert.equal(report.schema, "nnanything.unified.evaluate-report.v1");
    assert.equal(report.command, "evaluate-dev");
    assert.equal(report.provenance.evaluationKind, "development");
    assert.equal(report.provenance.partition, "dev");
    assert.equal(report.provenance.sourceGroup, "tsjs-evaluate-dev-fixture");
    assert.equal(report.provenance.trainingUsable, false);
    assert.equal(report.provenance.independentVerificationEligible, false);
    assert.equal(report.admission.partition, "dev");
    assert.equal(report.admission.usableForTrainingSupervision, false);
    assert.equal(report.admission.usableForIndependentVerification, false);
    assert.equal(report.gold.total, 1);
    assert.equal(report.studentPrediction.total, 1);
    assert.equal(report.executionEntries.length, 2);
    assert.equal(report.aggregation.rowCount, 1);
    assert.equal(report.aggregation.buckets[0].sourceFamily, "tsjs-evaluate-dev-fixture");
    assert.equal(report.aggregation.buckets[0].goldLabel, "true");
    assert.equal(Array.isArray(report.violations), true);
    assert.equal(Array.isArray(report.unassessed), true);
    assert.equal(Array.isArray(report.missingRun), true);
    assert.equal(typeof report.unknownRecall, "number");
  } finally {
    await rm(devFixture.root, { recursive: true, force: true });
  }

  const verificationFixture = await makeDevFixture({ command: "evaluate-dev" });
  try {
    const manifest = await readJson(join(verificationFixture.familyDir, "manifest.json"));
    manifest.partition = "verification";
    manifest.derivationFamily.independentVerificationEligible = true;
    await writeJson(join(verificationFixture.familyDir, "manifest.json"), manifest);
    const admissions = await readJson(verificationFixture.admissionsPath);
    admissions.familyAdmissions[0].partition = "verification";
    admissions.familyAdmissions[0].usableForIndependentVerification = true;
    await writeJson(verificationFixture.admissionsPath, admissions);
    assert.equal(
      await runStandardRunnerCli([
        "evaluate-dev",
        "--config",
        verificationFixture.configPath,
      ]),
      1,
    );
    const report = await readJson(join(verificationFixture.outputDir, "run-report.json"));
    assert.equal(report.error.code, "ADMISSION_NOT_DEV");
  } finally {
    await rm(verificationFixture.root, { recursive: true, force: true });
  }

  const rejectedByEvaluate = await makeDevFixture({ command: "evaluate" });
  try {
    assert.equal(
      await runStandardRunnerCli([
        "evaluate",
        "--config",
        rejectedByEvaluate.configPath,
      ]),
      1,
    );
    const report = await readJson(join(rejectedByEvaluate.outputDir, "run-report.json"));
    assert.equal(report.command, "evaluate");
    assert.equal(report.error.code, "ADMISSION_NOT_INDEPENDENT");
  } finally {
    await rm(rejectedByEvaluate.root, { recursive: true, force: true });
  }
});
