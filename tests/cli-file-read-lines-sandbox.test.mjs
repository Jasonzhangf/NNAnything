import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFileLines } from "../dist/adapters/cli/file-content.js";

const api = () => import("../dist/cli-goal.js");
const execFileAsync = promisify(execFile);
const mkfifo = path => execFileAsync("/usr/bin/mkfifo", [path]);

const LIMITS = Object.freeze({
  timeoutMs: 10_000,
  killGraceMs: 250,
  maxStdoutBytes: 16_777_216,
  maxStderrBytes: 1_048_576,
});

function countingIo(overrides = {}) {
  let opens = 0;
  let spawns = 0;
  const io = {
    lstat: overrides.lstat ?? ((path, options) => lstat(path, options)),
    open: async (path, flags) => {
      opens += 1;
      return (overrides.open ?? open)(path, flags);
    },
    spawn: (executable, argv, options) => {
      spawns += 1;
      return spawn(executable, [...argv], { shell: false, stdio: [...options.stdio] });
    },
  };
  return { io, opens: () => opens, spawns: () => spawns };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "nn-file-read-lines-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const counter = countingIo(options.ioOverrides);
  const module = await api();
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "lines",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/sub", kind: "directory" },
      ],
      sessions: options.sessions ?? [{ id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] }],
    },
    fileReadIo: options.fileReadIo ?? counter.io,
    ...(options.withLimits === false ? {} : { fileReadLinesOptions: options.limits ?? LIMITS }),
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  return { sandbox, session, startAbs: sandbox.getSession(session).cwd, counter };
}

async function bindBytes(fx, name, bytes) {
  const absolute = join(fx.startAbs, name);
  await writeFile(absolute, bytes);
  return { absolute, ref: await fx.sandbox.bindFile(fx.session, absolute) };
}

function assertSucceeded(receipt, ref, anchor, count, expected, expectedLines) {
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.execution.status, "succeeded");
  assert.equal(receipt.execution.executorInvoked, true);
  const observation = receipt.execution.observation;
  assert.equal(observation.kind, "file.read.lines");
  assert.deepEqual(observation.ref, ref);
  assert.equal(observation.anchor, anchor);
  assert.equal(observation.requestedCount, count);
  assert.deepEqual(Buffer.from(observation.bytes, "base64"), expected);
  assert.equal(observation.bytesRead, expected.length);
  assert.equal(observation.logicalLines, expectedLines);
  assert.deepEqual(observation.identity, { dev: ref.identity.dev, ino: ref.identity.ino });
  assert.equal(observation.process.executable, anchor === "head" ? "/usr/bin/head" : "/usr/bin/tail");
  assert.deepEqual(observation.process.argv, ["-n", String(count)]);
  assert.equal(observation.process.exitCode, 0);
  assert.equal(observation.process.signal, null);
  assert.equal(observation.process.terminationReason, "exit");
  assert.equal(observation.process.captureComplete, true);
  assert.equal(observation.process.stderr, "");
  assert.deepEqual(receipt.session_after, receipt.session_before);
}

function assertDenied(receipt, code, stage = undefined) {
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.execution.status, "failed");
  assert.equal(receipt.execution.executorInvoked, false);
  assert.equal(receipt.execution.error.code, code);
  if (stage !== undefined) assert.equal(receipt.execution.error.stage, stage);
  assert.equal(receipt.execution.observation, undefined);
  assert.equal(receipt.execution.process, undefined);
}

test("file.read.lines missing configuration rejects before open and spawn", async t => {
  const fx = await fixture(t, { withLimits: false });
  const { ref } = await bindBytes(fx, "short.txt", Buffer.from("one\ntwo\n"));
  const receipt = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref, anchor: "head", count: 1 },
  });
  assertDenied(receipt, "CONFIG_MISSING", "validate");
  assert.equal(fx.counter.opens(), 0);
  assert.equal(fx.counter.spawns(), 0);
});

test("file.read.lines head and tail match fixture bytes on empty, short, exact, long and no-final-LF inputs", async t => {
  const fx = await fixture(t);
  const cases = [
    { name: "empty", bytes: Buffer.from(""), count: 2, head: Buffer.from(""), tail: Buffer.from(""), headLines: 0, tailLines: 0 },
    { name: "short", bytes: Buffer.from("alpha\nbeta\n"), count: 5, head: Buffer.from("alpha\nbeta\n"), tail: Buffer.from("alpha\nbeta\n"), headLines: 2, tailLines: 2 },
    { name: "exact", bytes: Buffer.from("one\ntwo\nthree\n"), count: 3, head: Buffer.from("one\ntwo\nthree\n"), tail: Buffer.from("one\ntwo\nthree\n"), headLines: 3, tailLines: 3 },
    { name: "long", bytes: Buffer.from("1\n2\n3\n4\n5\n6\n"), count: 2, head: Buffer.from("1\n2\n"), tail: Buffer.from("5\n6\n"), headLines: 2, tailLines: 2 },
    { name: "no-final-lf", bytes: Buffer.from("a\nb\nc"), count: 2, head: Buffer.from("a\nb\n"), tail: Buffer.from("b\nc"), headLines: 2, tailLines: 2 },
    { name: "no-final-lf-short", bytes: Buffer.from("a\nb\nc"), count: 4, head: Buffer.from("a\nb\nc"), tail: Buffer.from("a\nb\nc"), headLines: 3, tailLines: 3 },
  ];
  for (const scenario of cases) {
    const { ref } = await bindBytes(fx, `${scenario.name}.txt`, scenario.bytes);
    const head = await fx.sandbox.execute({
      operation: "file.read.lines",
      parameters: { ref, anchor: "head", count: scenario.count },
    });
    assertSucceeded(head, ref, "head", scenario.count, scenario.head, scenario.headLines);
    const tail = await fx.sandbox.execute({
      operation: "file.read.lines",
      parameters: { ref, anchor: "tail", count: scenario.count },
    });
    assertSucceeded(tail, ref, "tail", scenario.count, scenario.tail, scenario.tailLines);
  }
});

test("file.read.lines preserves NUL and non-UTF-8 bytes exactly", async t => {
  const fx = await fixture(t);
  const source = Buffer.from([0x00, 0x41, 0xff, 0xfe, 0x0a, 0x42, 0x0a, 0xc3, 0x28, 0x0a]);
  const { ref } = await bindBytes(fx, "binary.bin", source);
  const head = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref, anchor: "head", count: 2 },
  });
  assertSucceeded(head, ref, "head", 2, source.subarray(0, 7), 2);
  const tail = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref, anchor: "tail", count: 1 },
  });
  assertSucceeded(tail, ref, "tail", 1, source.subarray(7), 1);
});

test("file.read.lines missing each effect separately denies before open and spawn", async t => {
  const fx = await fixture(t, {
    sessions: [
      { id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] },
      { id: "noexec", cwd: "start", grantedEffects: ["filesystem.read"] },
      { id: "noread", cwd: "start", grantedEffects: ["process.exec"] },
    ],
  });
  const { ref } = await bindBytes(fx, "data.txt", "payload\n");
  for (const sessionId of ["noexec", "noread"]) {
    const crafted = { ...ref, sessionId };
    const receipt = await fx.sandbox.execute({
      operation: "file.read.lines",
      parameters: { ref: crafted, anchor: "head", count: 1 },
    });
    assertDenied(receipt, "EFFECT_DENIED", "authorize");
  }
  assert.equal(fx.counter.opens(), 0);
  assert.equal(fx.counter.spawns(), 0);
});

test("file.read.lines rejects forged and stale references with zero open and zero spawn", async t => {
  const fx = await fixture(t, {
    sessions: [{ id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec", "session.write"] }],
  });
  const { ref } = await bindBytes(fx, "data.txt", "payload\n");

  const forged = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref: { ...ref, sourceRun: "forged-source-run" }, anchor: "head", count: 1 },
  });
  assertDenied(forged, "binding_identity_missing", "authorize");

  const wrongIdentity = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref: { ...ref, identity: { dev: ref.identity.dev, ino: Number(ref.identity.ino) + 1 } }, anchor: "head", count: 1 },
  });
  assertDenied(wrongIdentity, "binding_identity_missing", "authorize");

  const destination = await fx.sandbox.bindDirectory(fx.session, "sub");
  const moved = await fx.sandbox.execute({ operation: "cwd.set", parameters: { session: fx.session, directory: destination } });
  assert.equal(moved.execution.status, "succeeded");
  const stale = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref, anchor: "head", count: 1 },
  });
  assertDenied(stale, "STALE_REFERENCE", "authorize");
  assert.equal(fx.counter.opens(), 0);
  assert.equal(fx.counter.spawns(), 0);
});

test("file.read.lines rejects directory, symlink and FIFO references without opening or spawning", async t => {
  const fx = await fixture(t);
  await writeFile(join(fx.startAbs, "data.txt"), "payload\n");
  const directoryRef = await fx.sandbox.bindDirectoryObject(fx.session, join(fx.startAbs, "sub"));
  const directory = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref: directoryRef, anchor: "head", count: 1 },
  });
  assertDenied(directory, "NOT_REGULAR_FILE", "authorize");

  const symlinkPath = join(fx.startAbs, "link");
  await symlink("data.txt", symlinkPath);
  const symlinkRef = await fx.sandbox.bindEntry(fx.session, symlinkPath);
  const symlinkResult = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref: symlinkRef, anchor: "head", count: 1 },
  });
  assertDenied(symlinkResult, "NOT_REGULAR_FILE", "authorize");

  const fifoPath = join(fx.startAbs, "pipe");
  await mkfifo(fifoPath);
  const fifoRef = await fx.sandbox.bindEntry(fx.session, fifoPath);
  const fifo = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref: fifoRef, anchor: "head", count: 1 },
  });
  assertDenied(fifo, "NOT_REGULAR_FILE", "authorize");
  assert.equal(fx.counter.opens(), 0);
  assert.equal(fx.counter.spawns(), 0);
});

test("file.read.lines rejects path substitution and invalid parameters before execution", async t => {
  const fx = await fixture(t);
  const { ref, absolute } = await bindBytes(fx, "data.txt", "payload\n");
  await assert.rejects(
    fx.sandbox.execute({ operation: "file.read.lines", parameters: { path: absolute, anchor: "head", count: 1 } }),
    TypeError,
  );
  await assert.rejects(
    fx.sandbox.execute({ operation: "file.read.lines", parameters: { ref, anchor: "head", count: 1, extra: true } }),
    TypeError,
  );
  await assert.rejects(
    fx.sandbox.execute({ operation: "file.read.lines", parameters: { ref, anchor: "middle", count: 1 } }),
    TypeError,
  );
  await assert.rejects(
    fx.sandbox.execute({ operation: "file.read.lines", parameters: { ref, anchor: "head", count: 0 } }),
    TypeError,
  );
  await assert.rejects(
    fx.sandbox.execute({ operation: "file.read.lines", parameters: { ref, anchor: "head", count: 1.5 } }),
    TypeError,
  );
  assert.equal(fx.counter.opens(), 0);
  assert.equal(fx.counter.spawns(), 0);
});

test("file.read.lines rejects an already aborted signal before open and spawn", async t => {
  const controller = new AbortController();
  controller.abort();
  const fx = await fixture(t, { limits: { ...LIMITS, signal: controller.signal } });
  const { ref } = await bindBytes(fx, "data.txt", "payload\n");
  const receipt = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref, anchor: "head", count: 1 },
  });
  assertDenied(receipt, "ABORT_ERR", "observe");
  assert.equal(fx.counter.opens(), 0);
  assert.equal(fx.counter.spawns(), 0);
});

test("file.read.lines replacement before verified open is stale with zero open and zero spawn", async t => {
  const fx = await fixture(t);
  const { absolute, ref } = await bindBytes(fx, "swap.txt", "ORIGINAL\n");
  await rename(absolute, join(fx.startAbs, "moved.txt"));
  await writeFile(absolute, "REPLACEMENT\n");
  const receipt = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref, anchor: "head", count: 1 },
  });
  assertDenied(receipt, "STALE_REFERENCE", "authorize");
  assert.equal(fx.counter.opens(), 0);
  assert.equal(fx.counter.spawns(), 0);
});

test("file.read.lines refuses a preflight-to-open identity change before spawn", async t => {
  let other;
  const io = countingIo({
    lstat: (path, options) => lstat(other, options),
    open: async (path, flags) => {
      const handle = await open(other, flags);
      return {
        stat: (...args) => handle.stat(...args),
        read: (...args) => handle.read(...args),
        close: async () => {
          io.closeCount = (io.closeCount ?? 0) + 1;
          return handle.close();
        },
        get fd() { return handle.fd; },
      };
    },
  });
  const fx = await fixture(t, { fileReadIo: io.io });
  const { ref } = await bindBytes(fx, "stable.bin", "STABLE\n");
  other = join(fx.startAbs, "other.bin");
  await writeFile(other, "DIFFERENT\n");
  const receipt = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref, anchor: "head", count: 1 },
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.execution.executorInvoked, false);
  assert.equal(receipt.execution.error.code, "STALE_REFERENCE");
  assert.equal(receipt.execution.observation, undefined);
  assert.equal(io.opens(), 1, "the file was opened via the seam");
  assert.equal(io.closeCount ?? 0, 1, "the rejected handle is closed exactly once");
  assert.equal(io.spawns(), 0, "the native process was not started");
});

test("file.read.lines reads the already opened object after its path is renamed", async t => {
  let fxStartAbs;
  const io = countingIo({
    open: async (path, flags) => {
      const handle = await open(path, flags);
      await rename(path, join(fxStartAbs, "opened-moved.txt"));
      await writeFile(path, "REPLACEMENT-1\nREPLACEMENT-2\n");
      return handle;
    },
  });
  const fx = await fixture(t, { fileReadIo: io.io });
  fxStartAbs = fx.startAbs;
  const { ref } = await bindBytes(fx, "opened.txt", "ORIGINAL-1\nORIGINAL-2\n");
  const receipt = await fx.sandbox.execute({
    operation: "file.read.lines",
    parameters: { ref, anchor: "head", count: 2 },
  });
  assertSucceeded(receipt, ref, "head", 2, Buffer.from("ORIGINAL-1\nORIGINAL-2\n"), 2);
  assert.equal(io.opens(), 1);
  assert.equal(io.spawns(), 1);
});

test("file.read.lines closes the opened handle exactly once when the post-open target is non-regular", async t => {
  const fx = await fixture(t);
  const trustedPath = join(fx.startAbs, "trusted.bin");
  await writeFile(trustedPath, "TRUSTED\n");
  const fifoPath = join(fx.startAbs, "pipe");
  await mkfifo(fifoPath);
  const io = countingIo({
    lstat: async (path, options) => lstat(trustedPath, options),
    open: async (path, flags) => {
      const handle = await open(fifoPath, flags);
      return {
        stat: (...args) => handle.stat(...args),
        read: (...args) => handle.read(...args),
        close: async () => {
          io.closeCount = (io.closeCount ?? 0) + 1;
          return handle.close();
        },
        get fd() { return handle.fd; },
      };
    },
  });
  const controlled = await readFileLines(trustedPath, "head", 1, LIMITS, undefined, io.io);
  assert.equal(controlled.ok, false);
  assert.equal(controlled.error.code, "READ_TYPE_DENIED");
  assert.equal(io.closeCount ?? 0, 1, "the non-regular handle is closed exactly once");
});

test("file.read.lines closes the opened handle exactly once on a post-open identity swap", async t => {
  const fx = await fixture(t);
  const trustedPath = join(fx.startAbs, "trusted.bin");
  await writeFile(trustedPath, "TRUSTED\n");
  const otherPath = join(fx.startAbs, "other.bin");
  await writeFile(otherPath, "OTHER\n");
  const io = countingIo({
    lstat: async (path, options) => lstat(trustedPath, options),
    open: async (path, flags) => {
      const handle = await open(otherPath, flags);
      return {
        stat: (...args) => handle.stat(...args),
        read: (...args) => handle.read(...args),
        close: async () => {
          io.closeCount = (io.closeCount ?? 0) + 1;
          return handle.close();
        },
        get fd() { return handle.fd; },
      };
    },
  });
  const controlled = await readFileLines(trustedPath, "head", 1, LIMITS, undefined, io.io);
  assert.equal(controlled.ok, false);
  assert.equal(controlled.error.code, "READ_TARGET_CHANGED");
  assert.equal(io.closeCount ?? 0, 1, "the rejected handle is closed exactly once");
});

async function lifecycleRun(t, options) {
  const root = await mkdtemp(join(tmpdir(), "nn-native-line-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "seed.bin");
  await writeFile(file, "seed\n");
  let spawns = 0;
  const io = {
    lstat,
    open,
    spawn: (executable, argv, spawnOptions) => {
      spawns += 1;
      if (options.spawnOverride !== undefined) return options.spawnOverride(executable, argv, spawnOptions);
      return spawn(process.execPath, ["-e", options.script], {
        shell: false,
        stdio: [spawnOptions.stdio[0], "pipe", "pipe"],
      });
    },
  };
  const result = await readFileLines(
    file,
    options.anchor ?? "head",
    options.count ?? 1,
    { ...LIMITS, ...options.limits, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    undefined,
    io,
  );
  return { result, spawns };
}

test("native line helper: spawn failure keeps real errno and reports executor invoked", { timeout: 5_000 }, async t => {
  const { result, spawns } = await lifecycleRun(t, {
    script: "",
    spawnOverride: (executable, argv, options) => spawn("/nonexistent/nn-native-line-reader", [], {
      shell: false,
      stdio: [options.stdio[0], "pipe", "pipe"],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.executorInvoked, true);
  assert.equal(result.error.code, "ENOENT");
  assert.equal(result.process.terminationReason, "spawn_error");
  assert.equal(result.process.exitCode, -2);
  assert.equal(spawns, 1);
});

test("native line helper: non-zero exit and signal are failures", { timeout: 5_000 }, async t => {
  const exited = await lifecycleRun(t, { script: "process.stdout.write('x'); process.exit(7);" });
  assert.equal(exited.result.ok, false);
  assert.equal(exited.result.executorInvoked, true);
  assert.equal(exited.result.error.code, "PROCESS_EXIT");
  assert.equal(exited.result.process.exitCode, 7);
  assert.equal(exited.result.process.terminationReason, "exit");

  const signaled = await lifecycleRun(t, { script: "process.kill(process.pid, 'SIGTERM');" });
  assert.equal(signaled.result.ok, false);
  assert.equal(signaled.result.error.code, "PROCESS_SIGNAL");
  assert.equal(signaled.result.process.signal, "SIGTERM");
});

test("native line helper: timeout terminates its own child", { timeout: 5_000 }, async t => {
  const { result, spawns } = await lifecycleRun(t, {
    script: "process.on('SIGTERM', () => {}); process.stdout.write('started\\n'); setInterval(() => {}, 1000);",
    limits: { timeoutMs: 100, killGraceMs: 50 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.executorInvoked, true);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.process.terminationReason, "timeout");
  assert.notEqual(result.process.signal, null);
  assert.equal(spawns, 1);
});

test("native line helper: abort terminates its own child", { timeout: 5_000 }, async t => {
  const controller = new AbortController();
  const pending = lifecycleRun(t, {
    script: "process.on('SIGTERM', () => {}); process.stdout.write('started\\n'); setInterval(() => {}, 1000);",
    limits: { timeoutMs: 5_000, killGraceMs: 50 },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  const { result, spawns } = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.executorInvoked, true);
  assert.equal(result.error.code, "ABORT_ERR");
  assert.equal(result.process.terminationReason, "abort");
  assert.notEqual(result.process.signal, null);
  assert.equal(spawns, 1);
});

test("native line helper: stdout and stderr limits fail without returning partial success", { timeout: 5_000 }, async t => {
  const stdout = await lifecycleRun(t, {
    script: "process.stdout.write('x'.repeat(200000));",
    limits: { maxStdoutBytes: 32 },
  });
  assert.equal(stdout.result.ok, false);
  assert.equal(stdout.result.error.code, "STDOUT_LIMIT");
  assert.equal(stdout.result.process.terminationReason, "stdout_limit");
  assert.equal(stdout.result.process.captureComplete, false);

  const stderr = await lifecycleRun(t, {
    script: "process.stderr.write('e'.repeat(200000));",
    limits: { maxStderrBytes: 16 },
  });
  assert.equal(stderr.result.ok, false);
  assert.equal(stderr.result.error.code, "STDERR_LIMIT");
  assert.equal(stderr.result.process.terminationReason, "stderr_limit");
  assert.equal(stderr.result.process.captureComplete, false);
  assert.equal(Buffer.from(stderr.result.process.stderr, "base64").length, 16);
});

test("native line helper: non-empty stderr alone does not fail a complete read", { timeout: 5_000 }, async t => {
  const { result } = await lifecycleRun(t, {
    script: "process.stdout.write('ok\\n'); process.stderr.write('warn\\n');",
  });
  assert.equal(result.ok, true);
  assert.equal(result.observation.requestedCount, 1);
  assert.deepEqual(Buffer.from(result.observation.bytes, "base64"), Buffer.from("ok\n"));
  assert.equal(result.observation.logicalLines, 1);
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.process.terminationReason, "exit");
  assert.equal(result.process.captureComplete, true);
  assert.deepEqual(Buffer.from(result.process.stderr, "base64"), Buffer.from("warn\n"));
});
