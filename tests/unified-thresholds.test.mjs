import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bucket } from "../dist/training/unified-encoder.js";
import {
  loadFeatureThresholdsFromFile,
  loadMissingModeTableFromFile,
  validateFeatureThresholds,
  validateMissingModeTable,
} from "../dist/training/unified-thresholds.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "unified-64-slot");

const buckets = {
  constraints: [0, 1, 2, 4],
  knownFacts: [1, 2, 4, 8],
  missingFacts: [0, 1, 2, 4],
  objectRefs: [1, 2, 4, 8],
  requiredArgsRatio: [0, 0.25, 0.5, 1],
  requiredMissing: [0, 1, 2, 4],
};

function validResource() {
  return {
    schema: "nnanything.feature-thresholds.v1",
    route: "r",
    encoderVersion: "nnanything.unified-step.encoder.v1",
    buckets,
  };
}

test("feature threshold fixture loads and bucket math reproduces slot32", async () => {
  const loaded = await loadFeatureThresholdsFromFile(
    join(fixtures, "feature-thresholds-r-unified-step-encoder-v1.json"),
  );
  assert.deepEqual(loaded.buckets.requiredArgsRatio, [0, 0.25, 0.5, 1]);
  assert.equal(bucket(1.0, loaded.buckets.requiredArgsRatio), 0.75);
  assert.equal(bucket(0.25, loaded.buckets.requiredArgsRatio), 0.25);
  assert.equal(bucket(0.5, loaded.buckets.requiredArgsRatio), 0.5);
  assert.equal(bucket(0.75, loaded.buckets.requiredArgsRatio), 0.75);
});

test("missing required bucket is rejected, never defaulted", () => {
  const { requiredArgsRatio, ...rest } = buckets;
  assert.throws(
    () => validateFeatureThresholds({ ...validResource(), buckets: rest }),
    (error) => error.code === "THRESHOLD_INVALID",
  );
});

test("encoder version mismatch is rejected", () => {
  assert.throws(
    () => validateFeatureThresholds({ ...validResource(), encoderVersion: "nnanything.unified-step.encoder.v0" }),
    (error) => error.code === "THRESHOLD_INVALID",
  );
});

test("missing-mode table fixture validates and keeps only -1 fill", async () => {
  const loaded = await loadMissingModeTableFromFile(join(fixtures, "missing-mode-table.json"));
  assert.ok(loaded.entries.length > 0);
  assert.throws(
    () => validateMissingModeTable({
      ...loaded,
      entries: [{ ...loaded.entries[0], fill: 0 }],
    }),
    (error) => error.code === "THRESHOLD_INVALID",
  );
  assert.throws(
    () => validateMissingModeTable({
      ...loaded,
      entries: [{ ...loaded.entries[0], slotIndex: 64 }],
    }),
    (error) => error.code === "THRESHOLD_INVALID",
  );
});
