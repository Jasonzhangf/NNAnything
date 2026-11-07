import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";
import {
  loadStepwiseEpisodeFamily,
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

function studentRecord() {
  const firstEdge = binding(
    "edge:sources/src/entry.ts:import:0",
    "mod:sources/src/util.ts",
    "helper",
  );
  const secondEdge = binding(
    "edge:sources/src/util.ts:reexport:0",
    "mod:sources/src/impl.ts",
    "forwarded",
  );
  return {
    schemaVersion: "emma-tsjs-student-observation-v2",
    sampleId: "stepwise-sample-1",
    family: "train-stepwise-test-a",
    partition: "train",
    language: "ts",
    entryFile: "sources/src/entry.ts",
    request: {
      requestRef: "request:stepwise-sample-1",
      requestedDeclaration: {
        declarationRef: "decl:sources/src/impl.ts#top:helper",
        moduleRef: "mod:sources/src/impl.ts",
        name: "helper",
        kind: "function",
        sourceTargetRef: "sources/src/impl.ts#top:helper",
      },
      relationObligation: {
        callSiteRef: "call:sources/src/entry.ts:helper",
        calleeName: "helper",
        pendingRelationRef: "pending:stepwise-sample-1",
        requestRef: "request:stepwise-sample-1",
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
          pendingRelationRef: "pending:stepwise-sample-1",
          informationGain: {
            state: "known",
            value: "advances_chain",
            evidenceRefs: ["ev:sources/src/entry.ts:import:0:source"],
          },
        }],
        S_g: [
          "c:judge:true",
          "c:judge:false",
          "c:judge:unknown",
          `c:advance:${firstEdge.edgeRef}`,
          "c:defer",
        ],
        receipts: [{
          receiptId: "receipt:stepwise-sample-1:step0",
          action: "observe",
          target: "sources/src/entry.ts",
          result: { bindingEdge: firstEdge.edgeRef },
          evidenceRefs: ["ev:sources/src/entry.ts:import:0:source"],
        }],
        coverage: null,
        notReady: false,
      },
      {
        stepId: "step-1",
        observedAt: "current-step",
        localSyntax: {
          observedBindings: [
            { ...firstEdge, sourceContent: {
              state: "observed",
              resultRefs: [secondEdge.edgeRef],
              reason: null,
              evidenceRefs: ["ev:sources/src/util.ts:reexport:0:source"],
            } },
            secondEdge,
          ],
          observedDeclarations: [declaration()],
          moduleSpecifierRaw: "./impl",
          sourceContent: {
            state: "observed",
            resultRefs: ["decl:sources/src/impl.ts#top:helper"],
            reason: null,
            evidenceRefs: ["ev:sources/src/impl.ts:read"],
          },
          shadowFacts: [],
        },
        remainingObligations: [],
        S_g: [
          "c:judge:true",
          "c:judge:false",
          "c:judge:unknown",
          "c:return",
        ],
        receipts: [{
          receiptId: "receipt:stepwise-sample-1:step1",
          action: "advance",
          fromEdgeRef: firstEdge.edgeRef,
          result: { observedDeclaration: "decl:sources/src/impl.ts#top:helper" },
          evidenceRefs: ["ev:sources/src/impl.ts:read"],
        }],
        coverage: null,
        notReady: false,
      },
    ],
  };
}

function supervisionRecord() {
  return {
    schemaVersion: "emma-tsjs-independent-action-supervision-v1",
    sampleId: "stepwise-sample-1",
    family: "train-stepwise-test-a",
    requestRef: "request:stepwise-sample-1",
    gold: {
      label: "true",
      allowedEquivalentLabels: ["true"],
      labelAuthority: "researcher_structural_proof",
      oracleKind: "independent_tsc",
      unknownReason: null,
      originalLabel: null,
      originalUnknownReason: null,
      goldAction: "c:judge:true",
      candidateSet: ["c:judge:true"],
      admission: "superseded",
      supersededBy: "evidence/manual-structural-proof.md",
      recomputedLabel: "true",
      recomputedMatchedGold: true,
    },
    steps: [
      {
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
      },
      {
        stepId: "step-1",
        S_g: [
          "c:judge:true",
          "c:judge:false",
          "c:judge:unknown",
          "c:return",
        ],
        A_g: ["c:judge:true"],
        agSubsetOfSg: true,
        labelAuthority: "researcher_structural_proof",
        oracleKind: "independent_tsc",
        unknownReason: null,
      },
    ],
    trainingEligible: true,
    notReadyReason: null,
    terminalDeclarationRef: "decl:sources/src/impl.ts#top:helper",
    conflicts: [],
  };
}

async function makeStepwiseFamily() {
  const root = await mkdtemp(join(tmpdir(), "unified-stepwise-"));
  const familyDir = join(root, "train-stepwise-test-a");
  await mkdir(familyDir, { recursive: true });
  await writeJson(join(familyDir, "manifest.json"), {
    schemaVersion: "neural-cli-source-family-v1",
    sourceGroup: "tsjs-stepwise-test-family",
    language: "ts",
    semanticStratum: "module_export",
    partition: "train",
    derivationFamily: { familyId: "stepwise-test-family-v1" },
  });
  await writeJsonl(join(familyDir, "student-observations.jsonl"), [studentRecord()]);
  await writeJsonl(join(familyDir, "independent-supervision.jsonl"), [supervisionRecord()]);
  await writeJson(join(root, "corpus-admissions-v1.json"), {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [{
      sourceGroup: "tsjs-stepwise-test-family",
      partition: "train",
      usableForTrainingSupervision: true,
    }],
  });
  return { root, familyDir };
}

// Single-step structural family: generated candidates equal the declared S_g,
// so the public path reaches READY without leaning on the still-INCOMPLETE
// consumed-edge/observe-gain semantics exercised by the two-step fixture above.
async function makeSingleStepFamily() {
  const student = studentRecord();
  student.steps = [student.steps[0]];
  const supervision = supervisionRecord();
  supervision.steps = [supervision.steps[0]];
  const root = await mkdtemp(join(tmpdir(), "unified-stepwise-single-"));
  const familyDir = join(root, "train-stepwise-test-a");
  await mkdir(familyDir, { recursive: true });
  await writeJson(join(familyDir, "manifest.json"), {
    schemaVersion: "neural-cli-source-family-v1",
    sourceGroup: "tsjs-stepwise-test-family",
    language: "ts",
    semanticStratum: "module_export",
    partition: "train",
    derivationFamily: { familyId: "stepwise-test-family-v1" },
  });
  await writeJsonl(join(familyDir, "student-observations.jsonl"), [student]);
  await writeJsonl(join(familyDir, "independent-supervision.jsonl"), [supervision]);
  await writeJson(join(root, "corpus-admissions-v1.json"), {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [{
      sourceGroup: "tsjs-stepwise-test-family",
      partition: "train",
      usableForTrainingSupervision: true,
    }],
  });
  return { root, familyDir };
}

async function makeRunnerConfig(root) {
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
  });
  return items;
}

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test("stepwise student loader maps every nested step without pre-state files", async () => {
  const { root, familyDir } = await makeStepwiseFamily();
  try {
    const episodes = await loadStepwiseEpisodeFamily(familyDir);
    assert.equal(episodes.length, 2);
    assert.deepEqual(episodes.map(episode => episode.stepId), ["step-0", "step-1"]);
    assert.equal(episodes[0].targetRef, "decl:sources/src/impl.ts#top:helper");
    assert.equal(episodes[0].pendingRelationRef, "pending:stepwise-sample-1");
    assert.equal(episodes[0].requestId, "request:stepwise-sample-1");
    assert.deepEqual(
      episodes[0].remainingObligations[0].informationGain,
      {
        state: "known",
        value: "advances_chain",
        evidenceRefs: ["ev:sources/src/entry.ts:import:0:source"],
      },
    );
    assert.equal(episodes[0].receipts[0].receiptId, "receipt:stepwise-sample-1:step0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stepwise supervision loader preserves non-judge per-step A_g", async () => {
  const { root, familyDir } = await makeStepwiseFamily();
  try {
    const rows = await loadStepwiseSupervisionFamily(familyDir);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows[0].goldAllowedCandidateRefs,
      ["c:advance:edge:sources/src/entry.ts:import:0"],
    );
    assert.equal(rows[0].stepId, "step-0");
    assert.equal(rows[0].trainingEligible, true);
    assert.deepEqual(rows[1].goldAllowedCandidateRefs, ["c:judge:true"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public convert-samples consumes a staged stepwise family and keeps sides isolated", async () => {
  const { root } = await makeSingleStepFamily();
  try {
    const paths = await makeRunnerConfig(root);
    const exitCode = await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]);
    if (exitCode !== 0) {
      const report = JSON.parse(await readFile(join(paths.outputDir, "run-report.json"), "utf8"));
      assert.fail(JSON.stringify(report.error));
    }

    const studentRows = await readJsonl(paths.studentRowsPath);
    const supervisionRows = await readJsonl(paths.supervisionRowsPath);
    assert.equal(new Set(studentRows.map(row => row.group_id)).size, 1);
    assert.equal(new Set(studentRows.map(row => row.stepId)).size, 1);
    assert.equal(
      studentRows.some(row =>
        row.stepId === "step-0"
        && row.candidateRef === "c:advance:edge:sources/src/entry.ts:import:0"
      ),
      true,
    );
    assert.equal(
      studentRows.some(row => row.stepId === "step-0" && row.candidateRef === "c:defer"),
      true,
    );
    assert.deepEqual(
      supervisionRows.find(row => row.stepId === "step-0").goldAllowedCandidateRefs,
      ["c:advance:edge:sources/src/entry.ts:import:0"],
    );
    assert.equal(studentRows.some(row => "goldAllowedCandidateRefs" in row), false);
    assert.equal(studentRows.some(row => "A_g" in row), false);

    const report = JSON.parse(await readFile(join(paths.outputDir, "run-report.json"), "utf8"));
    assert.equal(report.status, "READY");
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changing independent supervision does not change student rows or vectors", async () => {
  const baselineRoot = await makeSingleStepFamily();
  const alteredRoot = await makeSingleStepFamily();
  try {
    const baseline = await makeRunnerConfig(baselineRoot.root);
    const altered = await makeRunnerConfig(alteredRoot.root);
    const alteredSupervisionPath = join(
      alteredRoot.familyDir,
      "independent-supervision.jsonl",
    );
    const supervisionRows = await readJsonl(alteredSupervisionPath);
    supervisionRows[0].steps[0].A_g = ["c:judge:true"];
    supervisionRows[0].gold.teacherExplanation = "independent diagnostic change";
    await writeJsonl(alteredSupervisionPath, supervisionRows);

    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", baseline.configPath]), 0);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", altered.configPath]), 0);

    const baselineStudentRows = await readFile(baseline.studentRowsPath, "utf8");
    const alteredStudentRows = await readFile(altered.studentRowsPath, "utf8");
    assert.equal(alteredStudentRows, baselineStudentRows);

    const baselineSupervision = await readJsonl(baseline.supervisionRowsPath);
    const alteredSupervision = await readJsonl(altered.supervisionRowsPath);
    assert.deepEqual(
      alteredSupervision.find(row => row.stepId === "step-0").goldAllowedCandidateRefs,
      ["c:judge:true"],
    );
    assert.deepEqual(
      baselineSupervision.find(row => row.stepId === "step-0").goldAllowedCandidateRefs,
      ["c:advance:edge:sources/src/entry.ts:import:0"],
    );
  } finally {
    await rm(baselineRoot.root, { recursive: true, force: true });
    await rm(alteredRoot.root, { recursive: true, force: true });
  }
});
