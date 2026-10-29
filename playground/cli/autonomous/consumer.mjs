// Public consumer for the C-A1 bounded autonomous CLI goal entry.
// Runs the real trained command profile through the public entry and prints a
// machine-readable receipt. No selector/evaluator IDs are passed by the caller.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const profilePath = process.env.NN_CLI_COMMAND_PROFILE;
if (profilePath === undefined || profilePath.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required; no candidate default is allowed");
}
const module = await import("nnanything/cli-goal");
const rawProfile = JSON.parse(await readFile(profilePath, "utf8"));
const profile = module.migrateCliCommandProfileToCurrent(rawProfile);

const root = await realpath(await mkdtemp(join(tmpdir(), "nn-cli-autonomous-consumer-")));
const sessionEffects = Object.freeze(["filesystem.read", "process.exec", "session.write"]);

// Deterministic identity-change seam: the injected read open wrapper replaces
// a.txt with a different inode after inspect and immediately before open.
const objectRace = { pending: false };
async function replaceWithDifferentInode(path, contents) {
  const original = await lstat(path, { bigint: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await rm(path, { force: true });
    await writeFile(path, contents);
    const current = await lstat(path, { bigint: true });
    if (current.dev !== original.dev || current.ino !== original.ino) return current;
  }
  throw new Error("unable to obtain a different file inode");
}
const fileReadIo = {
  lstat: async (path, options) => lstat(path, options),
  open: async (path, flags) => {
    if (objectRace.pending && basename(path) === "a.txt") {
      objectRace.pending = false;
      await replaceWithDifferentInode(path, "replaced");
    }
    return open(path, flags);
  },
};

const sandbox = await module.createCliFilesystemSandbox({
  root,
  ownerGrantedEffects: ["filesystem.write"],
  fileReadIo,
  recipe: {
    scenarioId: "cli-autonomous-consumer",
    entries: [
      { path: "work", kind: "directory" },
      { path: "work/a.txt", kind: "file", contents: "alpha" },
      { path: "work/b.txt", kind: "file", contents: "beta" },
      { path: "work/deep", kind: "directory" },
      { path: "work/deep/c.txt", kind: "file", contents: "gamma" },
    ],
    sessions: [{
      id: "s",
      cwd: "work",
      grantedEffects: sessionEffects,
    }],
  },
});
const session = sandbox.bindSession("s");

function cwdGoal(requirement) {
  return {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: { kind: "cli.file-query", relation: "sessionCwd", session },
    requirement,
  };
}

function pathGoal(base) {
  return {
    kind: "file.property",
    property: "file.property.path.absolute",
    target: { kind: "cli.path-query", base, input: "a.txt" },
    requirement: { kind: "observed", freshness: "this_run" },
  };
}

function entriesGoal(directory) {
  return {
    kind: "file.property",
    property: "file.property.directory.entries",
    target: directory,
    requirement: { kind: "observed", freshness: "this_run" },
  };
}

function unsupportedGoal() {
  return {
    kind: "file.property",
    property: "file.property.links",
    target: { kind: "cli.file-query", relation: "sessionCwd", session },
    requirement: { kind: "observed", freshness: "this_run" },
  };
}

function contentBytesGoal(expectedBase64, range = { offset: 0, length: 5 }) {
  return {
    kind: "file.property",
    property: "file.property.content.bytes",
    target: {
      kind: "cli.file-query",
      relation: "entrySelector",
      selector: { type: "regular" },
      cardinality: "one",
    },
    requirement: { kind: "equals", range, expectedBase64 },
  };
}

const cases = [];
async function run(name, goal, resources = {}) {
  const before = sandbox.getSession(session);
  const result = await module.runCliAutonomousGoal({
    goal,
    resources: { sandbox, session, profile, grantedEffects: sessionEffects, ...resources },
  });
  const after = sandbox.getSession(session);
  cases.push({
    name,
    status: result.domain.status,
    reason: result.domain.reason,
    executorInvocationCount: result.domain.executorInvocationCount,
    policyStepCount: result.domain.policyStepCount,
    heads: result.domain.steps.map(step => step.selectedHead),
    sessionChanged: before.cwd !== after.cwd || before.revision !== after.revision,
    stepStatuses: result.domain.steps.map(step => step.status),
    readReceipt: result.domain.readReceipt,
    bytesReturned: result.domain.readReceipt !== null,
  });
  return result;
}

try {
  const { relative, join } = await import("node:path");
  const target = join(sandbox.scenarioRoot, "work/deep");
  const bind = async () => {
    const rel = relative(sandbox.getSession(session).cwd, target);
    return sandbox.bindDirectory(session, rel === "" ? "." : rel);
  };

  await run("sessionCwd-observed", cwdGoal({ kind: "observed", freshness: "this_run" }));
  await run("sessionCwd-equals-other", cwdGoal({ kind: "equals", expected: await bind() }));
  await run("sessionCwd-equals-current", cwdGoal({ kind: "equals", expected: await bind() }));
  await run("directory-entries-observed", entriesGoal(await bind()));
  await run("unsupported-property", unsupportedGoal());
  await run("restricted-effects", cwdGoal({ kind: "equals", expected: await bind() }), {
    grantedEffects: ["filesystem.read"],
  });
  // A purely lexical path goal touches no OS resource, so it needs no effect grant.
  const lexicalBase = sandbox.bindPath(session, join(sandbox.scenarioRoot, "work/deep"));
  await run("atomic-path-lexical", pathGoal(lexicalBase), { grantedEffects: [] });
  const contentScope = await sandbox.bindDirectory(session, "..");
  await run("content-bytes-satisfied", contentBytesGoal("YWxwaGE="), {
    scope: contentScope,
    fileName: "a.txt",
  });
  await run("content-bytes-mismatch", contentBytesGoal("V1JPTkc="), {
    scope: contentScope,
    fileName: "b.txt",
  });
  await run("content-bytes-ambiguous", contentBytesGoal("YWxwaGE="), {
    scope: contentScope,
  });
  objectRace.pending = true;
  await run("content-bytes-object-changed", contentBytesGoal("YWxwaGE="), {
    scope: contentScope,
    fileName: "a.txt",
  });
  await run("content-bytes-no-skills", contentBytesGoal("YWxwaGE="), {
    scope: contentScope,
    fileName: "a.txt",
    enabledSkills: [],
  });

  process.stdout.write(`${JSON.stringify({ consumer: "cli-autonomous", profile: profilePath, cases }, null, 2)}\n`);
} finally {
  await sandbox.cleanup();
  await rm(root, { recursive: true, force: true });
}
