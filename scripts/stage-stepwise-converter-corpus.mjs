#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  STEPWISE_STUDENT_OBSERVATIONS_FILE,
} from "../dist/training/unified-student-converter.js";
import {
  STEPWISE_SUPERVISION_FILE,
} from "../dist/training/unified-supervision-converter.js";
import {
  resolveEntryFileFromSourceEpisode,
} from "../dist/training/stepwise-entry-file-mapping.js";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`missing --${name}`);
  }
  return resolve(value);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .split("\n")
    .flatMap((line, index) => {
      if (line.trim().length === 0) return [];
      try {
        return [{ value: JSON.parse(line), line: index + 1 }];
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        throw new TypeError(`${path} line ${index + 1} is invalid JSON: ${message}`);
      }
    });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path, rows) {
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

const studentPath = argument("student");
const supervisionPath = argument("supervision");
const sourceCorpusRoot = argument("source-corpus-root");
const outputRoot = argument("out");

const studentRows = await readJsonl(studentPath);
const supervisionRows = await readJsonl(supervisionPath);

// P1-1: keyed bilateral join. Every student and every supervision row must
// agree on family, sourceGroup when supplied, requestRef, sampleId and each
// stepId. Missing, extra, duplicate or conflicting records are rejected so the
// ready-slice cannot silently drop an unmatched student or skip source
// identity checks. S_g/A_g/eligibility/label fields stay copied verbatim.
function sampleKey(row) {
  const family = row.family;
  const sampleId = row.sampleId;
  if (typeof family !== "string" || family.length === 0) {
    throw new Error(`row ${row.sampleId} has no family`);
  }
  if (typeof sampleId !== "string" || sampleId.length === 0) {
    throw new Error(`row for family ${family} has no sampleId`);
  }
  return `${family}\u0000${sampleId}`;
}

function stepKeys(row, label) {
  if (!Array.isArray(row.steps) || row.steps.length === 0) {
    throw new Error(`${label} ${row.sampleId} has no steps`);
  }
  const seen = new Set();
  for (const step of row.steps) {
    const stepId = step.stepId;
    if (typeof stepId !== "string" || stepId.length === 0) {
      throw new Error(`${label} ${row.sampleId} has a step without stepId`);
    }
    if (seen.has(stepId)) {
      throw new Error(`duplicate step ${label} ${row.sampleId}/${stepId}`);
    }
    seen.add(stepId);
  }
  return [...seen];
}

function stringField(row, field, label) {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} ${row.sampleId} has no ${field}`);
  }
  return value;
}

const families = new Map();
const supervisionByKey = new Map();
for (const row of supervisionRows) {
  const entry = row.value;
  const family = stringField(entry, "family", "supervision");
  const sampleId = stringField(entry, "sampleId", "supervision");
  const key = `${family}\u0000${sampleId}`;
  if (supervisionByKey.has(key)) {
    throw new Error(`duplicate supervision row for family ${family} sample ${sampleId}`);
  }
  supervisionByKey.set(key, row);
  const members = families.get(family) ?? [];
  members.push(row);
  families.set(family, members);
}

const studentsByFamilyAndSample = new Map();
const studentKeys = new Set();
for (const row of studentRows) {
  const entry = row.value;
  const family = stringField(entry, "family", "student");
  const sampleId = stringField(entry, "sampleId", "student");
  const key = `${family}\u0000${sampleId}`;
  if (studentsByFamilyAndSample.has(key)) {
    throw new Error(`duplicate student row for family ${family} sample ${sampleId}`);
  }
  studentsByFamilyAndSample.set(key, row);
  studentKeys.add(key);
}

for (const [family, members] of families) {
  for (const entry of members) {
    const value = entry.value;
    const key = sampleKey(value);
    const student = studentsByFamilyAndSample.get(key);
    if (student === undefined) {
      throw new Error(`missing student row for family ${family} sample ${value.sampleId}`);
    }
    const studentValue = student.value;
    const label = `${family}/${value.sampleId}`;

    const studentRequestRef = studentValue.request?.requestRef;
    const supervisionRequestRef = value.requestRef;
    if (
      typeof studentRequestRef !== "string" ||
      typeof supervisionRequestRef !== "string" ||
      studentRequestRef !== supervisionRequestRef
    ) {
      throw new Error(
        `requestRef mismatch for ${label}: student=${String(studentRequestRef)} supervision=${String(supervisionRequestRef)}`,
      );
    }

    const studentSourceGroup =
      studentValue.sourceGroup === undefined ? undefined : studentValue.sourceGroup;
    const supervisionSourceGroup = value.sourceGroup;
    if (
      supervisionSourceGroup !== undefined &&
      studentSourceGroup !== supervisionSourceGroup
    ) {
      throw new Error(
        `sourceGroup mismatch for ${label}: student=${String(studentSourceGroup)} supervision=${String(supervisionSourceGroup)}`,
      );
    }

    const studentSteps = stepKeys(studentValue, `student ${label}`);
    const supervisionSteps = stepKeys(value, `supervision ${label}`);
    const studentStepSet = new Set(studentSteps);
    for (const stepId of supervisionSteps) {
      if (!studentStepSet.has(stepId)) {
        throw new Error(`missing supervision step ${label}/${stepId}`);
      }
    }
    if (studentSteps.length !== supervisionSteps.length) {
      throw new Error(
        `step mismatch for ${label}: student=${studentSteps.join(",")} supervision=${supervisionSteps.join(",")}`,
      );
    }
  }
}

const unmatchedStudents = [...studentKeys].filter(key => !supervisionByKey.has(key));
if (unmatchedStudents.length > 0) {
  const rendered = unmatchedStudents.map(key => key.replace("\u0000", "/")).join(", ");
  throw new Error(`student row without supervision: ${rendered}`);
}

await mkdir(outputRoot, { recursive: true });
const copiedAdmissions = await readJson(join(sourceCorpusRoot, "corpus-admissions-v1.json"));
await writeJson(join(outputRoot, "corpus-admissions-v1.json"), copiedAdmissions);

const reconciliation = [];
const familyReceipts = [];
let stagedSamples = 0;
let stagedSteps = 0;
let excludedSamples = 0;
for (const [family, entries] of [...families.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const sourceFamilyDir = join(sourceCorpusRoot, family);
  const manifest = await readJson(join(sourceFamilyDir, "manifest.json"));
  const sourceGroup = manifest.sourceGroup;
  if (typeof sourceGroup !== "string" || sourceGroup.length === 0) {
    throw new Error(`family ${family} manifest has no sourceGroup`);
  }
  const eligibleEntries = entries.filter(entry => entry.value.trainingEligible === true);
  const eligibleIds = new Set(eligibleEntries.map(entry => entry.value.sampleId));
  const eligibleStudents = eligibleEntries
    .map(entry => studentsByFamilyAndSample.get(`${family}\u0000${entry.value.sampleId}`))
    .filter(entry => entry !== undefined);
  const outputFamilyDir = join(outputRoot, family);
  await mkdir(outputFamilyDir, { recursive: true });
  await writeJson(join(outputFamilyDir, "manifest.json"), manifest);
  const stagedStudents = [];
  const entryFileSources = [];
  for (const studentEntry of eligibleStudents) {
    const sampleId = studentEntry.value.sampleId;
    const mapping = await resolveEntryFileFromSourceEpisode(
      sourceFamilyDir,
      sourceGroup,
      sampleId,
      studentEntry.value.entryFile,
    );
    stagedStudents.push({ ...studentEntry.value, entryFile: mapping.entryFile });
    entryFileSources.push({
      sampleId,
      entryFile: mapping.entryFile,
      sourcePath: mapping.sourcePath,
    });
  }
  await writeJsonl(
    join(outputFamilyDir, STEPWISE_STUDENT_OBSERVATIONS_FILE),
    stagedStudents,
  );
  await writeJsonl(
    join(outputFamilyDir, STEPWISE_SUPERVISION_FILE),
    eligibleEntries.map(entry => entry.value),
  );

  const familyStepCount = entries.reduce((total, entry) => total + entry.value.steps.length, 0);
  const familyStagedSteps = eligibleEntries.reduce((total, entry) => total + entry.value.steps.length, 0);
  stagedSamples += eligibleEntries.length;
  stagedSteps += familyStagedSteps;
  excludedSamples += entries.length - eligibleEntries.length;
  familyReceipts.push({
    family,
    sourceGroup,
    sourceSamples: entries.length,
    sourceSteps: familyStepCount,
    stagedSamples: eligibleEntries.length,
    stagedSteps: familyStagedSteps,
    excludedSamples: entries.length - eligibleEntries.length,
    entryFileSources,
  });

  const studentById = new Map(eligibleStudents.map(entry => [entry.value.sampleId, entry]));
  for (const entry of entries) {
    const sample = entry.value;
    const student = studentById.get(sample.sampleId);
    const staged = sample.trainingEligible === true;
    for (const step of sample.steps) {
      reconciliation.push({
        sourceGroup,
        family,
        sampleId: sample.sampleId,
        stepId: step.stepId,
        status: staged ? "STAGED" : "EXCLUDED",
        admissionReason: staged
          ? "trainingEligible=true"
          : sample.notReadyReason ?? "trainingEligible=false",
        outputGroupId: null,
        sourceStudentLine: staged ? student?.line ?? null : null,
        sourceSupervisionLine: entry.line,
        sourceStepContextRef: `ctx:${sample.sampleId}:${step.stepId}`,
        sourceCandidateGroupRef: `cg:${sample.sampleId}:${step.stepId}:0`,
        sGCandidateCount: step.S_g.length,
        aGCandidateCount: step.A_g.length,
        evidencePath: supervisionPath,
      });
    }
  }
}

await writeJsonl(join(outputRoot, "admission-decisions.jsonl"), reconciliation);
await writeJson(join(outputRoot, "staging-receipt.json"), {
  schema: "nnanything.stepwise-converter-staging-receipt.v1",
  generatedAt: new Date().toISOString(),
  inputs: {
    studentObservations: studentPath,
    independentSupervision: supervisionPath,
    sourceCorpusRoot,
  },
  outputRoot,
  counts: {
    sourceSamples: supervisionRows.length,
    sourceSteps: reconciliation.length,
    stagedSamples,
    stagedSteps,
    excludedSamples,
    excludedSteps: reconciliation.length - stagedSteps,
  },
  families: familyReceipts,
  sourceFamilies: [...families.keys()].map(name => basename(name)).sort(),
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  outputRoot,
  stagedSamples,
  stagedSteps,
  excludedSamples,
  excludedSteps: reconciliation.length - stagedSteps,
})}\n`);
