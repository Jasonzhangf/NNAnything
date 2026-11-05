import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";

const here = new URL(".", import.meta.url);
const thresholdsFixture = new URL(
  "./fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v1.json",
  here,
).pathname;

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeCase({ rowsText, thresholdsPath }) {
  const dir = await mkdtemp(join(tmpdir(), "unified-runner-route-"));
  const rowsPath = join(dir, "rows.jsonl");
  await writeFile(rowsPath, rowsText, "utf8");
  const outputDir = join(dir, "out");
  const configPath = join(dir, "runner-config.json");
  await writeJson(configPath, {
    schema: "nnanything.unified.runner-config.v1",
    command: "validate-data",
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "validation",
    encoderVersion: "nnanything.unified-step.encoder.v1",
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "TRAIN",
      encoderVersion: "nnanything.unified-step.encoder.v1",
      thresholdsPath,
      rowsPath,
    },
    outputDir,
  });
  return { dir, rowsPath, outputDir, configPath };
}

function validRow(overrides = {}) {
  return {
    schema: "nnanything.unified.data-row.v1",
    rowId: "row-1",
    partition: "TRAIN",
    route: { domain: "tsjs", decisionKind: "R" },
    input: Array.from({ length: 64 }, () => 0),
    missingMode: [],
    candidates: ["a", "b"],
    allowed: ["a"],
    gold: "a",
    labelMissing: false,
    enumeration: "complete",
    ...overrides,
  };
}

test("unified validate-data route consumes only 64-slot typed config and never loads the hybrid package", async () => {
  const { configPath, outputDir } = await makeCase({
    rowsText: `${JSON.stringify(validRow())}\n`,
    thresholdsPath: thresholdsFixture,
  });
  const exitCode = await runStandardRunnerCli(["validate-data", "--config", configPath]);
  assert.equal(exitCode, 0);
  const report = JSON.parse(await readFile(join(outputDir, "run-report.json"), "utf8"));
  assert.equal(report.schema, "nnanything.unified.run-report.v1");
  assert.equal(report.command, "validate-data");
  assert.deepEqual(report.route, { domain: "tsjs", decisionKind: "R" });
  assert.equal(report.dataGate.status, "READY");
  assert.equal(report.dataGate.counts.learnedRows, 1);
  // No hybrid package was loaded: the route ran without handwiredRoot/inputPackagePath.
  assert.equal(report.hybridPackageLoaded, false);
  assert.equal(report.paths.inputPackagePath, null);
});

test("unified validate-data route with empty rows is NO_LEARNED_ROWS and exits 0", async () => {
  const { configPath, outputDir } = await makeCase({
    rowsText: "",
    thresholdsPath: thresholdsFixture,
  });
  const exitCode = await runStandardRunnerCli(["validate-data", "--config", configPath]);
  assert.equal(exitCode, 0);
  const report = JSON.parse(await readFile(join(outputDir, "run-report.json"), "utf8"));
  assert.equal(report.dataGate.status, "NO_LEARNED_ROWS");
  assert.equal(report.dataGate.counts.learnedRows, 0);
});

test("missing threshold is explicit DATA_INVALID, exit 1, zero learned rows", async () => {
  const { configPath, outputDir } = await makeCase({
    rowsText: `${JSON.stringify(validRow())}\n`,
    thresholdsPath: "/tmp/unified-runner-route-missing-threshold.json",
  });
  const exitCode = await runStandardRunnerCli(["validate-data", "--config", configPath]);
  assert.equal(exitCode, 1);
  const report = JSON.parse(await readFile(join(outputDir, "run-report.json"), "utf8"));
  assert.equal(report.status, "DATA_INVALID");
  assert.equal(report.dataGate.status, "DATA_INVALID");
  assert.equal(report.dataGate.counts.learnedRows, 0);
  assert.equal(report.dataGate.firstViolation.reasonCode, "THRESHOLD_MISSING");
});

test("schema mismatch on encoder version is explicit DATA_INVALID, not a silent fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unified-runner-route-schema-"));
  const rowsPath = join(dir, "rows.jsonl");
  await writeFile(rowsPath, `${JSON.stringify(validRow())}\n`, "utf8");
  const thresholdsPath = join(dir, "thresholds.json");
  await writeFile(thresholdsPath, await readFile(thresholdsFixture, "utf8"), "utf8");
  const outputDir = join(dir, "out");
  const configPath = join(dir, "runner-config.json");
  await writeJson(configPath, {
    schema: "nnanything.unified.runner-config.v1",
    command: "validate-data",
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "validation",
    encoderVersion: "nnanything.unified-step.encoder.v1",
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "TRAIN",
      encoderVersion: "nnanything.unified-step.encoder.v0",
      thresholdsPath,
      rowsPath,
    },
    outputDir,
  });
  const exitCode = await runStandardRunnerCli(["validate-data", "--config", configPath]);
  assert.equal(exitCode, 1);
  const report = JSON.parse(await readFile(join(outputDir, "run-report.json"), "utf8"));
  assert.equal(report.status, "DATA_INVALID");
  assert.ok(report.dataGate.violations.some(v => v.reasonCode === "ROW_SCHEMA_INVALID"));
});

test("unified route keeps unimplemented commands explicit and never falls back", async () => {
  const { configPath } = await makeCase({
    rowsText: "",
    thresholdsPath: thresholdsFixture,
  });
  assert.equal(await runStandardRunnerCli(["evaluate", "--config", configPath]), 2);
  assert.equal(await runStandardRunnerCli(["resume", "--config", configPath]), 2);
});
