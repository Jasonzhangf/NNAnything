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

const INGEST = `export const traceToken = "tel-9f3a";\nexport function ingest(){ return "tel-9f3a"; }\n`;
const RELAY = `export const auditTag = "relay-audit-7";\nexport const relayMode = "shadow";\nexport const relayCapacity = 64;\n`;
const MANUAL = `traceToken is documented here.\n`;

function request(directory, needle, requestId, order) {
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
      requirement: { kind: "contains", predicate: { kind: "contains", needle, encoding: "utf8" } },
    },
    satisfactionThreshold: 100,
  };
}

async function snapshot(start) {
  const names = (await readdir(start)).sort();
  const contents = {};
  for (const name of names) {
    if (name.endsWith(".ts") || name.endsWith(".md") || name.endsWith(".txt")) {
      contents[name] = await readFile(join(start, name), "utf8");
    }
  }
  return { names, contents };
}

const root = await realpath(await mkdtemp(join(tmpdir(), "nn-content-search-consumer-")));
const sandbox = await createCliFilesystemSandbox({
  root,
  ownerGrantedEffects: ["filesystem.write"],
  recipe: {
    scenarioId: "m1-test-telemetry-e1",
    entries: [
      { path: "src", kind: "directory" },
      { path: "src/ingest.ts", kind: "file", contents: INGEST },
      { path: "src/relay.ts", kind: "file", contents: RELAY },
      { path: "src/manual.txt", kind: "file", contents: MANUAL },
    ],
    sessions: [{ id: "s", cwd: "src", grantedEffects: ["filesystem.read", "process.exec"] }],
  },
});

const session = sandbox.bindSession("s");
const directory = await sandbox.bindDirectory(session, ".");
const start = sandbox.getSession(session).cwd;
const beforeCwd = process.cwd();
const before = await snapshot(start);

try {
  const normal = await runCliContentSearchGoal(
    request(directory, "traceToken", "consumer-normal"),
    { sandbox, session, profile, limits },
  );
  assert.equal(normal.domain.status, "achieved");
  assert.equal(normal.domain.resolution, "matched");
  assert.equal(normal.domain.satisfaction, 100);
  assert.equal(normal.domain.deliberateSuboptimal, false);
  assert.equal(normal.domain.invocationCount, 3);
  assert.equal(normal.domain.bytesReadTotal, 85);
  assert.deepEqual(normal.domain.matches.map(match => match.path), [join(start, "ingest.ts")]);
  assert.deepEqual(normal.domain.negatives, []);

  const recovered = await runCliContentSearchGoal(
    request(directory, "traceToken", "consumer-recovery", { kind: "injected-first", name: "relay.ts" }),
    { sandbox, session, profile, limits, order: { kind: "injected-first", name: "relay.ts" } },
  );
  assert.equal(recovered.domain.status, "achieved");
  assert.equal(recovered.domain.resolution, "matched");
  assert.equal(recovered.domain.deliberateSuboptimal, true);
  assert.equal(recovered.domain.invocationCount, 5);
  assert.equal(recovered.domain.bytesReadTotal, 194);
  assert.deepEqual(recovered.domain.matches.map(match => match.path), [join(start, "ingest.ts")]);
  assert.deepEqual(recovered.domain.negatives.map(negative => negative.path), [join(start, "relay.ts")]);

  assert.equal(process.cwd(), beforeCwd);
  assert.equal(sandbox.getSession(session).cwd, start);
  assert.deepEqual(await snapshot(start), before);

  process.stdout.write(JSON.stringify({
    consumer: "public",
    exitCode: 0,
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
