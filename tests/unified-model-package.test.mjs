import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_INCOMPATIBLE,
  MODEL_NOT_FOUND,
  createUnifiedModelPackage,
  loadUnifiedModelPackageFromFile,
  saveUnifiedModelPackageAtomic,
  validateUnifiedModelPackage,
} from "../dist/training/unified-model-package.js";
import { createXavierTensors } from "../dist/training/unified-forward.js";

const resources = {
  thresholdsRef: "feature-thresholds-r-unified-step-encoder-v2.json",
  thresholdsSchema: "nnanything.feature-thresholds.v1",
  missingModeTableRef: "missing-mode-table.json",
  missingModeSchema: "nnanything.unified.missing-mode.v1",
};

function packageFor(tensors) {
  return createUnifiedModelPackage({
    modelId: "unified-step",
    version: "1",
    route: { domain: "tsjs", decisionKind: "R" },
    tensors,
    resources,
    fixedStages: ["nnanything.unified-step.encoder.v2"],
  });
}

test("package survives atomic save and new-process reload shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unified-package-"));
  const tensors = createXavierTensors(42);
  const pkg = packageFor(tensors);
  await writeFile(join(dir, resources.thresholdsRef), "{}\n");
  await writeFile(join(dir, resources.missingModeTableRef), "{}\n");
  const path = await saveUnifiedModelPackageAtomic(join(dir, "package.json"), pkg);
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(validateUnifiedModelPackage(raw), pkg);
  const loaded = await loadUnifiedModelPackageFromFile(path);
  assert.equal(loaded.package.modelId, pkg.modelId);
  assert.equal(loaded.resolvedResources.thresholdsPath, join(dir, resources.thresholdsRef));
  assert.equal(loaded.resolvedResources.missingModeTablePath, join(dir, resources.missingModeTableRef));
});

test("threshold and missing-mode refs must resolve during package load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unified-package-missing-"));
  const path = await saveUnifiedModelPackageAtomic(join(dir, "package.json"), packageFor(createXavierTensors(9)));
  await assert.rejects(
    () => loadUnifiedModelPackageFromFile(path),
    (error) => error.code === MODEL_NOT_FOUND && error.detail.resource === "thresholds",
  );
  await writeFile(join(dir, resources.thresholdsRef), "{}\n");
  await assert.rejects(
    () => loadUnifiedModelPackageFromFile(path),
    (error) => error.code === MODEL_NOT_FOUND && error.detail.resource === "missingModeTable",
  );
});

test("incompatible schemas and tensor shapes are rejected", () => {
  const pkg = packageFor(createXavierTensors(1));
  assert.throws(() => validateUnifiedModelPackage({ ...pkg, schema: "cli.hybrid-package.v1" }),
    (error) => error.code === MODEL_INCOMPATIBLE);
  assert.throws(() => validateUnifiedModelPackage({ ...pkg, inputSchema: "old.v0" }),
    (error) => error.code === MODEL_INCOMPATIBLE);
  assert.throws(() => validateUnifiedModelPackage({ ...pkg, encoderVersion: "old.encoder" }),
    (error) => error.code === MODEL_INCOMPATIBLE);
  assert.throws(() => validateUnifiedModelPackage({
    ...pkg,
    architecture: { ...pkg.architecture, hidden: [32, 64] },
  }), (error) => error.code === MODEL_INCOMPATIBLE);
  assert.throws(() => validateUnifiedModelPackage({
    ...pkg,
    tensors: { ...pkg.tensors, W1: pkg.tensors.W1.slice(1) },
  }), (error) => error.code === MODEL_INCOMPATIBLE);
});

test("binding is immutable and a late package change cannot steal a request version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unified-package-bind-"));
  const path = await saveUnifiedModelPackageAtomic(
    join(dir, "package.json"),
    packageFor(createXavierTensors(3)),
  );
  await writeFile(join(dir, resources.thresholdsRef), "{}\n");
  await writeFile(join(dir, resources.missingModeTableRef), "{}\n");

  const loaded = await loadUnifiedModelPackageFromFile(path);
  const binding = loaded.bind();
  assert.equal(binding.version, "1");
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.tensors.W1), true);

  const next = { ...loaded.package, version: "2" };
  await saveUnifiedModelPackageAtomic(path, next);
  assert.equal(binding.version, "1");
  assert.equal((await loadUnifiedModelPackageFromFile(path)).package.version, "2");
});
