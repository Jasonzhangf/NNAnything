// Guards the seam that broke every CLI public consumer when the shared command profile grew the
// search.nameNeedleSegment wire: the runtime entry rejects a saved 10x30 profile by contract, so
// each consumer must migrate it explicitly before handing it over. Without this guard, adding a
// wire silently breaks consumers that were not updated, because they are not covered elsewhere.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const REPO = new URL("..", import.meta.url).pathname;
const PROFILE = process.env.NN_CLI_COMMAND_PROFILE;

async function playgroundEntries(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await playgroundEntries(path));
    else if (entry.name.endsWith(".mjs")) found.push(path);
  }
  return found;
}

const MIGRATION_HELPERS = [
  "migrateCliCommandProfileV10x30",
  "migrateCliCommandProfileToCurrent",
];

function isProfileConsumerSource(source) {
  const readsEnv = source.includes("process.env.NN_CLI_COMMAND_PROFILE")
    || source.includes("env.NN_CLI_COMMAND_PROFILE");
  return readsEnv && source.includes("JSON.parse(await readFile");
}

function hasExplicitMigration(source) {
  return MIGRATION_HELPERS.some(name => source.includes(name));
}

test("every playground consumer that parses NN_CLI_COMMAND_PROFILE migrates a 10x30 profile", async () => {
  const files = await playgroundEntries(join(REPO, "playground"));
  const parsers = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // A real consumer reads the profile path from NN_CLI_COMMAND_PROFILE (directly or through a
    // process.env-derived object). A printed command line that merely contains the env name is not
    // a consumer; train.mjs reads --initial-source and migrates it with the current named helper.
    if (!isProfileConsumerSource(source)) continue;
    parsers.push({ file, source });
  }
  assert.ok(parsers.length > 0, "expected playground consumers that parse the shared command profile");
  const missing = parsers
    .filter(({ source }) => !hasExplicitMigration(source))
    .map(({ file }) => file.slice(REPO.length));
  assert.deepEqual(
    missing,
    [],
    "these consumers parse the command profile without the explicit 10x30 migration",
  );
});

test("the consumer guard still flags a profile consumer with no migration", () => {
  const unmigrated = [
    "const profilePath = process.env.NN_CLI_COMMAND_PROFILE;",
    "const rawProfile = JSON.parse(await readFile(profilePath, \"utf8\"));",
  ].join("\n");
  assert.equal(isProfileConsumerSource(unmigrated), true);
  assert.equal(hasExplicitMigration(unmigrated), false);
});

test("the entry-search consumer runs end to end against the saved 10x30 candidate", async (t) => {
  if (typeof PROFILE !== "string" || PROFILE.length === 0) {
    t.skip("NN_CLI_COMMAND_PROFILE is required");
    return;
  }
  const saved = JSON.parse(await readFile(PROFILE, "utf8"));
  if (saved.wires?.length !== 30) {
    t.skip("this guard needs the historical 10x30 saved candidate");
    return;
  }
  const child = spawn(process.execPath, [join(REPO, "playground/cli/entry-search/consumer.mjs")], {
    cwd: REPO,
    env: process.env,
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on("close", resolve));
  assert.equal(code, 0, `consumer exited ${code}: ${stderr}`);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.hit.status, "achieved");
  assert.equal(receipt.hit.satisfaction, 100);
  assert.equal(receipt.miss.resolution, "not_found");
  assert.equal(receipt.readOnly, undefined);
  assert.equal(receipt.noWriteOutsideSandbox, true);
});
