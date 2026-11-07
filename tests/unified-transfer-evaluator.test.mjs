import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_INCOMPATIBLE,
  MODEL_NOT_FOUND,
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
import {
  evaluateUnifiedTransfer,
} from "../dist/training/unified-transfer-evaluator.js";

const RESOURCE_NAMES = {
  thresholds: "feature-thresholds.json",
  missingMode: "missing-mode.json",
};
const TRANSFER_CLI = fileURLToPath(
  new URL("../playground/training/unified-transfer-evaluator.mjs", import.meta.url),
);

const THRESHOLDS = {
  schema: "nnanything.feature-thresholds.v1",
  route: "r",
  encoderVersion: "nnanything.unified-step.encoder.v1",
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

function facts(episodeRef, overrides = {}) {
  return {
    schema: "nnanything.unified.relation-facts.v1",
    episodeRef,
    languageAgnostic: true,
    symbols: [],
    imports: [],
    callSites: [],
    missing: [],
    unsupported: [],
    conflicts: [],
    ...overrides,
  };
}

function episode(sampleId, overrides = {}) {
  return {
    sampleId,
    stepId: "step:0",
    requestId: `request:${sampleId}`,
    sourceGroup: "unified-transfer-synthetic",
    language: "typescript",
    semanticStratum: "relation",
    partition: "verification",
    entryFile: "src/entry.ts",
    targetRef: "decl:target",
    observedFacts: ["synthetic observation"],
    pendingRelationRef: "relation:target",
    callSiteRef: "call:target",
    requestedDeclaration: {
      declarationRef: "decl:target",
      moduleRef: "src/entry.ts",
      name: "target",
      role: "local",
      kind: "function",
      evidenceRefs: ["tsjs:evidence"],
    },
    observedBindings: [],
    observedDeclarations: [],
    evidenceRefs: ["tsjs:evidence", "rust:evidence"],
    failureMode: null,
    derivationFamily: "synthetic",
    adapterRef: "test",
    ...overrides,
  };
}

function oracleSample(sampleId, overrides = {}) {
  return {
    sampleId,
    targetRef: "decl:target",
    gold: "true",
    goldSource: "manual-structural-proof",
    goldEvidence: [{ evidenceRef: `oracle:${sampleId}`, typeStep: "binding" }],
    labelMissing: false,
    ...overrides,
  };
}

function packageFor(route = { domain: "tsjs", decisionKind: "R" }) {
  const tensors = zeroTensors();
  // Synthetic package: x[36] is the `judge=true` slot, so the forward path
  // deterministically prefers it over the other judge candidates.
  tensors.W1[36] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  return createUnifiedModelPackage({
    modelId: "unified-transfer-synthetic",
    version: "1",
    route,
    tensors,
    resources: {
      thresholdsRef: RESOURCE_NAMES.thresholds,
      thresholdsSchema: THRESHOLDS.schema,
      missingModeTableRef: RESOURCE_NAMES.missingMode,
      missingModeSchema: MISSING_MODE.schema,
    },
    fixedStages: ["nnanything.unified-step.encoder.v1"],
  });
}

async function writeResources(dir) {
  await writeFile(join(dir, RESOURCE_NAMES.thresholds), `${JSON.stringify(THRESHOLDS, null, 2)}\n`);
  await writeFile(join(dir, RESOURCE_NAMES.missingMode), `${JSON.stringify(MISSING_MODE, null, 2)}\n`);
}

async function packagePath(dir, pkg = packageFor()) {
  await writeResources(dir);
  return saveUnifiedModelPackageAtomic(join(dir, "package.json"), pkg);
}

async function verificationDir(root, relation) {
  const dir = join(root, "rust-verification");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "verification.json"),
    `${JSON.stringify({
      schema: "nnanything.unified.rust-verification.v1",
      ...relation,
    }, null, 2)}\n`,
  );
  return dir;
}

async function oraclePath(root, samples, source = "manual-structural-proof") {
  const path = join(root, "oracle.json");
  await writeFile(path, `${JSON.stringify({
    schema: "nnanything.unified.transfer-oracle.v1",
    source,
    samples,
  }, null, 2)}\n`);
  return path;
}

test("missing package returns MODEL_NOT_FOUND without fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-missing-"));
  await assert.rejects(
    () => evaluateUnifiedTransfer({
      packagePath: join(root, "absent.json"),
    }),
    error => error.code === MODEL_NOT_FOUND,
  );
});
test("wrong package route or schema returns MODEL_INCOMPATIBLE", async () => {
  const routeRoot = await mkdtemp(join(tmpdir(), "unified-transfer-route-"));
  const routePackage = await packagePath(
    routeRoot,
    packageFor({ domain: "rust", decisionKind: "R" }),
  );
  await assert.rejects(
    () => evaluateUnifiedTransfer({ packagePath: routePackage }),
    error => error.code === MODEL_INCOMPATIBLE,
  );

  const schemaRoot = await mkdtemp(join(tmpdir(), "unified-transfer-schema-"));
  await writeResources(schemaRoot);
  const raw = {
    ...packageFor(),
    schema: "nnanything.unified.model-package.v0",
  };
  const schemaPackage = join(schemaRoot, "package.json");
  await writeFile(schemaPackage, `${JSON.stringify(raw, null, 2)}\n`);
  await assert.rejects(
    () => evaluateUnifiedTransfer({ packagePath: schemaPackage }),
    error => error.code === MODEL_INCOMPATIBLE,
  );
});

test("report always separates adapter, inference, and actual-transfer layers", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-layers-"));
  const modelPath = await packagePath(root);
  const sample = episode("layer-sample");
  const verification = await verificationDir(root, {
    tsjsFacts: facts("layer-sample"),
    rustFacts: facts("layer-sample"),
    episodes: [sample],
  });

  const report = await evaluateUnifiedTransfer({
    packagePath: modelPath,
    verificationPath: verification,
  });

  assert.ok(Object.hasOwn(report, "adapterSemanticAlignment"));
  assert.ok(Object.hasOwn(report, "encodingInferenceConsistency"));
  assert.ok(Object.hasOwn(report, "actualTransferCorrectness"));
  assert.equal(report.adapterSemanticAlignment.status, "pass");
  assert.equal(report.encodingInferenceConsistency.status, "pass");
  assert.equal(report.actualTransferCorrectness.status, "incomplete");
});

test("synthetic mechanics pass only the mechanics layers", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-mechanics-"));
  const modelPath = await packagePath(root);
  const verification = await verificationDir(root, {
    tsjsFacts: facts("mechanics"),
    rustFacts: facts("mechanics"),
    episodes: [episode("mechanics")],
  });

  const report = await evaluateUnifiedTransfer({
    packagePath: modelPath,
    verificationPath: verification,
  });

  assert.equal(report.encodingInferenceConsistency.encodedCount > 0, true);
  assert.equal(report.encodingInferenceConsistency.failedCount, 0);
  assert.equal(report.actualTransferCorrectness.status, "incomplete");
  assert.equal(report.actualTransferCorrectness.oracle, null);
});

test("public CLI reports incomplete transfer and exits non-zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-cli-"));
  const modelPath = await packagePath(root);
  const verification = await verificationDir(root, {
    tsjsFacts: facts("cli"),
    rustFacts: facts("cli"),
    episodes: [episode("cli")],
  });
  const oracle = await oraclePath(root, [oracleSample("cli")]);
  const reportPath = join(root, "report.json");

  const result = spawnSync(
    process.execPath,
    [
      TRANSFER_CLI,
      "--package",
      modelPath,
      "--verification",
      verification,
      "--oracle",
      oracle,
      "--report",
      reportPath,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /adapter=pass inference=pass transfer=incomplete/);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.actualTransferCorrectness.status, "incomplete");
});

test("synthetic package and complete-format oracle do not establish actual transfer admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-synthetic-admission-"));
  const modelPath = await packagePath(root);
  const verification = await verificationDir(root, {
    tsjsFacts: facts("synthetic-admission"),
    rustFacts: facts("synthetic-admission"),
    episodes: [episode("synthetic-admission")],
  });
  const oracle = await oraclePath(root, [
    oracleSample("synthetic-admission"),
  ]);

  const report = await evaluateUnifiedTransfer({
    packagePath: modelPath,
    verificationPath: verification,
    oraclePath: oracle,
  });

  assert.equal(
    report.actualTransferCorrectness.prerequisites.acceptedTsJsPackage,
    false,
  );
  assert.equal(report.actualTransferCorrectness.status, "incomplete");
});

test("missing Rust verification or oracle source stays explicitly incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-prereq-"));
  const modelPath = await packagePath(root);

  const missingVerification = await evaluateUnifiedTransfer({
    packagePath: modelPath,
    oraclePath: await oraclePath(root, [oracleSample("no-verification")]),
  });
  assert.equal(missingVerification.actualTransferCorrectness.status, "incomplete");
  assert.equal(
    missingVerification.actualTransferCorrectness.prerequisites.independentRustVerification,
    false,
  );

  const verification = await verificationDir(root, {
    tsjsFacts: facts("no-oracle"),
    rustFacts: facts("no-oracle"),
    episodes: [episode("no-oracle")],
  });
  const missingOracle = await evaluateUnifiedTransfer({
    packagePath: modelPath,
    verificationPath: verification,
  });
  assert.equal(missingOracle.actualTransferCorrectness.status, "incomplete");
  assert.equal(
    missingOracle.actualTransferCorrectness.prerequisites.independentOracleSource,
    false,
  );
});

test("multi-step episodes keep one sample run and match choices by sample and step", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-multistep-"));
  const modelPath = await packagePath(root);
  const verification = await verificationDir(root, {
    tsjsFacts: facts("multi-step"),
    rustFacts: facts("multi-step"),
    episodes: [
      episode("multi-step", { stepId: "step:0" }),
      episode("multi-step", { stepId: "step:1" }),
    ],
  });
  const oracle = await oraclePath(root, [
    oracleSample("multi-step"),
  ]);

  const report = await evaluateUnifiedTransfer({
    packagePath: modelPath,
    verificationPath: verification,
    oraclePath: oracle,
  });

  assert.deepEqual(
    report.actualTransferCorrectness.oracle.perStepEvaluation.entries.map(entry => entry.stepId),
    ["step:0", "step:1"],
  );
  assert.equal(report.actualTransferCorrectness.status, "incomplete");
});

test("threshold and missing-mode failures retain typed error evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-resource-error-"));
  const modelPath = await packagePath(root);
  await writeFile(
    join(root, RESOURCE_NAMES.thresholds),
    `${JSON.stringify({ ...THRESHOLDS, schema: "nnanything.feature-thresholds.v0" }, null, 2)}\n`,
  );

  const report = await evaluateUnifiedTransfer({ packagePath: modelPath });

  assert.equal(report.encodingInferenceConsistency.thresholdsValid, false);
  assert.equal(
    report.encodingInferenceConsistency.errors.some(error => error.code === "THRESHOLD_INVALID"),
    true,
  );
  assert.equal(
    report.encodingInferenceConsistency.errors.some(
      error => error.stage === "thresholds" && error.inputRef === join(root, RESOURCE_NAMES.thresholds),
    ),
    true,
  );
});

test("known-relation miss remains incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-miss-"));
  const modelPath = await packagePath(root);
  const sample = episode("known-miss");
  const verification = await verificationDir(root, {
    tsjsFacts: facts("known-miss"),
    rustFacts: facts("known-miss"),
    episodes: [sample],
  });
  const oracle = await oraclePath(root, [
    oracleSample("known-miss", { gold: "false" }),
  ]);

  const report = await evaluateUnifiedTransfer({
    packagePath: modelPath,
    verificationPath: verification,
    oraclePath: oracle,
  });

  assert.equal(report.actualTransferCorrectness.status, "incomplete");
  assert.equal(report.actualTransferCorrectness.oracle.perStepEvaluation.incorrect > 0, true);
  assert.equal(report.actualTransferCorrectness.oracle.violations.length > 0, true);
});

test("label-missing samples are excluded from the denominator but retained as evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-transfer-label-missing-"));
  const modelPath = await packagePath(root);
  const verification = await verificationDir(root, {
    tsjsFacts: facts("label-missing"),
    rustFacts: facts("label-missing"),
    episodes: [episode("known-correct"), episode("label-missing")],
  });
  const oracle = await oraclePath(root, [
    oracleSample("known-correct", { gold: "true" }),
    oracleSample("label-missing", { gold: "false", labelMissing: true }),
  ]);

  const report = await evaluateUnifiedTransfer({
    packagePath: modelPath,
    verificationPath: verification,
    oraclePath: oracle,
  });

  assert.equal(report.actualTransferCorrectness.oracle.gold.total, 1);
  assert.equal(report.actualTransferCorrectness.oracle.gold.labelMissingExcluded, 1);
  assert.deepEqual(
    report.actualTransferCorrectness.labelMissingSamples.map(sample => sample.sampleId),
    ["label-missing"],
  );
  assert.equal(report.actualTransferCorrectness.status, "incomplete");
});
