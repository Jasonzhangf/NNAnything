// Black-box corpus verifier for the TS/JS import-alias corpus.
// It validates JSONL alignment, manifest sample counts, admission
// contracts, and the three known label corrections. It reads nothing
// outside training/samples/neural-cli/tsjs and writes nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const failures = [];

function familyDir(sourceGroup) {
  return sourceGroup.startsWith("tsjs-")
    ? `${sourceGroup.slice(5)}`
    : sourceGroup;
}

function fail(message) {
  failures.push(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function readJsonl(file) {
  return fs
    .readFileSync(path.join(root, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(message);
}

function sortedSampleIds(rows) {
  return rows
    .map((row) => row.sampleId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const families = readJson("source-derivation.json");
const admittedFamilyIds = new Set([
  "tsjs-train-module-export-alias-a",
  "tsjs-train-closure-call-a",
  "tsjs-dev-closure-shadow-b",
  "tsjs-verification-reexport-closure-c",
  "tsjs-verification-independent-callgraph-d",
]);
for (const admitted of families.verificationPartition.admittedIndependent) {
  if (!admittedFamilyIds.has(admitted)) {
    fail(`unknown admitted verification family: ${admitted}`);
  }
}

for (const familyId of admittedFamilyIds) {
  const dir = familyDir(familyId);
  const manifest = readJson(`${dir}/manifest.json`);
  const goldRows = readJsonl(`${dir}/labels/gold.jsonl`);
  const preRows = readJsonl(`${dir}/evidence/pre-state.jsonl`);
  const episodeRows = fs
    .readdirSync(path.join(root, dir))
    .filter((name) => /^episode-.*\.jsonl$/.test(name))
    .map((name) => readJsonl(`${dir}/${name}`)[0]);
  assertEqual(episodeRows.length, manifest.sampleCount, `${dir}: episode count`);
  assertEqual(goldRows.length, manifest.sampleCount, `${dir}: gold count`);
  assertEqual(preRows.length, manifest.sampleCount, `${dir}: pre-state count`);
  for (const [section, rows] of [
    ["episode", episodeRows],
    ["gold", goldRows],
    ["pre-state", preRows],
  ]) {
    const ids = rows.map((row) => row.sampleId);
    if (new Set(ids).size !== ids.length) {
      fail(`${dir}: ${section} contains duplicate sample ids`);
    }
  }
  assertEqual(
    sortedSampleIds(goldRows),
    sortedSampleIds(episodeRows),
    `${dir}: gold/episode sample ids`,
  );
  assertEqual(
    sortedSampleIds(preRows),
    sortedSampleIds(episodeRows),
    `${dir}: pre-state/episode sample ids`,
  );
  for (const [section, rows] of [
    ["episode", episodeRows],
    ["gold", goldRows],
    ["pre-state", preRows],
  ]) {
    for (const row of rows) {
      if (
        familyId !== "tsjs-verification-independent-callgraph-d" &&
        (!("admission" in row) || !("supersededBy" in row))
      ) {
        fail(`${dir}: ${section} ${row.sampleId} lacks admission/supersededBy`);
      }
    }
  }
}

const admissions = readJson("corpus-admissions-v1.json");
for (const family of admissions.familyAdmissions) {
  const expectedFitting = family.partition === "train";
  if (family.usableForTrainingSupervision !== expectedFitting) {
    fail(
      `${family.sourceGroup}: partition ${family.partition} must set usableForTrainingSupervision=${expectedFitting}`,
    );
  }
}
const admissionSampleIds = new Set(admissions.sampleCorrections.map((row) => row.sampleId));
for (const sampleId of [
  "b-closure-unknown-dynamic-property",
  "c-dev-unknown-dynamic-property",
  "d-verification-unknown-dynamic",
]) {
  if (!admissionSampleIds.has(sampleId)) {
    fail(`missing sample correction: ${sampleId}`);
  }
}

function assertCorrection(familyDir, sampleId, label, targetRef) {
  const gold = readJsonl(`${familyDir}/labels/gold.jsonl`).find(
    (row) => row.sampleId === sampleId,
  );
  if (!gold) {
    fail(`missing corrected gold: ${sampleId}`);
    return;
  }
  if (gold.label !== label) fail(`${sampleId}: corrected gold label`);
  if (gold.correctedTargetRef !== targetRef) fail(`${sampleId}: corrected target ref`);
  if (!gold.originalLabel || !gold.originalUnknownReason || !gold.originalLabelAuthority) {
    fail(`${sampleId}: corrected gold lacks historical fields`);
  }
  if (!gold.admission || !gold.supersededBy) fail(`${sampleId}: corrected gold lacks admission`);
}

assertCorrection(
  "train-closure-call-a",
  "b-closure-unknown-dynamic-property",
  "true",
  "sources/src/closure.ts#top:base",
);
assertCorrection(
  "dev-closure-shadow-b",
  "c-dev-unknown-dynamic-property",
  "true",
  "sources/src/factory.ts#top:createStepper",
);
assertCorrection(
  "verification-reexport-closure-c",
  "d-verification-unknown-dynamic",
  "true",
  "sources/src/local-shadow.ts#top:makeLocal",
);

const independent = readJsonl(
  "verification-independent-callgraph-d/labels/gold.jsonl",
);
const unknownRows = independent.filter((row) => row.label === "unknown");
if (unknownRows.length !== 1) fail("independent verification must have exactly one runtime unknown");
if (unknownRows[0]?.unknownReason !== "runtime_dynamic_selector") {
  fail("independent verification runtime unknown reason");
}

const readiness = readJson("corpus-readiness-v1.json");
if (readiness.status !== "review_ready" || readiness.trainingReadiness !== "not_ready") {
  fail("corpus readiness must stay review_ready and training not_ready");
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.exit(1);
}
process.stdout.write("TS/JS import-alias corpus black-box checks: PASS\n");
