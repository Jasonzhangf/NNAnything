import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const { createCliFilesystemSandbox, runCliReadCompositionGoal } = await import("nnanything/cli-read");

const LOG_PATH =
  "/Volumes/Intel/playground/nnanything-runs/cli-read-composition-20261022/evidence/p3-independent-family.log";
const PROFILE_FILE = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof PROFILE_FILE !== "string" || PROFILE_FILE.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required");
}

const profile = JSON.parse(await readFile(PROFILE_FILE, "utf8"));
const limits = Object.freeze({ maxTransitions: 23, maxDepth: 4, maxDerivedGoals: 8 });
const allEffects = Object.freeze(["filesystem.read", "process.exec", "session.write"]);
const defaultOwnerEffects = Object.freeze(["filesystem.read", "filesystem.write"]);
const outputLines = [];
const caseResults = [];

const matched = Object.freeze({ status: "achieved", resolution: "matched", satisfaction: 100 });
const byteMismatch = Object.freeze({ status: "unmet", resolution: "byte_mismatch", satisfaction: 0 });
const typeMismatch = Object.freeze({ status: "unmet", resolution: "type_mismatch", satisfaction: 0 });
const notFound = Object.freeze({ status: "unmet", resolution: "not_found", satisfaction: 0 });
const insufficient = Object.freeze({
  status: "unknown",
  resolution: "insufficient_evidence",
  satisfaction: null,
});
const staleOrUnverified = Object.freeze({
  status: "unknown",
  resolution: "stale_or_unverified",
  satisfaction: null,
});
const rejected = Object.freeze({ status: "rejected", resolution: "rejected", satisfaction: null });
const failed = Object.freeze({ status: "failed", resolution: "failed", satisfaction: null });

function b64(value) {
  return Buffer.from(value).toString("base64");
}

function record(line) {
  const text = JSON.stringify(line);
  outputLines.push(text);
  console.log(text);
}

function sameActions(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameText(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function direntType(entry) {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

async function snapshotEntries(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .map((entry) => ({ name: entry.name, type: direntType(entry) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

async function inodeOf(path) {
  const value = await lstat(path, { bigint: true });
  return { dev: String(value.dev), ino: String(value.ino) };
}

function makeRequest({
  id,
  directory,
  name,
  offset,
  length,
  expectedBase64,
}) {
  return {
    requestId: id,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: { kind: "cli.exact-child", directory, name, requiredType: "regular" },
      requirement: { kind: "equals", range: { offset, length }, expectedBase64 },
    },
    satisfactionThreshold: 100,
  };
}

function runComposition(ctx, parameters) {
  return runCliReadCompositionGoal(makeRequest(parameters), {
    sandbox: ctx.sandbox,
    session: ctx.session,
    profile,
    limits,
  });
}

function readFailure(result) {
  for (const item of result.domain.preserve.atomicResults || []) {
    if (item.sourceResult?.tag !== "cli.file.read.receipt.v1") continue;
    const execution = item.sourceResult.value?.receipt?.execution;
    if (execution?.status === "failed") return execution.error;
  }
  return null;
}

async function createFixture({
  scenarioId,
  entries,
  cwd = ".",
  grantedEffects = allEffects,
  ownerGrantedEffects = defaultOwnerEffects,
  listingObserver,
  readIo,
}) {
  const root = await mkdtemp(join(tmpdir(), "nn-independent-family-"));
  const options = {
    root,
    recipe: {
      scenarioId,
      entries,
      sessions: [{ id: "main", cwd, grantedEffects }],
    },
    ownerGrantedEffects,
  };
  if (listingObserver) options.listingObserver = listingObserver;

  let opens = 0;
  options.fileReadIo = readIo
    ? {
        lstat: (path, lstatOptions) => readIo.lstat(path, lstatOptions),
        open: (path, flags) => {
          opens += 1;
          return readIo.open(path, flags);
        },
      }
    : {
        lstat: (path, lstatOptions) => lstat(path, lstatOptions),
        open: (path, flags) => {
          opens += 1;
          return open(path, flags);
        },
      };

  let sandbox;
  try {
    sandbox = await createCliFilesystemSandbox(options);
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const session = sandbox.bindSession("main");
  return {
    root,
    scenarioRoot: join(root, scenarioId),
    sandbox,
    session,
    boundDir: join(root, scenarioId),
    getOpens: () => opens,
    cleanup: async () => {
      await sandbox.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runCase({ family, name, expected, create, execute, verify }) {
  let ctx;
  const failures = [];
  const facts = {};
  let actual = null;
  let executedActions = [];
  let opens = 0;
  let cwdUnchanged = false;
  let entriesUnchanged = false;

  try {
    ctx = await create();
    const beforeSession = ctx.sandbox.getSession(ctx.session);
    const beforeEntries = await snapshotEntries(ctx.boundDir);
    let result = null;
    let thrown = null;
    try {
      result = await execute(ctx);
    } catch (error) {
      thrown = error;
    }
    const afterSession = ctx.sandbox.getSession(ctx.session);
    const afterEntries = await snapshotEntries(ctx.boundDir);
    opens = ctx.getOpens();
    cwdUnchanged = beforeSession.cwd === afterSession.cwd;
    entriesUnchanged = sameText(beforeEntries, afterEntries);

    if (thrown) {
      actual = { status: "rejected", resolution: "rejected", satisfaction: null };
      facts.thrown = thrown.constructor?.name ?? "Error";
      facts.thrownMessage = thrown.message;
    } else {
      actual = {
        status: result.domain.status,
        resolution: result.domain.resolution,
        satisfaction: result.domain.satisfaction,
      };
      executedActions = (result.domain.preserve.effects || []).map((effect) =>
        effect.skillId.replace("read-composition.", ""),
      );
      facts.rootFact = result.domain.rootFact?.kind ?? null;
      facts.matchPresent = result.domain.match !== null;
      facts.coverage = result.domain.coverage ?? null;
      const failure = readFailure(result);
      if (failure) facts.readError = { code: failure.code, message: failure.message };
    }

    const check = (condition, message) => {
      if (!condition) failures.push(message);
    };
    check(actual.status === expected.status, `status ${actual.status} !== ${expected.status}`);
    check(
      actual.resolution === expected.resolution,
      `resolution ${actual.resolution} !== ${expected.resolution}`,
    );
    check(
      actual.satisfaction === expected.satisfaction,
      `satisfaction ${String(actual.satisfaction)} !== ${String(expected.satisfaction)}`,
    );
    check(cwdUnchanged, "cwd changed during the run");
    check(entriesUnchanged, "directory entries changed during the run");
    verify?.({ ctx, result, thrown, actual, executedActions, opens, facts, check });
  } catch (error) {
    failures.push(`runner error: ${error.constructor?.name ?? "Error"}: ${error.message}`);
    facts.runnerError = {
      name: error.constructor?.name ?? "Error",
      message: error.message,
    };
  } finally {
    if (ctx) {
      try {
        await ctx.cleanup();
      } catch (error) {
        failures.push(`cleanup error: ${error.message}`);
      }
    }
  }

  if (failures.length > 0) facts.failures = failures;
  const line = {
    family,
    case: name,
    expected,
    actual,
    executedActions,
    opens,
    cwdUnchanged,
    entriesUnchanged,
    ok: failures.length === 0,
  };
  if (Object.keys(facts).length > 0) line.facts = facts;
  record(line);
  caseResults.push(line);
  return line.ok;
}

function flatFixture(id, name, contents, extraEntries = []) {
  return createFixture({
    scenarioId: id,
    entries: [
      { path: "d", kind: "directory" },
      { path: `d/${name}`, kind: "file", contents },
      ...extraEntries,
    ],
    cwd: "d",
  }).then((ctx) => {
    ctx.boundDir = join(ctx.scenarioRoot, "d");
    return ctx;
  });
}

async function flatReadCase({ family, name, fixtureId, fileName, contents, offset, length, expectedBase64, expected }) {
  return runCase({
    family,
    name,
    expected,
    create: () => flatFixture(fixtureId, fileName, contents),
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: name,
        directory,
        name: fileName,
        offset,
        length,
        expectedBase64,
      });
    },
    verify: ({ check, opens, executedActions, result }) => {
      check(opens === 1, `expected one read open, saw ${opens}`);
      check(sameActions(executedActions, ["list", "inspect", "read"]), "unexpected action sequence");
      if (expected.status === "achieved") {
        check(result.domain.match !== null, "matched case has no reusable match reference");
      } else {
        check(result.domain.match === null, "non-achieved case produced a reusable match");
      }
    },
  });
}

const cases = [];

cases.push(
  await runCase({
    family: "F1a",
    name: "flat-directory-binding",
    expected: matched,
    create: () => flatFixture("f1a", "note.txt", "flat-ok"),
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f1a",
        directory,
        name: "note.txt",
        offset: 0,
        length: 7,
        expectedBase64: b64("flat-ok"),
      });
    },
    verify: ({ check, opens, executedActions, result }) => {
      check(opens === 1, "flat binding did not open once");
      check(sameActions(executedActions, ["list", "inspect", "read"]), "unexpected flat action sequence");
      check(result.domain.match?.absolutePath?.endsWith("/f1a/d/note.txt"), "match path is not the flat fixture");
    },
  }),
);

cases.push(
  await runCase({
    family: "F1b",
    name: "nested-explicit-directory-binding",
    expected: matched,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f1b",
        entries: [
          { path: "deep", kind: "directory" },
          { path: "deep/nested", kind: "directory" },
          { path: "deep/nested/answer.txt", kind: "file", contents: "nested-ok" },
        ],
        cwd: ".",
      });
      ctx.boundDir = join(ctx.scenarioRoot, "deep/nested");
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, "deep/nested");
      return runComposition(ctx, {
        id: "f1b",
        directory,
        name: "answer.txt",
        offset: 0,
        length: 9,
        expectedBase64: b64("nested-ok"),
      });
    },
    verify: ({ check, opens, executedActions, result }) => {
      check(opens === 1, "nested binding did not open once");
      check(sameActions(executedActions, ["list", "inspect", "read"]), "unexpected nested action sequence");
      check(
        result.domain.match?.absolutePath?.endsWith("/deep/nested/answer.txt"),
        "match path is not the nested fixture",
      );
    },
  }),
);

function duplicateListingObserver(input) {
  const primary = join(input.physicalDirectory, "dup.txt");
  return Promise.resolve({
    ok: true,
    observation: {
      kind: "directory.list",
      configuredDirectory: input.configuredDirectory,
      physicalDirectory: input.physicalDirectory,
      executable: process.execPath,
      helperPath: "independent-duplicate-helper",
      argv: [process.execPath, "independent-duplicate-helper"],
      stdout: "",
      stderr: "",
      exitCode: 0,
      entries: [
        { name: "dup.txt", path: primary, type: "file" },
        { name: "dup.txt", path: `${primary}.alias`, type: "file" },
      ],
      coverage: "complete",
      errors: [],
    },
  });
}

cases.push(
  await runCase({
    family: "F1c",
    name: "duplicate-name-cardinality",
    expected: insufficient,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f1c",
        entries: [
          { path: "d", kind: "directory" },
          { path: "d/dup.txt", kind: "file", contents: "dup" },
        ],
        cwd: "d",
        listingObserver: duplicateListingObserver,
      });
      ctx.boundDir = join(ctx.scenarioRoot, "d");
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f1c",
        directory,
        name: "dup.txt",
        offset: 0,
        length: 3,
        expectedBase64: b64("dup"),
      });
    },
    verify: ({ check, opens, executedActions, result, actual, facts }) => {
      facts.observer = "complete listing with duplicate dup.txt entries";
      check(opens === 0, "duplicate cardinality performed a read");
      check(sameActions(executedActions, ["list"]), "duplicate cardinality continued past listing");
      check(actual.resolution !== "not_found", "duplicate cardinality became not_found");
      check(result.domain.rootFact?.kind === "insufficient_evidence", "duplicate root fact is not insufficient");
    },
  }),
);

const specialNames = [
  ["space", "space name.txt"],
  ["newline", "line\nbreak.txt"],
  ["unicode", "caf\u00e9-\u96ea.txt"],
  ["leading-dash", "-leading-dash.txt"],
  ["backslash", "back\\slash.txt"],
];

for (const [label, fileName] of specialNames) {
  const contents = `special-${label}`;
  cases.push(
    await runCase({
      family: "F1d",
      name: `special-name-${label}`,
      expected: matched,
      create: () => flatFixture(`f1d-${label}`, fileName, contents),
      execute: async (ctx) => {
        const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
        return runComposition(ctx, {
          id: `f1d-${label}`,
          directory,
          name: fileName,
          offset: 0,
          length: Buffer.byteLength(contents),
          expectedBase64: b64(contents),
        });
      },
      verify: ({ check, opens, result }) => {
        check(opens === 1, "special name did not open once");
        check(result.domain.match?.absolutePath?.endsWith(`/${fileName}`), "special name was not preserved");
      },
    }),
  );
}

const raceState = { swapped: false, scenarioRoot: "", target: "" };
const raceOriginal = "ORIGINAL";
const raceReplacement = "REPLACED";
const raceReplacementBase64 = b64(raceReplacement);
const raceIo = {
  lstat: async (path, options) => {
    if (!raceState.swapped && path === raceState.target) {
      raceState.swapped = true;
      await rename(join(raceState.scenarioRoot, "d/f.txt"), join(raceState.scenarioRoot, "stash/original.txt"));
      await rename(join(raceState.scenarioRoot, "stash/swap.bin"), join(raceState.scenarioRoot, "d/f.txt"));
    }
    return lstat(path, options);
  },
  open: (path, flags) => open(path, flags),
};

cases.push(
  await runCase({
    family: "F2a",
    name: "same-path-inode-swap-before-read",
    expected: staleOrUnverified,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f2a",
        entries: [
          { path: "d", kind: "directory" },
          { path: "d/f.txt", kind: "file", contents: raceOriginal },
          { path: "stash", kind: "directory" },
          { path: "stash/swap.bin", kind: "file", contents: raceReplacement },
        ],
        cwd: "d",
        readIo: raceIo,
      });
      ctx.boundDir = join(ctx.scenarioRoot, "d");
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      const resolved = await ctx.sandbox.resolveDirectory(directory);
      raceState.scenarioRoot = ctx.scenarioRoot;
      raceState.target = join(resolved.physicalPath, "f.txt");
      ctx.inodeBefore = await inodeOf(join(ctx.scenarioRoot, "d/f.txt"));
      const result = await runComposition(ctx, {
        id: "f2a",
        directory,
        name: "f.txt",
        offset: 0,
        length: raceOriginal.length,
        expectedBase64: b64(raceOriginal),
      });
      ctx.inodeAfter = await inodeOf(join(ctx.scenarioRoot, "d/f.txt"));
      return result;
    },
    verify: ({ ctx, check, opens, executedActions, result, facts }) => {
      facts.fixtureMutation =
        "fileReadIo.lstat moved d/f.txt to stash/original.txt and stash/swap.bin to d/f.txt before open";
      facts.inodeBefore = ctx.inodeBefore;
      facts.inodeAfter = ctx.inodeAfter;
      facts.swapped = raceState.swapped;
      facts.replacementVisible = JSON.stringify(result.domain).includes(raceReplacementBase64);
      facts.errorCode = readFailure(result)?.code ?? null;
      check(raceState.swapped, "public fileReadIo seam did not perform the swap");
      check(opens === 1, `expected one read open, saw ${opens}`);
      check(
        ctx.inodeBefore?.ino !== ctx.inodeAfter?.ino,
        "same-path file inode did not change during the race",
      );
      check(!facts.replacementVisible, "replacement bytes were returned");
      check(result.domain.match === null, "race produced a reusable match");
      check(result.domain.rootFact?.kind !== "matched", "race root became matched");
      check(result.domain.resolution !== "matched", "race resolution became matched");
      check(facts.errorCode === "STALE_REFERENCE", "race did not preserve STALE_REFERENCE");
      check(sameActions(executedActions, ["list", "inspect", "read"]), "unexpected race action sequence");
    },
  }),
);

cases.push(
  await runCase({
    family: "F2b",
    name: "advanced-session-revision-old-directory",
    expected: rejected,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f2b",
        entries: [
          { path: "d", kind: "directory" },
          { path: "d/f.txt", kind: "file", contents: "hello" },
          { path: "other", kind: "directory" },
        ],
        cwd: ".",
      });
      ctx.boundDir = join(ctx.scenarioRoot, "d");
      ctx.oldDirectory = await ctx.sandbox.bindDirectoryObject(ctx.session, "d");
      const other = await ctx.sandbox.bindDirectory(ctx.session, "other");
      const receipt = await ctx.sandbox.execute({
        operation: "cwd.set",
        parameters: { session: ctx.session, directory: other },
      });
      if (receipt.status !== "succeeded") throw new Error("cwd.set setup failed");
      ctx.revisionAfterSetup = ctx.sandbox.getSession(ctx.session).revision;
      return ctx;
    },
    execute: (ctx) =>
      runComposition(ctx, {
        id: "f2b",
        directory: ctx.oldDirectory,
        name: "f.txt",
        offset: 0,
        length: 5,
        expectedBase64: b64("hello"),
      }),
    verify: ({ ctx, check, opens, executedActions, result, facts }) => {
      facts.fixtureMutation = "cwd.set advanced the session revision before the run";
      facts.revisionAfterSetup = ctx.revisionAfterSetup;
      check(ctx.revisionAfterSetup >= 1, "session revision did not advance");
      check(opens === 0, "stale session revision opened a file");
      check(sameActions(executedActions, []), "stale session revision executed an action");
      check(result.domain.rootFact?.kind === "rejected", "old directory binding was not rejected");
    },
  }),
);

cases.push(
  await runCase({
    family: "F2c",
    name: "replaced-bound-directory",
    expected: rejected,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f2c",
        entries: [
          { path: "d", kind: "directory" },
          { path: "d/f.txt", kind: "file", contents: "hello" },
          { path: "d2", kind: "directory" },
        ],
        cwd: ".",
      });
      ctx.oldDirectory = await ctx.sandbox.bindDirectoryObject(ctx.session, "d");
      ctx.inodeBefore = await inodeOf(join(ctx.scenarioRoot, "d"));
      await rename(join(ctx.scenarioRoot, "d"), join(ctx.scenarioRoot, "d.old"));
      await rename(join(ctx.scenarioRoot, "d2"), join(ctx.scenarioRoot, "d"));
      ctx.inodeAfter = await inodeOf(join(ctx.scenarioRoot, "d"));
      ctx.boundDir = join(ctx.scenarioRoot, "d");
      return ctx;
    },
    execute: (ctx) =>
      runComposition(ctx, {
        id: "f2c",
        directory: ctx.oldDirectory,
        name: "f.txt",
        offset: 0,
        length: 5,
        expectedBase64: b64("hello"),
      }),
    verify: ({ ctx, check, opens, executedActions, result, facts }) => {
      facts.fixtureMutation = "renamed d to d.old and d2 to d before the run";
      facts.inodeBefore = ctx.inodeBefore;
      facts.inodeAfter = ctx.inodeAfter;
      check(ctx.inodeBefore?.ino !== ctx.inodeAfter?.ino, "bound directory inode did not change");
      check(opens === 0, "replaced directory opened a file");
      check(sameActions(executedActions, []), "replaced directory executed an action");
      check(result.domain.rootFact?.kind === "rejected", "replaced directory binding was not rejected");
    },
  }),
);

function partialListingObserver(input) {
  return Promise.resolve({
    ok: true,
    observation: {
      kind: "directory.list",
      configuredDirectory: input.configuredDirectory,
      physicalDirectory: input.physicalDirectory,
      executable: process.execPath,
      helperPath: "independent-partial-helper",
      argv: [process.execPath, "independent-partial-helper"],
      stdout: "",
      stderr: "",
      exitCode: 0,
      entries: [
        {
          name: "target.txt",
          path: join(input.physicalDirectory, "target.txt"),
          type: "file",
        },
      ],
      coverage: "partial",
      errors: [{ name: "locked", code: "EACCES", message: "permission denied" }],
    },
  });
}

cases.push(
  await runCase({
    family: "F2d",
    name: "partial-listing-unreadable-child",
    expected: insufficient,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f2d",
        entries: [
          { path: "d", kind: "directory" },
          { path: "d/target.txt", kind: "file", contents: "hello" },
          { path: "d/locked", kind: "directory" },
        ],
        cwd: "d",
        listingObserver: partialListingObserver,
      });
      ctx.boundDir = join(ctx.scenarioRoot, "d");
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f2d",
        directory,
        name: "target.txt",
        offset: 0,
        length: 5,
        expectedBase64: b64("hello"),
      });
    },
    verify: ({ check, opens, executedActions, result, facts }) => {
      facts.observer = "partial listing with a locked child EACCES error";
      check(opens === 0, "partial listing performed a read");
      check(sameActions(executedActions, ["list"]), "partial listing continued past listing");
      check(result.domain.coverage === "partial", "partial coverage was not preserved");
      check(result.domain.rootFact?.kind === "insufficient_evidence", "partial listing was not insufficient");
    },
  }),
);

cases.push(
  await flatReadCase({
    family: "F3a",
    name: "offset-middle-range",
    fixtureId: "f3a",
    fileName: "f.txt",
    contents: "0123456789",
    offset: 3,
    length: 4,
    expectedBase64: b64("3456"),
    expected: matched,
  }),
);

cases.push(
  await runCase({
    family: "F3b",
    name: "out-of-range-short-read",
    expected: insufficient,
    create: () => flatFixture("f3b", "f.txt", "abc"),
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f3b",
        directory,
        name: "f.txt",
        offset: 1,
        length: 10,
        expectedBase64: Buffer.alloc(10, 0x62).toString("base64"),
      });
    },
    verify: ({ check, opens, executedActions, result, actual }) => {
      check(opens === 1, "short read did not open once");
      check(sameActions(executedActions, ["list", "inspect", "read"]), "unexpected short-read actions");
      check(actual.resolution !== "byte_mismatch", "short read became byte_mismatch");
      check(result.domain.rootFact?.kind === "insufficient_evidence", "short read was not insufficient");
    },
  }),
);

cases.push(
  await runCase({
    family: "F3c",
    name: "zero-length-empty-expected",
    expected: matched,
    create: () => flatFixture("f3c-empty", "f.txt", "abc"),
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f3c-empty",
        directory,
        name: "f.txt",
        offset: 0,
        length: 0,
        expectedBase64: "",
      });
    },
    verify: ({ check, opens, result }) => {
      check(opens === 1, "zero-length read did not perform the required open");
      check(result.domain.match !== null, "zero-length match reference is missing");
    },
  }),
);

cases.push(
  await runCase({
    family: "F3c",
    name: "zero-length-nonempty-expected",
    expected: rejected,
    create: () => flatFixture("f3c-nonempty", "f.txt", "abc"),
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f3c-nonempty",
        directory,
        name: "f.txt",
        offset: 0,
        length: 0,
        expectedBase64: b64("a"),
      });
    },
    verify: ({ check, thrown, opens, executedActions }) => {
      check(thrown !== null, "zero-length non-empty expectation did not throw");
      check(
        /expectedBase64 decoded length must equal range.length/.test(thrown?.message ?? ""),
        "unexpected zero-length validation error",
      );
      check(opens === 0, "zero-length rejection opened a file");
      check(sameActions(executedActions, []), "zero-length rejection executed an action");
    },
  }),
);

const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x41]);
cases.push(
  await runCase({
    family: "F3d",
    name: "binary-nul-base64-fidelity",
    expected: matched,
    create: async () => {
      const ctx = await flatFixture("f3d", "f.bin", "placeholder");
      await writeFile(join(ctx.scenarioRoot, "d/f.bin"), binary);
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f3d",
        directory,
        name: "f.bin",
        offset: 0,
        length: binary.length,
        expectedBase64: binary.toString("base64"),
      });
    },
    verify: ({ check, opens, result }) => {
      check(opens === 1, "binary read did not open once");
      check(result.domain.rootFact?.kind === "matched", "binary read did not match");
    },
  }),
);

cases.push(
  await runCase({
    family: "F3e",
    name: "expected-length-differs-from-range",
    expected: rejected,
    create: () => flatFixture("f3e", "f.txt", "abcdef"),
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f3e",
        directory,
        name: "f.txt",
        offset: 0,
        length: 4,
        expectedBase64: b64("abc"),
      });
    },
    verify: ({ check, thrown, opens, executedActions }) => {
      check(thrown !== null, "expected-length mismatch did not throw");
      check(
        /expectedBase64 decoded length must equal range.length/.test(thrown?.message ?? ""),
        "unexpected expected-length validation error",
      );
      check(opens === 0, "expected-length rejection opened a file");
      check(sameActions(executedActions, []), "expected-length rejection executed an action");
    },
  }),
);

cases.push(
  await runCase({
    family: "F3f",
    name: "symlink-same-name",
    expected: typeMismatch,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f3f-symlink",
        entries: [
          { path: "d", kind: "directory" },
          { path: "d/target.txt", kind: "file", contents: "abc" },
        ],
        cwd: "d",
      });
      await symlink("target.txt", join(ctx.scenarioRoot, "d/link.txt"));
      ctx.boundDir = join(ctx.scenarioRoot, "d");
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f3f-symlink",
        directory,
        name: "link.txt",
        offset: 0,
        length: 3,
        expectedBase64: b64("abc"),
      });
    },
    verify: ({ check, opens, executedActions, result, facts }) => {
      facts.inspectedType = result.domain.rootFact?.inspected?.type ?? null;
      check(opens === 0, "symlink same-name case opened a file");
      check(sameActions(executedActions, ["list", "inspect"]), "symlink case read past inspection");
      check(facts.inspectedType === "symlink", "symlink type was not preserved");
    },
  }),
);

cases.push(
  await runCase({
    family: "F3f",
    name: "fifo-same-name",
    expected: typeMismatch,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f3f-fifo",
        entries: [{ path: "d", kind: "directory" }],
        cwd: "d",
      });
      await execFileP("/usr/bin/mkfifo", [join(ctx.scenarioRoot, "d/pipe")]);
      ctx.boundDir = join(ctx.scenarioRoot, "d");
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f3f-fifo",
        directory,
        name: "pipe",
        offset: 0,
        length: 3,
        expectedBase64: b64("abc"),
      });
    },
    verify: ({ check, opens, executedActions, result, facts }) => {
      facts.inspectedType = result.domain.rootFact?.inspected?.type ?? null;
      check(opens === 0, "FIFO same-name case opened a file");
      check(sameActions(executedActions, ["list", "inspect"]), "FIFO case read past inspection");
      check(facts.inspectedType === "fifo", "FIFO type was not preserved");
    },
  }),
);

cases.push(
  await flatReadCase({
    family: "F4a",
    name: "byte-mismatch",
    fixtureId: "f4a",
    fileName: "f.txt",
    contents: "hello",
    offset: 0,
    length: 5,
    expectedBase64: b64("world"),
    expected: byteMismatch,
  }),
);

cases.push(
  await runCase({
    family: "F4b",
    name: "same-name-non-regular",
    expected: typeMismatch,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f4b",
        entries: [
          { path: "d", kind: "directory" },
          { path: "d/entry", kind: "directory" },
        ],
        cwd: "d",
      });
      ctx.boundDir = join(ctx.scenarioRoot, "d");
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f4b",
        directory,
        name: "entry",
        offset: 0,
        length: 3,
        expectedBase64: b64("abc"),
      });
    },
    verify: ({ check, opens, executedActions, result, facts }) => {
      facts.inspectedType = result.domain.rootFact?.inspected?.type ?? null;
      check(opens === 0, "non-regular same-name case opened a file");
      check(sameActions(executedActions, ["list", "inspect"]), "non-regular case read past inspection");
      check(facts.inspectedType === "directory", "non-regular type was not preserved");
    },
  }),
);

cases.push(
  await runCase({
    family: "F4c",
    name: "not-found",
    expected: notFound,
    create: () => flatFixture("f4c", "other.txt", "abc"),
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f4c",
        directory,
        name: "missing.txt",
        offset: 0,
        length: 3,
        expectedBase64: b64("abc"),
      });
    },
    verify: ({ check, opens, executedActions, result }) => {
      check(opens === 0, "not-found case opened a file");
      check(sameActions(executedActions, ["list"]), "not-found case continued past listing");
      check(result.domain.rootFact?.kind === "not_found", "missing name did not produce not_found");
    },
  }),
);

cases.push(
  await flatReadCase({
    family: "F4d",
    name: "substeps-green-root-byte-mismatch",
    fixtureId: "f4d",
    fileName: "f.txt",
    contents: "abcdef",
    offset: 0,
    length: 3,
    expectedBase64: b64("abd"),
    expected: byteMismatch,
  }),
);

cases.push(
  await flatReadCase({
    family: "F4e",
    name: "success",
    fixtureId: "f4e",
    fileName: "final.txt",
    contents: "final-ok",
    offset: 0,
    length: 8,
    expectedBase64: b64("final-ok"),
    expected: matched,
  }),
);

cases.push(
  await runCase({
    family: "F4f",
    name: "missing-filesystem-read",
    expected: rejected,
    create: async () => {
      const ctx = await createFixture({
        scenarioId: "f4f-missing",
        entries: [
          { path: "d", kind: "directory" },
          { path: "d/f.txt", kind: "file", contents: "hello" },
        ],
        cwd: "d",
        grantedEffects: ["process.exec", "session.write"],
        ownerGrantedEffects: ["filesystem.write"],
      });
      ctx.boundDir = join(ctx.scenarioRoot, "d");
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      return runComposition(ctx, {
        id: "f4f-missing",
        directory,
        name: "f.txt",
        offset: 0,
        length: 5,
        expectedBase64: b64("hello"),
      });
    },
    verify: ({ check, opens, executedActions, result, facts }) => {
      facts.fixture = "session lacks filesystem.read and owner grants only filesystem.write";
      check(opens === 0, "missing filesystem.read opened a file");
      check(!executedActions.includes("read"), "missing filesystem.read reached file.read");
      check(result.domain.rootFact?.kind === "rejected", "missing effect was not rejected");
    },
  }),
);

cases.push(
  await runCase({
    family: "F4f",
    name: "real-eacces-read-failure",
    expected: failed,
    create: async () => {
      const ctx = await flatFixture("f4f-eacces", "f.txt", "hello");
      await chmod(join(ctx.scenarioRoot, "d/f.txt"), 0o000);
      return ctx;
    },
    execute: async (ctx) => {
      const directory = await ctx.sandbox.bindDirectory(ctx.session, ".");
      try {
        return await runComposition(ctx, {
          id: "f4f-eacces",
          directory,
          name: "f.txt",
          offset: 0,
          length: 5,
          expectedBase64: b64("hello"),
        });
      } finally {
        await chmod(join(ctx.scenarioRoot, "d/f.txt"), 0o600).catch(() => {});
      }
    },
    verify: ({ check, opens, executedActions, result, facts }) => {
      facts.fixtureMutation = "chmod 000 before the run, restored to 600 after the run";
      facts.errno = readFailure(result)?.code ?? null;
      check(opens === 1, "EACCES case did not perform the real open");
      check(sameActions(executedActions, ["list", "inspect", "read"]), "EACCES action sequence is wrong");
      check(facts.errno === "EACCES", "real errno was not preserved");
      check(result.domain.rootFact?.kind === "failed", "EACCES was not failed");
    },
  }),
);

const passed = caseResults.filter((entry) => entry.ok).length;
const failedCount = caseResults.length - passed;
const exitCode = failedCount === 0 ? 0 : 1;
const summary = {
  independentFamily: "cli-read-composition-p3",
  cases: caseResults.length,
  passed,
  failed: failedCount,
  finalExitCode: exitCode,
};
record(summary);

await mkdir(dirname(LOG_PATH), { recursive: true });
await writeFile(LOG_PATH, `${outputLines.join("\n")}\n`, "utf8");
process.exitCode = exitCode;
