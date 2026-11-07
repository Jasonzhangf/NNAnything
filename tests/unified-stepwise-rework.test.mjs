import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";
import {
  convertEpisodeToStudentGroup,
  loadStepwiseEpisodeFamily,
  StepwiseStudentDataError,
} from "../dist/training/unified-student-converter.js";
import {
  loadStepwiseSupervisionFamily,
} from "../dist/training/unified-supervision-converter.js";

const here = new URL(".", import.meta.url);
const thresholdsPath = resolve(
  here.pathname,
  "fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v1.json",
);
const missingModeTablePath = resolve(
  here.pathname,
  "fixtures/unified-64-slot/missing-mode-table.json",
);

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path, rows) {
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function declaration(overrides = {}) {
  return {
    declarationRef: "decl:sources/src/impl.ts#top:helper",
    moduleRef: "mod:sources/src/impl.ts",
    name: "helper",
    role: "export",
    kind: "function",
    sourceLocation: { file: "sources/src/impl.ts", line: 1, column: 1 },
    ...overrides,
  };
}

function binding(edgeRef, sourceModule, targetName, overrides = {}) {
  return {
    edgeRef,
    callSiteRef: null,
    fromNodeRef: `syntax:${edgeRef}`,
    edgeKind: "import",
    sourceName: "forwarded",
    sourceModule: {
      state: "known",
      value: sourceModule,
      reason: null,
      evidenceRefs: [`ev:${edgeRef}:source`],
    },
    targetName,
    targetModule: {
      state: "known",
      value: "mod:sources/src/entry.ts",
      reason: null,
      evidenceRefs: [`ev:${edgeRef}:target`],
    },
    moduleSpecifierRaw: "./util",
    sourceContent: {
      state: "not_requested",
      resultRefs: [],
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

function studentRecord(overrides = {}) {
  const firstEdge = binding(
    "edge:sources/src/entry.ts:import:0",
    "mod:sources/src/util.ts",
    "helper",
  );
  return {
    schemaVersion: "emma-tsjs-student-observation-v2",
    sampleId: "stepwise-rework-sample",
    family: "train-stepwise-rework",
    partition: "train",
    language: "ts",
    entryFile: "sources/src/explicit-entry.ts",
    request: {
      requestRef: "request:stepwise-rework-sample",
      requestedDeclaration: {
        declarationRef: "decl:sources/src/impl.ts#top:helper",
        moduleRef: "mod:sources/src/impl.ts",
        name: "helper",
        kind: "function",
        sourceTargetRef: "sources/src/impl.ts#top:helper",
      },
      relationObligation: {
        callSiteRef: "call:sources/src/call-site-entry.ts:helper",
        calleeName: "helper",
        pendingRelationRef: "pending:stepwise-rework-sample",
        requestRef: "request:stepwise-rework-sample",
      },
    },
    steps: [
      {
        stepId: "step-0",
        observedAt: "current-step",
        localSyntax: {
          observedBindings: [firstEdge],
          observedDeclarations: [],
          moduleSpecifierRaw: "./util",
          sourceContent: {
            state: "not_requested",
            resultRefs: [],
            reason: null,
            evidenceRefs: ["ev:sources/src/entry.ts:import:0:source"],
          },
          shadowFacts: [],
        },
        remainingObligations: [{
          kind: "advance",
          ref: firstEdge.edgeRef,
          pendingRelationRef: "pending:stepwise-rework-sample",
          informationGain: 1,
        }],
        S_g: [
          "c:judge:true",
          "c:judge:false",
          "c:judge:unknown",
          `c:advance:${firstEdge.edgeRef}`,
          "c:defer",
        ],
        receipts: [{
          receiptId: "receipt:stepwise-rework-sample:step0",
          action: "observe",
          target: "sources/src/entry.ts",
          result: { bindingEdge: firstEdge.edgeRef },
          evidenceRefs: ["ev:sources/src/entry.ts:import:0:source"],
        }],
        coverage: null,
        notReady: false,
      },
    ],
    ...overrides,
  };
}

function supervisionRecord(overrides = {}) {
  return {
    schemaVersion: "emma-tsjs-independent-action-supervision-v1",
    sampleId: "stepwise-rework-sample",
    family: "train-stepwise-rework",
    requestRef: "request:stepwise-rework-sample",
    steps: [{
      stepId: "step-0",
      S_g: [
        "c:judge:true",
        "c:judge:false",
        "c:judge:unknown",
        "c:advance:edge:sources/src/entry.ts:import:0",
        "c:defer",
      ],
      A_g: ["c:advance:edge:sources/src/entry.ts:import:0"],
      agSubsetOfSg: true,
      labelAuthority: "researcher_structural_proof",
      oracleKind: "independent_tsc",
      unknownReason: null,
    }],
    trainingEligible: true,
    notReadyReason: null,
    terminalDeclarationRef: "decl:sources/src/impl.ts#top:helper",
    conflicts: [],
    ...overrides,
  };
}

async function makeFamily({ student = studentRecord(), supervision = supervisionRecord() } = {}) {
  const root = await mkdtemp(join(tmpdir(), "unified-stepwise-rework-"));
  const familyDir = join(root, "train-stepwise-rework");
  await mkdir(familyDir, { recursive: true });
  await writeJson(join(familyDir, "manifest.json"), {
    schemaVersion: "neural-cli-source-family-v1",
    sourceGroup: "tsjs-stepwise-rework",
    language: "ts",
    semanticStratum: "module_export",
    partition: "train",
    derivationFamily: { familyId: "stepwise-rework-v1" },
  });
  await writeJsonl(join(familyDir, "student-observations.jsonl"), [student]);
  await writeJsonl(join(familyDir, "independent-supervision.jsonl"), [supervision]);
  await writeJson(join(root, "corpus-admissions-v1.json"), {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [{
      sourceGroup: "tsjs-stepwise-rework",
      partition: "train",
      usableForTrainingSupervision: true,
    }],
  });
  return { root, familyDir };
}

async function makeConfig(root, extraTraining = {}) {
  const outputDir = join(root, "out");
  const items = {
    outputDir,
    configPath: join(root, "runner-config.json"),
    studentRowsPath: join(outputDir, "student-rows", "student-rows.jsonl"),
    supervisionRowsPath: join(outputDir, "labels", "supervision.jsonl"),
    gateRowsPath: join(outputDir, "data-rows.jsonl"),
    packagePath: join(outputDir, "package.json"),
  };
  await writeJson(items.configPath, {
    schema: "nnanything.unified.runner-config.v1",
    command: "convert-samples",
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "sample_migration",
    encoderVersion: "nnanything.unified-step.encoder.v1",
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "TRAIN",
      encoderVersion: "nnanything.unified-step.encoder.v1",
      thresholdsPath,
      rowsPath: items.gateRowsPath,
    },
    outputDir,
    corpus: {
      root,
      admissionsPath: join(root, "corpus-admissions-v1.json"),
      studentRowsPath: items.studentRowsPath,
      supervisionRowsPath: items.supervisionRowsPath,
      packagePath: items.packagePath,
      missingModeTablePath,
    },
    ...extraTraining,
  });
  return items;
}

test("mutating S_g does not change generated candidates and reports a mismatch", async () => {
  const { root, familyDir } = await makeFamily();
  try {
    const studentPath = join(familyDir, "student-observations.jsonl");
    const beforeStudent = await readJsonl(studentPath);
    const observationsBefore = JSON.stringify(beforeStudent[0].steps[0].localSyntax);
    const beforeCandidates = convertEpisodeToStudentGroup(
      (await loadStepwiseEpisodeFamily(familyDir))[0],
    ).candidates.map(candidate => candidate.candidateRef).sort();

    beforeStudent[0].steps[0].S_g = ["c:judge:true", "c:judge:false", "c:judge:unknown"];
    await writeJsonl(studentPath, beforeStudent);

    const mutatedStudent = await readJsonl(studentPath);
    assert.equal(JSON.stringify(mutatedStudent[0].steps[0].localSyntax), observationsBefore);
    const mutatedCandidates = convertEpisodeToStudentGroup(
      (await loadStepwiseEpisodeFamily(familyDir))[0],
    ).candidates.map(candidate => candidate.candidateRef).sort();
    assert.deepEqual(mutatedCandidates, beforeCandidates);
    assert.equal(
      mutatedCandidates.includes("c:advance:edge:sources/src/entry.ts:import:0"),
      true,
    );

    const paths = await makeConfig(root);
    const exitCode = await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]);
    assert.equal(exitCode, 1);

    const report = JSON.parse(await readFile(join(paths.outputDir, "run-report.json"), "utf8"));
    assert.equal(report.error.code, "DATA_INVALID", JSON.stringify(report.error));
    assert.match(report.error.message, /S_g mismatch/);
    assert.match(report.error.message, /stepwise-rework-sample|step-0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct ineligible supervision is rejected by the training consumer", async () => {
  const { root, familyDir } = await makeFamily();
  try {
    const supervisionPath = join(familyDir, "independent-supervision.jsonl");
    const rows = await readJsonl(supervisionPath);
    rows[0].trainingEligible = false;
    rows[0].notReadyReason = "test-ineligible";
    await writeJsonl(supervisionPath, rows);

    const paths = await makeConfig(root);
    const exitCode = await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]);
    assert.equal(exitCode, 1);

    const report = JSON.parse(await readFile(join(paths.outputDir, "run-report.json"), "utf8"));
    assert.equal(report.error.code, "DATA_INVALID", JSON.stringify(report.error));
    assert.match(report.error.message, /tsjs-stepwise-rework/);
    assert.match(report.error.message, /stepwise-rework-sample/);
    assert.match(report.error.message, /not training-eligible/i);
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("entryFile must be explicit even when receipt and declaration observations are available", async () => {
  const missing = studentRecord({ entryFile: undefined });
  missing.steps[0].receipts[0].target = "entry-fold";
  missing.steps[0].localSyntax.observedDeclarations = [
    declaration({
      sourceLocation: { file: "sources/src/later-declaration.ts", line: 1, column: 1 },
    }),
  ];
  const { root, familyDir } = await makeFamily({ student: missing });
  try {
    await assert.rejects(
      loadStepwiseEpisodeFamily(familyDir),
      error => error instanceof StepwiseStudentDataError
        && error.code === "DATA_INVALID"
        && error.message.includes("sample stepwise-rework-sample entryFile")
        && error.message.includes("explicit non-empty top-level field"),
    );

    const paths = await makeConfig(root);
    const exitCode = await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]);
    assert.equal(exitCode, 1);

    const report = JSON.parse(await readFile(join(paths.outputDir, "run-report.json"), "utf8"));
    assert.equal(report.error.code, "DATA_INVALID", JSON.stringify(report.error));
    assert.match(report.error.message, /sample stepwise-rework-sample entryFile/);
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit entryFile remains root identity when the opaque call-site ref differs", async () => {
  const { root, familyDir } = await makeFamily();
  try {
    const episodes = await loadStepwiseEpisodeFamily(familyDir);
    assert.equal(episodes[0].entryFile, "sources/src/explicit-entry.ts");

    const paths = await makeConfig(root);
    const exitCode = await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]);
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(await readFile(join(paths.outputDir, "run-report.json"), "utf8")).status, "READY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stepwise obligations require an explicit current-relation ref", async () => {
  const missing = studentRecord();
  const obligationRef = missing.steps[0].remainingObligations[0].ref;
  missing.steps[0].remainingObligations[0] = {
    kind: "advance",
    ref: obligationRef,
    informationGain: 1,
  };
  const { root, familyDir } = await makeFamily({ student: missing });
  try {
    await assert.rejects(
      loadStepwiseEpisodeFamily(familyDir),
      error => error instanceof StepwiseStudentDataError
        && error.code === "DATA_INVALID"
        && error.message.includes("pendingRelationRef must be explicit"),
    );

    const paths = await makeConfig(root);
    const exitCode = await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]);
    assert.equal(exitCode, 1);

    const report = JSON.parse(await readFile(join(paths.outputDir, "run-report.json"), "utf8"));
    assert.equal(report.error.code, "DATA_INVALID", JSON.stringify(report.error));
    assert.match(report.error.message, /pendingRelationRef must be explicit/);
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unexecutable positive advance blocks public sample migration", async () => {
  const invalid = studentRecord();
  invalid.steps[0].localSyntax.observedBindings = [];
  const { root } = await makeFamily({ student: invalid });
  try {
    const paths = await makeConfig(root);
    const exitCode = await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]);
    assert.equal(exitCode, 1);

    const report = JSON.parse(await readFile(join(paths.outputDir, "run-report.json"), "utf8"));
    assert.equal(report.error.code, "DATA_INVALID", JSON.stringify(report.error));
    assert.match(report.error.message, /candidate group must be complete before encoding/);
    assert.notEqual(report.status, "READY");
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unrelated error containing the not-ready phrase stays RUNNER_ERROR", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-stepwise-rework-"));
  try {
    await writeJson(join(root, "corpus-admissions-v1.json"), {
      schemaVersion: "neural-cli-corpus-admissions-v1",
      familyAdmissions: [{
        sourceGroup: "tsjs-near-match",
        partition: "train",
        usableForTrainingSupervision: true,
      }],
    });
    const paths = await makeConfig(root);
    const config = JSON.parse(await readFile(paths.configPath, "utf8"));
    // A missing corpus root whose path contains the accepted not-ready phrase is
    // an unrelated RUNNER_ERROR, not the encoder's DATA_INVALID condition.
    config.corpus.root = join(root, "candidate group must be complete before encoding corpus");
    await writeJson(paths.configPath, config);

    const exitCode = await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]);
    assert.equal(exitCode, 1);

    const report = JSON.parse(await readFile(join(paths.outputDir, "run-report.json"), "utf8"));
    assert.equal(report.error.code, "RUNNER_ERROR", JSON.stringify(report.error));
    assert.equal(report.status, "failed", JSON.stringify(report.status));
    assert.match(report.error.message, /ENOENT/);
    assert.match(report.error.message, /candidate group must be complete before encoding/);
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
