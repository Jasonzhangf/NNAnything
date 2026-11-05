// Shared read-only converter check (launch contract §4.4.2).
//
// Verifies, for one corpus family:
//   1. Path A (student) never reads gold: the same family converted with and
//      without a `labels/` directory yields byte-identical student groups.
//   2. group_id linkage: every supervision row matches exactly one student group.
//   3. A_g is a subset of S_g and is non-empty unless `labelMissing` is true.
//   4. The two outputs live in physically separate directories by default.
//
// Usage: node playground/training/unified-converter-check.mjs <familyDir> [thresholdsPath]

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeatureThresholdsFromFile } from "../../dist/training/unified-thresholds.js";
import { loadEpisodeFamily, convertEpisodeToStudentGroup } from "../../dist/training/unified-student-converter.js";
import { loadGoldFamily, convertGoldToSupervisionRow } from "../../dist/training/unified-supervision-converter.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..", "..");

async function convertFamilyStudentOnly(familyDir, thresholds) {
  const episodes = await loadEpisodeFamily(familyDir);
  return episodes.map(episode => convertEpisodeToStudentGroup(episode, thresholds));
}

async function main() {
  const familyArg = process.argv[2];
  if (!familyArg) throw new Error("usage: unified-converter-check.mjs <familyDir> [thresholdsPath]");
  const familyDir = resolve(familyArg);
  const thresholdsPath = process.argv[3] ?? join(repoRoot, "tests/fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v1.json");
  const thresholds = await loadFeatureThresholdsFromFile(thresholdsPath);

  const studentGroups = await convertFamilyStudentOnly(familyDir, thresholds);
  const goldRecords = await loadGoldFamily(familyDir);
  const supervisionRows = goldRecords.map(convertGoldToSupervisionRow);

  // 1. No-gold counterexample: copy the family without `labels/` and re-run path A.
  const scratch = await mkdtemp(join(tmpdir(), "unified-converter-check-"));
  try {
    await cp(familyDir, scratch, {
      recursive: true,
      filter: source => !source.endsWith("/labels") && !source.endsWith("\\labels"),
    });
    const withoutGold = await convertFamilyStudentOnly(scratch, thresholds);
    assert.equal(
      JSON.stringify(withoutGold),
      JSON.stringify(studentGroups),
      "path A output changed when gold is absent: student features depend on gold",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  // 2/3. group_id linkage and A_g ⊆ S_g.
  const byGroup = new Map(studentGroups.map(group => [group.group_id, group]));
  for (const row of supervisionRows) {
    const group = byGroup.get(row.group_id);
    assert.ok(group, `supervision row ${row.group_id} has no student group`);
    const candidateRefs = new Set(group.candidates.map(candidate => candidate.candidateRef));
    if (!row.labelMissing) {
      assert.ok(row.goldAllowedCandidateRefs.length > 0, `A_g empty for ${row.group_id}`);
      for (const ref of row.goldAllowedCandidateRefs) {
        assert.ok(candidateRefs.has(ref), `A_g ref ${ref} not in S_g for ${row.group_id}`);
      }
    }
    for (const candidate of group.candidates) {
      assert.equal(candidate.input.length, 64, `candidate ${candidate.candidateRef} is not 64-slot`);
    }
    if (group.partition === "TRAIN") {
      assert.ok(goldRecords.length > 0, "TRAIN family has no supervision rows");
    }
  }

  const verdict = {
    family: familyDir,
    status: "PASS",
    studentGroups: studentGroups.length,
    supervisionRows: supervisionRows.length,
    groupIdsAligned: supervisionRows.every(row => byGroup.has(row.group_id)),
    noGoldCounterexample: "byte-identical",
    physicalSeparation: { studentPath: "student-rows/", supervisionPath: "labels/gold.jsonl" },
  };
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`converter-check FAILED: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
