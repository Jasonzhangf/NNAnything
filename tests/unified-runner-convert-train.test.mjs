import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";

const here = new URL(".", import.meta.url);
const thresholdsPath = resolve(
  here.pathname,
  "fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v1.json",
);
const missingModeTablePath = resolve(
  here.pathname,
  "fixtures/unified-64-slot/missing-mode-table.json",
);

function episode(sampleId, stepId, action, overrides = {}) {
  return {
    sampleId,
    stepId,
    requestId: `request-${sampleId}-${stepId}`,
    sourceGroup: "tsjs-test-family",
    language: "ts",
    semanticStratum: "module_export",
    partition: "train",
    entryFile: "sources/src/entry.ts",
    goal: { targetRef: "sources/src/impl.ts#top:helper" },
    failureMode: null,
    evidenceRefs: [`evidence/pre-state.jsonl#${sampleId}:${stepId}`],
    action,
    ...overrides,
  };
}

function gold(sampleId, stepId, action, overrides = {}) {
  return {
    sampleId,
    stepId,
    sourceGroup: "tsjs-test-family",
    partition: "train",
    label: action.endsWith("true") ? "true" : action.endsWith("false") ? "false" : "unknown",
    allowedEquivalentLabels: [action.endsWith("true") ? "true" : action.endsWith("false") ? "false" : "unknown"],
    labelMissing: false,
    unknownReason: action.endsWith("unknown") ? "evidence_insufficient" : null,
    goldAction: action,
    labelAuthority: "researcher_structural_proof",
    oracleKind: "independent_tsc",
    ...overrides,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path, rows) {
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function makeCorpus({ badGold = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "unified-runner-train-"));
  const family = join(root, "train-test-family");
  await mkdir(join(family, "evidence"), { recursive: true });
  await mkdir(join(family, "labels"), { recursive: true });
  await writeJson(join(family, "manifest.json"), {
    schemaVersion: "neural-cli-source-family-v1",
    sourceGroup: "tsjs-test-family",
    language: "ts",
    semanticStratum: "module_export",
    partition: "train",
    derivationFamily: { familyId: "test-family-v1" },
  });
  const requestedDeclaration = {
    declarationRef: "decl:sources/src/impl.ts#top:helper",
    moduleRef: "module:sources/src/impl.ts",
    name: "helper",
    role: "export",
    kind: "function",
    evidenceRefs: ["evidence/pre-state.jsonl#request"],
  };
  await writeJsonl(join(family, "evidence", "pre-state.jsonl"), [
    {
      sampleId: "episode-1",
      stepId: "step-1",
      observedFacts: ["import helper from ./one"],
      callSiteRef: "call:one:helper",
      pendingRelationRef: "relation:one:helper",
      requestedDeclaration,
      observedDeclarations: [requestedDeclaration],
    },
    {
      sampleId: "episode-1",
      stepId: "step-2",
      // Two observed facts give this step a genuinely distinct encoded state.
      // The pre-rework fixture relied on inferring the pending declaration from
      // observedDeclarations[0], which the converter contract now forbids
      // (multi-declaration current-relation projection stays INCOMPLETE).
      observedFacts: ["import helper from ./two", "helper imported through two hops"],
      callSiteRef: "call:two:helper",
      pendingRelationRef: "relation:two:helper",
      requestedDeclaration,
      observedDeclarations: [{
        declarationRef: "decl:sources/src/impl.ts#top:otherHelper",
        moduleRef: "module:sources/src/impl.ts",
        name: "otherHelper",
        role: "local",
        kind: "function",
        evidenceRefs: ["evidence/pre-state.jsonl#step-2"],
      }],
    },
    {
      sampleId: "label-missing-1",
      stepId: "step-1",
      observedFacts: ["not observed"],
      requestedDeclaration,
      observedDeclarations: [],
    },
  ]);
  await writeJsonl(join(family, "episode-test-family.jsonl"), [
    episode("episode-1", "step-1", "c:judge:true"),
    episode("episode-1", "step-2", "c:judge:false"),
    episode("label-missing-1", "step-1", "c:judge:unknown"),
  ]);
  await writeJsonl(join(family, "labels", "gold.jsonl"), [
    gold("episode-1", "step-1", badGold ? "c:judge:present" : "c:judge:true"),
    gold("episode-1", "step-2", "c:judge:false"),
    gold("label-missing-1", "step-1", "c:judge:unknown", {
      labelMissing: true,
      unknownReason: "label_missing",
    }),
  ]);
  await writeJson(join(root, "corpus-admissions-v1.json"), {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [{
      sourceGroup: "tsjs-test-family",
      partition: "train",
      usableForTrainingSupervision: true,
    }],
  });
  return root;
}

async function makeConfig(root, overrides = {}) {
  const outputDir = join(root, "out");
  const studentRowsPath = join(outputDir, "student-rows", "student-rows.jsonl");
  const supervisionRowsPath = join(outputDir, "labels", "supervision.jsonl");
  const gateRowsPath = join(outputDir, "data-rows.jsonl");
  const packagePath = join(outputDir, "package.json");
  const configPath = join(root, "runner-config.json");
  await writeJson(configPath, {
    schema: "nnanything.unified.runner-config.v1",
    command: "train",
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "pretraining",
    encoderVersion: "nnanything.unified-step.encoder.v1",
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "TRAIN",
      encoderVersion: "nnanything.unified-step.encoder.v1",
      thresholdsPath,
      rowsPath: gateRowsPath,
    },
    outputDir,
    corpus: {
      root,
      admissionsPath: join(root, "corpus-admissions-v1.json"),
      studentRowsPath,
      supervisionRowsPath,
      packagePath,
      missingModeTablePath,
    },
    training: {
      modelId: "tests.unified-runner",
      version: "0.0.1-test",
      optimizer: "full_batch_sgd",
      learningRate: 0.01,
      maxEpochs: 2,
      seed: 20261104,
      init: "xavier_uniform",
      ...overrides,
    },
  });
  return {
    configPath,
    outputDir,
    studentRowsPath,
    supervisionRowsPath,
    gateRowsPath,
    packagePath,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("convert-samples writes separated student rows and labels and data gate is READY", async () => {
  const root = await makeCorpus();
  try {
    const paths = await makeConfig(root);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 0);

    const studentRows = (await readFile(paths.studentRowsPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    const supervisionRows = (await readFile(paths.supervisionRowsPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    assert.equal(new Set(studentRows.map(row => row.group_id)).size, 3);
    assert.equal(supervisionRows.length, 3);
    assert.equal(supervisionRows.filter(row => row.labelMissing).length, 1);
    assert.equal(studentRows.some(row => "gold" in row || "allowed" in row), false);
    assert.equal(supervisionRows.some(row => "x" in row || "input" in row), false);

    const report = await readJson(join(paths.outputDir, "run-report.json"));
    assert.equal(report.status, "READY");
    assert.equal(report.dataGate.status, "READY");
    assert.equal(report.counts.studentGroups, 3);
    assert.equal(report.counts.supervisionRows, 3);
    assert.equal(report.counts.labelMissingExcluded, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same episode with two steps keeps separate group ids", async () => {
  const root = await makeCorpus();
  try {
    const paths = await makeConfig(root);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 0);
    const rows = (await readFile(paths.studentRowsPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))
      .filter(row => row.sampleId === "episode-1");
    assert.deepEqual(
      [...new Set(rows.map(row => row.stepContextRef))].sort(),
      ["ctx:episode-1:step-1", "ctx:episode-1:step-2"],
    );
    assert.equal(new Set(rows.map(row => row.group_id)).size, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting gold leaves student S_g and every x[64] byte-identical", async () => {
  const root = await makeCorpus();
  try {
    const paths = await makeConfig(root);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 0);
    const withGold = await readFile(paths.studentRowsPath, "utf8");
    await rm(join(root, "train-test-family", "labels"), { recursive: true, force: true });

    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 1);
    const withoutGold = await readFile(paths.studentRowsPath, "utf8");
    assert.equal(withoutGold, withGold);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("train saves a package, reloads tensors, and reports epoch limit", async () => {
  const root = await makeCorpus();
  try {
    const paths = await makeConfig(root);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 0);
    assert.equal(await runStandardRunnerCli(["train", "--config", paths.configPath]), 0);

    const report = await readJson(join(paths.outputDir, "run-report.json"));
    assert.equal(report.status, "completed");
    assert.equal(report.dataGate.status, "READY");
    assert.equal(report.trainReport.stopReason, "epoch_limit_exhausted");
    assert.equal(report.trainReport.completedEpochs, 2);
    assert.equal(Number.isFinite(report.trainReport.initialLoss), true);
    assert.equal(report.trainReport.epochs.length, 2);
    assert.equal(report.packageReload.tensorsMatch, true);
    const model = await readJson(paths.packagePath);
    assert.equal(model.schema, "nnanything.unified.model-package.v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A_g outside S_g is explicit DATA_INVALID and creates no package", async () => {
  const root = await makeCorpus({ badGold: true });
  try {
    const paths = await makeConfig(root);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 1);
    const report = await readJson(join(paths.outputDir, "run-report.json"));
    assert.equal(report.status, "DATA_INVALID");
    assert.match(report.error.message, /outside S_g/);
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-finite training is explicit and creates no package", async () => {
  const root = await makeCorpus();
  try {
    const paths = await makeConfig(root, { maxEpochs: 1 });
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 0);
    const rows = (await readFile(paths.studentRowsPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    for (const row of rows) {
      // Keep the missing-mode declaration consistent with the replaced vector;
      // this test exercises non-finite training, not missing-mode rejection.
      row.x = Array.from({ length: 64 }, () => 1e308);
      row.missingMode = [];
    }
    await writeJsonl(paths.studentRowsPath, rows);

    assert.equal(await runStandardRunnerCli(["train", "--config", paths.configPath]), 1);
    const report = await readJson(join(paths.outputDir, "run-report.json"));
    assert.equal(report.status, "failed");
    assert.equal(report.trainReport.stopReason, "non_finite");
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("student rows carrying gold or teacher fields are DATA_INVALID", async () => {
  const root = await makeCorpus();
  try {
    const paths = await makeConfig(root);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 0);
    const rows = (await readFile(paths.studentRowsPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    rows[0].goldAction = "c:judge:true";
    await writeJsonl(paths.studentRowsPath, rows);

    assert.equal(await runStandardRunnerCli(["train", "--config", paths.configPath]), 1);
    const report = await readJson(join(paths.outputDir, "run-report.json"));
    assert.equal(report.status, "DATA_INVALID");
    assert.match(report.error.message, /forbidden.*goldAction/);
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervision rows carrying x or input fields are DATA_INVALID", async () => {
  const root = await makeCorpus();
  try {
    const paths = await makeConfig(root);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 0);
    const rows = (await readFile(paths.supervisionRowsPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    rows[0].x = Array.from({ length: 64 }, () => 0);
    await writeJsonl(paths.supervisionRowsPath, rows);

    assert.equal(await runStandardRunnerCli(["train", "--config", paths.configPath]), 1);
    const report = await readJson(join(paths.outputDir, "run-report.json"));
    assert.equal(report.status, "DATA_INVALID");
    assert.match(report.error.message, /forbidden.*x/);
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("convert-samples rejects a discovered family absent from corpus admissions", async () => {
  const root = await makeCorpus();
  try {
    const unadmitted = join(root, "family-unadmitted");
    await mkdir(join(unadmitted, "evidence"), { recursive: true });
    await mkdir(join(unadmitted, "labels"), { recursive: true });
    await writeJson(join(unadmitted, "manifest.json"), {
      schemaVersion: "neural-cli-source-family-v1",
      sourceGroup: "tsjs-unadmitted-family",
      language: "ts",
      semanticStratum: "module_export",
      partition: "train",
      derivationFamily: { familyId: "unadmitted-family-v1" },
    });
    await writeJsonl(join(unadmitted, "evidence", "pre-state.jsonl"), [
      { sampleId: "unadmitted-episode-1", stepId: "step-1", observedFacts: ["unadmitted source"] },
    ]);
    await writeJsonl(join(unadmitted, "episode-unadmitted-family.jsonl"), [
      episode("unadmitted-episode-1", "step-1", "c:judge:true", {
        sourceGroup: "tsjs-unadmitted-family",
      }),
    ]);
    await writeJsonl(join(unadmitted, "labels", "gold.jsonl"), [
      gold("unadmitted-episode-1", "step-1", "c:judge:true", {
        sourceGroup: "tsjs-unadmitted-family",
      }),
    ]);

    const paths = await makeConfig(root);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 1);
    const report = await readJson(join(paths.outputDir, "run-report.json"));
    assert.equal(report.status, "DATA_INVALID");
    assert.match(report.error.message, /tsjs-unadmitted-family/);
    assert.match(report.error.message, /not declared|not admitted/i);
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("train rejects DEV supervision joined to a TRAIN student group", async () => {
  const root = await makeCorpus();
  try {
    const paths = await makeConfig(root);
    assert.equal(await runStandardRunnerCli(["convert-samples", "--config", paths.configPath]), 0);
    const supervisionRows = (await readFile(paths.supervisionRowsPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    const changed = supervisionRows.find(row => !row.labelMissing);
    changed.partition = "DEV";
    await writeJsonl(paths.supervisionRowsPath, supervisionRows);

    assert.equal(await runStandardRunnerCli(["train", "--config", paths.configPath]), 1);
    const report = await readJson(join(paths.outputDir, "run-report.json"));
    assert.equal(report.status, "DATA_INVALID");
    assert.match(report.error.message, new RegExp(changed.group_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(report.error.message, /student=TRAIN/);
    assert.match(report.error.message, /supervision=DEV/);
    await assert.rejects(readFile(paths.packagePath, "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
