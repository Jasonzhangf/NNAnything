// Profile shape changes are a caller/callee contract. Runtime validation stays strict, while every
// affected offline consumer must name the unified migration explicitly before it uses the profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const REPO = new URL("..", import.meta.url).pathname;
const PROFILE = process.env.NN_CLI_COMMAND_PROFILE;
const ENTRY_SEARCH_CONSUMER = join(REPO, "playground/cli/entry-search/consumer.mjs");

const AFFECTED_CONSUMERS = Object.freeze([
  "playground/cli/autonomous/consumer.mjs",
  "playground/cli/autonomous/controller-budget.mjs",
  "playground/cli/autonomous/independent-family.mjs",
  "playground/cli/content-search/collect-p3.mjs",
  "playground/cli/content-search/consumer.mjs",
  "playground/cli/content-search/evaluate-p3.mjs",
  "playground/cli/content-search/fit-p3.mjs",
  "playground/cli/content-search/independent-family.mjs",
  "playground/cli/content-search/reload-p3.mjs",
  "playground/cli/content-search/train-p3.mjs",
  "playground/cli/entry-search/consumer-authority.mjs",
  "playground/cli/entry-search/consumer.mjs",
  "playground/cli/entry-search/family-a.mjs",
  "playground/cli/entry-search/family-b.mjs",
  "playground/cli/read-composition/consumer.mjs",
  "playground/cli/read-composition/independent-family.mjs",
  "playground/cli/read-composition/multi-source-independent-family.mjs",
  "playground/cli/read-composition/multi-source.mjs",
  "playground/l2-t2-cli/evidence.mjs",
  "playground/recursive-goal/cwd.mjs",
  "playground/recursive-goal/optional-budget-consumer.mjs",
]);

function setWeight(profile, head, wire, value) {
  const row = profile.heads.indexOf(head);
  const column = profile.wires.indexOf(wire);
  assert.notEqual(row, -1, `missing head ${head}`);
  assert.notEqual(column, -1, `missing wire ${wire}`);
  profile.weights[row][column] = value;
}

function fixtureProfile(current) {
  const profile = {
    ...current,
    weights: current.weights.map(row => [...row]),
  };
  setWeight(profile, "ls", "property.directory.entries", 8);
  setWeight(profile, "entry.inspect", "property.type", 8);
  setWeight(profile, "entry.inspect", "search.nameNeedleSegment", 2);
  return profile;
}

function legacyShape(current, columns) {
  const removedWires = new Set([
    "property.path.physical",
    "predicate.observe.physical",
    "predicate.observe.resolvedTarget",
    ...(columns === 30 ? ["search.nameNeedleSegment"] : []),
  ]);
  const heads = current.heads.filter(head => head !== "path.realpath");
  const properties = current.properties.filter(property => property !== "property.path.physical");
  const predicates = current.predicates.filter(predicate =>
    predicate !== "predicate.observe.physical" && predicate !== "predicate.observe.resolvedTarget");
  const wires = current.wires.filter(wire => !removedWires.has(wire));
  assert.equal(heads.length, 10);
  assert.equal(wires.length, columns);
  return {
    contract: current.contract,
    heads,
    properties,
    predicates,
    wires,
    weights: heads.map(head => wires.map(wire =>
      current.weights[current.heads.indexOf(head)][current.wires.indexOf(wire)])),
    calibration: current.calibration,
    adoption: current.adoption,
  };
}

async function runEntrySearchConsumer(profilePath) {
  const child = spawn(process.execPath, [ENTRY_SEARCH_CONSUMER], {
    cwd: REPO,
    env: { ...process.env, NN_CLI_COMMAND_PROFILE: profilePath },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on("close", resolve));
  return { code, stdout, stderr };
}

function hasLegacyShapeBranch(source) {
  return source.includes("migrateCliCommandProfileV10x30")
    || source.includes("migrateCliCommandProfileStage0ToStage1")
    || source.includes("current-10x31")
    || /wires\?\.length\s*===\s*(?:30|31)\b/.test(source)
    || /wires\.length\s*!==\s*(?:30|31)\b/.test(source)
    || /weights\.length\s*(?:===|!==)\s*10\b/.test(source)
    || /row\.length\s*!==\s*31\b/.test(source);
}

test("every affected public consumer uses the unified current-profile migration", async () => {
  for (const relative of AFFECTED_CONSUMERS) {
    const source = await readFile(join(REPO, relative), "utf8");
    assert.match(source, /migrateCliCommandProfileToCurrent/, `${relative} must use the unified migration`);
    assert.equal(hasLegacyShapeBranch(source), false, `${relative} still has a mutually exclusive legacy shape branch`);
  }
});

test("the source guard still flags a profile consumer with a legacy-only branch", () => {
  const legacy = [
    "const profilePath = process.env.NN_CLI_COMMAND_PROFILE;",
    "const rawProfile = JSON.parse(await readFile(profilePath, \"utf8\"));",
    "const profile = rawProfile.wires?.length === 30 ? migrateCliCommandProfileV10x30(rawProfile) : rawProfile;",
  ].join("\n");
  assert.equal(hasLegacyShapeBranch(legacy), true);
});

test("entry-search accepts public 10x30 and 10x31 migration inputs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nn-cli-profile-shapes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const api = await import("../dist/cli-goal.js");
  const current = fixtureProfile(api.zeroCliCommandProfile());

  for (const columns of [30, 31]) {
    const profilePath = join(directory, `profile-10x${columns}.json`);
    await writeFile(profilePath, `${JSON.stringify(legacyShape(current, columns), null, 2)}\n`);
    const child = await runEntrySearchConsumer(profilePath);
    assert.equal(child.code, 0, `10x${columns} consumer exited ${child.code}: ${child.stderr}`);
    const receipt = JSON.parse(child.stdout);
    assert.equal(receipt.hit.status, "achieved");
    assert.equal(receipt.hit.satisfaction, 100);
    assert.equal(receipt.miss.resolution, "not_found");
    assert.equal(receipt.noWriteOutsideSandbox, true);
  }
});

test("an explicitly supplied saved profile reloads through entry-search", async t => {
  if (typeof PROFILE !== "string" || PROFILE.length === 0) {
    t.skip("NN_CLI_COMMAND_PROFILE is required");
    return;
  }
  const api = await import("../dist/cli-goal.js");
  const profile = api.migrateCliCommandProfileToCurrent(JSON.parse(await readFile(PROFILE, "utf8")));
  assert.equal(profile.heads.length, 11);
  assert.equal(profile.wires.length, 34);
  assert.equal(profile.weights.length, 11);
  assert.equal(profile.weights.every(row => row.length === 34), true);
  assert.equal(profile.calibration, "uncalibrated");
  assert.equal(profile.adoption, "not_applied");
  const child = await runEntrySearchConsumer(PROFILE);
  assert.equal(child.code, 0, `saved profile consumer exited ${child.code}: ${child.stderr}`);
  const receipt = JSON.parse(child.stdout);
  assert.equal(receipt.hit.status, "achieved");
  assert.equal(receipt.miss.resolution, "not_found");
});
