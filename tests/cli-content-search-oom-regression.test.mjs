// Regression gate for the directory text-coverage OOM: the recursive-goal
// engine deep-clones the whole content-search state after every atomic step.
// When the deposited candidate read fact echoed the raw file chunk, each state
// snapshot grew with every scanned byte and a real repository scope exhausted
// the V8 heap. The scan verdict only needs the scalar read metadata, so the
// deposited state must not carry the raw bytes; the read receipts keep them.
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function routingProfile(goal) {
  const heads = goal.CLI_COMMAND_HEADS;
  const wires = goal.CLI_COMMAND_WIRES;
  const weights = heads.map(() => wires.map(() => 0));
  const set = (head, wire) => {
    const row = heads.indexOf(head);
    const column = wires.indexOf(wire);
    assert.ok(row >= 0 && column >= 0, `unknown text-scan route ${head} x ${wire}`);
    weights[row][column] = 1;
  };
  set("ls", "goalListDirectory");
  set("ls", "property.directory.entries");
  set("ls", "predicate.observe.entries");
  set("entry.inspect", "property.type");
  set("entry.inspect", "predicate.observe.inspect");
  return goal.validateCliCommandProfile({
    contract: "cli.command-policy.v1",
    heads: [...heads],
    properties: [...goal.CLI_COMMAND_PROPERTIES],
    predicates: [...goal.CLI_COMMAND_PREDICATES],
    wires: [...wires],
    weights,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

test("directory text coverage keeps raw read bytes out of the deposited state", async t => {
  const search = await import("nnanything/cli-content-search");
  const goal = await import("nnanything/cli-goal");
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-oom-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const needle = "needle-token";
  const entries = [
    { path: "src", kind: "directory" },
    { path: "src/entry.ts", kind: "file", contents: `export function entry(){ return "${needle}"; }\n` },
    ...Array.from({ length: 6 }, (_, index) => ({
      path: `src/plain-${index}.ts`,
      kind: "file",
      contents: `export const value${index} = ${index};\n`,
    })),
  ];
  const sandbox = await search.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "content-search-oom-regression",
      entries,
      sessions: [{ id: "s", cwd: "src", grantedEffects: ["filesystem.read", "process.exec"] }],
    },
  });
  t.after(async () => {
    await sandbox.cleanup();
  });

  const session = sandbox.bindSession("s");
  const directory = await sandbox.bindDirectory(session, ".");
  const result = await search.runCliContentSearchGoal({
    requestId: "content-search-oom-regression",
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: ".ts" },
        cardinality: "all",
        recursion: "nested",
      },
      requirement: { kind: "contains", predicate: { kind: "contains", needle, encoding: "utf8" } },
    },
    satisfactionThreshold: 100,
  }, {
    sandbox,
    session,
    profile: routingProfile(goal),
    scan: Object.freeze({
      maxBytesPerFile: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      chunkSize: 64 * 1024,
      maxDirectoryDepth: 8,
      maxStaleRetries: 1,
    }),
  });

  assert.equal(result.domain.status, "achieved");
  assert.equal(result.domain.matches.length, 1);
  assert.equal(result.domain.matches[0].path, join(sandbox.getSession(session).cwd, "entry.ts"));
  assert.equal(result.domain.coverage, "complete");
  assert.ok(result.domain.bytesReadTotal > 0);

  const states = result.response.report.states;
  const lastState = states[states.length - 1].value;
  const readCandidates = lastState.candidates.filter(candidate => candidate.read !== null);
  assert.ok(readCandidates.length >= 6, `expected read candidates, saw ${readCandidates.length}`);

  const readReceipts = result.response.report.atomicResults
    .map(atomic => atomic.sourceResult)
    .filter(source => source !== null && source.tag === "cli.file.read.receipt.v1");
  assert.ok(readReceipts.length >= 6, `expected read receipts, saw ${readReceipts.length}`);
  const receiptRunIds = new Set(readReceipts.map(source => source.value.receipt.execution.runId));

  for (const candidate of readCandidates) {
    const read = candidate.read;
    assert.equal(
      read.kind,
      "cli.content-search.read-state-ref.v1",
      `state read for ${candidate.path} must use the explicit receipt reference`,
    );
    assert.ok(
      !Object.hasOwn(read, "bytes"),
      `empty bytes string used as state read for ${candidate.path}`,
    );
    assert.equal(read.bytesRef.kind, "cli.file.read.receipt.v1",
      `state read for ${candidate.path} must reference the read receipt kind`);
    assert.equal(typeof read.bytesRef.runId, "string");
    assert.ok(read.bytesRef.runId.length > 0, `state read for ${candidate.path} must name a receipt run`);
    assert.ok(receiptRunIds.has(read.bytesRef.runId),
      `state read for ${candidate.path} references a missing receipt run ${read.bytesRef.runId}`);
    assert.ok(read.bytesRead > 0, `state read for ${candidate.path} must retain the observed byte count`);
    assert.equal(typeof read.offset, "number");
    assert.equal(typeof read.length, "number");
    assert.equal(typeof read.size, "number");
    assert.equal(typeof read.eof, "boolean");
    assert.ok(read.identity.dev !== null && read.identity.dev !== undefined,
      `state read for ${candidate.path} must retain the device identity`);
    assert.ok(read.identity.ino !== null && read.identity.ino !== undefined,
      `state read for ${candidate.path} must retain the inode identity`);
  }

  for (const source of readReceipts) {
    const observation = source.value.receipt.execution.observation;
    assert.equal(observation.kind, "file.read");
    assert.ok(observation.bytes.length > 0, "read receipts must keep the observed bytes");
  }
});
