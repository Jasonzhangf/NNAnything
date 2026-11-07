import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  StepwiseEntryFileMappingError,
  resolveEntryFileFromSourceEpisode,
} from "../dist/training/stepwise-entry-file-mapping.js";

async function withFamilyDir(rows, run) {
  const root = await mkdtemp(join(tmpdir(), "stepwise-entry-file-"));
  try {
    const episodePath = join(root, "episode-sample-a.jsonl");
    await writeFile(episodePath, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("extracts only the whitelisted entryFile from the matching episode record", async () => {
  await withFamilyDir(
    [{
      sampleId: "sample-a",
      sourceGroup: "tsjs-family-a",
      entryFile: "sources/src/closure.ts",
      label: "true",
      oracleRef: "evidence/oracle.json#sample-a",
    }],
    async familyDir => {
      const mapping = await resolveEntryFileFromSourceEpisode(familyDir, "tsjs-family-a", "sample-a");
      assert.equal(mapping.entryFile, "sources/src/closure.ts");
      assert.equal(mapping.sourcePath, join(familyDir, "episode-sample-a.jsonl"));
      assert.deepEqual(Object.keys(mapping).sort(), ["entryFile", "sourcePath"]);
    },
  );
});

test("accepts an identical existing entryFile and rejects a conflicting one", async () => {
  await withFamilyDir(
    [{ sampleId: "sample-a", sourceGroup: "tsjs-family-a", entryFile: "sources/src/closure.ts" }],
    async familyDir => {
      const same = await resolveEntryFileFromSourceEpisode(
        familyDir,
        "tsjs-family-a",
        "sample-a",
        "sources/src/closure.ts",
      );
      assert.equal(same.entryFile, "sources/src/closure.ts");
      await assert.rejects(
        resolveEntryFileFromSourceEpisode(familyDir, "tsjs-family-a", "sample-a", "sources/src/other.ts"),
        error => error instanceof StepwiseEntryFileMappingError
          && error.code === "DATA_INVALID"
          && /entryFile conflict/.test(error.message),
      );
    },
  );
});

test("rejects an empty entryFile and a matching record that is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "stepwise-entry-file-"));
  try {
    await writeFile(
      join(root, "episode-sample-a.jsonl"),
      `${JSON.stringify({ sampleId: "sample-a", sourceGroup: "tsjs-family-a", entryFile: "" })}\n`,
      "utf8",
    );
    await writeFile(
      join(root, "episode-sample-b.jsonl"),
      `${JSON.stringify({ sampleId: "other", sourceGroup: "tsjs-family-a", entryFile: "sources/src/x.ts" })}\n`,
      "utf8",
    );
    await assert.rejects(
      resolveEntryFileFromSourceEpisode(root, "tsjs-family-a", "sample-a"),
      error => error instanceof StepwiseEntryFileMappingError
        && /entryFile must be an explicit non-empty string/.test(error.message),
    );
    await assert.rejects(
      resolveEntryFileFromSourceEpisode(root, "tsjs-family-a", "sample-b"),
      error => error instanceof StepwiseEntryFileMappingError
        && /has no record for sample sample-b/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate matching records for the same sample", async () => {
  await withFamilyDir(
    [
      { sampleId: "sample-a", sourceGroup: "tsjs-family-a", entryFile: "sources/src/a.ts" },
      { sampleId: "sample-a", sourceGroup: "tsjs-family-a", entryFile: "sources/src/b.ts" },
    ],
    async familyDir => {
      await assert.rejects(
        resolveEntryFileFromSourceEpisode(familyDir, "tsjs-family-a", "sample-a"),
        error => error instanceof StepwiseEntryFileMappingError
          && /has 2 records for sample sample-a/.test(error.message),
      );
    },
  );
});

test("rejects a sourceGroup mismatch for the same sampleId", async () => {
  await withFamilyDir(
    [{
      sampleId: "sample-a",
      sourceGroup: "tsjs-family-b",
      entryFile: "sources/src/other.ts",
    }],
    async familyDir => {
      await assert.rejects(
        resolveEntryFileFromSourceEpisode(familyDir, "tsjs-family-a", "sample-a"),
        error => error instanceof StepwiseEntryFileMappingError
          && error.code === "DATA_INVALID"
          && /sourceGroup mismatch/.test(error.message),
      );
    },
  );
});

test("resolves the correct family for the same sampleId across sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "stepwise-entry-file-cross-"));
  try {
    const familyA = join(root, "family-a");
    const familyB = join(root, "family-b");
    await mkdir(familyA);
    await mkdir(familyB);
    await writeFile(
      join(familyA, "episode-sample-a.jsonl"),
      `${JSON.stringify({ sampleId: "sample-a", sourceGroup: "tsjs-family-a", entryFile: "sources/src/a.ts" })}\n`,
      "utf8",
    );
    await writeFile(
      join(familyB, "episode-sample-a.jsonl"),
      `${JSON.stringify({ sampleId: "sample-a", sourceGroup: "tsjs-family-b", entryFile: "sources/src/b.ts" })}\n`,
      "utf8",
    );
    const a = await resolveEntryFileFromSourceEpisode(familyA, "tsjs-family-a", "sample-a");
    const b = await resolveEntryFileFromSourceEpisode(familyB, "tsjs-family-b", "sample-a");
    assert.equal(a.entryFile, "sources/src/a.ts");
    assert.equal(b.entryFile, "sources/src/b.ts");
    await assert.rejects(
      resolveEntryFileFromSourceEpisode(familyA, "tsjs-family-b", "sample-a"),
      error => error instanceof StepwiseEntryFileMappingError
        && /sourceGroup mismatch/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
