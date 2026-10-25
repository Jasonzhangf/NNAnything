import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createCliFilesystemSandbox, runCliEntrySearchGoal } = await import("nnanything/cli-search");

const profileFile = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof profileFile !== "string" || profileFile.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required");
}
// A 10x30 profile predates the search.nameNeedleSegment wire; the runtime entry rejects that
// shape by contract, so this caller migrates it by name first. A 10x31 profile passes through.
const rawProfile = JSON.parse(await readFile(profileFile, "utf8"));
const profile = rawProfile.wires?.length === 30
  ? await (await import("nnanything/cli-goal")).migrateCliCommandProfileV10x30(rawProfile)
  : rawProfile;
const limits = Object.freeze({ maxTransitions: 20, maxDepth: 4, maxDerivedGoals: 8 });

function request(directory, requestId) {
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target: directory,
      requirement: {
        kind: "matches",
        predicate: {
          kind: "entrySelector",
          name: "target.txt",
          type: "regular",
          cardinality: "one",
        },
      },
    },
    satisfactionThreshold: 100,
  };
}

function inspect(sandbox, ref) {
  return sandbox.execute({
    operation: "entry.inspect",
    parameters: { ref, followSymlinks: false },
  });
}

async function replaceWithDifferentInode(path, previousIno) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await rm(path, { force: true });
    await writeFile(path, `replacement-${attempt}`);
    const stat = await lstat(path);
    if (String(stat.ino) !== String(previousIno)) return stat;
  }
  throw new Error("unable to replace the file with a different inode");
}

const root = await realpath(await mkdtemp(join(tmpdir(), "nn-entry-search-authority-")));
const sandbox = await createCliFilesystemSandbox({
  root,
  ownerGrantedEffects: ["filesystem.write"],
  recipe: {
    scenarioId: "authority-consumer",
    entries: [
      { path: "start", kind: "directory" },
      { path: "start/target.txt", kind: "file", contents: "original" },
      { path: "start/other", kind: "directory" },
    ],
    sessions: [
      {
        id: "s",
        cwd: "start",
        grantedEffects: ["filesystem.read", "process.exec", "session.write"],
      },
    ],
  },
});
const session = sandbox.bindSession("s");
const directory = await sandbox.bindDirectoryObject(session, ".");
const start = sandbox.getSession(session).cwd;
const target = join(start, "target.txt");

try {
  const hit = await runCliEntrySearchGoal(
    request(directory, "authority-hit"),
    { sandbox, session, profile, limits },
  );
  assert.equal(hit.domain.status, "achieved");
  assert.equal(hit.domain.resolution, "matched");
  assert.equal(hit.domain.match.kind, "cli.file");
  assert.deepEqual(hit.domain.rootFact.ref, hit.domain.match);

  const accepted = await inspect(sandbox, hit.domain.match);
  assert.equal(accepted.status, "succeeded");
  assert.equal(accepted.execution.executorInvoked, true);
  assert.equal(String(accepted.execution.observation.snapshot.ino), String(hit.domain.match.identity.ino));

  const replacement = await replaceWithDifferentInode(target, hit.domain.match.identity.ino);
  const replaced = await inspect(sandbox, hit.domain.match);
  assert.equal(replaced.status, "failed");
  assert.equal(replaced.execution.executorInvoked, false);
  assert.equal(replaced.execution.error.code, "STALE_REFERENCE");

  const freshHit = await runCliEntrySearchGoal(
    request(directory, "authority-fresh-hit"),
    { sandbox, session, profile, limits },
  );
  assert.equal(freshHit.domain.status, "achieved");
  assert.equal(String(freshHit.domain.match.identity.ino), String(replacement.ino));

  const beforeRevision = await inspect(sandbox, freshHit.domain.match);
  assert.equal(beforeRevision.status, "succeeded");

  const other = await sandbox.bindDirectory(session, "other");
  const moved = await sandbox.execute({
    operation: "cwd.set",
    parameters: { session, directory: other },
  });
  assert.equal(moved.status, "succeeded");

  const afterRevision = await inspect(sandbox, freshHit.domain.match);
  assert.equal(afterRevision.status, "failed");
  assert.equal(afterRevision.execution.executorInvoked, false);
  assert.equal(afterRevision.execution.error.code, "STALE_REFERENCE");

  process.stdout.write(JSON.stringify({
    consumer: "authority",
    accepted: {
      status: accepted.status,
      executorInvoked: accepted.execution.executorInvoked,
    },
    replacement: {
      previousIno: String(hit.domain.match.identity.ino),
      currentIno: String(replacement.ino),
      status: replaced.status,
      error: replaced.execution.error.code,
      executorInvoked: replaced.execution.executorInvoked,
    },
    revision: {
      status: afterRevision.status,
      error: afterRevision.execution.error.code,
      executorInvoked: afterRevision.execution.executorInvoked,
    },
  }) + "\n");
} finally {
  await sandbox.cleanup();
  await rm(root, { recursive: true, force: true });
}
