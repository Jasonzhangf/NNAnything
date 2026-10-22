import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createCliFilesystemSandbox, runCliEntrySearchGoal } = await import("nnanything/cli-search");

const profileFile = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof profileFile !== "string" || profileFile.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required");
}
const profile = JSON.parse(await readFile(profileFile, "utf8"));
const limits = Object.freeze({ maxTransitions: 20, maxDepth: 4, maxDerivedGoals: 8 });

function request(directory, requestId, name, type) {
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.directory.entries",
      target: directory,
      requirement: {
        kind: "matches",
        predicate: { kind: "entrySelector", name, type, cardinality: "one" },
      },
    },
    satisfactionThreshold: 100,
  };
}

const root = await realpath(await mkdtemp(join(tmpdir(), "nn-entry-search-consumer-")));
const sandbox = await createCliFilesystemSandbox({
  root,
  ownerGrantedEffects: ["filesystem.write"],
  recipe: {
    scenarioId: "public-consumer",
    entries: [
      { path: "start", kind: "directory" },
      { path: "start/target.txt", kind: "file", contents: "target contents" },
      { path: "start/other.txt", kind: "file", contents: "other contents" },
    ],
    sessions: [{ id: "s", cwd: "start", grantedEffects: ["filesystem.read", "process.exec"] }],
  },
});
const session = sandbox.bindSession("s");
const directory = await sandbox.bindDirectory(session, ".");
const start = sandbox.getSession(session).cwd;
const beforeEntries = (await readdir(start)).sort();
const parentCwd = process.cwd();
const outsideProbe = join(root, "outside-write-probe");

try {
  const hit = await runCliEntrySearchGoal(
    request(directory, "consumer-hit", "target.txt", "regular"),
    { sandbox, session, profile, limits },
  );
  const miss = await runCliEntrySearchGoal(
    request(directory, "consumer-miss", "absent.txt", "regular"),
    { sandbox, session, profile, limits },
  );

  assert.equal(hit.domain.status, "achieved");
  assert.equal(hit.domain.satisfaction, 100);
  assert.equal(hit.domain.match.name, "target.txt");
  assert.equal(hit.domain.match.absolutePath, join(start, "target.txt"));
  const stat = await lstat(join(start, "target.txt"));
  assert.equal(String(hit.domain.match.identity.ino), String(stat.ino));

  assert.equal(miss.domain.status, "unmet");
  assert.equal(miss.domain.resolution, "not_found");
  assert.equal(miss.domain.satisfaction, 0);
  assert.equal(miss.domain.match, null);

  assert.equal(process.cwd(), parentCwd);
  assert.equal(sandbox.getSession(session).cwd, start);
  assert.deepEqual((await readdir(start)).sort(), beforeEntries);
  await writeFile(outsideProbe, "owned");
  assert.equal(await readFile(join(start, "target.txt"), "utf8"), "target contents");

  process.stdout.write(JSON.stringify({
    consumer: "public",
    hit: { status: hit.domain.status, resolution: hit.domain.resolution, satisfaction: hit.domain.satisfaction },
    miss: { status: miss.domain.status, resolution: miss.domain.resolution, satisfaction: miss.domain.satisfaction },
    noWriteOutsideSandbox: true,
    cwdUnchanged: true,
    entriesUnchanged: true,
    inoVerified: true,
  }) + "\n");
} finally {
  await rm(outsideProbe, { force: true });
  await sandbox.cleanup();
  await rm(root, { recursive: true, force: true });
}
