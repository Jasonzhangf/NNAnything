import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Contract: `eof` stays a short-read flag (bytesRead < length) and never claims
// the real file end. The real end is a separate observed fact:
//   end_observed = offset + bytesRead >= size
// Zero-length reads use the same rule (offset >= size), so an empty file at
// offset 0 reports end_observed true while eof stays false.
//
// Counterexamples were measured against the real sandbox; see
// nnanything-runs/cli-read-feedback-plan-20261024/facts/file-read-eof-facts.json.

const api = () => import("../dist/cli-goal.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nn-file-read-end-observed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = await api();
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "end-observed",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/placeholder.bin", kind: "file", contents: "x" },
      ],
      sessions: [{ id: "s", cwd: "start", grantedEffects: ["filesystem.read"] }],
    },
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  return { sandbox, session, startAbs: sandbox.getSession(session).cwd };
}

async function readRange(fx, name, bytes, offset, length) {
  const absolute = join(fx.startAbs, name);
  await writeFile(absolute, bytes);
  const ref = await fx.sandbox.bindFile(fx.session, absolute);
  const receipt = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref, offset, length },
  });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.execution.status, "succeeded");
  return receipt.execution.observation;
}

test("empty file, zero-length read: eof false, end_observed true", async t => {
  const fx = await fixture(t);
  const observation = await readRange(fx, "empty.bin", Buffer.alloc(0), 0, 0);
  assert.equal(observation.size, 0);
  assert.equal(observation.bytesRead, 0);
  assert.equal(observation.eof, false, "eof is the short-read flag, not the file end");
  assert.equal(observation.end_observed, true, "offset 0 on an empty file reaches the end");
});

test("empty file, non-zero-length read: short read eof true, end_observed true", async t => {
  const fx = await fixture(t);
  const observation = await readRange(fx, "empty.bin", Buffer.alloc(0), 0, 4);
  assert.equal(observation.size, 0);
  assert.equal(observation.bytesRead, 0);
  assert.equal(observation.eof, true, "requested 4 bytes but got 0");
  assert.equal(observation.end_observed, true);
});

test("prefix read of a larger file: not eof, not end_observed", async t => {
  const fx = await fixture(t);
  const observation = await readRange(fx, "eight.bin", Buffer.from("abcdefgh"), 0, 4);
  assert.equal(observation.size, 8);
  assert.equal(observation.bytesRead, 4);
  assert.equal(observation.eof, false);
  assert.equal(observation.end_observed, false, "bytes 0..4 do not reach the end of an 8-byte file");
});

test("read ending exactly at the end: eof false but end_observed true", async t => {
  const fx = await fixture(t);
  const observation = await readRange(fx, "eight.bin", Buffer.from("abcdefgh"), 4, 4);
  assert.equal(observation.bytesRead, 4);
  assert.equal(observation.eof, false, "the requested range was filled, so this is not a short read");
  assert.equal(observation.end_observed, true, "offset 4 + 4 bytes reaches size 8");
});

test("read starting at the end: empty bytes, eof true, end_observed true", async t => {
  const fx = await fixture(t);
  const observation = await readRange(fx, "eight.bin", Buffer.from("abcdefgh"), 8, 4);
  assert.equal(observation.bytesRead, 0);
  assert.equal(observation.eof, true);
  assert.equal(observation.end_observed, true, "there is nothing at or after the end");
});

test("reading past the end clamps bytesRead and still reports the end", async t => {
  const fx = await fixture(t);
  const observation = await readRange(fx, "eight.bin", Buffer.from("abcdefgh"), 4, 8);
  assert.equal(observation.bytesRead, 4);
  assert.equal(observation.eof, true, "requested 8 bytes, got 4");
  assert.equal(observation.end_observed, true, "offset 4 + 4 clamped bytes reaches size 8");
});

test("whole-file read of a small file: full payload, end_observed true", async t => {
  const fx = await fixture(t);
  const observation = await readRange(fx, "four.bin", Buffer.from("abcd"), 0, 4);
  assert.equal(observation.size, 4);
  assert.equal(observation.bytesRead, 4);
  assert.equal(Buffer.from(observation.bytes, "base64").toString("utf8"), "abcd");
  assert.equal(observation.eof, false);
  assert.equal(observation.end_observed, true);
});

test("end_observed always agrees with offset + bytesRead >= size", async t => {
  const fx = await fixture(t);
  const cases = [
    ["a.bin", Buffer.from("abcdefgh"), 0, 0],
    ["a.bin", Buffer.from("abcdefgh"), 0, 3],
    ["a.bin", Buffer.from("abcdefgh"), 3, 5],
    ["a.bin", Buffer.from("abcdefgh"), 8, 2],
    ["a.bin", Buffer.from("abcdefgh"), 9, 2],
    ["b.bin", Buffer.from("ab"), 0, 2],
  ];
  for (const [name, bytes, offset, length] of cases) {
    const observation = await readRange(fx, name, bytes, offset, length);
    const expected = offset + observation.bytesRead >= observation.size;
    assert.equal(
      observation.end_observed,
      expected,
      `${name} offset=${offset} length=${length} bytesRead=${observation.bytesRead} size=${observation.size}`,
    );
    assert.equal(
      observation.eof,
      observation.bytesRead < length,
      `${name} offset=${offset} length=${length} must keep eof as the short-read flag`,
    );
  }
});
