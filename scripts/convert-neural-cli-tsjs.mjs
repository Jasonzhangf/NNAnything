// Real TS/JS corpus conversion entry (launch contract §4.4.2).
//
// Converts each admitted TRAIN family into two physically separated outputs:
//   <family>/student-rows/student-rows.jsonl   (path A: S_g + x[64], no gold)
//   <family>/labels/supervision.jsonl          (path B: group_id -> A_g, no x)
//
// Usage: node scripts/convert-neural-cli-tsjs.mjs [--dry-run]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeatureThresholdsFromFile } from "../dist/training/unified-thresholds.js";
import {
  loadEpisodeFamily,
  convertEpisodeToStudentGroup,
} from "../dist/training/unified-student-converter.js";
import {
  loadGoldFamily,
  convertGoldToSupervisionRow,
} from "../dist/training/unified-supervision-converter.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const corpusRoot = join(repoRoot, "training/samples/neural-cli/tsjs");
const thresholdsPath = join(
  repoRoot,
  "tests/fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json",
);

function studentRow(group, candidate) {
  return {
    schema: "nnanything.unified.student-row.v1",
    group_id: group.group_id,
    sampleId: group.sampleId,
    requestRef: group.requestRef,
    sourceGroup: group.sourceGroup,
    language: group.language,
    adapterRef: group.adapterRef,
    derivationFamily: group.derivationFamily,
    semanticStratum: group.semanticStratum,
    stepContextRef: group.stepContextRef,
    candidateGroupRef: group.candidateGroupRef,
    featureSchemaVersion: group.featureSchemaVersion,
    encoderVersion: group.encoderVersion,
    partition: group.partition,
    candidateEnumeration: group.candidateEnumeration,
    coverageCursorRef: group.coverageCursorRef,
    evidenceRefs: group.evidenceRefs,
    failureMode: group.failureMode,
    candidateRef: candidate.candidateRef,
    optionSemantics: candidate.optionSemantics,
    candidateKind: candidate.candidateKind,
    x: candidate.input,
  };
}

async function resolveFamilyDir(corpusRoot, sourceGroup) {
  const base = join(corpusRoot, sourceGroup);
  const strippedBase = join(corpusRoot, sourceGroup.replace(/^tsjs-/, ""));
  try {
    await readFile(join(base, "manifest.json"), "utf8");
    return base;
  } catch {
    await readFile(join(strippedBase, "manifest.json"), "utf8");
    return strippedBase;
  }
}

async function main() {
  const admissions = JSON.parse(await readFile(join(corpusRoot, "corpus-admissions-v1.json"), "utf8"));
  const thresholds = await loadFeatureThresholdsFromFile(thresholdsPath);
  const families = admissions.familyAdmissions
    .filter(entry => entry.partition === "train" && entry.usableForTrainingSupervision === true)
    .map(entry => entry.sourceGroup);
  if (families.length === 0) throw new Error("no admitted TRAIN families");

  const summary = { schema: "nnanything.unified.conversion-report.v1", status: "READY", families: [] };
  for (const sourceGroup of families) {
    const familyDir = await resolveFamilyDir(corpusRoot, sourceGroup);
    const episodes = await loadEpisodeFamily(familyDir);
    const studentGroups = episodes.map(episode => convertEpisodeToStudentGroup(episode, thresholds));
    const goldRecords = await loadGoldFamily(familyDir);
    const supervisionRows = goldRecords.map(convertGoldToSupervisionRow);

    const byGroup = new Map(studentGroups.map(group => [group.group_id, group]));
    for (const row of supervisionRows) {
      const group = byGroup.get(row.group_id);
      if (!group) throw new Error(`supervision group ${row.group_id} has no student group`);
      const refs = new Set(group.candidates.map(candidate => candidate.candidateRef));
      if (!row.labelMissing) {
        if (row.goldAllowedCandidateRefs.length === 0) throw new Error(`empty A_g for ${row.group_id}`);
        for (const ref of row.goldAllowedCandidateRefs) {
          if (!refs.has(ref)) throw new Error(`A_g ref ${ref} outside S_g for ${row.group_id}`);
        }
      }
    }

    const studentRows = studentGroups.flatMap(group =>
      group.candidates.map(candidate => studentRow(group, candidate)),
    );
    const studentPath = join(familyDir, "student-rows", "student-rows.jsonl");
    const supervisionPath = join(familyDir, "labels", "supervision.jsonl");
    if (!dryRun) {
      await mkdir(dirname(studentPath), { recursive: true });
      await writeFile(studentPath, `${studentRows.map(row => JSON.stringify(row)).join("\n")}\n`);
      await writeFile(supervisionPath, `${supervisionRows.map(row => JSON.stringify(row)).join("\n")}\n`);
    }
    summary.families.push({
      sourceGroup,
      episodes: episodes.length,
      studentGroups: studentGroups.length,
      studentRows: studentRows.length,
      supervisionRows: supervisionRows.length,
      studentPath: dryRun ? null : studentPath,
      supervisionPath: dryRun ? null : supervisionPath,
    });
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`convert-neural-cli-tsjs FAILED: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
