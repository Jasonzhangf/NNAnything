import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const consumerUrl = new URL("../playground/browser/file-weight.mjs", import.meta.url);

test("public local file consumer rereads A, B, atomic A, failures, and restore", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "nnanything-file-weight-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const { verifyFileWeightLifecycle } = await import(consumerUrl);
  const result = await verifyFileWeightLifecycle(tempDir);

  assert.equal(result.sameProfileId, true);
  assert.notDeepEqual(
    [
      result.firstResult.judgmentStatus,
      result.firstResult.basicKind,
      result.firstResult.score,
    ],
    [
      result.secondResult.judgmentStatus,
      result.secondResult.basicKind,
      result.secondResult.score,
    ],
  );
  assert.equal(result.restoredEqualsFirst, true);
  assert.deepEqual(
    [result.malformedRejected, result.incompatibleRejected, result.deletedRejected],
    [true, true, true],
  );
  assert.deepEqual(result.restoredResult, result.firstResult);
});
