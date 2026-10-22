import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const api = () => import("../dist/cli-goal.js");
const execFileAsync = promisify(execFile);
const mkfifo = path => execFileAsync("/usr/bin/mkfifo", [path]);

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

async function makeSandbox(root, recipe, fileReadIo) {
  const module = await api();
  const base = { root, ownerGrantedEffects: ["filesystem.write"], recipe };
  try {
    return await module.createCliFilesystemSandbox({ ...base, fileReadIo });
  } catch (error) {
    if (error instanceof TypeError && /sandbox options/.test(String(error))) {
      // Red-phase compatibility: the fileReadIo test seam does not exist yet.
      return module.createCliFilesystemSandbox(base);
    }
    throw error;
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "nn-file-read-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const counter = countingIo();
  const fileReadIo = options.fileReadIo ?? counter.io;
  const sessions = options.sessions ?? [{ id: "s", cwd: "start", grantedEffects: ["filesystem.read"] }];
  const sandbox = await makeSandbox(
    root,
    {
      scenarioId: "read",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/sub", kind: "directory" },
        { path: "start/data.bin", kind: "file", contents: "placeholder" },
        ...(options.entries ?? []),
      ],
      sessions,
    },
    fileReadIo,
  );
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  return {
    sandbox,
    session,
    startAbs: sandbox.getSession(session).cwd,
    openCount: () => counter.count(),
  };
}

async function bindRegularFile(fixtureState, name, bytes) {
  const absolute = join(fixtureState.startAbs, name);
  await writeFile(absolute, bytes);
  return { absolute, ref: await fixtureState.sandbox.bindFile(fixtureState.session, absolute) };
}

function identityOf(ref) {
  return { dev: ref.identity.dev, ino: ref.identity.ino };
}

function assertIdentityMatches(observation, ref) {
  assert.deepEqual(observation.identity, identityOf(ref), "post-open identity must match the trusted reference");
}

test("P1 file.read: trusted regular ref reads a real byte range", async t => {
  const fx = await fixture(t);
  const { ref } = await bindRegularFile(fx, "data.bin", Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a, 0x14]));
  const receipt = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref, offset: 1, length: 3 },
  });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.execution.status, "succeeded");
  assert.equal(receipt.execution.executorInvoked, true);
  const observation = receipt.execution.observation;
  assert.equal(observation.kind, "file.read");
  assert.deepEqual(observation.ref, ref);
  assert.equal(observation.offset, 1);
  assert.equal(observation.length, 3);
  assert.equal(observation.size, 7);
  assert.equal(observation.bytesRead, 3);
  assert.equal(observation.eof, false);
  assert.deepEqual(Buffer.from(observation.bytes, "base64"), Buffer.from([0x01, 0x02, 0xff]));
  assertIdentityMatches(observation, ref);
  assert.equal(fx.openCount(), 1);
});

test("P1 file.read: zero-length read succeeds and still verifies identity", async t => {
  const fx = await fixture(t);
  const { ref } = await bindRegularFile(fx, "data.bin", Buffer.from("abc"));
  const receipt = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref, offset: 0, length: 0 },
  });
  assert.equal(receipt.status, "succeeded");
  const observation = receipt.execution.observation;
  assert.equal(observation.bytesRead, 0);
  assert.equal(observation.bytes, "");
  assert.equal(observation.eof, false, "zero length does not claim EOF by itself");
  assert.equal(observation.size, 3);
  assertIdentityMatches(observation, ref);
  assert.equal(fx.openCount(), 1, "identity is verified through a real open");
});

test("P1 file.read: short read past EOF reports bytesRead and eof", async t => {
  const fx = await fixture(t);
  const { ref } = await bindRegularFile(fx, "data.bin", Buffer.from([0x0a, 0x14, 0x1e, 0x28, 0x32, 0x3c, 0x46]));
  const receipt = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref, offset: 5, length: 10 },
  });
  assert.equal(receipt.status, "succeeded");
  const observation = receipt.execution.observation;
  assert.equal(observation.bytesRead, 2);
  assert.equal(observation.eof, true);
  assert.ok(observation.bytesRead < observation.length, "short read must not pretend completeness");
  assert.deepEqual(Buffer.from(observation.bytes, "base64"), Buffer.from([0x3c, 0x46]));
  assert.equal(fx.openCount(), 1);
});

test("P1 file.read: forged sourceRun, revision and identity reject with zero opens", async t => {
  const fx = await fixture(t);
  const { ref } = await bindRegularFile(fx, "data.bin", Buffer.from("payload"));

  const forgedSourceRun = { ...ref, sourceRun: "forged-source-run" };
  const forgedSourceResult = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref: forgedSourceRun, offset: 0, length: 1 },
  });
  assert.equal(forgedSourceResult.status, "failed");
  assert.equal(forgedSourceResult.execution.executorInvoked, false);
  assert.equal(forgedSourceResult.execution.error.code, "binding_identity_missing");

  const wrongRevision = { ...ref, sessionRevision: ref.sessionRevision + 1 };
  const wrongRevisionResult = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref: wrongRevision, offset: 0, length: 1 },
  });
  assert.equal(wrongRevisionResult.status, "failed");
  assert.equal(wrongRevisionResult.execution.executorInvoked, false);
  assert.equal(wrongRevisionResult.execution.error.code, "binding_identity_missing");

  const wrongIdentity = { ...ref, identity: { dev: ref.identity.dev, ino: Number(ref.identity.ino) + 1 } };
  const wrongIdentityResult = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref: wrongIdentity, offset: 0, length: 1 },
  });
  assert.equal(wrongIdentityResult.status, "failed");
  assert.equal(wrongIdentityResult.execution.executorInvoked, false);
  assert.equal(wrongIdentityResult.execution.error.code, "binding_identity_missing");

  assert.equal(fx.openCount(), 0, "no file was opened");
});

test("P1 file.read: directory and non-regular refs reject without opening", async t => {
  const fx = await fixture(t);
  const directoryRef = await fx.sandbox.bindDirectoryObject(fx.session, join(fx.startAbs, "sub"));
  const directoryResult = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref: directoryRef, offset: 0, length: 1 },
  });
  assert.equal(directoryResult.status, "failed");
  assert.equal(directoryResult.execution.executorInvoked, false);
  assert.equal(directoryResult.execution.error.code, "NOT_REGULAR_FILE");

  await symlink("data.bin", join(fx.startAbs, "link"));
  const symlinkRef = await fx.sandbox.bindEntry(fx.session, join(fx.startAbs, "link"));
  const symlinkResult = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref: symlinkRef, offset: 0, length: 1 },
  });
  assert.equal(symlinkResult.status, "failed");
  assert.equal(symlinkResult.execution.executorInvoked, false);
  assert.equal(symlinkResult.execution.error.code, "NOT_REGULAR_FILE");

  assert.equal(fx.openCount(), 0);
});

test("P1 file.read: same-path inode swap is stale and never returns bytes", async t => {
  const fx = await fixture(t);
  const absolute = join(fx.startAbs, "swap.bin");
  await writeFile(absolute, "ORIGINAL");
  const ref = await fx.sandbox.bindFile(fx.session, absolute);

  await rename(absolute, join(fx.startAbs, "moved.bin"));
  await writeFile(absolute, "REPLACEMENT");

  const receipt = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref, offset: 0, length: 8 },
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.execution.executorInvoked, false);
  assert.equal(receipt.execution.error.code, "STALE_REFERENCE");
  assert.equal(fx.openCount(), 0, "the replaced path was never opened through the trusted ref");

  // A swap between the preflight lstat and the actual open must also be caught
  // by comparing the post-open identity with the trusted ref. The seam below
  // resolves the trusted path to a different regular file, so readFileRange's
  // own pre-open/post-open check passes; only the ref comparison can refuse it.
  const other = join(fx.startAbs, "other.bin");
  await writeFile(other, "DIFFERENT");
  const { io } = countingIo();
  io.lstat = (path, options) => lstat(other, options);
  io.open = (path, flags) => open(other, flags);
  const second = await fixture(t, { fileReadIo: io });
  const swappedFile = join(second.startAbs, "stable.bin");
  await writeFile(swappedFile, "STABLE");
  const swappedRef = await second.sandbox.bindFile(second.session, swappedFile);
  const swappedReceipt = await second.sandbox.execute({
    operation: "file.read",
    parameters: { ref: swappedRef, offset: 0, length: 6 },
  });
  assert.equal(swappedReceipt.status, "failed");
  assert.equal(swappedReceipt.execution.error.code, "STALE_REFERENCE");
  assert.equal(swappedReceipt.execution.observation, undefined);
});

test("P1 file.read: stale session revision rejects an old ref", async t => {
  const fx = await fixture(t, { sessions: [{ id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec", "session.write"] }] });
  const { ref } = await bindRegularFile(fx, "data.bin", Buffer.from("payload"));
  const destination = await fx.sandbox.bindDirectory(fx.session, "sub");
  const moved = await fx.sandbox.execute({
    operation: "cwd.set",
    parameters: { session: fx.session, directory: destination },
  });
  assert.equal(moved.execution.status, "succeeded");

  const receipt = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref, offset: 0, length: 1 },
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.execution.executorInvoked, false);
  assert.equal(receipt.execution.error.code, "STALE_REFERENCE");
  assert.equal(fx.openCount(), 0);
});

test("P1 file.read: missing filesystem.read rejects with EFFECT_DENIED and zero opens", async t => {
  const fx = await fixture(t, {
    sessions: [
      { id: "s", cwd: "start", grantedEffects: ["filesystem.read"] },
      { id: "noread", cwd: "start", grantedEffects: ["process.exec"] },
    ],
  });
  const { ref } = await bindRegularFile(fx, "data.bin", Buffer.from("payload"));
  const crafted = { ...ref, sessionId: "noread" };
  const receipt = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref: crafted, offset: 0, length: 1 },
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.execution.executorInvoked, false);
  assert.equal(receipt.execution.error.code, "EFFECT_DENIED");
  assert.equal(receipt.execution.error.stage, "authorize");
  assert.equal(fx.openCount(), 0);
});

test("P1 file.read: real EACCES stays a real errno", async t => {
  const fx = await fixture(t);
  const { absolute, ref } = await bindRegularFile(fx, "locked.bin", Buffer.from("secret"));
  await chmod(absolute, 0o000);
  try {
    const receipt = await fx.sandbox.execute({
      operation: "file.read",
      parameters: { ref, offset: 0, length: 1 },
    });
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.execution.status, "failed");
    assert.equal(receipt.execution.executorInvoked, true);
    assert.equal(receipt.execution.error.code, "EACCES");
    assert.equal(fx.openCount(), 1);
  } finally {
    await chmod(absolute, 0o600);
  }
});

test("P1 file.read: symlink, FIFO and device targets are refused", async t => {
  const fx = await fixture(t);
  await writeFile(join(fx.startAbs, "data.bin"), "payload");

  const symlinkPath = join(fx.startAbs, "final-link");
  await symlink("data.bin", symlinkPath);
  const symlinkRef = await fx.sandbox.bindEntry(fx.session, symlinkPath);
  await assert.rejects(fx.sandbox.bindFile(fx.session, symlinkPath), { code: "NOT_REGULAR_FILE" });
  const symlinkResult = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref: symlinkRef, offset: 0, length: 1 },
  });
  assert.equal(symlinkResult.status, "failed");
  assert.equal(symlinkResult.execution.executorInvoked, false);
  assert.equal(symlinkResult.execution.error.code, "NOT_REGULAR_FILE");

  const fifoPath = join(fx.startAbs, "pipe");
  await mkfifo(fifoPath);
  const fifoRef = await fx.sandbox.bindEntry(fx.session, fifoPath);
  const fifoResult = await fx.sandbox.execute({
    operation: "file.read",
    parameters: { ref: fifoRef, offset: 0, length: 1 },
  });
  assert.equal(fifoResult.status, "failed");
  assert.equal(fifoResult.execution.executorInvoked, false);
  assert.equal(fifoResult.execution.error.code, "NOT_REGULAR_FILE");

  const { readFileRange } = await import("../dist/adapters/cli/file-content.js");
  const device = await readFileRange("/dev/null", 0, 1);
  assert.equal(device.ok, false);
  assert.equal(device.error.code, "READ_TYPE_DENIED");
  assert.equal(fx.openCount(), 0);
});

test("P1 file.read: extra parameter keys are rejected before execution", async t => {
  const fx = await fixture(t);
  const { ref } = await bindRegularFile(fx, "data.bin", Buffer.from("payload"));
  await assert.rejects(
    fx.sandbox.execute({ operation: "file.read", parameters: { ref, offset: 0, length: 1, extra: true } }),
    TypeError,
  );
  await assert.rejects(
    fx.sandbox.execute({ operation: "file.read", parameters: { ref, offset: 0 } }),
    TypeError,
  );
  assert.equal(fx.openCount(), 0);
});
