import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCliFilesystemSandbox,
  readSemanticCliCall,
} from "../dist/adapters/cli/filesystem-sandbox.js";
import {
  createIncrementalStreamParser,
} from "../dist/adapters/cli/directory-command-search.js";

const S = Object.freeze({
  id: "s",
  cwd: ".",
  grantedEffects: ["filesystem.read", "process.exec"],
});

const SESSION_REF = Object.freeze({ kind: "cli.session", scenarioId: "x", sessionId: "s" });
const DIRECTORY_REF = Object.freeze({
  kind: "cli.directory",
  scenarioId: "x",
  sessionId: "s",
  path: "scan",
});

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-sc-sandbox-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId ?? "sc-sandbox",
      entries: options.entries ?? [],
      sessions: options.sessions ?? [S],
    },
    ...(options.commandSearchCapabilities === undefined
      ? {}
      : { commandSearchCapabilities: options.commandSearchCapabilities }),
  });
  t.after(async () => {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return {
    sandbox,
    root,
    scenarioRoot: sandbox.scenarioRoot,
    session: sandbox.bindSession(options.sessionId ?? "s"),
  };
}

function treeEntries() {
  return [
    { path: "scan", kind: "directory" },
    { path: "scan/deep", kind: "directory" },
    { path: "scan/amber.txt", kind: "file", contents: "alpha\nquarryMark here\n" },
    { path: "scan/deep/quartz.log", kind: "file", contents: "quarryMark deep\n" },
    { path: "scan/notes.md", kind: "file", contents: "quarryMark md\n" },
  ];
}

function parse(parser, chunks) {
  for (const chunk of chunks) parser.pushChunk(Buffer.from(chunk, "utf8"));
  return parser.finish();
}

test("T0 incremental parser keeps records split across chunks", () => {
  const rgLine = `${JSON.stringify({
    type: "match",
    data: { path: { text: "./amber.txt" }, lines: { text: "quarryMark\n" }, line_number: 2 },
  })}\n`;
  const split = createIncrementalStreamParser({
    toolUsed: "rg",
    scopeRoot: "/scenario",
    fileFilter: { suffix: ".txt" },
  });
  const rgResult = parse(split, [
    rgLine.slice(0, 17),
    rgLine.slice(17, 43),
    rgLine.slice(43),
  ]);
  assert.deepEqual(rgResult.matchedEntries, ["amber.txt"]);
  assert.equal(rgResult.matchedLines.length, 1);
  assert.equal(rgResult.matchedLines[0].lineNumber, 2);
  assert.equal(rgResult.matchedLines[0].matchedLineHasTrailingLF, true);
  assert.ok(rgResult.crossChunkRecordSplits > 0);
  assert.equal(rgResult.unterminatedFragmentDiscarded, false);

  const grepLine = "./amber.txt\0" + "2:" + "quarryMark here" + "\n";
  const grepResult = parse(
    createIncrementalStreamParser({ toolUsed: "grep_bsd", scopeRoot: "/scenario", fileFilter: null }),
    [grepLine.slice(0, 6), grepLine.slice(6, 19), grepLine.slice(19)],
  );
  assert.deepEqual(grepResult.matchedEntries, ["amber.txt"]);
  assert.equal(grepResult.matchedLines[0].lineNumber, 2);
  assert.ok(grepResult.crossChunkRecordSplits > 0);

  const filesResult = parse(
    createIncrementalStreamParser({ toolUsed: "rg_files", scopeRoot: "/scenario", fileFilter: null }),
    ["amber.txt\0deep/qu", "artz.txt\0"],
  );
  assert.deepEqual(filesResult.matchedEntries, ["amber.txt", "deep/quartz.txt"]);
  assert.ok(filesResult.crossChunkRecordSplits > 0);
});

test("T0b unterminated fragments never become fake matches", () => {
  const rgLine = `${JSON.stringify({
    type: "match",
    data: { path: { text: "./amber.txt" }, lines: { text: "quarryMark\n" }, line_number: 1 },
  })}\n`;
  const rgFragment = createIncrementalStreamParser({
    toolUsed: "rg",
    scopeRoot: "/scenario",
    fileFilter: null,
  });
  const rgResult = parse(rgFragment, [rgLine.slice(0, rgLine.length - 8)]);
  assert.deepEqual(rgResult.matchedEntries, []);
  assert.equal(rgResult.matchedLines.length, 0);
  assert.ok(rgResult.unterminatedRemainderBytes > 0);
  assert.equal(rgResult.unterminatedFragmentDiscarded, true);

  const grepFragment = createIncrementalStreamParser({
    toolUsed: "grep_bsd",
    scopeRoot: "/scenario",
    fileFilter: null,
  });
  const grepResult = parse(grepFragment, ["./amber.txt\0" + "1:" + "quarryMark"]);
  assert.deepEqual(grepResult.matchedEntries, []);
  assert.equal(grepResult.unterminatedFragmentDiscarded, true);

  const filesFragment = createIncrementalStreamParser({
    toolUsed: "find_P",
    scopeRoot: "/scenario",
    fileFilter: null,
  });
  const filesResult = parse(filesFragment, ["amber.txt\0deep/quar"]);
  assert.deepEqual(filesResult.matchedEntries, ["amber.txt"]);
  assert.equal(filesResult.unterminatedFragmentDiscarded, true);
});

test("T1 real rg search executes through sandbox with zero probe spawns", async t => {
  const fx = await fixture(t, { scenarioId: "sc-rg", entries: treeEntries() });
  const directory = await fx.sandbox.bindDirectory(fx.session, "scan");

  const entries = await fx.sandbox.execute({
    operation: "directory.search.entries",
    parameters: {
      session: fx.session,
      directory,
      fileFilter: { suffix: ".log" },
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(entries.status, "succeeded");
  const entriesObservation = entries.execution.observation;
  assert.equal(entriesObservation.kind, "directory.search.entries");
  assert.equal(entriesObservation.toolUsed, "rg_files");
  assert.deepEqual(entriesObservation.matchedEntries, ["deep/quartz.log"]);
  assert.equal(entriesObservation.exitCode, 0);
  assert.equal(entriesObservation.normalCompleted, true);
  assert.equal(entriesObservation.coverage, "complete");
  assert.equal(entriesObservation.queryMatches, 1);
  assert.equal(entriesObservation.spawnLedger.length, 1);
  assert.equal(entriesObservation.spawnLedger[0].purpose, "search_command");
  assert.ok(entriesObservation.argv.includes("--files"));

  const content = await fx.sandbox.execute({
    operation: "directory.search.content",
    parameters: {
      session: fx.session,
      directory,
      queryLiteral: "quarryMark",
      fileFilter: { suffix: ".txt" },
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(content.status, "succeeded");
  const contentObservation = content.execution.observation;
  assert.equal(contentObservation.kind, "directory.search.content");
  assert.equal(contentObservation.toolUsed, "rg");
  assert.deepEqual(contentObservation.matchedEntries, ["amber.txt"]);
  assert.equal(contentObservation.matchedLines.length, 1);
  assert.equal(contentObservation.matchedLines[0].lineNumber, 2);
  assert.equal(contentObservation.matchedLines[0].lineText, "quarryMark here");
  assert.equal(contentObservation.spawnLedger.filter(item => item.purpose === "probe_grep_version").length, 0);

  const noMatch = await fx.sandbox.execute({
    operation: "directory.search.content",
    parameters: {
      session: fx.session,
      directory,
      queryLiteral: "absentLiteral",
      fileFilter: null,
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(noMatch.status, "succeeded");
  const noMatchObservation = noMatch.execution.observation;
  assert.equal(noMatchObservation.kind, "directory.search.content");
  assert.equal(noMatchObservation.exitCode, 1);
  assert.equal(noMatchObservation.normalCompleted, true);
  assert.equal(noMatchObservation.coverage, "complete");
  assert.deepEqual(noMatchObservation.matchedEntries, []);

  const all = await fx.sandbox.execute({
    operation: "directory.search.entries",
    parameters: {
      session: fx.session,
      directory,
      fileFilter: null,
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(all.status, "succeeded");
  assert.deepEqual(all.execution.observation.matchedEntries, [
    "amber.txt",
    "deep/quartz.log",
    "notes.md",
  ]);
});

test("T2 explicit stdout limit marks coverage partial and names the reason", async t => {
  const fx = await fixture(t, { scenarioId: "sc-truncate", entries: treeEntries() });
  const directory = await fx.sandbox.bindDirectory(fx.session, "scan");
  const receipt = await fx.sandbox.execute({
    operation: "directory.search.content",
    parameters: {
      session: fx.session,
      directory,
      queryLiteral: "quarryMark",
      fileFilter: null,
      ignorePolicy: "no_ignore",
      explicitLimits: { maxStdoutBytes: 8 },
    },
  });
  assert.equal(receipt.status, "succeeded");
  const observation = receipt.execution.observation;
  assert.equal(observation.kind, "directory.search.content");
  assert.equal(observation.normalCompleted, false);
  assert.equal(observation.coverage, "partial");
  assert.ok(observation.reasons.includes("stdout_max_bytes_exceeded"));
  assert.ok(observation.stdoutBytesRead > 8);
});

test("T3 real find fallback enumerates entries and reports missing grep capability", async t => {
  const fx = await fixture(t, {
    scenarioId: "sc-find",
    entries: treeEntries(),
    commandSearchCapabilities: {
      rg: null,
      grep: null,
      grepFlavor: "unprobed",
      find: "/usr/bin/find",
    },
  });
  const directory = await fx.sandbox.bindDirectory(fx.session, "scan");
  const entries = await fx.sandbox.execute({
    operation: "directory.search.entries",
    parameters: {
      session: fx.session,
      directory,
      fileFilter: { suffix: ".log" },
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(entries.status, "succeeded");
  const observation = entries.execution.observation;
  assert.equal(observation.kind, "directory.search.entries");
  assert.equal(observation.toolUsed, "find_P");
  assert.deepEqual(observation.matchedEntries, ["deep/quartz.log"]);
  assert.equal(observation.normalCompleted, true);

  const content = await fx.sandbox.execute({
    operation: "directory.search.content",
    parameters: {
      session: fx.session,
      directory,
      queryLiteral: "quarryMark",
      fileFilter: null,
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(content.status, "failed");
  assert.equal(content.execution.executorInvoked, false);
});

test("T4 real grep fallback parses content with NUL-delimited records", async t => {
  const fx = await fixture(t, {
    scenarioId: "sc-grep",
    entries: treeEntries(),
    commandSearchCapabilities: {
      rg: null,
      grep: "/usr/bin/grep",
      grepFlavor: "bsd",
      find: null,
    },
  });
  const directory = await fx.sandbox.bindDirectory(fx.session, "scan");
  const content = await fx.sandbox.execute({
    operation: "directory.search.content",
    parameters: {
      session: fx.session,
      directory,
      queryLiteral: "quarryMark",
      fileFilter: { suffix: ".txt" },
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(content.status, "succeeded");
  const observation = content.execution.observation;
  assert.equal(observation.kind, "directory.search.content");
  assert.equal(observation.toolUsed, "grep_bsd");
  assert.deepEqual(observation.matchedEntries, ["amber.txt"]);
  assert.equal(observation.matchedLines[0].lineNumber, 2);
  assert.equal(observation.matchedLines[0].lineText, "quarryMark here");
  assert.equal(observation.normalCompleted, true);
  assert.equal(observation.coverage, "complete");
  assert.equal(observation.spawnLedger.filter(item => item.purpose === "probe_grep_version").length, 0);
});

test("T5 effect, binding and final-symlink gates reject before spawning", async t => {
  const noExec = await fixture(t, {
    scenarioId: "sc-no-exec",
    entries: treeEntries(),
    sessions: [{ id: "s", cwd: ".", grantedEffects: ["filesystem.read"] }],
  });
  const noExecDirectory = await noExec.sandbox.bindDirectory(noExec.session, "scan");
  const denied = await noExec.sandbox.execute({
    operation: "directory.search.entries",
    parameters: {
      session: noExec.session,
      directory: noExecDirectory,
      fileFilter: null,
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(denied.status, "failed");
  assert.equal(denied.execution.executorInvoked, false);
  assert.equal(denied.execution.error.code, "EFFECT_DENIED");

  const fx = await fixture(t, { scenarioId: "sc-gates", entries: treeEntries() });
  const forged = await fx.sandbox.execute({
    operation: "directory.search.entries",
    parameters: {
      session: fx.session,
      directory: {
        kind: "cli.directory",
        scenarioId: fx.sandbox.scenarioId,
        sessionId: "s",
        path: "scan",
      },
      fileFilter: null,
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(forged.status, "failed");
  assert.equal(forged.execution.executorInvoked, false);
  assert.equal(forged.execution.error.code, "binding_identity_missing");

  await symlink(join(fx.scenarioRoot, "scan"), join(fx.scenarioRoot, "scan-link"));
  const linkDirectory = await fx.sandbox.bindDirectory(fx.session, "scan-link");
  const link = await fx.sandbox.execute({
    operation: "directory.search.entries",
    parameters: {
      session: fx.session,
      directory: linkDirectory,
      fileFilter: null,
      ignorePolicy: "no_ignore",
    },
  });
  assert.equal(link.status, "failed");
  assert.equal(link.execution.executorInvoked, false);
  assert.equal(link.execution.error.code, "FINAL_SYMLINK");
});

test("T6 semantic call schema rejects malformed search parameters", () => {
  assert.throws(() => readSemanticCliCall({
    operation: "directory.search.content",
    parameters: {
      session: SESSION_REF,
      directory: DIRECTORY_REF,
      queryLiteral: "line\nbreak",
      fileFilter: null,
      ignorePolicy: "no_ignore",
    },
  }), /queryLiteral/);

  assert.throws(() => readSemanticCliCall({
    operation: "directory.search.entries",
    parameters: {
      session: SESSION_REF,
      directory: DIRECTORY_REF,
      ignorePolicy: "no_ignore",
    },
  }), /fileFilter/);

  assert.throws(() => readSemanticCliCall({
    operation: "directory.search.entries",
    parameters: {
      session: SESSION_REF,
      directory: DIRECTORY_REF,
      fileFilter: null,
      ignorePolicy: "no_ignore",
      extra: true,
    },
  }), /exactly/);
});
