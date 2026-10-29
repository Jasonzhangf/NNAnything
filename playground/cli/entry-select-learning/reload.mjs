import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  predictEntrySelectRelation,
  resolveEntrySelectSet,
  validateEntrySelectProfile,
} from "../../../dist/filters/cli-entry-select-relation.js";
import {
  validateEntrySelectDataset,
} from "../../../dist/training/cli-entry-select-samples.js";

const args = process.argv.slice(2);

let directoryProfilePath;
let regularProfilePath;
let samplesPath;
let reportPath;

if (args.length === 2 && args[0] === "--output-root") {
  const outputRoot = resolve(args[1]);
  const latestMeta = JSON.parse(await readFile(join(outputRoot, "latest-report.json"), "utf8"));
  directoryProfilePath = latestMeta.directoryProfilePath;
  regularProfilePath = latestMeta.regularProfilePath;
  samplesPath = latestMeta.samplesPath;
  reportPath = latestMeta.reportPath;
} else if (args.length === 4) {
  [directoryProfilePath, regularProfilePath, samplesPath, reportPath] = args.map(p => resolve(p));
} else {
  throw new Error(
    "Expected --output-root PATH or <directoryProfilePath> <regularProfilePath> <samplesPath> <reportPath>",
  );
}

const reloadStarted = performance.now();
const directoryProfile = validateEntrySelectProfile(JSON.parse(await readFile(directoryProfilePath, "utf8")));
const regularProfile = validateEntrySelectProfile(JSON.parse(await readFile(regularProfilePath, "utf8")));
const dataset = JSON.parse(await readFile(samplesPath, "utf8"));
const report = JSON.parse(await readFile(reportPath, "utf8"));

assert.equal(directoryProfile.contract, "cli.directory-select-relation.v1");
assert.equal(directoryProfile.targetType, "directory");
assert.equal(regularProfile.contract, "cli.file-select-relation.v1");
assert.equal(regularProfile.targetType, "regular");
assert.deepEqual(report.profiles.directory, directoryProfile);
assert.deepEqual(report.profiles.regular, regularProfile);

validateEntrySelectDataset(dataset);

const profiles = {
  directory: directoryProfile,
  regular: regularProfile,
};

const setExecutionRows = [];
const candidateExecutionRows = [];
const probeExecutionRows = [];

function emptyPartitionCounter() {
  return {
    setsChecked: 0,
    setsCorrect: 0,
    selectedSetsChecked: 0,
    selectedSetsCorrect: 0,
    notFoundSetsChecked: 0,
    notFoundSetsCorrect: 0,
    candidatesChecked: 0,
    candidatesCorrect: 0,
    positiveCandidatesChecked: 0,
    positiveCandidatesCorrect: 0,
    negativeCandidatesChecked: 0,
    negativeCandidatesCorrect: 0,
    failures: [],
  };
}

const byPartition = {
  train: emptyPartitionCounter(),
  development: emptyPartitionCounter(),
  verification: emptyPartitionCounter(),
};

for (const setSample of dataset.sets) {
  const counter = byPartition[setSample.partition];
  const profile = profiles[setSample.targetType];

  for (const row of setSample.candidateRows) {
    const pred = predictEntrySelectRelation(row.selector, row.candidate, profile);
    const candidateCorrect = pred.status === "judged" && pred.relation === row.expectedRelation;
    counter.candidatesChecked += 1;
    if (row.expectedLabel === 1) counter.positiveCandidatesChecked += 1;
    else counter.negativeCandidatesChecked += 1;
    if (candidateCorrect) {
      counter.candidatesCorrect += 1;
      if (row.expectedLabel === 1) counter.positiveCandidatesCorrect += 1;
      else counter.negativeCandidatesCorrect += 1;
    }
    candidateExecutionRows.push({
      id: row.id,
      setId: row.setId,
      sourceGroup: row.sourceGroup,
      partition: row.partition,
      role: row.partition === "verification" ? "bounded_synthetic_held_out" : "known_replay",
      targetType: row.targetType,
      combinationId: row.combinationId,
      features: row.features,
      expectedLabel: row.expectedLabel,
      expectedRelation: row.expectedRelation,
      actualStatus: pred.status,
      actualRelation: pred.relation,
      logit: pred.logit,
      score: pred.score,
      correct: candidateCorrect,
    });
  }

  const res = resolveEntrySelectSet(setSample.selector, setSample.candidates, setSample.coverage, profile);
  const setCorrect = res.outcome === setSample.expectedOutcome
    && res.status === setSample.expectedStatus
    && res.satisfaction === setSample.expectedSatisfaction
    && res.reason === setSample.expectedReason
    && JSON.stringify(res.ref) === JSON.stringify(setSample.expectedRef);

  counter.setsChecked += 1;
  if (setSample.expectedOutcome === "selected") counter.selectedSetsChecked += 1;
  else counter.notFoundSetsChecked += 1;

  if (setCorrect) {
    counter.setsCorrect += 1;
    if (setSample.expectedOutcome === "selected") counter.selectedSetsCorrect += 1;
    else counter.notFoundSetsCorrect += 1;
  } else {
    counter.failures.push({
      id: setSample.id,
      targetType: setSample.targetType,
      expectedOutcome: setSample.expectedOutcome,
      actualOutcome: res.outcome,
      expectedStatus: setSample.expectedStatus,
      actualStatus: res.status,
      expectedSatisfaction: setSample.expectedSatisfaction,
      actualSatisfaction: res.satisfaction,
      expectedReason: setSample.expectedReason,
      actualReason: res.reason,
    });
  }

  setExecutionRows.push({
    id: setSample.id,
    sourceGroup: setSample.sourceGroup,
    partition: setSample.partition,
    role: setSample.partition === "verification" ? "bounded_synthetic_held_out" : "known_replay",
    targetType: setSample.targetType,
    expectedOutcome: setSample.expectedOutcome,
    actualOutcome: res.outcome,
    expectedStatus: setSample.expectedStatus,
    actualStatus: res.status,
    expectedSatisfaction: setSample.expectedSatisfaction,
    actualSatisfaction: res.satisfaction,
    expectedRef: setSample.expectedRef,
    actualRef: res.ref,
    expectedReason: setSample.expectedReason,
    actualReason: res.reason,
    correct: setCorrect,
  });
}

let probesChecked = 0;
let probesCorrect = 0;
const probeFailures = [];

for (const probe of dataset.probes) {
  const baseProfile = profiles[probe.targetType];
  const profile = probe.overrideProfileWeights
    ? { ...baseProfile, weights: [...probe.overrideProfileWeights] }
    : baseProfile;
  const res = resolveEntrySelectSet(probe.selector, probe.candidates, probe.coverage, profile);
  const correct = res.outcome === probe.expectedOutcome
    && res.status === probe.expectedStatus
    && res.satisfaction === probe.expectedSatisfaction
    && res.reason === probe.expectedReason
    && JSON.stringify(res.ref) === JSON.stringify(probe.expectedRef);
  probesChecked += 1;
  if (correct) {
    probesCorrect += 1;
  } else {
    probeFailures.push({
      id: probe.id,
      targetType: probe.targetType,
      expectedOutcome: probe.expectedOutcome,
      actualOutcome: res.outcome,
      expectedStatus: probe.expectedStatus,
      actualStatus: res.status,
      expectedSatisfaction: probe.expectedSatisfaction,
      actualSatisfaction: res.satisfaction,
      expectedReason: probe.expectedReason,
      actualReason: res.reason,
    });
  }
  probeExecutionRows.push({
    id: probe.id,
    targetType: probe.targetType,
    coverage: probe.coverage,
    expectedOutcome: probe.expectedOutcome,
    actualOutcome: res.outcome,
    expectedStatus: probe.expectedStatus,
    actualStatus: res.status,
    expectedSatisfaction: probe.expectedSatisfaction,
    actualSatisfaction: res.satisfaction,
    expectedRef: probe.expectedRef,
    actualRef: res.ref,
    expectedReason: probe.expectedReason,
    actualReason: res.reason,
    correct,
  });
}

const resultsDir = dirname(reportPath);
const reloadRowsPath = join(resultsDir, "reload-rows.json");
const reloadReceiptPath = join(resultsDir, "reload.json");

await writeFile(reloadRowsPath, JSON.stringify({
  contract: "cli.entry-select-reload.rows.v1",
  processId: process.pid,
  setExecutionRows,
  candidateExecutionRows,
  probeExecutionRows,
}, null, 2) + "\n", "utf8");

const totalSetsChecked = byPartition.train.setsChecked + byPartition.development.setsChecked + byPartition.verification.setsChecked;
const totalSetsCorrect = byPartition.train.setsCorrect + byPartition.development.setsCorrect + byPartition.verification.setsCorrect;
const totalCandidatesChecked = byPartition.train.candidatesChecked + byPartition.development.candidatesChecked + byPartition.verification.candidatesChecked;
const totalCandidatesCorrect = byPartition.train.candidatesCorrect + byPartition.development.candidatesCorrect + byPartition.verification.candidatesCorrect;
const totalFailed = (totalSetsChecked - totalSetsCorrect) + (totalCandidatesChecked - totalCandidatesCorrect) + (probesChecked - probesCorrect);

const reloadReceipt = {
  contract: "cli.entry-select-reload.receipt.v1",
  fitted: false,
  processId: process.pid,
  profileMatchesSavedFile: true,
  paths: {
    directoryProfilePath,
    regularProfilePath,
    samplesPath,
    reportPath,
    reloadRowsPath,
    reloadReceiptPath,
  },
  schema: {
    contracts: [directoryProfile.contract, regularProfile.contract],
    wires: [...directoryProfile.wires],
    parametersPerUnit: 4,
    totalParameters: 8,
    threshold: directoryProfile.threshold,
  },
  knownReplay: {
    role: "known_replay",
    train: byPartition.train,
    development: byPartition.development,
    combinedSetsChecked: byPartition.train.setsChecked + byPartition.development.setsChecked,
    combinedSetsCorrect: byPartition.train.setsCorrect + byPartition.development.setsCorrect,
    combinedCandidatesChecked: byPartition.train.candidatesChecked + byPartition.development.candidatesChecked,
    combinedCandidatesCorrect: byPartition.train.candidatesCorrect + byPartition.development.candidatesCorrect,
    passed: byPartition.train.setsCorrect === byPartition.train.setsChecked
      && byPartition.train.candidatesCorrect === byPartition.train.candidatesChecked
      && byPartition.development.setsCorrect === byPartition.development.setsChecked
      && byPartition.development.candidatesCorrect === byPartition.development.candidatesChecked,
  },
  independentVerification: {
    role: "bounded_synthetic_held_out",
    provenance: "synthetic_held_out_from_eight_boolean_templates",
    allEightFeatureVectorsSeenInTrain: true,
    unseenFeatureCapabilityVerified: false,
    fullyVerified: false,
    verification: byPartition.verification,
    passed: byPartition.verification.setsCorrect === byPartition.verification.setsChecked
      && byPartition.verification.candidatesCorrect === byPartition.verification.candidatesChecked,
  },
  probes: {
    role: "non_bce_set_probes",
    checked: probesChecked,
    correct: probesCorrect,
    failures: probeFailures,
    passed: probesCorrect === probesChecked,
  },
  totals: {
    setsChecked: totalSetsChecked,
    setsCorrect: totalSetsCorrect,
    candidatesChecked: totalCandidatesChecked,
    candidatesCorrect: totalCandidatesCorrect,
    probesChecked,
    probesCorrect,
    failed: totalFailed,
  },
  reloadMs: performance.now() - reloadStarted,
};

await writeFile(reloadReceiptPath, JSON.stringify(reloadReceipt, null, 2) + "\n", "utf8");
console.log(JSON.stringify(reloadReceipt, null, 2));
