import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  UNIFIED_SUPERVISION_ROW_SCHEMA,
  convertGoldToSupervisionRow,
  loadGoldFamily,
  SupervisionConverterError,
} from "../dist/training/unified-supervision-converter.js";

function goldFixture(overrides = {}) {
  return {
    sampleId: "sample-1",
    sourceGroup: "source-group",
    partition: "train",
    labelMissing: false,
    unknownReason: null,
    goldAction: "c:judge:true",
    labelAuthority: "researcher_structural_proof",
    oracleKind: "independent_tsc",
    ...overrides,
  };
}

test("gold maps to a matched group id and A_g", () => {
  const row = convertGoldToSupervisionRow(goldFixture());
  assert.equal(row.schema, UNIFIED_SUPERVISION_ROW_SCHEMA);
  assert.equal(row.group_id, "source-group|sample-1|ctx:sample-1:step:0|cg:sample-1:step:0:0");
  assert.deepEqual(row.goldAllowedCandidateRefs, ["c:judge:true"]);
  assert.equal(row.teacherResolutionRef, "teacher:sample-1");
  assert.ok(!("input" in row));
  assert.ok(!("x" in row));
});

test("unknown gold keeps unknown reason and maps the unknown judge", () => {
  const row = convertGoldToSupervisionRow(goldFixture({
    goldAction: "c:judge:unknown",
    unknownReason: "evidence_insufficient",
  }));
  assert.deepEqual(row.goldAllowedCandidateRefs, ["c:judge:unknown"]);
  assert.equal(row.unknownReason, "evidence_insufficient");
});

test("labelMissing supervision is preserved with empty A_g", () => {
  const row = convertGoldToSupervisionRow(goldFixture({ labelMissing: true, goldAction: "" }));
  assert.equal(row.labelMissing, true);
  assert.deepEqual(row.goldAllowedCandidateRefs, []);
});

test("non-judge non-missing supervision is rejected", () => {
  assert.throws(
    () => convertGoldToSupervisionRow(goldFixture({ goldAction: "c:observe:settings" })),
    error => error instanceof SupervisionConverterError,
  );
});

test("loader reads independent gold records", async () => {
  const root = await mkdtemp(join(tmpdir(), "supervision-converter-"));
  try {
    const labels = join(root, "labels");
    await mkdir(labels, { recursive: true });
    await writeFile(join(labels, "gold.jsonl"), `${JSON.stringify(goldFixture())}\n`);
    const records = await loadGoldFamily(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].sampleId, "sample-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
