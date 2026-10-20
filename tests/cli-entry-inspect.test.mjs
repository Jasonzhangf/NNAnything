import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdtemp, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const api = () => import("../dist/cli-goal.js");
const execFileAsync = promisify(execFile);

const EMPTY_STATE = session => ({
  session: session.sessionId,
  cwdObservation: null,
  directoryListing: null,
});

function pathRef(sandbox, session, path) {
  return Object.freeze({
    kind: "cli.path",
    scenarioId: sandbox.scenarioId,
    sessionId: session.sessionId,
    path,
  });
}

function inspectGoal(property, ref, followSymlinks) {
  return Object.freeze({
    kind: "file.property",
    property: property.startsWith("file.property.") ? property : `file.property.${property}`,
    target: Object.freeze({ kind: "cli.entry-query", ref, followSymlinks }),
    requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
  });
}

function witnessProfile(module, head) {
  const profile = module.zeroCliCommandProfile();
  const row = profile.heads.indexOf(head);
  if (row < 0) return profile;
  return {
    ...profile,
    weights: profile.weights.map((weights, index) =>
      index === row ? weights.map((weight, column) => column === 0 ? 10 : weight) : [...weights]),
  };
}

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp("/tmp/nn-entry-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = await api();
  const grants = options.grants ?? ["filesystem.read", "process.exec", "session.write"];
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: "entry-inspect",
      entries: [
        { path: "start", kind: "directory" },
        { path: "start/dir", kind: "directory" },
        { path: "start/file.txt", kind: "file", contents: "payload" },
        { path: "start/locked", kind: "directory" },
        { path: "start/locked/child.txt", kind: "file", contents: "hidden" },
        ...(options.entries ?? []),
      ],
      sessions: [
        { id: "s", cwd: "start", grantedEffects: grants },
        { id: "other", cwd: "start", grantedEffects: grants },
      ],
    },
  });
  t.after(() => sandbox.cleanup());
  const session = sandbox.bindSession("s");
  return {
    module,
    sandbox,
    session,
    other: sandbox.bindSession("other"),
    startAbs: sandbox.getSession(session).cwd,
  };
}

async function bindObserved(sandbox, session, absolutePath, kind = "cli.entry") {
  if (typeof sandbox.bindObservedEntry === "function") {
    return sandbox.bindObservedEntry(session, absolutePath, { kind });
  }
  const binder = {
    "cli.entry": sandbox.bindEntry,
    "cli.file": sandbox.bindFile,
    "cli.directory": sandbox.bindDirectoryObject,
  }[kind];
  if (typeof binder === "function") {
    return binder.call(sandbox, session, absolutePath);
  }
  throw new Error(
    "R08/R09/R10/R11 require a public sandbox binding API for observed object references. "
    + "Expected bindObservedEntry(session, absolutePath, { kind }) or a named equivalent for E/F/D.",
  );
}

async function inspect(module, sandbox, session, input) {
  const policy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "entry.inspect"),
    sandbox,
    session,
  });
  return policy.step({
    goal: inspectGoal(input.property, input.ref, input.followSymlinks ?? false),
    satisfactionThreshold: input.satisfactionThreshold ?? 100,
    state: input.state ?? EMPTY_STATE(session),
  });
}

function knowledgeOf(result) {
  const after = result?.observed_state_after ?? {};
  return after.entryKnowledge ?? after.entry ?? after.pathKnowledge ?? {};
}

function observedValue(result, key) {
  const knowledge = knowledgeOf(result);
  if (key === "exists") {
    const projected = knowledge.query?.followSymlinks
      ? knowledge.resolvedTargetExists
      : knowledge.entryExists;
    if (projected !== undefined) return projected;
  }
  if (key === "link.target") {
    if (knowledge.linkTarget !== undefined) return knowledge.linkTarget;
  }
  const candidates = [
    knowledge[key],
    knowledge.value?.[key],
    knowledge.observation?.[key],
    result?.evidence?.[key],
    result?.evidence?.value?.[key],
    result?.execution_result?.receipt?.execution?.observation?.[key],
    result?.execution_result?.receipt?.execution?.observation?.value?.[key],
  ];
  return candidates.find(value => value !== undefined);
}

function requireObserved(result, key) {
  const value = observedValue(result, key);
  if (value === undefined) {
    const knowledge = knowledgeOf(result);
    assert.fail(`public inspect result must expose ${key}; observed keys: ${Object.keys(knowledge).join(",") || "<none>"}`);
  }
  return value;
}

function errorCode(result) {
  return result?.execution_result?.receipt?.execution?.error?.code
    ?? result?.execution_result?.error
    ?? result?.execution_result?.reason
    ?? result?.evidence?.bindingError
    ?? result?.policy_error
    ?? result?.reason
    ?? null;
}

function assertEntryInspectSignature(result, ref, followSymlinks) {
  assert.equal(result.invocation?.[0], "entry.inspect", "inspect must execute the registered entry.inspect head");
  assert.equal(result.invocation?.length, 3, "entry.inspect invocation must be [head, ref, followSymlinks]");
  assert.deepEqual(result.invocation?.[1], ref, "inspect must preserve the typed source reference");
  assert.equal(result.invocation?.[2], followSymlinks, "inspect must preserve the explicit followSymlinks parameter");
}

test("R08 E, F, P and identity-bearing D references keep their categories and project real types", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const fileAbs = join(startAbs, "file.txt");
  const directoryAbs = join(startAbs, "dir");
  const cases = [
    ["cli.entry", await bindObserved(sandbox, session, fileAbs, "cli.entry"), "regular"],
    ["cli.file", await bindObserved(sandbox, session, fileAbs, "cli.file"), "regular"],
    ["cli.path", pathRef(sandbox, session, fileAbs), "regular"],
    ["cli.directory", await bindObserved(sandbox, session, directoryAbs, "cli.directory"), "directory"],
  ];

  for (const [kind, ref, expectedType] of cases) {
    const result = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
    assert.equal(result.goal.target.ref.kind, kind);
    assertEntryInspectSignature(result, ref, false);
    assert.equal(result.status, "achieved", `${kind} inspect must achieve a real type observation`);
    assert.equal(result.satisfaction, 100);
    assert.equal(requireObserved(result, "type"), expectedType);
    assert.equal(result.execution_result.receipt?.execution?.status, "succeeded");
    assert.equal(result.execution_result.receipt?.execution?.observation?.kind, "entry.inspect");
  }
});

test("R09 observed file identity rejects a renamed path replaced by a new file", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const original = join(startAbs, "file.txt");
  const moved = join(startAbs, "moved.txt");
  const ref = await bindObserved(sandbox, session, original, "cli.file");
  const originalIdentity = await lstat(original);

  await rename(original, moved);
  await writeFile(original, "replacement");
  const replacementIdentity = await lstat(original);
  assert.notEqual(originalIdentity.ino, replacementIdentity.ino);

  const result = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
  assertEntryInspectSignature(result, ref, false);
  assert.notEqual(result.status, "achieved", "stale observed identity must not follow the replacement path");
  assert.notEqual(result.satisfaction, 100);
  assert.match(String(errorCode(result)), /STALE|IDENTITY|REVISION|stale|identity|revision/i);
});

test("R10 legacy D, forged sourceRun and cross-session E never become trusted path evidence", async t => {
  const { module, sandbox, session, other, startAbs } = await fixture(t);
  const directoryAbs = join(startAbs, "dir");
  const fileAbs = join(startAbs, "file.txt");

  const legacyDirectory = await sandbox.bindDirectory(session, "dir");
  const legacy = await inspect(module, sandbox, session, {
    property: "type",
    ref: legacyDirectory,
    followSymlinks: false,
  });
  assert.notEqual(legacy.status, "achieved", "a legacy four-field D lacks identity and must not be trusted");
  assert.equal(legacy.satisfaction, null);
  assert.match(String(errorCode(legacy)), /binding_identity_missing|identity_missing|unknown/i);

  const observedFile = await bindObserved(sandbox, session, fileAbs, "cli.file");
  const forged = { ...observedFile, sourceRun: "forged-source-run" };
  let forgedResult;
  try {
    forgedResult = await inspect(module, sandbox, session, { property: "type", ref: forged, followSymlinks: false });
  } catch (error) {
    assert.ok(error instanceof TypeError, `forged sourceRun must reject as TypeError, got ${error}`);
  }
  if (forgedResult !== undefined) {
    assert.notEqual(forgedResult.status, "achieved", "forged sourceRun must not gain fresh or known evidence");
    assert.notEqual(forgedResult.satisfaction, 100);
  }

  const foreignPolicy = module.createCliCommandPolicy({
    profile: witnessProfile(module, "entry.inspect"),
    sandbox,
    session: other,
  });
  await assert.rejects(
    foreignPolicy.step({
      goal: inspectGoal("type", observedFile, false),
      satisfactionThreshold: 100,
      state: EMPTY_STATE(other),
    }),
    TypeError,
    "an observed reference from another session must reject before OS effects",
  );
  assert.equal(sandbox.getSession(session).revision, sandbox.getSession(other).revision);
  assert.ok(directoryAbs);
});

test("R11 session revision change invalidates an observed directory reference", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const ref = await bindObserved(sandbox, session, startAbs, "cli.directory");
  const before = sandbox.getSession(session);
  const destination = await sandbox.bindDirectory(session, "dir");
  const moved = await sandbox.execute({
    operation: "cwd.set",
    parameters: { session, directory: destination },
  });
  assert.equal(moved.execution.status, "succeeded");
  assert.ok(sandbox.getSession(session).revision > before.revision);

  const result = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
  assertEntryInspectSignature(result, ref, false);
  assert.notEqual(result.status, "achieved", "old directory knowledge must become stale after session revision changes");
  assert.notEqual(result.satisfaction, 100);
  assert.match(String(errorCode(result)), /STALE|REVISION|session|revision/i);
});

test("R12 follow=false observes a broken symlink itself with exists true and raw link text", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const linkAbs = join(startAbs, "broken-link");
  await symlink("missing-target", linkAbs);
  const ref = pathRef(sandbox, session, linkAbs);

  const type = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
  assertEntryInspectSignature(type, ref, false);
  assert.equal(type.status, "achieved");
  assert.equal(requireObserved(type, "type"), "symlink");

  const exists = await inspect(module, sandbox, session, { property: "exists", ref, followSymlinks: false });
  assert.equal(exists.status, "achieved");
  assert.equal(requireObserved(exists, "exists"), true);

  const target = await inspect(module, sandbox, session, { property: "link.target", ref, followSymlinks: false });
  assert.equal(target.status, "achieved");
  assert.equal(requireObserved(target, "linkTarget"), "missing-target");
  assert.equal(await readlink(linkAbs), "missing-target");
});

test("R13 follow=true distinguishes a missing resolved target from a missing path entry", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const linkAbs = join(startAbs, "broken-link");
  const missingAbs = join(startAbs, "does-not-exist");
  await symlink("missing-target", linkAbs);
  const linkRef = pathRef(sandbox, session, linkAbs);
  const missingRef = pathRef(sandbox, session, missingAbs);

  const followed = await inspect(module, sandbox, session, { property: "exists", ref: linkRef, followSymlinks: true });
  assertEntryInspectSignature(followed, linkRef, true);
  assert.equal(followed.status, "achieved");
  assert.equal(requireObserved(followed, "exists"), false);
  const followedKnowledge = knowledgeOf(followed);
  if (Object.hasOwn(followedKnowledge, "entryExists")) assert.equal(followedKnowledge.entryExists, true);
  if (Object.hasOwn(followedKnowledge, "resolvedTargetExists")) assert.equal(followedKnowledge.resolvedTargetExists, false);

  const missing = await inspect(module, sandbox, session, { property: "exists", ref: missingRef, followSymlinks: false });
  assert.equal(missing.status, "achieved", "an explicit P ENOENT is a valid exists=false observation");
  assert.equal(missing.satisfaction, 100);
  assert.equal(requireObserved(missing, "exists"), false);

  const missingType = await inspect(module, sandbox, session, { property: "type", ref: missingRef, followSymlinks: false });
  assert.notEqual(missingType.status, "achieved");
  assert.notEqual(missingType.satisfaction, 100, "a missing entry has no type value");
  assert.equal(observedValue(missingType, "type") ?? null, null);
});

test("R14 symlink ELOOP is a failure and never a lexical fallback", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const a = join(startAbs, "loop-a");
  const b = join(startAbs, "loop-b");
  await symlink("loop-b", a);
  await symlink("loop-a", b);
  const ref = pathRef(sandbox, session, a);

  const followed = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: true });
  assertEntryInspectSignature(followed, ref, true);
  assert.notEqual(followed.status, "achieved");
  assert.equal(followed.satisfaction, 0);
  assert.equal(errorCode(followed), "ELOOP");

  const lexical = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
  assert.equal(lexical.status, "achieved");
  assert.equal(requireObserved(lexical, "type"), "symlink");
});

test("R15 native mode denial never writes exists=false", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const locked = join(startAbs, "locked");
  const child = join(locked, "child.txt");
  const ref = pathRef(sandbox, session, child);
  await chmod(locked, 0o000);
  try {
    const result = await inspect(module, sandbox, session, { property: "exists", ref, followSymlinks: false });
    assertEntryInspectSignature(result, ref, false);
    if (result.status === "achieved") {
      assert.equal(requireObserved(result, "exists"), true, "mode traversal bypass may observe the entry but cannot report false");
      t.diagnostic("R15 native EACCES UNVERIFIED: current identity traversed mode 000");
    } else {
      assert.equal(result.satisfaction, 0);
      assert.match(String(errorCode(result)), /EACCES|EPERM/);
      const exists = observedValue(result, "exists");
      assert.notEqual(exists, false, "EACCES or EPERM must not become a known false existence");
    }
  } finally {
    await chmod(locked, 0o700);
  }
});

test("R16 ENOTDIR stays distinct from ENOENT and does not create a false existence fact", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const ref = pathRef(sandbox, session, join(startAbs, "file.txt", "child"));
  const result = await inspect(module, sandbox, session, { property: "exists", ref, followSymlinks: false });
  assertEntryInspectSignature(result, ref, false);
  assert.notEqual(result.status, "achieved");
  assert.equal(result.satisfaction, 0);
  assert.equal(errorCode(result), "ENOTDIR");
  assert.notEqual(observedValue(result, "exists"), false);
});

test("R17 missing filesystem.read grant rejects before any property read", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t, { grants: [] });
  const ref = pathRef(sandbox, session, join(startAbs, "file.txt"));
  const result = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
  assertEntryInspectSignature(result, ref, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.satisfaction, 0);
  assert.equal(errorCode(result), "EFFECT_DENIED");
  assert.equal(observedValue(result, "type") ?? null, null);
});

test("F2 entry.inspect requires process.exec before starting the helper", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t, { grants: ["filesystem.read"] });
  const ref = pathRef(sandbox, session, join(startAbs, "file.txt"));
  const result = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
  assertEntryInspectSignature(result, ref, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.satisfaction, 0);
  assert.equal(errorCode(result), "EFFECT_DENIED");
  const execution = result.execution_result?.receipt?.execution;
  assert.equal(execution?.executorInvoked, false);
  assert.equal(execution?.error?.stage, "authorize");
});

test("F1 ancestor symlink followed by .. binds the OS object and identity", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t, {
    entries: [{ path: "start/dir/child", kind: "directory" }],
  });
  const link = join(startAbs, "anchor");
  const rawPath = `${link}/..`;
  await symlink("dir/child", link);

  const osIdentity = await lstat(rawPath, { bigint: true });
  const osPhysicalPath = await realpath(rawPath);
  const ref = await bindObserved(sandbox, session, rawPath, "cli.directory");
  assert.equal(ref.absolutePath, osPhysicalPath, "binding must keep the OS-resolved object path");
  assert.equal(BigInt(ref.identity.dev), osIdentity.dev);
  assert.equal(BigInt(ref.identity.ino), osIdentity.ino);

  const result = await inspect(module, sandbox, session, {
    property: "entry.identity",
    ref: pathRef(sandbox, session, rawPath),
    followSymlinks: false,
  });
  assert.equal(result.status, "achieved");
  const observed = requireObserved(result, "identity");
  assert.equal(BigInt(observed.dev), osIdentity.dev);
  assert.equal(BigInt(observed.ino), osIdentity.ino);

  const escapingLink = join(startAbs, "escape-anchor");
  const escapingPath = `${escapingLink}/..`;
  await symlink("..", escapingLink);
  await assert.rejects(
    bindObserved(sandbox, session, escapingPath, "cli.directory"),
    error => error?.code === "SANDBOX_ESCAPE",
  );
  const escaped = await inspect(module, sandbox, session, {
    property: "type",
    ref: pathRef(sandbox, session, escapingPath),
    followSymlinks: false,
  });
  assert.notEqual(escaped.status, "achieved");
  assert.equal(errorCode(escaped), "SANDBOX_ESCAPE");
});

test("R18 real regular, directory, symlink, FIFO and socket types keep mode and identity evidence", { timeout: 15000 }, async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const regular = join(startAbs, "file.txt");
  const directory = join(startAbs, "dir");
  const symbolic = join(startAbs, "symbolic");
  const fifo = join(startAbs, "named-pipe");
  const socket = join(startAbs, "unix-socket");
  await symlink("file.txt", symbolic);
  await execFileAsync("mkfifo", [fifo]);

  let server = null;
  let socketAvailable = true;
  try {
    server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
  } catch (error) {
    socketAvailable = false;
    t.diagnostic(`R18 unix socket fixture UNVERIFIED on this host: ${error.code ?? error.message}`);
  }

  const cases = [
    [regular, "regular"],
    [directory, "directory"],
    [symbolic, "symlink"],
    [fifo, "fifo"],
    ...(socketAvailable ? [[socket, "socket"]] : []),
  ];
  for (const [absolutePath, expectedType] of cases) {
    const ref = pathRef(sandbox, session, absolutePath);
    const type = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
    assertEntryInspectSignature(type, ref, false);
    assert.equal(type.status, "achieved", `${expectedType} must be observed without opening its stream`);
    assert.equal(requireObserved(type, "type"), expectedType);

    const mode = await inspect(module, sandbox, session, { property: "mode", ref, followSymlinks: false });
    assert.equal(mode.status, "achieved");
    assert.equal(requireObserved(mode, "mode") & 0o7777, (await lstat(absolutePath)).mode & 0o7777);

    const identity = await inspect(module, sandbox, session, { property: "entry.identity", ref, followSymlinks: false });
    assert.equal(identity.status, "achieved");
    const observed = requireObserved(identity, "identity");
    assert.ok(Object.hasOwn(observed, "dev"));
    assert.ok(Object.hasOwn(observed, "ino"));
    assert.ok(Object.hasOwn(observed, "nlink"));
    assert.ok(Object.hasOwn(observed, "rdev"));
  }
  t.diagnostic("R18 character_device and block_device native fixtures remain UNVERIFIED on macOS; the public type union must retain both.");
});

test("R19 hardlinks preserve dev/ino and nlink with OS integer fidelity", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const first = join(startAbs, "file.txt");
  const second = join(startAbs, "hardlink.txt");
  await link(first, second);

  const firstResult = await inspect(module, sandbox, session, {
    property: "entry.identity",
    ref: pathRef(sandbox, session, first),
    followSymlinks: false,
  });
  const secondResult = await inspect(module, sandbox, session, {
    property: "entry.identity",
    ref: pathRef(sandbox, session, second),
    followSymlinks: false,
  });
  assert.equal(firstResult.status, "achieved");
  assert.equal(secondResult.status, "achieved");
  const firstIdentity = requireObserved(firstResult, "identity");
  const secondIdentity = requireObserved(secondResult, "identity");
  assert.deepEqual(firstIdentity.dev, secondIdentity.dev);
  assert.deepEqual(firstIdentity.ino, secondIdentity.ino);
  assert.ok(Number(firstIdentity.nlink) >= 2);
  for (const value of [firstIdentity.dev, firstIdentity.ino, firstIdentity.nlink, firstIdentity.rdev]) {
    assert.ok(value === null || (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && /^\d+$/.test(value)),
      "OS integers must be number-safe, decimal strings or null");
  }
  t.diagnostic("R19 controlled big-integer injection remains UNVERIFIED until the public inspection injection hook is available.");
});

test("R20 inapplicable link.target stays unknown and does not fabricate time or link text", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const ref = pathRef(sandbox, session, join(startAbs, "file.txt"));
  const type = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
  assert.equal(type.status, "achieved");
  assert.equal(requireObserved(type, "type"), "regular");

  const linkTarget = await inspect(module, sandbox, session, { property: "link.target", ref, followSymlinks: false });
  assert.notEqual(linkTarget.status, "achieved");
  assert.notEqual(linkTarget.satisfaction, 100);
  assert.equal(observedValue(linkTarget, "linkTarget") ?? null, null);

  const times = await inspect(module, sandbox, session, { property: "times", ref, followSymlinks: false });
  assert.equal(times.status, "achieved");
  const observedTimes = requireObserved(times, "times");
  for (const key of ["atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs"]) {
    assert.ok(Object.hasOwn(observedTimes, key), `times must expose ${key}`);
    const value = observedTimes[key];
    assert.ok(value === null || typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)),
      `${key} must be an OS value or null, not a fabricated default`);
  }
});

test("R23 special names stay one typed argument and external link targets do not escape scope", async t => {
  const { module, sandbox, session, startAbs } = await fixture(t);
  const name = 'sp ace-\u4e2d\u6587-\n-quote"\'-$(touch PWNED)';
  const special = join(startAbs, name);
  await writeFile(special, "special");
  const ref = pathRef(sandbox, session, special);

  const type = await inspect(module, sandbox, session, { property: "type", ref, followSymlinks: false });
  assertEntryInspectSignature(type, ref, false);
  assert.equal(type.invocation[1].path, special);
  assert.equal(type.status, "achieved");
  assert.equal(requireObserved(type, "type"), "regular");
  await assert.rejects(lstat(join(process.cwd(), "PWNED")), { code: "ENOENT" });

  const outside = join(startAbs, "outside-link");
  await symlink("/etc/passwd", outside);
  const outsideRef = pathRef(sandbox, session, outside);
  const escaped = await inspect(module, sandbox, session, { property: "type", ref: outsideRef, followSymlinks: true });
  assertEntryInspectSignature(escaped, outsideRef, true);
  assert.notEqual(escaped.status, "achieved", "follow=true must reject a resolved target outside the authorized scenario");
  assert.notEqual(escaped.satisfaction, 100);
  assert.match(String(errorCode(escaped)), /SANDBOX_ESCAPE|EFFECT_DENIED|AUTHOR|ESCAPE/i);
});
