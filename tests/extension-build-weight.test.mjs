import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { DEFAULT_BASIC_KIND_PROFILE } from "nnanything/browser-classify";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const buildScript = join(repositoryRoot, "scripts/build-extension.mjs");
const contentBundle = join(repositoryRoot, "artifacts/chrome-extension/content.js");

function fixtureWeight(profileId) {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = profileId;
  return {
    targetOperator: "dom.basic_kinds",
    operatorVersion: "0.1.0",
    contractVersion: 1,
    taskId: "dom.basic-kinds.v1",
    profileId,
    baseProfileId: DEFAULT_BASIC_KIND_PROFILE.id,
    calibrated: false,
    compatibility: { taskId: "dom.basic-kinds.v1", minScore: 0.7, minMargin: 0.2 },
    profile,
  };
}

async function build(args) {
  return run(process.execPath, [buildScript, ...args], { cwd: repositoryRoot });
}

test("extension build embeds a selected weight and otherwise keeps the handwritten baseline", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "nnanything-extension-build-"));
  t.after(async () => {
    await build([]).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseline = await build([]);
  assert.match(baseline.stdout, /handwritten baseline/);
  const baselineBundle = await readFile(contentBundle, "utf8");
  // The panel must not start in file mode with an absent source; that combination
  // classifies nothing and forces a manual pick on every page.
  assert.equal(baselineBundle.includes("weightFile: null"), false);

  const embeddedId = "build-embed-fixture-v1";
  const weightPath = join(tempDir, "embed.weight.json");
  await writeFile(weightPath, JSON.stringify(fixtureWeight(embeddedId), null, 2));
  const embedded = await build(["--weight-file", weightPath]);
  assert.match(embedded.stdout, new RegExp(embeddedId));
  const embeddedBundle = await readFile(contentBundle, "utf8");
  assert.equal(embeddedBundle.includes(embeddedId), true);
  assert.equal(embeddedBundle.includes("weightFile: null"), false);

  const beforeFailure = await readFile(contentBundle);
  const brokenPath = join(tempDir, "broken.weight.json");
  await writeFile(brokenPath, "{not json");
  await assert.rejects(build(["--weight-file", brokenPath]), /Cannot load --weight-file/);
  assert.deepEqual(await readFile(contentBundle), beforeFailure, "a rejected weight must not overwrite the built bundle");

  await assert.rejects(build(["--weight-file", join(tempDir, "absent.weight.json")]), /Cannot load --weight-file/);
  assert.deepEqual(await readFile(contentBundle), beforeFailure);
});
