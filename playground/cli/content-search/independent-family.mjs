import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createCliFilesystemSandbox, runCliContentSearchGoal } = await import("nnanything/cli-content-search");

const profileFile = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof profileFile !== "string" || profileFile.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required");
}
const profile = JSON.parse(await readFile(profileFile, "utf8"));
const limits = Object.freeze({ maxTransitions: 64, maxDepth: 4, maxDerivedGoals: 16 });

const NEEDLE = "renderSlot";
const ENGINE = `export const renderSlot = "slot-3a";\nexport function render(){ return "slot-3a"; }\n`;
const PROBE = `export const queueLimit = 3;\nexport const queueMode = "hold";\n`;
const MEMO = `renderSlot is described here.\n`;

function request(directory, requestId, order) {
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: ".ts" },
        cardinality: "one",
      },
      requirement: { kind: "contains", predicate: { kind: "contains", needle: NEEDLE, encoding: "utf8" } },
    },
    satisfactionThreshold: 100,
  };
}

async function snapshot(start) {
  const names = (await readdir(start)).sort();
  const contents = {};
  for (const name of names) {
    contents[name] = await readFile(join(start, name), "utf8");
  }
  return { names, contents };
}

const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-independent-")));
const sandbox = await createCliFilesystemSandbox({
  root,
  ownerGrantedEffects: ["filesystem.write"],
  recipe: {
    scenarioId: "m1-independent-runtime-e9",
    entries: [
      { path: "src", kind: "directory" },
      { path: "src/engine.ts", kind: "file", contents: ENGINE },
      { path: "src/probe.ts", kind: "file", contents: PROBE },
      { path: "src/memo.md", kind: "file", contents: MEMO },
    ],
    sessions: [{ id: "s", cwd: "src", grantedEffects: ["filesystem.read", "process.exec"] }],
  },
});

const session = sandbox.bindSession("s");
const directory = await sandbox.bindDirectory(session, ".");
const start = sandbox.getSession(session).cwd;
const beforeCwd = process.cwd();
const before = await snapshot(start);
const engineBytes = Buffer.byteLength(ENGINE, "utf8");
const probeBytes = Buffer.byteLength(PROBE, "utf8");
const needleStart = Buffer.from(ENGINE, "utf8").indexOf(Buffer.from(NEEDLE, "utf8"));

try {
  const normal = await runCliContentSearchGoal(request(directory, "independent-normal"), {
    sandbox,
    session,
    profile,
    limits,
  });
  assert.equal(normal.domain.status, "achieved");
  assert.equal(normal.domain.resolution, "matched");
  assert.equal(normal.domain.deliberateSuboptimal, false);
  assert.equal(normal.domain.invocationCount, 3);
  assert.equal(normal.domain.bytesReadTotal, engineBytes);
  assert.deepEqual(normal.domain.matches.map(match => match.path), [join(start, "engine.ts")]);
  assert.deepEqual(normal.domain.negatives, []);
  assert.deepEqual(normal.domain.matches[0].byteSpan, {
    start: needleStart,
    end: needleStart + Buffer.byteLength(NEEDLE, "utf8"),
  });

  const recovered = await runCliContentSearchGoal(request(directory, "independent-recovery"), {
    sandbox,
    session,
    profile,
    limits,
    order: { kind: "injected-first", name: "probe.ts" },
  });
  assert.equal(recovered.domain.status, "achieved");
  assert.equal(recovered.domain.resolution, "matched");
  assert.equal(recovered.domain.deliberateSuboptimal, true);
  assert.equal(recovered.domain.invocationCount, 5);
  assert.equal(recovered.domain.bytesReadTotal, probeBytes + engineBytes);
  assert.deepEqual(recovered.domain.matches.map(match => match.path), [join(start, "engine.ts")]);
  assert.deepEqual(recovered.domain.negatives.map(negative => negative.path), [join(start, "probe.ts")]);

  assert.equal(process.cwd(), beforeCwd);
  assert.equal(sandbox.getSession(session).cwd, start);
  assert.deepEqual(await snapshot(start), before);

  process.stdout.write(JSON.stringify({
    consumer: "independent-family",
    exitCode: 0,
    needle: NEEDLE,
    normal: { status: normal.domain.status, resolution: normal.domain.resolution, deliberateSuboptimal: normal.domain.deliberateSuboptimal },
    recovery: { status: recovered.domain.status, resolution: recovered.domain.resolution, deliberateSuboptimal: recovered.domain.deliberateSuboptimal },
    readOnly: true,
    cwdUnchanged: true,
    entriesUnchanged: true,
    contentsUnchanged: true,
  }) + "\n");
} finally {
  await sandbox.cleanup();
  await rm(root, { recursive: true, force: true });
}
