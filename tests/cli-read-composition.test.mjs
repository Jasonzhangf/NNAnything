import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const mkfifo = path => execFileAsync("/usr/bin/mkfifo", [path]);

const LIMITS = Object.freeze({
  maxTransitions: 23,
  maxDepth: 4,
  maxDerivedGoals: 8,
});

function profilePath() {
  const value = process.env.NN_CLI_COMMAND_PROFILE;
  assert.equal(
    typeof value,
    "string",
    "NN_CLI_COMMAND_PROFILE must name an explicit saved CLI command profile",
  );
  assert.notEqual(value.length, 0, "NN_CLI_COMMAND_PROFILE must not be empty");
  return value;
}

async function api() {
  return import("nnanything/cli-read");
}

async function profile() {
  return JSON.parse(await readFile(profilePath(), "utf8"));
}

function countingIo() {
  let opens = 0;
  const io = {
    lstat: (path, options) => lstat(path, options),
    open: async (path, flags) => {
      opens += 1;
      return open(path, flags);
    },
  };
  return { io, count: () => opens };
}

async function fixture(t, options) {
  const module = await api();
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-composition-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const counter = countingIo();
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId,
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/sub", kind: "directory" },
        ...(options.entries ?? []),
      ],
      sessions: options.sessions ?? [
        {
          id: "s",
          cwd: options.cwd ?? "start",
          grantedEffects: options.grantedEffects ?? ["filesystem.read", "process.exec"],
        },
      ],
    },
    ...(options.listingObserver === undefined ? {} : { listingObserver: options.listingObserver }),
    fileReadIo: options.fileReadIo ?? counter.io,
  });
  t.after(async () => {
    await sandbox.cleanup();
  });
  const session = sandbox.bindSession(options.sessionId ?? "s");
  const directory = await sandbox.bindDirectoryObject(session, ".");
  return { module, sandbox, session, directory, openCount: () => counter.count() };
}

function readRequest(directory, name, range, expectedBase64, requestId) {
  return {
    requestId: requestId ?? `read-composition-${name}`,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.exact-child",
        directory,
        name,
        requiredType: "regular",
      },
      requirement: {
        kind: "equals",
        range,
        expectedBase64,
      },
    },
    satisfactionThreshold: 100,
  };
}

function b64(value) {
  return Buffer.from(value).toString("base64");
}

function heads(response) {
  return response.report.atomicResults
    .filter(result => result.sourceResult.tag === "cli.command.transition.v1")
    .map(result => result.sourceResult.value.policy.selectedHead);
}

function childSkillIds(response) {
  return response.report.atomicResults.map(result => result.skillId);
}

function statesOf(response) {
  return response.report.states.map(item => item.value);
}

function stateFileRefs(response) {
  return statesOf(response)
    .filter(state => state.fileRef !== null)
    .map(state => state.fileRef);
}

function readFactsOf(response) {
  return statesOf(response)
    .filter(state => state.read !== null)
    .map(state => state.read);
}

function runWith(fixtureValue, goal, options = {}) {
  return fixtureValue.module.runCliReadCompositionGoal(goal, {
    sandbox: fixtureValue.sandbox,
    session: options.session ?? fixtureValue.session,
    profile: options.profile ?? fixtureValue.profile ?? undefined,
    limits: options.limits ?? LIMITS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onSample === undefined ? {} : { onSample: options.onSample }),
  });
}

async function withProfile(t, entries, options = {}) {
  const loaded = await fixture(t, {
    scenarioId: options.scenarioId ?? "read-composition",
    entries,
    cwd: options.cwd,
    grantedEffects: options.grantedEffects,
    sessions: options.sessions,
    sessionId: options.sessionId,
    listingObserver: options.listingObserver,
    fileReadIo: options.fileReadIo,
  });
  loaded.profile = await profile();
  return loaded;
}

async function observeRealListing(input, failName = null) {
  const names = (await readdir(input.physicalDirectory)).sort();
  const entries = [];
  const errors = [];
  for (const name of names) {
    if (name === failName) {
      errors.push({ name, code: "EACCES", message: "controlled lstat denial" });
      continue;
    }
    const stats = await lstat(join(input.physicalDirectory, name));
    entries.push({
      name,
      path: join(input.physicalDirectory, name),
      type: stats.isDirectory()
        ? "directory"
        : stats.isSymbolicLink()
          ? "symlink"
          : stats.isFile()
            ? "file"
            : "other",
    });
  }
  return {
    ok: true,
    observation: {
      kind: "directory.list",
      configuredDirectory: input.configuredDirectory,
      physicalDirectory: input.physicalDirectory,
      executable: process.execPath,
      helperPath: "controlled-real-listing",
      argv: ["controlled-real-listing", input.physicalDirectory],
      stdout: JSON.stringify({ directory: input.physicalDirectory, entries, errors }),
      stderr: "",
      exitCode: 0,
      entries,
      coverage: errors.length === 0 ? "complete" : "partial",
      errors,
    },
  };
}

async function replaceSamePath(path, previousIno) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await rm(path, { force: true });
    await writeFile(path, "replacement");
    const stat = await lstat(path);
    if (String(stat.ino) !== String(previousIno)) return stat;
  }
  throw new Error("unable to obtain a different file inode");
}

test("R01 exact hit with equal bytes achieves matched at 100 with state-carried file ref", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "placeholder" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;
  await writeFile(join(start, "target.bin"), Buffer.from([0x00, 0x01, 0x02]));
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 1, length: 2 }, b64("\u0001\u0002")),
  );
  assert.equal(result.domain.status, "achieved");
  assert.equal(result.domain.resolution, "matched");
  assert.equal(result.domain.satisfaction, 100);
  assert.equal(result.domain.coverage, "complete");
  assert.equal(result.domain.match.kind, "cli.file");
  assert.equal(result.domain.match.type, "regular");
  assert.equal(result.domain.match.absolutePath, join(start, "target.bin"));
  assert.equal(result.domain.rootFact.kind, "matched");
  assert.deepEqual(result.domain.rootFact.fileRef, result.domain.match);
  assert.deepEqual(heads(result.response), ["ls", "entry.inspect"]);
  assert.deepEqual(childSkillIds(result.response), [
    "read-composition.list",
    "read-composition.inspect",
    "read-composition.read",
  ]);
  assert.equal(result.response.report.rootEvaluation.result, "satisfied");

  const refs = stateFileRefs(result.response);
  assert.equal(refs.length, 1, "the file ref must travel through composition state");
  assert.equal(refs[0].kind, "cli.file");
  assert.equal(refs[0].type, "regular");
  assert.equal(refs[0].absolutePath, join(start, "target.bin"));
  assert.equal(refs[0].sessionRevision, value.sandbox.getSession(value.session).revision);
  assert.equal(typeof refs[0].sourceRun, "string");
  assert.notEqual(refs[0].sourceRun.length, 0);
  assert.deepEqual(refs[0], result.domain.match);

  const readFacts = readFactsOf(result.response);
  assert.equal(readFacts.length, 1);
  assert.equal(readFacts[0].refSourceRun, refs[0].sourceRun);
  assert.equal(readFacts[0].offset, 1);
  assert.equal(readFacts[0].length, 2);
  assert.equal(readFacts[0].bytesRead, 2);
  assert.equal(readFacts[0].bytes, b64("\u0001\u0002"));
  assert.equal(readFacts[0].identity.ino, refs[0].identity.ino);

  const fileStat = await lstat(join(start, "target.bin"), { bigint: true });
  assert.equal(String(refs[0].identity.ino), String(fileStat.ino));
});

test("R02 same-name non-regular types stop at type_mismatch and never read", async t => {
  const value = await withProfile(t, [
    { path: "start/real.bin", kind: "file", contents: "payload" },
    { path: "start/dir-name", kind: "directory" },
    { path: "start/fifo-name", kind: "file", contents: "fifo placeholder" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;
  const dir = join(start, "dir-name");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir);
  await rm(join(start, "fifo-name"), { force: true });
  await mkfifo(join(start, "fifo-name"));
  await symlink("real.bin", join(start, "link-name"));

  const directoryResult = await runWith(
    value,
    readRequest(value.directory, "dir-name", { offset: 0, length: 0 }, ""),
  );
  assert.equal(directoryResult.domain.status, "unmet");
  assert.equal(directoryResult.domain.resolution, "type_mismatch");
  assert.equal(directoryResult.domain.satisfaction, 0);
  assert.equal(directoryResult.domain.match, null);
  assert.equal(directoryResult.domain.rootFact.kind, "type_mismatch");
  assert.equal(directoryResult.domain.rootFact.inspected.type, "directory");
  assert.equal(value.openCount(), 0, "no read open for a directory");

  const fifoResult = await runWith(
    value,
    readRequest(value.directory, "fifo-name", { offset: 0, length: 1 }, b64("f")),
  );
  assert.equal(fifoResult.domain.status, "unmet");
  assert.equal(fifoResult.domain.resolution, "type_mismatch");
  assert.equal(fifoResult.domain.satisfaction, 0);
  assert.equal(fifoResult.domain.rootFact.inspected.type, "fifo");
  assert.equal(value.openCount(), 0, "no read open for a fifo");

  const linkResult = await runWith(
    value,
    readRequest(value.directory, "link-name", { offset: 0, length: 1 }, b64("p")),
  );
  assert.equal(linkResult.domain.status, "unmet");
  assert.equal(linkResult.domain.resolution, "type_mismatch");
  assert.equal(linkResult.domain.satisfaction, 0);
  assert.equal(linkResult.domain.rootFact.inspected.type, "symlink");
  assert.equal(value.openCount(), 0, "no read open for a symlink");
  assert.equal(await readFile(join(start, "real.bin"), "utf8"), "payload");
  assert.deepEqual(heads(linkResult.response), ["ls", "entry.inspect"]);
});

test("R03 complete listing without the exact name is not_found and never inspects", async t => {
  const value = await withProfile(t, [
    { path: "start/other.bin", kind: "file", contents: "other" },
  ]);
  const result = await runWith(
    value,
    readRequest(value.directory, "absent.bin", { offset: 0, length: 1 }, b64("x")),
  );
  assert.equal(result.domain.status, "unmet");
  assert.equal(result.domain.resolution, "not_found");
  assert.equal(result.domain.satisfaction, 0);
  assert.equal(result.domain.match, null);
  assert.equal(result.domain.rootFact.kind, "not_found");
  assert.deepEqual(heads(result.response), ["ls"]);
  assert.equal(childSkillIds(result.response).includes("read-composition.inspect"), false);
  assert.equal(childSkillIds(result.response).includes("read-composition.read"), false);
  assert.equal(value.openCount(), 0);
});

test("R04 equal-range full read with different bytes is byte_mismatch at 0", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "abcdef" },
  ]);
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 1, length: 3 }, b64("XYZ")),
  );
  assert.equal(result.domain.status, "unmet");
  assert.equal(result.domain.resolution, "byte_mismatch");
  assert.equal(result.domain.satisfaction, 0);
  assert.equal(result.domain.match, null);
  assert.equal(result.domain.rootFact.kind, "byte_mismatch");
  assert.deepEqual(heads(result.response), ["ls", "entry.inspect"]);
  assert.equal(result.response.report.rootEvaluation.result, "unsatisfied");
  assert.equal(value.openCount(), 1);
});

test("R05 partial listing stays insufficient_evidence and never inspects or reads", async t => {
  const value = await withProfile(
    t,
    [
      { path: "start/target.bin", kind: "file", contents: "payload" },
      { path: "start/unrelated.bin", kind: "file", contents: "unrelated" },
    ],
    { listingObserver: input => observeRealListing(input, "unrelated.bin") },
  );
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 0, length: 7 }, b64("payload")),
  );
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "insufficient_evidence");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.match, null);
  assert.equal(result.domain.coverage, "partial");
  assert.equal(result.domain.rootFact.kind, "insufficient_evidence");
  assert.deepEqual(result.domain.rootFact.listing.candidateNames, ["target.bin"]);
  assert.match(JSON.stringify(result.domain.rootFact.listing.errors), /EACCES/);
  assert.deepEqual(heads(result.response), ["ls"]);
  assert.equal(childSkillIds(result.response).includes("read-composition.inspect"), false);
  assert.equal(childSkillIds(result.response).includes("read-composition.read"), false);
  assert.equal(value.openCount(), 0);
});

test("S-React-1 read-before replacement is stale_or_unverified and never returns old bytes", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "original" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;
  const target = join(start, "target.bin");
  const replaced = [];
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 0, length: 8 }, b64("original")),
    {
      onSample: async sample => {
        if (sample.goal.property === "file.property.type" && sample.status === "achieved") {
          replaced.push(await replaceSamePath(target, sample.observed_state_after.entryKnowledge.identity.ino));
        }
      },
    },
  );
  assert.equal(replaced.length, 1, "the replacement happened between inspect and read");
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "stale_or_unverified");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.match, null);
  assert.equal(result.domain.rootFact.kind, "stale_or_unverified");
  assert.equal(result.domain.rootFact.read, null);
  assert.equal(value.openCount(), 0, "a stale ref must not open the replacement file");
  assert.equal(result.response.report.errors.length, 1, "a read-less stale run records one derivation error");
  assert.deepEqual(heads(result.response), ["ls", "entry.inspect"]);
});

test("S-React-2 binding expired by revision is rejected with zero execution", async t => {
  let listings = 0;
  const value = await withProfile(
    t,
    [{ path: "start/target.bin", kind: "file", contents: "x" }],
    {
      listingObserver: async input => {
        listings += 1;
        return observeRealListing(input);
      },
    },
  );
  const stale = { ...value.directory, sessionRevision: value.directory.sessionRevision + 1 };
  const result = await runWith(value, readRequest(stale, "target.bin", { offset: 0, length: 1 }, b64("x")));
  assert.equal(result.response.kind, "request_rejected");
  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.resolution, "rejected");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(listings, 0);
  assert.equal(value.openCount(), 0);
});

test("S-React-3 forged directory sourceRun is rejected with zero execution", async t => {
  let listings = 0;
  const value = await withProfile(
    t,
    [{ path: "start/target.bin", kind: "file", contents: "x" }],
    {
      listingObserver: async input => {
        listings += 1;
        return observeRealListing(input);
      },
    },
  );
  const forged = { ...value.directory, sourceRun: "never-issued-by-sandbox" };
  const result = await runWith(value, readRequest(forged, "target.bin", { offset: 0, length: 1 }, b64("x")));
  assert.equal(result.response.kind, "request_rejected");
  assert.equal(result.domain.status, "rejected");
  assert.equal(result.domain.resolution, "rejected");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(listings, 0);
  assert.equal(value.openCount(), 0);
});

test("S-React-4 postcondition insufficient on short read is insufficient_evidence, not byte_mismatch", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "abc" },
  ]);
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 2, length: 10 }, b64("cxxxxxxxxx")),
  );
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "insufficient_evidence");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.match, null);
  assert.equal(result.domain.rootFact.kind, "insufficient_evidence");
  assert.equal(result.domain.rootFact.read.bytesRead, 1);
  assert.ok(result.domain.rootFact.read.bytesRead < result.domain.rootFact.read.length);
  assert.equal(result.domain.rootFact.read.eof, true);
  assert.equal(value.openCount(), 1);
  assert.deepEqual(heads(result.response), ["ls", "entry.inspect"]);
  assert.equal(result.response.report.rootEvaluation.result, "unknown");
});

test("S-React-5 root already satisfied performs no extra OS calls after the read receipt", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "payload" },
  ]);
  const samples = [];
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 0, length: 7 }, b64("payload")),
    {
      onSample: async sample => {
        samples.push({ property: sample.goal.property, status: sample.status });
      },
    },
  );
  assert.equal(result.domain.status, "achieved");
  assert.deepEqual(samples, [
    { property: "file.property.directory.entries", status: "achieved" },
    { property: "file.property.type", status: "achieved" },
  ]);
  assert.equal(result.response.report.atomicResults.length, 3);
  assert.equal(value.openCount(), 1, "exactly one read open; root satisfaction added no extra OS call");
});

test("R09 zero length with empty expectation achieves and identity verifies; schema rejects length mismatch", async t => {
  const value = await withProfile(t, [
    { path: "start/empty.bin", kind: "file", contents: "" },
  ]);
  const result = await runWith(
    value,
    readRequest(value.directory, "empty.bin", { offset: 0, length: 0 }, ""),
  );
  assert.equal(result.domain.status, "achieved");
  assert.equal(result.domain.resolution, "matched");
  assert.equal(result.domain.satisfaction, 100);
  assert.equal(value.openCount(), 1, "zero length still verifies identity through one open");
  const readFact = result.domain.rootFact.read;
  assert.equal(readFact.bytesRead, 0);
  assert.equal(readFact.length, 0);
  assert.equal(readFact.eof, false);

  await assert.rejects(
    runWith(value, readRequest(value.directory, "empty.bin", { offset: 0, length: 0 }, b64("x"))),
    /expectedBase64 decoded length must equal range.length/,
  );
  assert.equal(value.openCount(), 1, "schema rejection performed no new read");

  await assert.rejects(
    runWith(value, readRequest(value.directory, "empty.bin", { offset: 0, length: 2 }, b64("x"))),
    /expectedBase64 decoded length must equal range.length/,
  );
  assert.equal(value.openCount(), 1, "schema rejection performed no new read");
});

test("R10 read-less directory binding is denied with zero execution; real EACCES stays failed with errno", async t => {
  await assert.rejects(
    withProfile(
      t,
      [{ path: "start/target.bin", kind: "file", contents: "x" }],
      { grantedEffects: ["process.exec"] },
    ),
    error => error instanceof TypeError && error.code === "EFFECT_DENIED",
    "a read-less session cannot bind the directory",
  );

  const allowed = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "payload" },
  ]);
  const absolute = join(allowed.sandbox.getSession(allowed.session).cwd, "target.bin");
  await chmod(absolute, 0o000);
  const failed = await runWith(
    allowed,
    readRequest(allowed.directory, "target.bin", { offset: 0, length: 7 }, b64("payload")),
  );
  assert.equal(failed.domain.status, "failed");
  assert.equal(failed.domain.resolution, "failed");
  assert.equal(failed.domain.satisfaction, null);
  assert.equal(failed.domain.match, null);
  assert.equal(failed.domain.rootFact.kind, "failed");
  assert.match(JSON.stringify(failed.domain.preserve.errors), /EACCES/);
  await chmod(absolute, 0o600);
});

test("R11 inspect succeeded but file ref issuance fails stays stale_or_unverified with no read", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "payload" },
  ]);
  const start = value.sandbox.getSession(value.session).cwd;
  const target = join(start, "target.bin");
  let samples = 0;
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 0, length: 7 }, b64("payload")),
    {
      onSample: async sample => {
        if (sample.goal.property === "file.property.type" && sample.status === "achieved") {
          samples += 1;
          await rm(target, { force: true });
        }
      },
    },
  );
  assert.equal(samples, 1);
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "stale_or_unverified");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.rootFact.kind, "stale_or_unverified");
  assert.equal(result.domain.rootFact.fileRef, null);
  assert.equal(value.openCount(), 0);
  assert.deepEqual(heads(result.response), ["ls", "entry.inspect"]);
});

test("R12 cancellation before a root fact interrupts without replay or unknown-effect reuse", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "payload" },
  ]);
  const controller = new AbortController();
  let samples = 0;
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 0, length: 7 }, b64("payload")),
    {
      signal: controller.signal,
      onSample: async sample => {
        if (sample.goal.property === "file.property.directory.entries" && sample.status === "achieved") {
          samples += 1;
          controller.abort();
        }
      },
    },
  );
  assert.equal(samples, 1);
  assert.equal(result.domain.status, "unknown");
  assert.equal(result.domain.resolution, "interrupted");
  assert.equal(result.domain.satisfaction, null);
  assert.equal(result.domain.match, null);
  assert.equal(result.domain.rootFact.kind, "interrupted");
  assert.match(JSON.stringify(result.response.report.control), /cancel/);
  assert.equal(value.openCount(), 0);
  assert.equal(result.response.report.atomicResults.length, 1, "no atomic was replayed after cancel");
});

test("R13 root satisfaction adds no extra OS call and independent reruns each read once", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "payload" },
  ]);
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 0, length: 7 }, b64("payload")),
  );
  assert.equal(result.domain.status, "achieved");
  assert.equal(value.openCount(), 1);
  for (let index = 0; index < 3; index += 1) {
    const repeated = await runWith(
      value,
      readRequest(value.directory, "target.bin", { offset: 0, length: 7 }, b64("payload"), `repeated-${index}`),
    );
    assert.equal(repeated.domain.status, "achieved");
    assert.equal(value.openCount(), index + 2, "each independent rerun reads once");
  }
});

test("R14 child steps all green but root bytes differ never reach 100", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "same-prefix-different" },
  ]);
  const result = await runWith(
    value,
    readRequest(value.directory, "target.bin", { offset: 0, length: 5 }, b64("diff!")),
  );
  assert.equal(result.response.report.atomicResults.length, 3);
  assert.deepEqual(
    result.response.report.atomicResults.map(item => item.outcome),
    ["succeeded", "succeeded", "succeeded"],
  );
  assert.equal(result.domain.status, "unmet");
  assert.equal(result.domain.resolution, "byte_mismatch");
  assert.equal(result.domain.satisfaction, 0);
  assert.equal(result.domain.rootFact.kind, "byte_mismatch");
  assert.equal(result.response.report.rootEvaluation.result, "unsatisfied");
});

test("R15 special exact names are compared verbatim including spaces, newline, Unicode, dash and backslash", async t => {
  const names = [
    "with space",
    "line\nbreak",
    "中文.bin",
    "-dash",
    "back\\slash",
    "$(touch nope)",
    "a;b",
    "*",
  ];
  const value = await withProfile(
    t,
    names.map(name => ({ path: `start/${name}`, kind: "file", contents: "content" })),
  );
  const start = value.sandbox.getSession(value.session).cwd;
  for (const name of names) {
    const result = await runWith(
      value,
      readRequest(value.directory, name, { offset: 0, length: 7 }, b64("content"), `special-${names.indexOf(name)}`),
    );
    assert.equal(result.domain.status, "achieved", `expected exact hit for ${JSON.stringify(name)}`);
    assert.equal(basename(result.domain.match.absolutePath), name);
    assert.equal(result.domain.match.absolutePath, join(start, name));
  }
  assert.equal((await readdir(start)).includes("nope"), false);
});

test("R16 unsupported typed requests are rejected with stable codes and zero execution", async t => {
  const value = await withProfile(t, [
    { path: "start/target.bin", kind: "file", contents: "payload" },
  ]);
  const base = readRequest(value.directory, "target.bin", { offset: 0, length: 7 }, b64("payload"));

  const otherProperty = {
    ...base,
    goal: { ...base.goal, property: "file.property.content.format" },
  };
  const multiCandidate = {
    ...base,
    goal: {
      ...base.goal,
      target: { ...base.goal.target, name: ["target.bin", "other.bin"] },
    },
  };
  const shellText = {
    ...base,
    goal: {
      ...base.goal,
      requirement: {
        ...base.goal.requirement,
        shellText: "cat target.bin | head -c 7",
      },
    },
  };
  const extraField = { ...base, hiddenScope: { write: true } };
  const naturalLanguage = {
    ...base,
    goal: { ...base.goal, property: "please read the file for me" },
  };

  for (const [label, requestValue] of [
    ["other property", otherProperty],
    ["multi candidate", multiCandidate],
    ["shell text", shellText],
    ["extra field", extraField],
    ["natural language", naturalLanguage],
  ]) {
    await assert.rejects(runWith(value, requestValue), TypeError, `${label} must be rejected`);
  }
  assert.equal(value.openCount(), 0);
});
