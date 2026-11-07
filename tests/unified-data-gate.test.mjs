import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNIFIED_DATA_GATE_SCHEMA,
  validateUnified64SlotTrainingData,
} from "../dist/training/unified-data-gate.js";

const here = new URL(".", import.meta.url);
const thresholdsPath = new URL("./fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json", here).pathname;

async function withRows(rows) {
  const dir = await mkdtemp(join(tmpdir(), "unified-data-gate-"));
  const rowsPath = join(dir, "rows.jsonl");
  await writeFile(
    rowsPath,
    rows.map(row => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
  return dir;
}

function row(overrides = {}) {
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

function config(dir) {
  return {
    schema: UNIFIED_DATA_GATE_SCHEMA,
    partition: "TRAIN",
    encoderVersion: "nnanything.unified-step.encoder.v2",
    thresholdsPath,
    rowsPath: join(dir, "rows.jsonl"),
  };
}

function withInput(slot, value) {
  return Array.from({ length: 64 }, (_, index) => (index === slot ? value : 0));
}

test("valid row with threshold => READY and learned row emitted", async () => {
  const dir = await withRows([row()]);
  const result = await validateUnified64SlotTrainingData(config(dir));
  assert.equal(result.status, "READY");
  assert.equal(result.counts.learnedRows, 1);
  assert.equal(result.counts.labelMissingExcluded, 0);
  assert.equal(result.violations.length, 0);
});

test("v1 config is explicitly rejected, not silently reinterpreted", async () => {
  const dir = await withRows([row()]);
  const result = await validateUnified64SlotTrainingData({
    ...config(dir),
    encoderVersion: "nnanything.unified-step.encoder.v1",
  });
  assert.equal(result.status, "DATA_INVALID");
  assert.ok(result.violations.some(v => v.reasonCode === "ROW_SCHEMA_INVALID"));
});

test("missing threshold is explicit DATA_INVALID, no learned rows", async () => {
  const dir = await withRows([row()]);
  const result = await validateUnified64SlotTrainingData({
    ...config(dir),
    thresholdsPath: join(dir, "missing-threshold.json"),
  });
  assert.equal(result.status, "DATA_INVALID");
  assert.equal(result.firstViolation.reasonCode, "THRESHOLD_MISSING");
});

test("truncated candidates are UNASSESSED with open cursor, not model errors", async () => {
  const dir = await withRows([
    row({
      rowId: "truncated",
      enumeration: "truncated",
      openCursorRef: "cursor:1",
      candidates: [],
      allowed: [],
      gold: "unknown",
    }),
  ]);
  const result = await validateUnified64SlotTrainingData(config(dir));
  assert.equal(result.unassessed.length, 1);
  assert.equal(result.unassessed[0].reason, "candidate_truncated");
  assert.equal(result.unassessed[0].openCursorRef, "cursor:1");
  assert.equal(result.status, "NO_LEARNED_ROWS");
});

test("empty A_g and A_g not subset of S_g are DATA_INVALID", async () => {
  const emptyAllowedDir = await withRows([row({ rowId: "empty-allowed", allowed: [] })]);
  const emptyAllowed = await validateUnified64SlotTrainingData(config(emptyAllowedDir));
  assert.equal(emptyAllowed.status, "DATA_INVALID");
  assert.ok(emptyAllowed.violations.some(v => v.reasonCode === "ALLOWED_EMPTY"));

  const notSubsetDir = await withRows([row({ rowId: "not-subset", allowed: ["c"] })]);
  const notSubset = await validateUnified64SlotTrainingData(config(notSubsetDir));
  assert.equal(notSubset.status, "DATA_INVALID");
  assert.ok(notSubset.violations.some(v => v.reasonCode === "ALLOWED_NOT_SUBSET"));
});

test("label missing is excluded; valid unknown gold is a separate denominator", async () => {
  const dir = await withRows([
    row({ rowId: "missing-label", labelMissing: true }),
    row({
      rowId: "unknown",
      candidates: ["unknown", "true"],
      allowed: ["unknown"],
      gold: "unknown",
    }),
  ]);
  const result = await validateUnified64SlotTrainingData(config(dir));
  assert.equal(result.status, "READY");
  assert.equal(result.counts.labelMissingExcluded, 1);
  assert.equal(result.counts.unknownGoldRows, 1);
});

test("teacher chain and undeclared missing fill are rejected", async () => {
  const teacherDir = await withRows([row({ teacherChain: ["decl"] })]);
  const teacher = await validateUnified64SlotTrainingData(config(teacherDir));
  assert.equal(teacher.status, "DATA_INVALID");
  assert.ok(teacher.violations.some(v => v.reasonCode === "TEACHER_LEAKAGE"));

  const missingDir = await withRows([
    row({
      input: Array.from({ length: 64 }, (_, i) => (i === 3 ? -1 : 0)),
    }),
  ]);
  const missing = await validateUnified64SlotTrainingData(config(missingDir));
  assert.equal(missing.status, "DATA_INVALID");
  assert.ok(missing.violations.some(v => v.reasonCode === "MISSING_FILLED"));
});

test("missing mode declaration and vector are validated in both directions", async () => {
  for (const value of [0, 0.5]) {
    const dir = await withRows([row({
      input: withInput(3, value),
      missingMode: [{ slotIndex: 3, reason: "not_requested", fill: -1 }],
    })]);
    const result = await validateUnified64SlotTrainingData(config(dir));
    assert.equal(result.status, "DATA_INVALID");
    assert.ok(result.violations.some(v =>
      v.reasonCode === "MISSING_FILLED" && v.message.includes("in input 3")
    ));
  }
});

test("missing mode entry schema is explicit and not silently ignored", async () => {
  const badEntries = [
    { slotIndex: 64, reason: "not_requested", fill: -1 },
    { slotIndex: 1.5, reason: "not_requested", fill: -1 },
    null,
    { slotIndex: 3, reason: "not_requested", fill: 0 },
    { slotIndex: 3, reason: "", fill: -1 },
    { slotIndex: 3, reason: undefined, fill: -1 },
  ];
  for (const badEntry of badEntries) {
    const dir = await withRows([row({ missingMode: [badEntry] })]);
    const result = await validateUnified64SlotTrainingData(config(dir));
    assert.equal(result.status, "DATA_INVALID");
    assert.ok(result.violations.some(v =>
      v.reasonCode === "ROW_SCHEMA_INVALID" && v.message.includes("missingMode")
    ));
  }

  const nonArrayDir = await withRows([row({ missingMode: "not-an-array" })]);
  const nonArray = await validateUnified64SlotTrainingData(config(nonArrayDir));
  assert.equal(nonArray.status, "DATA_INVALID");
  assert.ok(nonArray.violations.some(v => v.reasonCode === "ROW_SCHEMA_INVALID"));
});

test("declared missing slot and normal finite values pass", async () => {
  const missingDir = await withRows([row({
    input: withInput(3, -1),
    missingMode: [{ slotIndex: 3, reason: "not_requested", fill: -1 }],
  })]);
  const missing = await validateUnified64SlotTrainingData(config(missingDir));
  assert.equal(missing.status, "READY");

  const normalDir = await withRows([row({ input: withInput(3, 0.5) })]);
  const normal = await validateUnified64SlotTrainingData(config(normalDir));
  assert.equal(normal.status, "READY");
});

test("same student input with different gold is a supervision conflict, not silently fitted", async () => {
  const dir = await withRows([
    row({ rowId: "gold-true", allowed: ["a"], gold: "a" }),
    row({ rowId: "gold-b", allowed: ["b"], gold: "b" }),
  ]);
  const result = await validateUnified64SlotTrainingData(config(dir));
  assert.equal(result.status, "DATA_INVALID");
  assert.equal(result.counts.learnedRows, 0);
  assert.ok(result.violations.some(v =>
    v.reasonCode === "SUPERVISION_CONFLICT" && v.message.includes("gold-true") && v.message.includes("gold-b")
  ));
});

test("candidate-group vectors decide conflict when the full group input is present", async () => {
  const first = Array.from({ length: 64 }, () => 0);
  const second = Array.from({ length: 64 }, (_, index) => (index === 45 ? index / 100 : 0));
  const dir = await withRows([
    row({
      rowId: "gold-true",
      allowed: ["a"],
      gold: "a",
      candidateInputs: [
        { candidateRef: "a", input: first },
        { candidateRef: "b", input: first },
      ],
    }),
    row({
      rowId: "gold-b",
      allowed: ["b"],
      gold: "b",
      candidateInputs: [
        { candidateRef: "a", input: first },
        { candidateRef: "b", input: second },
      ],
    }),
  ]);
  const result = await validateUnified64SlotTrainingData(config(dir));
  assert.equal(result.status, "READY");
  assert.equal(result.violations.length, 0);
});
