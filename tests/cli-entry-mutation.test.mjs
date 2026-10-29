import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const mutationApi = () => import("../dist/adapters/cli/entry-mutation.js");
const inspectionApi = () => import("../dist/adapters/cli/entry-inspection.js");
const execFileAsync = promisify(execFile);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

async function inspect(path) {
  const { readEntrySnapshot } = await inspectionApi();
  return readEntrySnapshot(path, false);
}

function osInteger(value) {
  assert.notEqual(value, null, "entry snapshot identity must be present");
  return value <= MAX_SAFE ? Number(value) : value.toString();
}

function identity(snapshot) {
  return Object.freeze({ dev: osInteger(snapshot.dev), ino: osInteger(snapshot.ino) });
}

function sameIdentity(snapshot, expected) {
  return String(snapshot.dev) === String(expected.dev) && String(snapshot.ino) === String(expected.ino);
}

async function target(parentPhysicalPath, name) {
  const parent = await inspect(parentPhysicalPath);
  assert.equal(parent.entryExists, true);
  assert.equal(parent.kind, "directory");
  return Object.freeze({
    parentPhysicalPath,
    parentExpectedIdentity: identity(parent),
    name,
  });
}

async function source(physicalPath, expectedType) {
  const observed = await inspect(physicalPath);
  assert.equal(observed.entryExists, true);
  return Object.freeze({
    physicalPath,
    expectedType,
    expectedIdentity: identity(observed),
  });
}

async function scene(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-p4-a1-")));
  const work = join(root, "work");
  const left = join(work, "left");
  const right = join(work, "right");
  await mkdir(left, { recursive: true });
  await mkdir(right);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, work, left, right };
}

async function run(request) {
  const { runEntryMutationHelper } = await mutationApi();
  return runEntryMutationHelper(request);
}

async function decide(request, state) {
  const { evaluateEntryMutationPrecondition } = await mutationApi();
  return evaluateEntryMutationPrecondition(request, state);
}

test("P01 directory.create creates one real directory and observes its type", async t => {
  const { root, left } = await scene(t);
  const name = "created";
  const result = await run({
    operation: "directory.create",
    sandboxRoot: root,
    target: await target(left, name),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.executorInvoked, true);
  assert.equal(result.helper.exitCode, 0);
  assert.equal(result.receipt.postObservation.kind, "directory");
  assert.equal(result.receipt.postObservation.entryExists, true);
  assert.equal((await lstat(join(left, name))).isDirectory(), true);
});

test("P02 file.create creates one empty regular file and observes its type", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "created.txt");
  const result = await run({
    operation: "file.create",
    sandboxRoot: root,
    target: await target(left, "created.txt"),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.kind, "regular");
  assert.equal(result.receipt.postObservation.size, 0);
  assert.equal((await lstat(path)).isFile(), true);
  assert.equal((await readFile(path, "utf8")), "");
});

test("P03 link.create rejects an existing destination with EEXIST and preserves it", async t => {
  const { root, left } = await scene(t);
  const destination = join(left, "occupied");
  await writeFile(destination, "keep");
  const result = await run({
    operation: "link.create",
    sandboxRoot: root,
    target: await target(left, "occupied"),
    targetText: "elsewhere",
  });
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.errno, "EEXIST");
  assert.equal((await readFile(destination, "utf8")), "keep");
});

test("P04 link.create permits a dangling relative symlink and preserves its text", async t => {
  const { root, left } = await scene(t);
  const destination = join(left, "dangling");
  const result = await run({
    operation: "link.create",
    sandboxRoot: root,
    target: await target(left, "dangling"),
    targetText: "../missing-target",
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.kind, "symlink");
  assert.equal(result.receipt.postObservation.linkTarget, "../missing-target");
  assert.equal(await readlink(destination), "../missing-target");
});

test("P05 file.link creates a second name for the same regular-file inode", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "source.txt");
  const destination = join(left, "hard.txt");
  await writeFile(sourcePath, "same bytes");
  const sourceInput = await source(sourcePath, "regular");
  const initial = await lstat(sourcePath);

  const result = await run({
    operation: "file.link",
    sandboxRoot: root,
    source: sourceInput,
    destination: await target(left, "hard.txt"),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.kind, "regular");
  assert.equal(sameIdentity(result.receipt.postObservation, sourceInput.expectedIdentity), true);
  assert.ok(Number(result.receipt.postObservation.nlink) >= 2);
  const destinationStats = await lstat(destination);
  assert.equal(destinationStats.dev, initial.dev);
  assert.equal(destinationStats.ino, initial.ino);
  assert.ok(destinationStats.nlink >= 2);
});

test("P06 file.link rejects a same-entry request without a NOOP", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "source.txt");
  await writeFile(sourcePath, "payload");
  const sourceInput = await source(sourcePath, "regular");
  const result = await run({
    operation: "file.link",
    sandboxRoot: root,
    source: sourceInput,
    destination: await target(left, basename(sourcePath)),
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "SAME_ENTRY_CONFLICT");
  assert.equal(result.receipt.executorInvoked, false);
  assert.equal((await lstat(sourcePath)).nlink, 1);
});

test("P07 file.link precondition recognizes a distinct existing hardlink as satisfied", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "source.txt");
  const destination = join(left, "existing-hard.txt");
  await writeFile(sourcePath, "payload");
  await link(sourcePath, destination);
  const sourceInput = await source(sourcePath, "regular");
  const destinationInput = await target(left, "existing-hard.txt");
  const request = {
    operation: "file.link",
    sandboxRoot: root,
    source: sourceInput,
    destination: destinationInput,
  };
  const decision = await decide(request, {
    parent: await inspect(left),
    source: await inspect(sourcePath),
    destination: await inspect(destination),
    resolvedSourcePath: sourcePath,
    resolvedDestinationPath: destination,
  });
  assert.equal(decision.outcome, "noop_satisfied");
  assert.equal(decision.executorInvoked, false);
});

test("P08 file.link executor does not turn an existing hardlink into NOOP", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "source.txt");
  const destination = join(left, "existing-hard.txt");
  await writeFile(sourcePath, "payload");
  await link(sourcePath, destination);
  const before = await lstat(sourcePath);
  const result = await run({
    operation: "file.link",
    sandboxRoot: root,
    source: await source(sourcePath, "regular"),
    destination: await target(left, "existing-hard.txt"),
  });
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.errno, "EEXIST");
  const after = await lstat(destination);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 2);
});

test("P09 file.link rejects a directory source before hardlink execution", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "directory-source");
  await mkdir(sourcePath);
  const result = await run({
    operation: "file.link",
    sandboxRoot: root,
    source: await source(sourcePath, "directory"),
    destination: await target(left, "not-created"),
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "INVALID_HARDLINK_SOURCE_TYPE");
  assert.equal(result.receipt.executorInvoked, false);
});

test("P10 file.link rejects a symlink source before hardlink execution", async t => {
  const { root, left } = await scene(t);
  const realFile = join(left, "real.txt");
  const sourcePath = join(left, "source-link");
  await writeFile(realFile, "payload");
  await symlink(realFile, sourcePath);
  const result = await run({
    operation: "file.link",
    sandboxRoot: root,
    source: await source(sourcePath, "symlink"),
    destination: await target(left, "not-created"),
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "INVALID_HARDLINK_SOURCE_TYPE");
  assert.equal(result.receipt.executorInvoked, false);
});

test("P11 file.link rejects an unrelated existing destination with EEXIST", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "source.txt");
  const destination = join(left, "destination.txt");
  await writeFile(sourcePath, "source");
  await writeFile(destination, "destination");
  const result = await run({
    operation: "file.link",
    sandboxRoot: root,
    source: await source(sourcePath, "regular"),
    destination: await target(left, "destination.txt"),
  });
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.errno, "EEXIST");
  assert.equal((await readFile(sourcePath, "utf8")), "source");
  assert.equal((await readFile(destination, "utf8")), "destination");
});

test("P12 entry.move renames within one parent and preserves object identity", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "before.txt");
  const destination = join(left, "after.txt");
  await writeFile(sourcePath, "payload");
  const sourceInput = await source(sourcePath, "regular");
  const result = await run({
    operation: "entry.move",
    sandboxRoot: root,
    source: sourceInput,
    destination: await target(left, "after.txt"),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.kind, "regular");
  assert.equal(sameIdentity(result.receipt.postObservation, sourceInput.expectedIdentity), true);
  assert.equal(result.receipt.postSourceObservation.entryExists, false);
  await assert.rejects(lstat(sourcePath), { code: "ENOENT" });
});

test("P13 entry.move moves a directory across parents with its contents", async t => {
  const { root, left, right } = await scene(t);
  const sourcePath = join(left, "directory");
  const destination = join(right, "directory");
  await mkdir(sourcePath);
  await writeFile(join(sourcePath, "child.txt"), "child");
  const sourceInput = await source(sourcePath, "directory");
  const result = await run({
    operation: "entry.move",
    sandboxRoot: root,
    source: sourceInput,
    destination: await target(right, "directory"),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.kind, "directory");
  assert.equal(sameIdentity(result.receipt.postObservation, sourceInput.expectedIdentity), true);
  assert.equal((await readFile(join(destination, "child.txt"), "utf8")), "child");
  await assert.rejects(lstat(sourcePath), { code: "ENOENT" });
});

test("P14 entry.move moves a symlink itself without moving or changing its target", async t => {
  const { root, left, right } = await scene(t);
  const realFile = join(left, "target.txt");
  const sourcePath = join(left, "link");
  const destination = join(right, "link");
  await writeFile(realFile, "target bytes");
  await symlink(realFile, sourcePath);
  const result = await run({
    operation: "entry.move",
    sandboxRoot: root,
    source: await source(sourcePath, "symlink"),
    destination: await target(right, "link"),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.kind, "symlink");
  assert.equal(result.receipt.postObservation.linkTarget, realFile);
  assert.equal(await readlink(destination), realFile);
  assert.equal((await readFile(realFile, "utf8")), "target bytes");
});

test("P15 entry.move to the same path is an explicit NOOP without execution", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "same.txt");
  await writeFile(sourcePath, "payload");
  const result = await run({
    operation: "entry.move",
    sandboxRoot: root,
    source: await source(sourcePath, "regular"),
    destination: await target(left, "same.txt"),
  });
  assert.equal(result.receipt.outcome, "noop_satisfied");
  assert.equal(result.receipt.executorInvoked, false);
  assert.equal((await readFile(sourcePath, "utf8")), "payload");
});

test("P16 entry.move refuses to absorb a distinct hardlink name at the destination", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "a.txt");
  const destination = join(left, "b.txt");
  await writeFile(sourcePath, "payload");
  await link(sourcePath, destination);
  const before = await lstat(sourcePath);
  assert.equal(before.nlink, 2);

  const result = await run({
    operation: "entry.move",
    sandboxRoot: root,
    source: await source(sourcePath, "regular"),
    destination: await target(left, "b.txt"),
  });
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.errno, "EEXIST");
  assert.notEqual(result.receipt.native, null);
  assert.notEqual(result.receipt.native.exitCode, 0);
  assert.equal(result.receipt.native.argv[1], sourcePath);
  assert.equal(result.receipt.native.argv[2], destination);

  const sourceAfter = await lstat(sourcePath);
  const destinationAfter = await lstat(destination);
  assert.equal(sourceAfter.nlink, 2);
  assert.equal(destinationAfter.nlink, 2);
  assert.equal(sourceAfter.dev, destinationAfter.dev);
  assert.equal(sourceAfter.ino, destinationAfter.ino);
  assert.equal((await readFile(sourcePath, "utf8")), "payload");
  assert.equal((await readFile(destination, "utf8")), "payload");
});

test("P17 entry.move precondition rejects an observed destination before execution", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "a.txt");
  const destination = join(left, "b.txt");
  await writeFile(sourcePath, "payload");
  await link(sourcePath, destination);
  const request = {
    operation: "entry.move",
    sandboxRoot: root,
    source: await source(sourcePath, "regular"),
    destination: await target(left, "b.txt"),
  };
  const decision = await decide(request, {
    parent: await inspect(left),
    source: await inspect(sourcePath),
    destination: await inspect(destination),
    resolvedSourcePath: sourcePath,
    resolvedDestinationPath: destination,
  });
  assert.equal(decision.outcome, "rejected");
  assert.equal(decision.code, "DESTINATION_ALREADY_EXISTS");
  assert.equal(decision.executorInvoked, false);
});

test("P18 entry.move never overwrites an unrelated existing destination", async t => {
  const { root, left } = await scene(t);
  const sourcePath = join(left, "source.txt");
  const destination = join(left, "destination.txt");
  await writeFile(sourcePath, "source");
  await writeFile(destination, "destination");
  const result = await run({
    operation: "entry.move",
    sandboxRoot: root,
    source: await source(sourcePath, "regular"),
    destination: await target(left, "destination.txt"),
  });
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.errno, "EEXIST");
  assert.equal((await readFile(sourcePath, "utf8")), "source");
  assert.equal((await readFile(destination, "utf8")), "destination");
});

test("P19 entry.remove unlinks one regular file and observes its absence", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "remove.txt");
  await writeFile(path, "payload");
  const result = await run({
    operation: "entry.remove",
    sandboxRoot: root,
    target: await source(path, "regular"),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.entryExists, false);
  assert.equal(result.receipt.postObservation.errno, "ENOENT");
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("P20 entry.remove removes one empty directory without recursive deletion", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "empty");
  await mkdir(path);
  const result = await run({
    operation: "entry.remove",
    sandboxRoot: root,
    target: await source(path, "directory"),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.entryExists, false);
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("P21 entry.remove removes a symlink itself and leaves its target intact", async t => {
  const { root, left } = await scene(t);
  const realFile = join(left, "target.txt");
  const path = join(left, "link");
  await writeFile(realFile, "target bytes");
  await symlink(realFile, path);
  const result = await run({
    operation: "entry.remove",
    sandboxRoot: root,
    target: await source(path, "symlink"),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.kind, null);
  await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.equal((await readFile(realFile, "utf8")), "target bytes");
});

test("P22 entry.remove unlinks a FIFO", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "fifo");
  await execFileAsync("mkfifo", [path], { shell: false });
  const before = await inspect(path);
  assert.equal(before.kind, "fifo");
  const result = await run({
    operation: "entry.remove",
    sandboxRoot: root,
    target: await source(path, "fifo"),
  });
  assert.equal(result.receipt.outcome, "succeeded");
  assert.equal(result.receipt.postObservation.entryExists, false);
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("P23 entry.remove rejects a non-empty directory with ENOTEMPTY", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "nonempty");
  await mkdir(path);
  await writeFile(join(path, "child.txt"), "child");
  const result = await run({
    operation: "entry.remove",
    sandboxRoot: root,
    target: await source(path, "directory"),
  });
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.errno, "ENOTEMPTY");
  assert.equal((await readFile(join(path, "child.txt"), "utf8")), "child");
});

test("P24 entry.remove rejects a stale dev/ino reference", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "stale.txt");
  const oldPath = join(left, "old.txt");
  await writeFile(path, "old");
  const stale = await source(path, "regular");
  await rename(path, oldPath);
  await writeFile(path, "replacement");
  const result = await run({
    operation: "entry.remove",
    sandboxRoot: root,
    target: stale,
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "STALE_REFERENCE");
  assert.equal(result.receipt.executorInvoked, false);
  assert.equal((await readFile(path, "utf8")), "replacement");
});

test("P25 rejects a target parent outside the sandbox root", async t => {
  const { root, left } = await scene(t);
  const outside = await realpath(await mkdtemp(join(tmpdir(), "nn-p4-a1-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  assert.ok(left.startsWith(root));
  const result = await run({
    operation: "directory.create",
    sandboxRoot: root,
    target: await target(outside, "escape"),
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "SANDBOX_BOUNDARY_VIOLATION");
  assert.equal(result.receipt.executorInvoked, false);
});

test("P26 rejects a target name containing a slash", async t => {
  const { root, left } = await scene(t);
  const result = await run({
    operation: "file.create",
    sandboxRoot: root,
    target: await target(left, "bad/name"),
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "INVALID_ENTRY_NAME");
  assert.equal(result.receipt.executorInvoked, false);
});

test("P27 rejects the parent entry name dot-dot", async t => {
  const { root, left } = await scene(t);
  const result = await run({
    operation: "directory.create",
    sandboxRoot: root,
    target: await target(left, ".."),
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "INVALID_ENTRY_NAME");
  assert.equal(result.receipt.executorInvoked, false);
});

test("P28 rejects a source outside the sandbox root", async t => {
  const { root, left } = await scene(t);
  const outside = await realpath(await mkdtemp(join(tmpdir(), "nn-p4-a1-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, "outside.txt");
  await writeFile(outsideFile, "outside");
  const result = await run({
    operation: "entry.move",
    sandboxRoot: root,
    source: await source(outsideFile, "regular"),
    destination: await target(left, "inside.txt"),
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "SANDBOX_BOUNDARY_VIOLATION");
  assert.equal(result.receipt.executorInvoked, false);
});

test("P29 rejects the sandbox root itself as a source entry", async t => {
  const { root } = await scene(t);
  const rootSnapshot = await inspect(root);
  const result = await run({
    operation: "entry.remove",
    sandboxRoot: root,
    target: {
      physicalPath: root,
      expectedType: "directory",
      expectedIdentity: identity(rootSnapshot),
    },
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "SANDBOX_BOUNDARY_VIOLATION");
  assert.equal(result.receipt.executorInvoked, false);
});

test("P30 rejects a replaced parent with a stale identity", async t => {
  const { root, left } = await scene(t);
  const oldLeft = `${left}-old`;
  const request = {
    operation: "file.create",
    sandboxRoot: root,
    target: await target(left, "child.txt"),
  };
  await rename(left, oldLeft);
  await mkdir(left);
  const result = await run(request);
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "STALE_REFERENCE");
  assert.equal(result.receipt.executorInvoked, false);
  await assert.rejects(lstat(join(left, "child.txt")), { code: "ENOENT" });
});

test("P31 rejects a non-directory target parent with ENOTDIR", async t => {
  const { root, left } = await scene(t);
  const parentPath = join(left, "not-a-directory");
  await writeFile(parentPath, "file");
  const parentSnapshot = await inspect(parentPath);
  const result = await run({
    operation: "directory.create",
    sandboxRoot: root,
    target: Object.freeze({
      parentPhysicalPath: parentPath,
      parentExpectedIdentity: identity(parentSnapshot),
      name: "child",
    }),
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "ENOTDIR");
  assert.equal(result.receipt.executorInvoked, false);
});

test("P32 rejects a missing source reference as STALE_REFERENCE", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "missing.txt");
  await writeFile(path, "payload");
  const stale = await source(path, "regular");
  await unlink(path);
  const result = await run({
    operation: "entry.remove",
    sandboxRoot: root,
    target: stale,
  });
  assert.equal(result.receipt.outcome, "rejected");
  assert.equal(result.receipt.code, "STALE_REFERENCE");
  assert.equal(result.receipt.executorInvoked, false);
});

test("P33 directory.create reports EEXIST and keeps the existing directory", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "existing-directory");
  await mkdir(path);
  await writeFile(join(path, "child.txt"), "child");
  const result = await run({
    operation: "directory.create",
    sandboxRoot: root,
    target: await target(left, "existing-directory"),
  });
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.errno, "EEXIST");
  assert.equal((await readFile(join(path, "child.txt"), "utf8")), "child");
});

test("P34 file.create reports EEXIST without truncating the existing file", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "existing.txt");
  await writeFile(path, "keep this");
  const result = await run({
    operation: "file.create",
    sandboxRoot: root,
    target: await target(left, "existing.txt"),
  });
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.errno, "EEXIST");
  assert.equal((await readFile(path, "utf8")), "keep this");
});

test("P35 link.create reports EEXIST without replacing the existing entry", async t => {
  const { root, left } = await scene(t);
  const path = join(left, "existing.txt");
  await writeFile(path, "keep this");
  const result = await run({
    operation: "link.create",
    sandboxRoot: root,
    target: await target(left, "existing.txt"),
    targetText: "elsewhere",
  });
  assert.equal(result.receipt.outcome, "failed");
  assert.equal(result.receipt.errno, "EEXIST");
  assert.equal((await readFile(path, "utf8")), "keep this");
});

test("P36 the fixed native no-replace helper compiles on demand", async t => {
  const { ensureNativeRenameBinary } = await mutationApi();
  const binary = await ensureNativeRenameBinary();
  const stats = await lstat(binary);
  assert.equal(stats.isFile(), true);
  assert.notEqual(stats.mode & 0o111, 0);
});
