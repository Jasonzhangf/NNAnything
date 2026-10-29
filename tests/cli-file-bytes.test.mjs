import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readFileRange } from "../dist/adapters/cli/file-content.js";
import {
  runFileBytesHelper,
  validateTypedBytes,
  verifyFileAppendReceipt,
  verifyFileCopyReceipt,
  verifyFileReplaceReceipt,
  verifyFileTruncateReceipt,
  verifyFileWriteReceipt,
} from "../dist/adapters/cli/file-bytes.js";

const O_NOFOLLOW = constants.O_NOFOLLOW;
const O_NONBLOCK = constants.O_NONBLOCK;
const O_APPEND = constants.O_APPEND;
const O_CREAT = constants.O_CREAT;
const O_EXCL = constants.O_EXCL;
const O_TRUNC = constants.O_TRUNC;
const O_RDWR = constants.O_RDWR;

function typedBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Object.freeze({
    kind: "cli.bytes",
    base64: bytes.toString("base64"),
    byteLength: bytes.length,
  });
}

async function identity(path) {
  const stats = await lstat(path, { bigint: true });
  return Object.freeze({ dev: stats.dev.toString(), ino: stats.ino.toString() });
}

async function scene(t) {
  const root = await mkdtemp(join(tmpdir(), "nn-p5-a1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function regularFile(root, name, contents) {
  const path = join(root, name);
  await writeFile(path, contents);
  return { path, identity: await identity(path) };
}

async function run(request) {
  return runFileBytesHelper(request);
}

function assertSucceeded(result, operation) {
  assert.equal(result.executorInvoked, true);
  assert.equal(result.receipt.operation, operation);
  assert.equal(result.receipt.ok, true);
  assert.equal(result.receipt.status, "succeeded");
  assert.equal(result.receipt.errorCode, null);
  assert.equal(result.receipt.errno, null);
}

test("file.replace truncates the old tail and preserves dev/ino", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "replace.bin", "abcdefghijklmnop");
  const content = typedBytes("WXYZ");

  const result = await run({
    operation: "file.replace",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    content,
  });

  assertSucceeded(result, "file.replace");
  const { receipt } = result;
  assert.notEqual(receipt.openFlagsUsed & O_RDWR, 0);
  assert.notEqual(receipt.openFlagsUsed & O_NOFOLLOW, 0);
  assert.notEqual(receipt.openFlagsUsed & O_NONBLOCK, 0);
  assert.equal(receipt.openFlagsUsed & O_CREAT, 0, "existing-file replace must not create");
  assert.equal(receipt.openFlagsUsed & O_TRUNC, 0, "truncation must happen after pre-read");
  assert.equal(receipt.preWriteSnapshot.size, 16);
  assert.equal(receipt.postWriteSnapshot.size, 4);
  assert.equal(receipt.postWriteSnapshot.bytesBase64, content.base64);
  assert.deepEqual(receipt.postWriteSnapshot.identity, receipt.preWriteSnapshot.identity);
  assert.equal(receipt.bytesWritten, 4);
  assert.equal(receipt.effectsObserved.mutationCommitted, true);
  assert.deepEqual(receipt.effectsObserved.modifiedPaths, [target.path]);
  assert.equal(await readFile(target.path, "utf8"), "WXYZ");
  assert.equal(verifyFileReplaceReceipt(receipt, content).satisfaction, 100);

  const readBack = await readFileRange(target.path, 0, 4);
  assert.equal(readBack.ok, true);
  assert.equal(readBack.observation.bytesRead, 4);
  assert.equal(readBack.observation.bytes, content.base64);
});

test("file.replace with zero bytes leaves an existing empty file", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "replace-empty.bin", "old");
  const content = typedBytes(Buffer.alloc(0));

  const result = await run({
    operation: "file.replace",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    content,
  });

  assertSucceeded(result, "file.replace");
  assert.equal(result.receipt.postWriteSnapshot.size, 0);
  assert.equal(result.receipt.postWriteSnapshot.bytesBase64, "");
  assert.equal(result.receipt.bytesWritten, 0);
  assert.equal(verifyFileReplaceReceipt(result.receipt, content).satisfaction, 100);
  assert.equal((await readFile(target.path)).length, 0);
});

test("file.replace rejects a missing target without creating it", async t => {
  const root = await scene(t);
  const original = await regularFile(root, "gone.bin", "gone");
  await rm(original.path);

  const result = await run({
    operation: "file.replace",
    workspaceRoot: root,
    targetPath: original.path,
    expectedIdentity: original.identity,
    content: typedBytes("new"),
  });

  assert.equal(result.executorInvoked, true);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.errorCode, "TARGET_MISSING");
  assert.equal(result.receipt.errno, "ENOENT");
  assert.equal(result.receipt.bytesWritten, 0);
  assert.equal(result.receipt.effectsObserved.mutationCommitted, false);
  await assert.rejects(readFile(original.path), error => error.code === "ENOENT");
});

test("file.write patches only the requested window", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "patch.bin", "0123456789abcdef");
  const patch = typedBytes("ABCDE");

  const result = await run({
    operation: "file.write",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    offset: 4,
    content: patch,
  });

  assertSucceeded(result, "file.write");
  assert.equal(result.receipt.bytesWritten, 5);
  assert.equal(result.receipt.openFlagsUsed & O_APPEND, 0);
  assert.equal(result.receipt.openFlagsUsed & O_CREAT, 0);
  assert.equal(await readFile(target.path, "utf8"), "0123ABCDE9abcdef");
  assert.equal(verifyFileWriteReceipt(result.receipt, 4, patch).satisfaction, 100);
});

test("file.write beyond EOF zero-fills the sparse gap", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "sparse.bin", "abcdefghijklmnop");
  const patch = typedBytes("TAIL");

  const result = await run({
    operation: "file.write",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    offset: 24,
    content: patch,
  });

  assertSucceeded(result, "file.write");
  const expected = Buffer.alloc(28);
  Buffer.from("abcdefghijklmnop").copy(expected, 0);
  Buffer.from("TAIL").copy(expected, 24);
  assert.deepEqual(await readFile(target.path), expected);
  assert.deepEqual(result.receipt.postWriteSnapshot.bytesBase64, expected.toString("base64"));
  assert.equal(result.receipt.postWriteSnapshot.size, 28);
  assert.equal(verifyFileWriteReceipt(result.receipt, 24, patch).satisfaction, 100);
});

test("zero-byte file.write beyond EOF does not extend or truncate", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "zero-write.bin", "abcd");
  const empty = typedBytes(Buffer.alloc(0));

  const result = await run({
    operation: "file.write",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    offset: 10,
    content: empty,
  });

  assertSucceeded(result, "file.write");
  assert.equal(result.receipt.bytesWritten, 0);
  assert.equal(result.receipt.postWriteSnapshot.size, 4);
  assert.equal(result.receipt.postWriteSnapshot.bytesBase64, Buffer.from("abcd").toString("base64"));
  assert.equal(result.receipt.effectsObserved.mutationCommitted, false);
  assert.equal((await readFile(target.path)).length, 4);
  assert.equal(verifyFileWriteReceipt(result.receipt, 10, empty).satisfaction, 100);
});

test("file.append reads before and after on the same O_RDWR|O_APPEND fd", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "append.bin", "hello world!");
  const suffix = typedBytes(" again");

  const result = await run({
    operation: "file.append",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    content: suffix,
  });

  assertSucceeded(result, "file.append");
  assert.notEqual(result.receipt.openFlagsUsed & O_APPEND, 0);
  assert.notEqual(result.receipt.openFlagsUsed & O_RDWR, 0);
  assert.equal(result.receipt.openFlagsUsed & O_CREAT, 0);
  assert.equal(result.receipt.preWriteSnapshot.size, 12);
  assert.equal(result.receipt.postWriteSnapshot.size, 18);
  assert.equal(await readFile(target.path, "utf8"), "hello world! again");
  assert.equal(verifyFileAppendReceipt(result.receipt, suffix).satisfaction, 100);
});

test("append post-read loss stays unknown and forbids replay", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "append-unknown.bin", "hello world!");
  const suffix = typedBytes(" again");
  const successful = await run({
    operation: "file.append",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    content: suffix,
  });
  assertSucceeded(successful, "file.append");

  const simulated = {
    ...successful.receipt,
    ok: false,
    status: "unknown",
    errorCode: "POST_READ_FAILED",
    postWriteSnapshot: null,
  };
  const verdict = verifyFileAppendReceipt(simulated, suffix);
  assert.equal(verdict.status, "unknown");
  assert.equal(verdict.satisfaction, null);
  assert.equal(verdict.replayForbidden, true);
  assert.equal(simulated.effectsObserved.bytesWritten, 6);
  assert.equal(simulated.effectsObserved.mutationCommitted, true);
});

test("file.truncate shortens and preserves the retained prefix", async t => {
  const root = await scene(t);
  const original = "0123456789abcdefghijklmnopqrstuv";
  const target = await regularFile(root, "shrink.bin", original);

  const result = await run({
    operation: "file.truncate",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    length: 10,
  });

  assertSucceeded(result, "file.truncate");
  assert.equal(result.receipt.bytesWritten, 0);
  assert.equal(await readFile(target.path, "utf8"), original.slice(0, 10));
  assert.equal(verifyFileTruncateReceipt(result.receipt, 10).satisfaction, 100);
});

test("file.truncate extends with zero bytes", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "extend.bin", "0123456789");

  const result = await run({
    operation: "file.truncate",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    length: 20,
  });

  assertSucceeded(result, "file.truncate");
  const expected = Buffer.alloc(20);
  Buffer.from("0123456789").copy(expected, 0);
  assert.deepEqual(await readFile(target.path), expected);
  assert.equal(verifyFileTruncateReceipt(result.receipt, 20).satisfaction, 100);
});

test("file.truncate rejects a missing target", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "truncate-gone.bin", "gone");
  await rm(target.path);

  const result = await run({
    operation: "file.truncate",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    length: 0,
  });

  assert.equal(result.executorInvoked, true);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.errorCode, "TARGET_MISSING");
  assert.equal(result.receipt.errno, "ENOENT");
  assert.equal(result.receipt.bytesWritten, 0);
});

test("file.copy creates a distinct object with identical bytes", async t => {
  const root = await scene(t);
  const source = await regularFile(root, "source.bin", "fourteen-byte!");
  const parentIdentity = await identity(root);
  const destination = join(root, "copy.bin");

  const result = await run({
    operation: "file.copy",
    workspaceRoot: root,
    sourcePath: source.path,
    expectedSourceIdentity: source.identity,
    destinationParentPath: root,
    expectedParentIdentity: parentIdentity,
    destinationName: basename(destination),
  });

  assertSucceeded(result, "file.copy");
  const { receipt } = result;
  assert.equal(receipt.bytesWritten, 14);
  assert.equal(receipt.openFlagsUsed & O_CREAT, O_CREAT);
  assert.equal(receipt.openFlagsUsed & O_EXCL, O_EXCL);
  assert.deepEqual(receipt.sourceSnapshot, receipt.preWriteSnapshot);
  assert.equal(receipt.destinationSnapshot.bytesBase64, receipt.sourceSnapshot.bytesBase64);
  assert.notDeepEqual(receipt.destinationSnapshot.identity, receipt.sourceSnapshot.identity);
  assert.deepEqual(receipt.effectsObserved.createdPaths, [destination]);
  assert.equal(receipt.effectsObserved.mutationCommitted, true);
  assert.equal(await readFile(destination, "utf8"), "fourteen-byte!");
  assert.equal(verifyFileCopyReceipt(receipt).satisfaction, 100);
});

test("copying an empty file records the immediate create side effect", async t => {
  const root = await scene(t);
  const source = await regularFile(root, "empty-source.bin", Buffer.alloc(0));
  const destination = join(root, "empty-copy.bin");

  const result = await run({
    operation: "file.copy",
    workspaceRoot: root,
    sourcePath: source.path,
    expectedSourceIdentity: source.identity,
    destinationParentPath: root,
    expectedParentIdentity: await identity(root),
    destinationName: basename(destination),
  });

  assertSucceeded(result, "file.copy");
  const { receipt } = result;
  assert.equal(receipt.bytesWritten, 0);
  assert.deepEqual(receipt.effectsObserved.createdPaths, [destination]);
  assert.equal(receipt.effectsObserved.mutationCommitted, true);
  assert.equal(receipt.preWriteSnapshot.size, 0);
  assert.equal(receipt.sourceSnapshot.size, 0);
  assert.equal(receipt.destinationSnapshot.size, 0);
  assert.notDeepEqual(receipt.destinationSnapshot.identity, receipt.sourceSnapshot.identity);
  assert.equal(verifyFileCopyReceipt(receipt).satisfaction, 100);
  assert.equal((await lstat(destination)).size, 0);
});

test("file.copy refuses an existing destination and preserves its bytes", async t => {
  const root = await scene(t);
  const source = await regularFile(root, "existing-source.bin", "source");
  const destination = join(root, "existing-destination.bin");
  await writeFile(destination, "keep-me");

  const result = await run({
    operation: "file.copy",
    workspaceRoot: root,
    sourcePath: source.path,
    expectedSourceIdentity: source.identity,
    destinationParentPath: root,
    expectedParentIdentity: await identity(root),
    destinationName: basename(destination),
  });

  assert.equal(result.executorInvoked, true);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.errorCode, "TARGET_EXISTS");
  assert.equal(result.receipt.errno, "EEXIST");
  assert.equal(result.receipt.bytesWritten, 0);
  assert.deepEqual(result.receipt.effectsObserved.createdPaths, []);
  assert.equal(result.receipt.effectsObserved.mutationCommitted, false);
  assert.equal(await readFile(destination, "utf8"), "keep-me");
});

test("file.copy rejects a missing source and a missing parent directory", async t => {
  const root = await scene(t);
  const source = await regularFile(root, "copy-source.bin", "source");
  const missingSource = join(root, "missing-source.bin");

  const sourceResult = await run({
    operation: "file.copy",
    workspaceRoot: root,
    sourcePath: missingSource,
    expectedSourceIdentity: source.identity,
    destinationParentPath: root,
    expectedParentIdentity: await identity(root),
    destinationName: "missing-source-copy.bin",
  });
  assert.equal(sourceResult.receipt.status, "failed");
  assert.equal(sourceResult.receipt.errorCode, "TARGET_MISSING");
  assert.equal(sourceResult.receipt.errno, "ENOENT");

  const missingParent = join(root, "missing-parent");
  const parentResult = await run({
    operation: "file.copy",
    workspaceRoot: root,
    sourcePath: source.path,
    expectedSourceIdentity: source.identity,
    destinationParentPath: missingParent,
    expectedParentIdentity: await identity(root),
    destinationName: "copy.bin",
  });
  assert.equal(parentResult.receipt.status, "failed");
  assert.equal(parentResult.receipt.errorCode, "PARENT_NOT_DIRECTORY");
  assert.equal(parentResult.receipt.errno, "ENOENT");
  await assert.rejects(readFile(join(missingParent, "copy.bin")), error => error.code === "ENOENT");
});

test("file.copy same-entry conflict is rejected before child execution", async t => {
  const root = await scene(t);
  const source = await regularFile(root, "same.bin", "unchanged");

  const result = await run({
    operation: "file.copy",
    workspaceRoot: root,
    sourcePath: source.path,
    expectedSourceIdentity: source.identity,
    destinationParentPath: root,
    expectedParentIdentity: await identity(root),
    destinationName: basename(source.path),
  });

  assert.equal(result.executorInvoked, false);
  assert.equal(result.receipt.status, "rejected");
  assert.equal(result.receipt.errorCode, "SAME_ENTRY_CONFLICT");
  assert.equal(result.receipt.bytesWritten, 0);
  assert.equal(result.receipt.effectsObserved.attempted, false);
  assert.equal(result.receipt.effectsObserved.mutationCommitted, false);
  assert.equal(await readFile(source.path, "utf8"), "unchanged");
});

test("file.copy hard-link conflict is rejected before child execution", async t => {
  const root = await scene(t);
  const source = await regularFile(root, "hardlink-source.bin", "shared");
  const destination = join(root, "hardlink-destination.bin");
  await link(source.path, destination);

  const result = await run({
    operation: "file.copy",
    workspaceRoot: root,
    sourcePath: source.path,
    expectedSourceIdentity: source.identity,
    destinationParentPath: root,
    expectedParentIdentity: await identity(root),
    destinationName: basename(destination),
  });

  assert.equal(result.executorInvoked, false);
  assert.equal(result.receipt.status, "rejected");
  assert.equal(result.receipt.errorCode, "SAME_ENTRY_CONFLICT");
  assert.equal(result.receipt.effectsObserved.mutationCommitted, false);
  assert.equal(await readFile(destination, "utf8"), "shared");
});

test("copy evaluator uses the full (dev, ino) pair", async t => {
  const root = await scene(t);
  const source = await regularFile(root, "identity-source.bin", "identity");
  const destination = join(root, "identity-destination.bin");
  const result = await run({
    operation: "file.copy",
    workspaceRoot: root,
    sourcePath: source.path,
    expectedSourceIdentity: source.identity,
    destinationParentPath: root,
    expectedParentIdentity: await identity(root),
    destinationName: basename(destination),
  });
  assertSucceeded(result, "file.copy");

  const crossDeviceSameInode = structuredClone(result.receipt);
  crossDeviceSameInode.destinationSnapshot.identity.dev = (BigInt(crossDeviceSameInode.sourceSnapshot.identity.dev) + 1n).toString();
  crossDeviceSameInode.destinationSnapshot.identity.ino = crossDeviceSameInode.sourceSnapshot.identity.ino;
  assert.equal(verifyFileCopyReceipt(crossDeviceSameInode).status, "achieved");
  assert.equal(verifyFileCopyReceipt(crossDeviceSameInode).satisfaction, 100);

  const sameObject = structuredClone(result.receipt);
  sameObject.destinationSnapshot.identity = { ...sameObject.sourceSnapshot.identity };
  assert.equal(verifyFileCopyReceipt(sameObject).status, "unmet");
  assert.equal(verifyFileCopyReceipt(sameObject).satisfaction, 0);
});

test("write-only files fail O_RDWR before mutation", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "write-only.bin", "protected");
  t.after(() => chmod(target.path, 0o600).catch(() => undefined));
  await chmod(target.path, 0o200);

  const writeResult = await run({
    operation: "file.write",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    offset: 0,
    content: typedBytes("X"),
  });
  const appendResult = await run({
    operation: "file.append",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    content: typedBytes("X"),
  });

  for (const result of [writeResult, appendResult]) {
    assert.equal(result.executorInvoked, true);
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.receipt.errorCode, "PERMISSION_DENIED");
    assert.equal(result.receipt.errno, "EACCES");
    assert.equal(result.receipt.bytesWritten, 0);
    assert.equal(result.receipt.effectsObserved.mutationCommitted, false);
  }
  await chmod(target.path, 0o600);
  assert.equal(await readFile(target.path, "utf8"), "protected");
});

function requestFor(operation, target, targetIdentity, root, rootIdentity) {
  if (operation === "file.copy") {
    return {
      operation,
      workspaceRoot: root,
      sourcePath: target,
      expectedSourceIdentity: targetIdentity,
      destinationParentPath: root,
      expectedParentIdentity: rootIdentity,
      destinationName: `copy-${basename(target)}`,
    };
  }
  if (operation === "file.truncate") {
    return {
      operation,
      workspaceRoot: root,
      targetPath: target,
      expectedIdentity: targetIdentity,
      length: 1,
    };
  }
  if (operation === "file.write") {
    return {
      operation,
      workspaceRoot: root,
      targetPath: target,
      expectedIdentity: targetIdentity,
      offset: 0,
      content: typedBytes("X"),
    };
  }
  return {
    operation,
    workspaceRoot: root,
    targetPath: target,
    expectedIdentity: targetIdentity,
    content: typedBytes("X"),
  };
}

test("all five primitives reject final symlinks and directories", async t => {
  const root = await scene(t);
  const directory = join(root, "directory-target");
  const real = await regularFile(root, "real.bin", "real");
  const link = join(root, "link.bin");
  await mkdir(directory);
  await symlink("real.bin", link);

  const operations = ["file.replace", "file.write", "file.append", "file.truncate", "file.copy"];
  const rootIdentity = await identity(root);
  for (const [label, target] of [["symlink", link], ["directory", directory]]) {
    const targetIdentity = await identity(target);
    for (const operation of operations) {
      const result = await run(requestFor(operation, target, targetIdentity, root, rootIdentity));
      assert.equal(result.executorInvoked, true, `${operation} ${label}`);
      assert.equal(result.receipt.status, "failed", `${operation} ${label}`);
      assert.equal(result.receipt.errorCode, "READ_TYPE_DENIED", `${operation} ${label}`);
      assert.equal(result.receipt.bytesWritten, 0, `${operation} ${label}`);
      assert.equal(result.receipt.effectsObserved.mutationCommitted, false, `${operation} ${label}`);
    }
  }
  assert.equal(await readFile(real.path, "utf8"), "real");
});

test("a replaced inode is rejected as a stale reference", async t => {
  const root = await scene(t);
  const target = await regularFile(root, "stale.bin", "before");
  const moved = join(root, "stale-original.bin");
  await rename(target.path, moved);
  await writeFile(target.path, "replacement");

  const result = await run({
    operation: "file.replace",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    content: typedBytes("after"),
  });

  assert.equal(result.executorInvoked, true);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.errorCode, "STALE_REFERENCE");
  assert.equal(result.receipt.bytesWritten, 0);
  assert.equal(result.receipt.effectsObserved.mutationCommitted, false);
  assert.equal(await readFile(target.path, "utf8"), "replacement");
});

test("request validation rejects malformed bytes and pre-execution paths", async t => {
  const root = await scene(t);
  const outsideRoot = await mkdtemp(join(tmpdir(), "nn-p5-a1-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const target = await regularFile(root, "validate.bin", "valid");
  const outside = await regularFile(outsideRoot, "outside.bin", "outside");

  assert.throws(
    () => validateTypedBytes({ kind: "cli.bytes", base64: "a===", byteLength: 0 }),
    /base64|canonical/i,
  );
  assert.throws(
    () => validateTypedBytes({ kind: "cli.bytes", base64: "/w==", byteLength: 2 }),
    /byteLength|length/i,
  );

  const invalidOffset = await run({
    operation: "file.write",
    workspaceRoot: root,
    targetPath: target.path,
    expectedIdentity: target.identity,
    offset: -1,
    content: typedBytes("X"),
  });
  assert.equal(invalidOffset.executorInvoked, false);
  assert.equal(invalidOffset.receipt.status, "rejected");
  assert.equal(invalidOffset.receipt.errorCode, "INVALID_ARGUMENT");
  assert.equal(invalidOffset.receipt.effectsObserved.attempted, false);

  const escaped = await run({
    operation: "file.replace",
    workspaceRoot: root,
    targetPath: outside.path,
    expectedIdentity: outside.identity,
    content: typedBytes("X"),
  });
  assert.equal(escaped.executorInvoked, false);
  assert.equal(escaped.receipt.status, "rejected");
  assert.equal(escaped.receipt.errorCode, "INVALID_ARGUMENT");
  assert.equal(await readFile(outside.path, "utf8"), "outside");

  const invalidName = await run({
    operation: "file.copy",
    workspaceRoot: root,
    sourcePath: target.path,
    expectedSourceIdentity: target.identity,
    destinationParentPath: root,
    expectedParentIdentity: await identity(root),
    destinationName: "../escape.bin",
  });
  assert.equal(invalidName.executorInvoked, false);
  assert.equal(invalidName.receipt.status, "rejected");
  assert.equal(invalidName.receipt.errorCode, "INVALID_ARGUMENT");
});
