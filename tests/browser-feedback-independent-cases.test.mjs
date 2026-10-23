import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { feedbackFeatures, auditFeedbackProjections } from "nnanything/browser-feedback";
import { INDEPENDENT_CASES, FAMILY_IDS } from "../playground/browser/feedback/independent/cases.mjs";
import { deriveFeedbackGold } from "../playground/browser/feedback/independent/materialize.mjs";
import { projectionKind } from "../playground/browser/feedback/independent/projections.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = "/Volumes/Intel/playground/nnanything-runs/browser-longhorizon-20261022";
const familyFiles = {
  "inspect-table": "playground/browser/feedback/independent/family-inspect-table.mjs",
  "sheet-audit": "playground/browser/feedback/independent/family-sheet-audit.mjs",
};

test("independent set has exactly 24 cases across two 12-case families", () => {
  assert.equal(INDEPENDENT_CASES.length, 24);
  assert.deepEqual(FAMILY_IDS, ["inspect-table", "sheet-audit"]);
  for (const familyId of FAMILY_IDS) {
    assert.equal(INDEPENDENT_CASES.filter(c => c.family === familyId).length, 12);
  }
  assert.equal(INDEPENDENT_CASES.every(c => c.partition === "verification"), true);
});

test("case ids are unique and every family is a distinct source", () => {
  const ids = new Set(INDEPENDENT_CASES.map(c => c.id));
  assert.equal(ids.size, 24);
  const byFamily = Object.fromEntries(FAMILY_IDS.map(id => [id, INDEPENDENT_CASES.find(c => c.family === id)]));
  assert.notEqual(byFamily["inspect-table"].input.request.state.documentRef, byFamily["sheet-audit"].input.request.state.documentRef);
  assert.notEqual(byFamily["inspect-table"].input.request.state.evidence[0].source, byFamily["sheet-audit"].input.request.state.evidence[0].source);
});

test("the two family modules do not import each other or old material", async () => {
  for (const [familyId, relativePath] of Object.entries(familyFiles)) {
    const source = await readFile(resolve(repoRoot, relativePath), "utf8");
    const importSpecifiers = [
      ...source.matchAll(/\b(?:from\s*|import\s*\()\s*["']([^"']+)["']/g),
    ].map(match => match[1]);
    for (const other of FAMILY_IDS) {
      if (other === familyId) continue;
      assert.equal(
        importSpecifiers.some(specifier => specifier.includes(other)),
        false,
        `${familyId} imports ${other}`,
      );
    }
    assert.equal(
      importSpecifiers.some(specifier => specifier.includes("f1-robustness")),
      false,
      `${familyId} imports old holdout material`,
    );
  }
});

test("gold is derived from the public projection and matches the projection class", () => {
  for (const c of INDEPENDENT_CASES) {
    const features = feedbackFeatures(c.input);
    assert.equal(features.length, 12, `${c.id} projection width`);
    assert.deepEqual(features, c.features, `${c.id} projection stability`);
    assert.equal(deriveFeedbackGold(c.input), c.gold, `${c.id} gold derivation`);
    assert.equal(projectionKind(features), c.projectionKind, `${c.id} projection class`);
    assert.equal(c.sourceType, c.projectionKind === "old-projection"
      ? "new-source-old-projection"
      : "new-source-new-projection", `${c.id} source type`);
  }
});

test("feedback projections contain zero conflicting golds", () => {
  const headEpisodes = INDEPENDENT_CASES.filter(c => c.teacher !== null).map(c => ({
    id: c.id,
    family: c.family,
    partition: c.partition,
    input: c.input,
    teacher: c.teacher,
  }));
  const audit = auditFeedbackProjections(headEpisodes);
  assert.equal(audit.count, headEpisodes.length);
  assert.ok(audit.projectionCount > 0);
  const fullGroups = new Map();
  for (const c of INDEPENDENT_CASES) {
    const key = JSON.stringify(c.features);
    const gold = c.gold;
    const group = fullGroups.get(key);
    if (group === undefined) fullGroups.set(key, { gold, ids: [c.id] });
    else {
      assert.equal(group.gold, gold, `${key} has conflicting gold`);
      group.ids.push(c.id);
    }
  }
});

test("the evaluation script re-runs offline with stable results", async (t) => {
  const candidates = [
    `${runRoot}/b-feedback/training/f1/candidate.json`,
    "/Volumes/Intel/playground/nnanything-runs/browser-semantic-single-action-20261020/progressive-strategy/fitted-r1/candidate.json",
    "/Volumes/Intel/playground/nnanything-runs/browser-semantic-single-action-20261020/fitted/candidate.json",
  ];
  const missing = [];
  for (const path of candidates) {
    try {
      await stat(path);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length > 0) {
    t.skip(`fixed candidates are not present in this checkout: ${missing.join(",")}`);
    return;
  }
  const script = resolve(repoRoot, "playground/browser/feedback/independent/evaluate.mjs");
  const runOnce = () => JSON.parse(execFileSync(process.execPath, [script, "--check"], {
    cwd: repoRoot,
    encoding: "utf8",
  }));
  const first = runOnce();
  const second = runOnce();
  assert.equal(first.count, 24);
  assert.equal(second.count, 24);
  assert.deepEqual(first.summary, second.summary, "offline evaluation must be deterministic");
});

test("materialized cases are written before the first-evaluation results", async (t) => {
  const casesPath = `${runRoot}/b-feedback/verification/independent/cases.json`;
  const rowsPath = `${runRoot}/b-feedback/verification/independent/rows.jsonl`;
  let casesStat;
  let rowsStat;
  try {
    [casesStat, rowsStat] = await Promise.all([stat(casesPath), stat(rowsPath)]);
  } catch {
    t.skip("first-evaluation artifacts are not present in this checkout");
    return;
  }
  assert.ok(casesStat.mtimeMs <= rowsStat.mtimeMs, "cases.json must not be newer than rows.jsonl");
});
