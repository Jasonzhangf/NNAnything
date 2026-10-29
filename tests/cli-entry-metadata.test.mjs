import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const api = () => import("../dist/adapters/cli/entry-metadata.js");

async function freshDir(t, prefix = "nn-entry-metadata-") {
  const root = await mkdtemp(`/tmp/${prefix}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function kindOf(stats) {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "regular";
  if (stats.isDirectory()) return "directory";
  if (stats.isCharacterDevice()) return "character_device";
  if (stats.isBlockDevice()) return "block_device";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  return "other";
}

function identityOf(stats) {
  return Object.freeze({ dev: stats.dev.toString(), ino: stats.ino.toString() });
}

function modeBits(stats) {
  return Number(stats.mode & 0o7777n);
}

function modeRequest(path, stats, mode) {
  return Object.freeze({
    operation: "entry.mode.set",
    absolutePath: path,
    expectedType: kindOf(stats),
    expectedIdentity: identityOf(stats),
    mode,
  });
}

function ownerRequest(path, stats, uid, gid) {
  return Object.freeze({
    operation: "entry.owner.set",
    absolutePath: path,
    expectedType: kindOf(stats),
    expectedIdentity: identityOf(stats),
    owner: Object.freeze({ uid, gid }),
  });
}

function timesRequest(path, stats, atimeNs, mtimeNs) {
  return Object.freeze({
    operation: "entry.times.set",
    absolutePath: path,
    expectedType: kindOf(stats),
    expectedIdentity: identityOf(stats),
    times: Object.freeze({ atimeNs, mtimeNs }),
  });
}

async function immutableFacts(path) {
  const stats = await lstat(path, { bigint: true });
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    atimeNs: stats.atimeNs,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  });
}

function assertUnchanged(actual, expected, label) {
  for (const key of ["dev", "ino", "mode", "uid", "gid", "atimeNs", "mtimeNs", "ctimeNs"]) {
    assert.equal(actual[key], expected[key], `${label}.${key} must be unchanged`);
  }
}

function observedIdentityOf(snapshot) {
  return Object.freeze({
    dev: snapshot.dev,
    ino: snapshot.ino,
  });
}

function sameIdentity(left, right) {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

test("entry.mode.set changes a regular file and leaves non-target entries untouched", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const file = join(dir, "file.txt");
  const sibling = join(dir, "sibling.txt");
  await writeFile(file, "payload", { mode: 0o644 });
  await writeFile(sibling, "sibling", { mode: 0o640 });
  const before = await lstat(file, { bigint: true });
  const siblingBefore = await immutableFacts(sibling);

  const result = await module.runEntryMetadataHelper(modeRequest(file, before, 0o600));

  assert.equal(result.ok, true);
  assert.equal(result.executorInvoked, true);
  assert.equal(result.observation.kind, "entry.mode.set");
  assert.equal(result.observation.argv[1], "entry.mode.set");
  assert.equal(result.observation.executable, process.execPath);
  assert.equal(result.observation.exitCode, 0);
  const after = await lstat(file, { bigint: true });
  assert.equal(modeBits(after), 0o600);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(sameIdentity(observedIdentityOf(result.observation.beforeSnapshot), identityOf(before)), true);
  assert.equal(module.compareModeEquals(after.mode.toString(), 0o600), true);
  assertUnchanged(await immutableFacts(sibling), siblingBefore, "sibling");
});

test("entry.mode.set changes a directory mode and restores it", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const target = join(dir, "target-dir");
  await mkdir(target, { mode: 0o755 });
  await chmod(target, 0o755);

  const first = await lstat(target, { bigint: true });
  const to750 = await module.runEntryMetadataHelper(modeRequest(target, first, 0o750));
  assert.equal(to750.ok, true);
  assert.equal(to750.executorInvoked, true);
  const mid = await lstat(target, { bigint: true });
  assert.equal(modeBits(mid), 0o750);
  assert.equal(mid.dev, first.dev);
  assert.equal(mid.ino, first.ino);

  const to755 = await module.runEntryMetadataHelper(modeRequest(target, mid, 0o755));
  assert.equal(to755.ok, true);
  assert.equal(to755.executorInvoked, true);
  const final = await lstat(target, { bigint: true });
  assert.equal(modeBits(final), 0o755);
  assert.equal(final.dev, first.dev);
  assert.equal(final.ino, first.ino);
});

test("entry.owner.set self-ownership succeeds and is observed exactly", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const file = join(dir, "owned.txt");
  await writeFile(file, "owned", { mode: 0o644 });
  const before = await lstat(file, { bigint: true });
  const uid = process.getuid();
  const gid = process.getgid();

  const result = await module.runEntryMetadataHelper(ownerRequest(file, before, uid, gid));

  assert.equal(result.ok, true);
  assert.equal(result.executorInvoked, true);
  const after = await lstat(file, { bigint: true });
  assert.equal(after.uid, before.uid);
  assert.equal(module.compareOwnerEquals({ uid: after.uid.toString(), gid: after.gid.toString() }, { uid, gid }), true);
});

test("entry.owner.set non-privileged cross-uid preserves real EPERM and leaves owner unchanged", async t => {
  if (process.getuid() === 0) {
    throw new Error("EPERM chown case requires a non-root process; this environment is root");
  }
  const module = await api();
  const dir = await freshDir(t);
  const file = join(dir, "no-chown.txt");
  await writeFile(file, "no-chown", { mode: 0o644 });
  const before = await immutableFacts(file);
  const stats = await lstat(file, { bigint: true });

  const result = await module.runEntryMetadataHelper(ownerRequest(file, stats, 0, 0));

  assert.equal(result.ok, false);
  assert.equal(result.executorInvoked, true);
  assert.equal(result.error.code, "EPERM");
  const after = await immutableFacts(file);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
});

test("entry.times.set accepts ordinary and fractional nanosecond timestamps", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const file = join(dir, "times.txt");
  await writeFile(file, "times", { mode: 0o644 });
  const created = await lstat(file, { bigint: true });

  const ordinary = { atimeNs: "1700000000000000000", mtimeNs: "1700000100000000000" };
  const first = await module.runEntryMetadataHelper(timesRequest(file, created, ordinary.atimeNs, ordinary.mtimeNs));
  assert.equal(first.ok, true);
  assert.equal(first.executorInvoked, true);
  let observed = await lstat(file, { bigint: true });
  assert.equal(module.compareTimesEquals({ atimeNs: observed.atimeNs.toString(), mtimeNs: observed.mtimeNs.toString() }, ordinary), true);
  const afterFirst = observed.ctimeNs;

  const fractional = { atimeNs: "1700000000123456789", mtimeNs: "1700000100654321987" };
  const second = await module.runEntryMetadataHelper(timesRequest(file, observed, fractional.atimeNs, fractional.mtimeNs));
  assert.equal(second.ok, true);
  assert.equal(second.executorInvoked, true);
  observed = await lstat(file, { bigint: true });
  assert.equal(module.compareTimesEquals({ atimeNs: observed.atimeNs.toString(), mtimeNs: observed.mtimeNs.toString() }, fractional), true);
  assert.notEqual(observed.ctimeNs, afterFirst);
});

test("entry.times.set sets fractional directory times and refreshes ctime without changing identity", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const target = join(dir, "target-dir");
  await mkdir(target, { mode: 0o755 });

  const before = await lstat(target, { bigint: true });
  const fractional = { atimeNs: "1700000000123456789", mtimeNs: "1700000100654321987" };

  const result = await module.runEntryMetadataHelper(timesRequest(target, before, fractional.atimeNs, fractional.mtimeNs));

  assert.equal(result.ok, true);
  assert.equal(result.executorInvoked, true);
  const after = await lstat(target, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(
    module.compareTimesEquals(
      { atimeNs: after.atimeNs.toString(), mtimeNs: after.mtimeNs.toString() },
      fractional,
    ),
    true,
  );
  assert.notEqual(after.ctimeNs, before.ctimeNs);
});

test("invalid mode, owner, and times values throw TypeError before any subprocess", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const file = join(dir, "invalid.txt");
  await writeFile(file, "invalid", { mode: 0o644 });
  const stats = await lstat(file, { bigint: true });
  const base = { absolutePath: file, expectedType: "regular", expectedIdentity: identityOf(stats) };

  for (const mode of [-1, 4096, 0o100644, 4294967296, "0755", "u+x"]) {
    assert.throws(() => module.validateModeValue(mode), TypeError);
    assert.throws(() => module.runEntryMetadataHelper({ ...base, operation: "entry.mode.set", mode }), TypeError);
  }

  for (const owner of [
    { uid: 4294967295, gid: 20 },
    { uid: "4294967295", gid: "20" },
    { uid: "4294967296", gid: "20" },
    { uid: -1, gid: 20 },
    { uid: null, gid: 20 },
  ]) {
    assert.throws(() => module.validateOwnerValue(owner), TypeError);
    assert.throws(() => module.runEntryMetadataHelper({ ...base, operation: "entry.owner.set", owner }), TypeError);
  }

  for (const times of [
    { atimeNs: "4102444800000000001", mtimeNs: "1700000000000000000" },
    { atimeNs: "99999999999999999999999999", mtimeNs: "1700000000000000000" },
    { atimeNs: -1, mtimeNs: 0 },
    { atimeNs: "1700000000000000000", mtimeNs: "1700000000000000000", ctimeNs: "1700000000000000000" },
  ]) {
    assert.throws(() => module.validateTimesValue(times), TypeError);
    assert.throws(() => module.runEntryMetadataHelper({ ...base, operation: "entry.times.set", times }), TypeError);
  }
});

test("unsupported target types are rejected before spawn and leave the real target unchanged", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const target = join(dir, "target.txt");
  const link = join(dir, "link");
  await writeFile(target, "sensitive", { mode: 0o644 });
  await symlink("target.txt", link);
  const linkStats = await lstat(link, { bigint: true });
  const targetBefore = await immutableFacts(target);

  const symlinkResult = await module.runEntryMetadataHelper(modeRequest(link, linkStats, 0o600));
  assert.equal(symlinkResult.ok, false);
  assert.equal(symlinkResult.executorInvoked, false);
  assert.equal(symlinkResult.error.code, "TYPE_UNSUPPORTED");

  const fileStats = await lstat(target, { bigint: true });
  const fifoResult = await module.runEntryMetadataHelper({
    operation: "entry.mode.set",
    absolutePath: target,
    expectedType: "fifo",
    expectedIdentity: identityOf(fileStats),
    mode: 0o600,
  });
  assert.equal(fifoResult.ok, false);
  assert.equal(fifoResult.executorInvoked, false);
  assert.equal(fifoResult.error.code, "TYPE_UNSUPPORTED");

  assertUnchanged(await immutableFacts(target), targetBefore, "symlink target");
});

test("entry metadata helper rejects a stale reference after the file is replaced", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const path = join(dir, "stale.txt");
  await writeFile(path, "a", { mode: 0o644 });
  const oldStats = await lstat(path, { bigint: true });
  await unlink(path);
  await writeFile(path, "b", { mode: 0o644 });
  let newStats = await lstat(path, { bigint: true });
  let attempts = 0;
  while (newStats.ino === oldStats.ino && attempts < 16) {
    await unlink(path);
    await writeFile(path, "b", { mode: 0o644 });
    newStats = await lstat(path, { bigint: true });
    attempts += 1;
  }
  assert.notEqual(newStats.ino, oldStats.ino);
  const before = await immutableFacts(path);

  const result = await module.runEntryMetadataHelper(modeRequest(path, oldStats, 0o600));

  assert.equal(result.ok, false);
  assert.equal(result.executorInvoked, true);
  assert.equal(result.error.code, "STALE_REFERENCE");
  assertUnchanged(await immutableFacts(path), before, "replacement file");
});

test("entry metadata helper rejects a regular file replaced by a symlink without touching the target", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const sensitive = join(dir, "sensitive.txt");
  const path = join(dir, "swap.txt");
  await writeFile(sensitive, "sensitive", { mode: 0o600 });
  await writeFile(path, "original", { mode: 0o644 });
  const original = await lstat(path, { bigint: true });
  const sensitiveBefore = await immutableFacts(sensitive);
  await unlink(path);
  await symlink("sensitive.txt", path);

  const result = await module.runEntryMetadataHelper(modeRequest(path, original, 0o600));

  assert.equal(result.ok, false);
  assert.equal(result.executorInvoked, true);
  assert.ok(["STALE_REFERENCE", "TYPE_UNSUPPORTED", "ELOOP"].includes(result.error.code), result.error.code);
  assertUnchanged(await immutableFacts(sensitive), sensitiveBefore, "sensitive target");
});

test("entry metadata helper returns ENOENT for a missing path after invocation", async t => {
  const module = await api();
  const dir = await freshDir(t);
  const path = join(dir, "gone.txt");
  await writeFile(path, "gone", { mode: 0o644 });
  const stats = await lstat(path, { bigint: true });
  await unlink(path);

  const result = await module.runEntryMetadataHelper(modeRequest(path, stats, 0o600));

  assert.equal(result.ok, false);
  assert.equal(result.executorInvoked, true);
  assert.equal(result.error.code, "ENOENT");
});

test("entry metadata helper CLI rejects an invalid operation argv with EINVAL", async () => {
  const module = await api();
  const helperPath = module.entryMetadataHelperPath();
  let error = null;
  try {
    await execFileAsync(process.execPath, [helperPath, "entry.bogus.set"], {
      shell: false,
      encoding: "utf8",
    });
  } catch (err) {
    error = err;
  }
  assert.ok(error, "invalid argv must fail");
  assert.equal(error.code, 1);
  const receipt = JSON.parse(error.stderr.trim());
  assert.equal(receipt.ok, false);
  assert.equal(receipt.errno, "EINVAL");
});

test("deterministic comparators reject masking, sentinels, and out-of-range values", async t => {
  const module = await api();

  assert.equal(module.compareModeEquals(0o100640, 0o640), true);
  assert.throws(() => module.compareModeEquals(0o100640, 0o100640), TypeError);
  assert.throws(() => module.compareModeEquals(0o640, 4294967296), TypeError);

  assert.equal(module.compareOwnerEquals({ uid: "501", gid: "20" }, { uid: 501, gid: 20 }), true);
  assert.equal(module.compareOwnerEquals({ uid: "501", gid: "20" }, { uid: 501, gid: 21 }), false);
  assert.equal(module.compareOwnerEquals(null, { uid: 501, gid: 20 }), false);
  assert.throws(() => module.compareOwnerEquals({ uid: 0, gid: 0 }, { uid: 4294967295, gid: 20 }), TypeError);

  const base = 1_700_000_000_000_000_000n;
  assert.equal(
    module.compareTimesEquals(
      { atimeNs: base.toString(), mtimeNs: base.toString() },
      { atimeNs: (base + 1000n).toString(), mtimeNs: base.toString() },
    ),
    true,
  );
  assert.equal(
    module.compareTimesEquals(
      { atimeNs: base.toString(), mtimeNs: base.toString() },
      { atimeNs: base.toString(), mtimeNs: (base + 1001n).toString() },
    ),
    false,
  );
  assert.equal(module.compareTimesEquals(null, { atimeNs: base.toString(), mtimeNs: base.toString() }), false);
  assert.throws(
    () => module.compareTimesEquals(
      { atimeNs: base.toString(), mtimeNs: base.toString() },
      { atimeNs: "4102444800000000001", mtimeNs: base.toString() },
    ),
    TypeError,
  );
});
