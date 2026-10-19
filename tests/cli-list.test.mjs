import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const api = () => import("../dist/cli-goal.js");

async function root(t) {
  const value = await mkdtemp(join(tmpdir(), "nnanything-list-api-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

test("collector preserves exact names and returns partial on a controlled lstat failure", async () => {
  const { collectDirectoryListing } = await api();
  const listing = await collectDirectoryListing("/virtual-directory", {
    readdir: async () => [".hidden", "space name", "line\nbreak", "中文", "blocked"],
    lstat: async path => {
      if (basename(path) === "blocked") {
        throw Object.assign(new Error("controlled lstat failure"), { code: "EACCES" });
      }
      return {
        isFile: () => basename(path) === "space name" || basename(path) === "中文",
        isDirectory: () => basename(path) === ".hidden",
        isSymbolicLink: () => basename(path) === "line\nbreak",
      };
    },
  });
  assert.equal(listing.coverage, "partial");
  assert.deepEqual(new Set(listing.entries.map(entry => entry.name)), new Set([".hidden", "space name", "line\nbreak", "中文", "blocked"]));
  assert.equal(listing.entries.find(entry => entry.name === ".hidden").type, "directory");
  assert.equal(listing.entries.find(entry => entry.name === "line\nbreak").type, "symlink");
  assert.equal(listing.entries.find(entry => entry.name === "blocked").type, "unknown");
  assert.deepEqual(listing.errors.map(error => [error.name, error.code]), [["blocked", "EACCES"]]);
});

test("directory.list preserves direct special names, types and session state", async t => {
  const { createCliFilesystemSandbox } = await api();
  const ownerRoot = await root(t);
  const sandbox = await createCliFilesystemSandbox({
    root: ownerRoot,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "named-listing",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/space name", kind: "file", contents: "space\n" },
        { path: "start/line\nbreak", kind: "file", contents: "line\n" },
        { path: "start/quote'\"name", kind: "file", contents: "quote\n" },
        { path: "start/中文", kind: "directory" },
        { path: "start/.hidden", kind: "file", contents: "hidden\n" },
        { path: "start/child/descendant.txt", kind: "file", contents: "nested\n" },
      ],
      sessions: [
        { id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] },
      ],
    },
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  const directory = await sandbox.bindDirectory(session, ".");
  const before = sandbox.getSession(session);
  const receipt = await sandbox.execute({ operation: "directory.list", parameters: { session, directory } });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.execution.observation.kind, "directory.list");
  assert.equal(receipt.execution.observation.coverage, "complete");
  assert.deepEqual(
    new Set(receipt.execution.observation.entries.map(entry => entry.name)),
    new Set(["space name", "line\nbreak", "quote'\"name", "中文", ".hidden", "child"]),
  );
  assert.equal(receipt.execution.observation.entries.find(entry => entry.name === "中文").type, "directory");
  assert.equal(receipt.execution.observation.entries.find(entry => entry.name === ".hidden").type, "file");
  assert.equal(receipt.execution.observation.entries.some(entry => entry.name === "descendant.txt"), false);
  assert.deepEqual(sandbox.getSession(session), before);
  assert.deepEqual(receipt.session_after, before);
});

test("directory.list rejects final links and wrong session bindings before the helper", async t => {
  const { createCliFilesystemSandbox } = await api();
  const ownerRoot = await root(t);
  const sandbox = await createCliFilesystemSandbox({
    root: ownerRoot,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "link-and-binding",
      entries: [
        { path: "start", kind: "directory" },
        { path: "target", kind: "directory" },
        { path: "start/target", kind: "directory" },
      ],
      sessions: [
        { id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] },
        { id: "other", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] },
      ],
    },
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  const other = sandbox.bindSession("other");
  const otherDirectory = await sandbox.bindDirectory(other, "target");
  const mismatch = await sandbox.execute({ operation: "directory.list", parameters: { session, directory: otherDirectory } });
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.execution.executorInvoked, false);
  assert.equal(mismatch.execution.error.code, "EINVAL");

  await symlink(join(sandbox.scenarioRoot, "target"), join(sandbox.scenarioRoot, "start", "link"));
  const linked = await sandbox.bindDirectory(session, "link");
  const finalLink = await sandbox.execute({ operation: "directory.list", parameters: { session, directory: linked } });
  assert.equal(finalLink.status, "failed");
  assert.equal(finalLink.execution.executorInvoked, false);
  assert.equal(finalLink.execution.error.code, "FINAL_SYMLINK");
});

test("directory.list requires both declared effects", async t => {
  const { createCliFilesystemSandbox } = await api();
  const ownerRoot = await root(t);
  const sandbox = await createCliFilesystemSandbox({
    root: ownerRoot,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "missing-effect",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/file.txt", kind: "file", contents: "file\n" },
      ],
      sessions: [
        { id: "s", cwd: "start", grantedEffects: ["filesystem.read"] },
      ],
    },
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  const directory = await sandbox.bindDirectory(session, ".");
  const receipt = await sandbox.execute({ operation: "directory.list", parameters: { session, directory } });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.execution.executorInvoked, false);
  assert.equal(receipt.execution.error.code, "EFFECT_DENIED");
});
