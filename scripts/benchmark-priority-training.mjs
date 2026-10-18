#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeFixturePath = resolve(repositoryRoot, "playground/training/priority-native.fixture.json");
const VALUE_FLAGS = new Set([
  "--input",
  "--reference-weight",
  "--gold-reference",
  "--dataset-notes",
  "--lineage",
  "--handwired-root",
  "--out-dir",
  "--weights-dir",
  "--fixture",
]);
const REQUIRED_FLAGS = [
  "--input",
  "--reference-weight",
  "--gold-reference",
  "--dataset-notes",
  "--handwired-root",
  "--out-dir",
  "--weights-dir",
];
const TIMING_FIELDS = [
  "backendLoadMs",
  "circuitBuildMs",
  "baselineEvalMs",
  "trainEpochGradMs",
  "postEpochEvalMs",
  "finalEvalMs",
  "fitTotalMs",
];
const FORMAL_EPOCHS = 500;
const MATRIX_EPOCHS = 100;
const FORMAL_CONFIG = Object.freeze({
  minScore: 0.6,
  minMargin: 0.15,
  objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
  fit: { epochs: FORMAL_EPOCHS, learningRate: 0.02, anchorLambda: 0.001 },
});
const HELP = `Priority training benchmark

Usage:
  node scripts/benchmark-priority-training.mjs \\
    --input <prepared-training-request.json> \\
    --reference-weight <legacy-reference.json> \\
    --gold-reference <legacy-reference.json> \\
    --dataset-notes <dataset-notes.json> \\
    --handwired-root <source-root> \\
    --out-dir <report-dir> \\
    --weights-dir <weight-dir> \\
    [--fixture <reviewed.fixture.json>] [--lineage <lineage.json>]

Required:
  --input             Prepared BasicKindTrainingRequest (schemaVersion 1).
  --reference-weight  Preserved adopted profile or reference bundle.
  --gold-reference    Legacy reference bundle with gold and diagnostic groups.
  --dataset-notes     Data-curation notes with actual source and augmentation counts.
  --handwired-root    Explicit Handwired source root. Missing roots fail; no fallback.
  --out-dir           Report output directory.
  --weights-dir       Separate directory for uncalibrated weight assets.

Optional:
  --fixture           Additional public synthetic reviewed fixture.
  --lineage           Optional lineage JSON copied into the report.
  -h, --help          Show this usage without importing public package exports.

The script uses only nnanything/training and nnanything/browser-classify public
exports. It never applies a candidate, builds the project, or runs browser work.
`;

class CliError extends Error {}

function parseArgs(argv) {
  const flags = new Map();
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--help" || key === "-h") return { help: true, flags };
    if (!VALUE_FLAGS.has(key)) throw new CliError(`Unknown option: ${key}`);
    if (flags.has(key)) throw new CliError(`Duplicate option: ${key}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new CliError(`Missing value for ${key}`);
    flags.set(key, value);
  }
  for (const key of REQUIRED_FLAGS) {
    if (!flags.has(key)) throw new CliError(`Missing required option: ${key}`);
  }
  return { help: false, flags };
}

function requireCondition(condition, message) {
  if (!condition) throw new TypeError(message);
}

function errorDetails(error) {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
  };
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label}: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJson(path, value, exclusive = true) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(exclusive ? { flag: "wx" } : {}),
  });
}

function runId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `priority-benchmark-${stamp}-${process.pid}`;
}

async function loadPublicModules() {
  let training;
  let browser;
  try {
    [training, browser] = await Promise.all([
      import("nnanything/training"),
      import("nnanything/browser-classify"),
    ]);
  } catch (error) {
    throw new Error(
      `Public package modules are unavailable. Build the package first. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const requiredTraining = [
    "readBasicKindTrainingRequest",
    "prepareBasicKindSamples",
    "toBasicKindFitRows",
    "fitBasicKinds",
    "validateBasicKindTrainingConfig",
  ];
  const requiredBrowser = [
    "DEFAULT_BASIC_KIND_PROFILE",
    "PRIORITY_BASIC_KIND_INITIAL_PROFILE",
    "BASIC_KIND_FAMILIES",
    "classifyBasicKind",
    "validateBasicKindConfig",
    "validateBasicKindProfile",
    "validateBasicKindProperties",
    "parseBrowserWeightAsset",
  ];
  for (const name of requiredTraining) {
    requireCondition(typeof training[name] === "function", `nnanything/training is missing public export ${name}`);
  }
  for (const name of requiredBrowser) {
    requireCondition(browser[name] !== undefined, `nnanything/browser-classify is missing public export ${name}`);
  }
  return { training, browser };
}

function labelSet(browser) {
  return new Set([...Object.values(browser.BASIC_KIND_FAMILIES).flat(), "other"]);
}

function cloneProfile(profile) {
  return structuredClone(profile);
}

function zeroLegacyProfile(browser) {
  const profile = cloneProfile(browser.DEFAULT_BASIC_KIND_PROFILE);
  delete profile.topology;
  profile.id = "priority-benchmark-legacy-zeroed";
  for (const rows of [profile.familyWeights, profile.leafWeights]) {
    for (const weights of Object.values(rows)) {
      for (const key of Object.keys(weights)) weights[key] = 0;
    }
  }
  return browser.validateBasicKindProfile(profile);
}

function priorityInitialProfile(browser) {
  const profile = cloneProfile(browser.PRIORITY_BASIC_KIND_INITIAL_PROFILE);
  requireCondition(profile.topology === "priority_staged_v1", "priority initial profile must use priority_staged_v1");
  return browser.validateBasicKindProfile(profile);
}

function sparseCellCount(profile) {
  return [...Object.values(profile.familyWeights), ...Object.values(profile.leafWeights)]
    .reduce((count, row) => count + Object.keys(row).length, 0);
}

function nonzeroCellCount(profile) {
  return [...Object.values(profile.familyWeights), ...Object.values(profile.leafWeights)]
    .reduce((count, row) => count + Object.values(row).filter(value => value !== 0).length, 0);
}

function profileSummary(profile) {
  return {
    id: profile.id,
    topology: profile.topology ?? "family_leaf_v1",
    sparseCellCount: sparseCellCount(profile),
    nonzeroCellCount: nonzeroCellCount(profile),
    familyCellCount: Object.values(profile.familyWeights).reduce((count, row) => count + Object.keys(row).length, 0),
    leafCellCount: Object.values(profile.leafWeights).reduce((count, row) => count + Object.keys(row).length, 0),
  };
}

function augmentationIds(notes) {
  const ids = new Set();
  const derived = notes?.derivation?.sampleId;
  if (typeof derived === "string" && derived.length > 0) ids.add(derived);
  return ids;
}

function isSyntheticRow(row) {
  return row.provenanceRef.startsWith("synthetic/")
    || row.provenanceRef.startsWith("fixture:")
    || row.review.reviewerRef?.startsWith("fixture:")
    || row.review.reviewerRef?.startsWith("synthetic");
}

function rowSourceKind(row, augmentedIds) {
  if (augmentedIds.has(row.sampleId) || row.sampleId.includes("/masked-pointer")) return "augmentation";
  if (isSyntheticRow(row)) return "synthetic";
  return "source";
}

function sourceClusterKey(row, augmentedIds) {
  if (rowSourceKind(row, augmentedIds) === "synthetic") return `synthetic:${row.sampleId}`;
  return JSON.stringify(row.sourceAssociations);
}

function normalizeTrainingRows(preparedRows, augmentedIds) {
  return preparedRows.map(row => ({
    sampleId: row.sampleId,
    properties: row.properties,
    expectedLabel: row.review.expectedLabel,
    sourceKind: rowSourceKind(row, augmentedIds),
    sourceCluster: sourceClusterKey(row, augmentedIds),
    provenanceRef: row.provenanceRef,
    reviewerRef: row.review.reviewerRef,
    sourceAssociations: row.sourceAssociations,
  }));
}

function prepareRequest(raw, training, label) {
  const request = training.readBasicKindTrainingRequest(raw);
  const prepared = training.prepareBasicKindSamples(request, {
    taskId: request.taskId,
    inputScope: "candidate_qualified",
  });
  const rows = prepared.rows.filter(row => row.included);
  requireCondition(rows.length === request.rows.length, `${label}: every row must be included by the public reader`);
  for (const row of rows) {
    requireCondition(row.review.status === "verified", `${label}: included row ${row.sampleId} is not verified`);
    requireCondition(row.review.expectedLabel !== null, `${label}: included row ${row.sampleId} has no expected label`);
  }
  const fitRows = training.toBasicKindFitRows(prepared);
  requireCondition(fitRows.length === rows.length, `${label}: fit projection count differs from included rows`);
  for (let index = 0; index < rows.length; index++) {
    requireCondition(
      fitRows[index].expectedLabel === rows[index].review.expectedLabel,
      `${label}: fit projection changed the expected label for ${rows[index].sampleId}`,
    );
  }
  return { request, prepared, rows, fitRows };
}

function checkDatasetNotes(notes, mainRows, augmentedIds) {
  requireCondition(notes?.schemaVersion === 1, "dataset notes schemaVersion must be 1");
  requireCondition(notes.taskId === "dom.basic-kinds.v1", "dataset notes taskId must be dom.basic-kinds.v1");
  const counts = notes.counts;
  requireCondition(counts && typeof counts === "object", "dataset notes must contain counts");
  const computed = {
    sourceUniqueRows: mainRows.length - mainRows.filter(row => rowSourceKind(row, augmentedIds) === "augmentation").length,
    processedTrainingRows: mainRows.length,
    augmentationRows: mainRows.filter(row => rowSourceKind(row, augmentedIds) === "augmentation").length,
    uniqueSampleIds: new Set(mainRows.map(row => row.sampleId)).size,
    duplicateSampleIds: mainRows.length - new Set(mainRows.map(row => row.sampleId)).size,
  };
  for (const key of ["sourceUniqueRows", "processedTrainingRows", "augmentationRows", "uniqueSampleIds"]) {
    requireCondition(
      Number.isInteger(counts[key]) && counts[key] === computed[key],
      `dataset notes ${key} disagrees with actual prepared rows`,
    );
  }
  if (counts.duplicateSampleIds !== undefined) {
    requireCondition(counts.duplicateSampleIds === computed.duplicateSampleIds, "dataset notes duplicateSampleIds disagrees with prepared rows");
  }
  return { declared: notes, computed };
}

function assertNoDuplicateIds(rows, label) {
  const ids = new Set();
  for (const row of rows) {
    requireCondition(!ids.has(row.sampleId), `${label}: duplicate sampleId ${row.sampleId}`);
    ids.add(row.sampleId);
  }
}

function readGoldReference(raw, browser) {
  const profile = browser.validateBasicKindProfile(raw.profile);
  const config = browser.validateBasicKindConfig(raw.config ?? raw.compatibility);
  requireCondition(Array.isArray(raw.groups), "gold reference must contain groups");
  const labels = labelSet(browser);
  const groups = raw.groups.map((group, groupIndex) => {
    requireCondition(typeof group.name === "string" && group.name.length > 0, `gold group ${groupIndex} has no name`);
    requireCondition(Array.isArray(group.rows), `gold group ${group.name} has no rows`);
    const rows = group.rows.map((row, rowIndex) => {
      const expectedLabel = row.expectedLabel === null ? null : row.expectedLabel;
      if (expectedLabel !== null) requireCondition(labels.has(expectedLabel), `gold ${group.name}[${rowIndex}] has an invalid label`);
      const properties = browser.validateBasicKindProperties(row.properties);
      const recomputed = browser.classifyBasicKind(properties, config, profile);
      const projected = {
        familyStatus: recomputed.familyStatus,
        family: recomputed.family,
        familyScores: recomputed.familyScores,
        leafScores: recomputed.leafScores,
        judgmentStatus: recomputed.judgmentStatus,
        basicKind: recomputed.basicKind,
        score: recomputed.score,
        margin: recomputed.margin,
        reasons: recomputed.reasons,
        path: recomputed.evidence.path,
      };
      requireCondition(
        JSON.stringify(projected) === JSON.stringify(row.judgment),
        `gold reference ${group.name}[${rowIndex}] does not match the preserved legacy profile`,
      );
      return {
        sampleId: row.sampleId,
        expectedLabel,
        properties,
        referenceJudgment: projected,
        sourceGroup: group.name,
      };
    });
    return { name: group.name, rows };
  });
  return { profile, config, groups };
}

function isCorrect(expectedLabel, judgment) {
  return expectedLabel !== null
    && judgment.judgmentStatus === "judged"
    && judgment.basicKind === expectedLabel;
}

function compactJudgment(judgment) {
  return {
    status: judgment.judgmentStatus,
    kind: judgment.basicKind,
    score: judgment.score,
    margin: judgment.margin,
  };
}

function classifyRows(rows, profile, config, browser) {
  return rows.map(row => {
    const judgment = browser.classifyBasicKind(row.properties, config, profile);
    return {
      sampleId: row.sampleId,
      expectedLabel: row.expectedLabel,
      sourceKind: row.sourceKind ?? "gold",
      sourceCluster: row.sourceCluster ?? row.sourceGroup,
      sourceGroup: row.sourceGroup ?? "training",
      judgment,
      correct: isCorrect(row.expectedLabel, judgment),
    };
  });
}

function transition(oldCorrect, newCorrect, expectedLabel) {
  if (expectedLabel === null) return "unassessed";
  if (oldCorrect && newCorrect) return "retained";
  if (!oldCorrect && newCorrect) return "fixed";
  if (oldCorrect && !newCorrect) return "regressed";
  return "unresolved";
}

function emptyClassMetric() {
  return { support: 0, correct: 0, predicted: 0, truePositive: 0, precision: null, recall: null, f1: null, uncovered: true };
}

function finalizeMetric(metric) {
  const precision = metric.predicted === 0 ? null : metric.truePositive / metric.predicted;
  const recall = metric.support === 0 ? null : metric.truePositive / metric.support;
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null
    : 2 * precision * recall / (precision + recall);
  return {
    ...metric,
    precision,
    recall,
    f1,
    uncovered: metric.support === 0,
  };
}

export function summarizeOutcomes(outcomes, browser) {
  const labels = [...labelSet(browser)];
  const byClass = Object.fromEntries(labels.map(label => [label, emptyClassMetric()]));
  const statusCounts = {};
  const kindCounts = {};
  const transitions = { fixed: 0, regressed: 0, retained: 0, unresolved: 0, unassessed: 0 };
  let assessed = 0;
  let correct = 0;
  for (const outcome of outcomes) {
    const judgment = outcome.judgment;
    statusCounts[judgment.judgmentStatus] = (statusCounts[judgment.judgmentStatus] ?? 0) + 1;
    kindCounts[judgment.basicKind] = (kindCounts[judgment.basicKind] ?? 0) + 1;
    if (outcome.transition !== undefined) transitions[outcome.transition]++;
    if (outcome.expectedLabel === null) continue;
    assessed++;
    const expected = outcome.expectedLabel;
    const metric = byClass[expected];
    requireCondition(metric !== undefined, `unknown expected label ${expected}`);
    metric.support++;
    if (outcome.correct) {
      correct++;
      metric.correct++;
      metric.truePositive++;
    }
    if (judgment.judgmentStatus === "judged" && byClass[judgment.basicKind]) byClass[judgment.basicKind].predicted++;
  }
  const classes = Object.fromEntries(Object.entries(byClass).map(([label, metric]) => [label, finalizeMetric(metric)]));
  return {
    assessed,
    correct,
    accuracy: assessed === 0 ? null : correct / assessed,
    statusCounts,
    kindCounts,
    transitions,
    byClass: classes,
  };
}

export function pairOutcomes(reference, legacy, priority, rows) {
  const referenceById = new Map(reference.map(row => [row.sampleId, row]));
  const legacyById = new Map(legacy.map(row => [row.sampleId, row]));
  const priorityById = new Map(priority.map(row => [row.sampleId, row]));
  const perRow = rows.map(row => {
    const ref = referenceById.get(row.sampleId);
    const leg = legacyById.get(row.sampleId);
    const pri = priorityById.get(row.sampleId);
    requireCondition(ref && leg && pri, `comparison is missing arm output for ${row.sampleId}`);
    const transitionValue = transition(ref.correct, pri.correct, row.expectedLabel);
    const legacyTransition = transition(ref.correct, leg.correct, row.expectedLabel);
    return {
      sampleId: row.sampleId,
      sourceKind: row.sourceKind ?? "gold",
      sourceCluster: row.sourceCluster ?? row.sourceGroup,
      sourceGroup: row.sourceGroup ?? "training",
      expectedLabel: row.expectedLabel,
      assessed: row.expectedLabel !== null,
      reference: compactJudgment(ref.judgment),
      legacyRetrain: compactJudgment(leg.judgment),
      priorityRetrain: compactJudgment(pri.judgment),
      referenceCorrect: ref.correct,
      legacyCorrect: leg.correct,
      priorityCorrect: pri.correct,
      priorityTransition: transitionValue,
      legacyTransition,
    };
  });
  const attachTransition = (outcomes, arm) => {
    const byId = new Map(perRow.map(row => [row.sampleId, row]));
    return outcomes.map(outcome => ({
      ...outcome,
      transition: arm === "reference" ? transition(outcome.correct, outcome.correct, outcome.expectedLabel)
        : byId.get(outcome.sampleId)?.[arm === "legacy" ? "legacyTransition" : "priorityTransition"] ?? "unassessed",
    }));
  };
  return {
    perRow,
    reference: attachTransition(reference, "reference"),
    legacy: attachTransition(legacy, "legacy"),
    priority: attachTransition(priority, "priority"),
  };
}

function groupByLabel(rows) {
  const groups = new Map();
  for (const row of rows) {
    const label = row.expectedLabel;
    requireCondition(label !== null, "stratified training rows require labels");
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }
  for (const values of groups.values()) values.sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  return groups;
}

function stratifiedSubset(rows, target) {
  requireCondition(Number.isInteger(target) && target > 0 && target <= rows.length, `cannot select ${target} rows from ${rows.length}`);
  const groups = groupByLabel(rows);
  requireCondition(target >= groups.size, `target ${target} cannot cover ${groups.size} classes`);
  const allocation = new Map([...groups.keys()].map(label => [label, 1]));
  let remaining = target - groups.size;
  while (remaining > 0) {
    let best = null;
    for (const [label, values] of groups) {
      const current = allocation.get(label);
      if (current >= values.length) continue;
      const ratio = (target * values.length) / rows.length - current;
      if (best === null || ratio > best.ratio || (ratio === best.ratio && label < best.label)) {
        best = { label, ratio };
      }
    }
    requireCondition(best !== null, "stratified allocation exhausted before target");
    allocation.set(best.label, allocation.get(best.label) + 1);
    remaining--;
  }
  const selected = [];
  for (const [label, values] of groups) selected.push(...values.slice(0, allocation.get(label)));
  selected.sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  return selected;
}

function labelCounts(rows) {
  const counts = {};
  for (const row of rows) {
    const label = row.expectedLabel;
    if (label === null) continue;
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

function sourceKindCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.sourceKind] = (counts[row.sourceKind] ?? 0) + 1;
  return counts;
}

function validateTiming(timing, rows, requestedEpochs) {
  requireCondition(timing && typeof timing === "object", "fitBasicKinds did not return timing");
  for (const field of TIMING_FIELDS) {
    requireCondition(Number.isFinite(timing[field]) && timing[field] >= 0, `timing.${field} must be finite and nonnegative`);
  }
  for (const field of ["completedEpochs", "processedRowCount", "gradientRowEpochs", "totalRowPasses", "trainableParamCount"]) {
    requireCondition(Number.isInteger(timing[field]) && timing[field] >= 0, `timing.${field} must be a nonnegative integer`);
  }
  requireCondition(timing.completedEpochs === requestedEpochs, "timing.completedEpochs differs from requested epochs");
  requireCondition(timing.processedRowCount === rows.length, "timing.processedRowCount differs from actual fit rows");
  requireCondition(timing.gradientRowEpochs === rows.length * requestedEpochs, "timing.gradientRowEpochs has the wrong row-epoch unit");
  requireCondition(timing.totalRowPasses === rows.length * (2 * requestedEpochs + 2), "timing.totalRowPasses has the wrong row-pass unit");
  return timing;
}

function errorTiming(error) {
  const timing = error?.timing;
  const completedEpochs = Number.isInteger(error?.completedEpochs)
    ? error.completedEpochs
    : Number.isInteger(timing?.completedEpochs)
      ? timing.completedEpochs
      : 0;
  return { timing: timing ?? null, completedEpochs };
}

async function runFit({ report, key, training, handwiredRoot, rows, baseProfile, config, candidateId }) {
  const started = performance.now();
  report.fits[key] = {
    status: "running",
    baseProfileId: baseProfile.id,
    candidateProfileId: candidateId,
    topology: baseProfile.topology ?? "family_leaf_v1",
    rowCount: rows.length,
    requestedEpochs: config.fit.epochs,
  };
  try {
    const result = await training.fitBasicKinds({
      handwiredRoot,
      rows: rows.map(({ properties, expectedLabel }) => ({ properties, expectedLabel })),
      baseProfile: cloneProfile(baseProfile),
      config,
      candidateId,
    });
    const wallElapsedMs = performance.now() - started;
    const timing = validateTiming(result.timing, rows, config.fit.epochs);
    requireCondition(result.profile?.id === candidateId, "fit result profile id differs from candidateId");
    if (baseProfile.topology === "priority_staged_v1") {
      requireCondition(result.profile.topology === "priority_staged_v1", "priority fit lost topology during serialization");
    }
    report.fits[key] = {
      status: "completed",
      baseProfileId: baseProfile.id,
      candidateProfileId: result.profile.id,
      topology: result.profile.topology ?? "family_leaf_v1",
      rowCount: rows.length,
      requestedEpochs: config.fit.epochs,
      wallElapsedMs,
      timing,
      trajectoryLength: result.trajectory.length,
      lossBefore: result.lossBefore,
      lossAfter: result.lossAfter,
      initialization: profileSummary(baseProfile),
      result: profileSummary(result.profile),
    };
    return result;
  } catch (error) {
    const wallElapsedMs = performance.now() - started;
    const partial = errorTiming(error);
    report.fits[key] = {
      ...report.fits[key],
      status: "failed",
      wallElapsedMs,
      timing: partial.timing,
      completedEpochs: partial.completedEpochs,
      failure: errorDetails(error),
    };
    throw error;
  }
}

function repeatRows(rows, factor) {
  const repeated = [];
  for (let index = 0; index < factor; index++) repeated.push(...rows);
  return repeated;
}

async function runTimingMatrix({ report, training, browser, handwiredRoot, rows, config }) {
  const uniqueRows = rows.filter(row => row.sourceKind !== "augmentation");
  requireCondition(uniqueRows.length >= 64, `timing matrix needs at least 64 unique source rows, got ${uniqueRows.length}`);
  const base = priorityInitialProfile(browser);
  const cases = [
    { id: "unique-32-e100", rows: stratifiedSubset(uniqueRows, 32), epochs: MATRIX_EPOCHS, purpose: "row-scaling" },
    { id: "unique-64-e100", rows: stratifiedSubset(uniqueRows, 64), epochs: MATRIX_EPOCHS, purpose: "row-scaling" },
    { id: "unique-all-e100", rows: uniqueRows, epochs: MATRIX_EPOCHS, purpose: "row-scaling" },
    {
      id: "duplicate-2x-e100",
      rows: repeatRows(uniqueRows, 2),
      epochs: MATRIX_EPOCHS,
      purpose: "throughput-only",
      duplicateFactor: 2,
    },
  ];
  const matrix = [];
  for (const item of cases) {
    const fitConfig = training.validateBasicKindTrainingConfig({
      taskId: config.taskId,
      ...FORMAL_CONFIG,
      fit: { ...FORMAL_CONFIG.fit, epochs: item.epochs },
    });
    const candidateId = `priority-benchmark-${item.id}`;
    const result = await runFit({
      report,
      key: `timing:${item.id}`,
      training,
      handwiredRoot,
      rows: item.rows,
      baseProfile: base,
      config: fitConfig,
      candidateId,
    });
    matrix.push({
      id: item.id,
      purpose: item.purpose,
      epochs: item.epochs,
      duplicateFactor: item.duplicateFactor ?? 1,
      uniqueSourceRowCount: item.duplicateFactor ? uniqueRows.length : new Set(item.rows.map(row => row.sampleId)).size,
      processedRowCount: item.rows.length,
      augmentationRowCount: item.rows.filter(row => row.sourceKind === "augmentation").length,
      labelCoverage: labelCounts(item.rows),
      sourceKindCounts: sourceKindCounts(item.rows),
      completedEpochs: result.timing.completedEpochs,
      trainableParamCount: result.timing.trainableParamCount,
      gradientRowEpochs: result.timing.gradientRowEpochs,
      totalRowPasses: result.timing.totalRowPasses,
      timing: result.timing,
      profileId: result.profile.id,
    });
  }
  return matrix;
}

function linearEstimate(matrix) {
  const points = matrix
    .filter(item => item.completedEpochs > 0 && item.trainableParamCount > 0)
    .map(item => ({
      id: item.id,
      x: item.processedRowCount * item.completedEpochs * item.trainableParamCount,
      y: item.timing.fitTotalMs,
    }));
  if (points.length < 2) return { points, setupMs: null, perUnitMs: null, note: "fewer than two completed timing points" };
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  if (denominator === 0) return { points, setupMs: null, perUnitMs: null, note: "timing points have no x variation" };
  const perUnitMs = numerator / denominator;
  return {
    formula: "fitTotalMs ~= setupMs + perUnitMs * processedRowCount * completedEpochs * trainableParamCount",
    points,
    setupMs: meanY - perUnitMs * meanX,
    perUnitMs,
    note: "Local linear estimate only. It is not a hardware-independent benchmark and does not isolate pure training from setup.",
  };
}

function buildAdoptionGate({ trainingRows, goldRows, referenceRows, priorityRows }) {
  const priorityById = new Map(priorityRows.map(row => [row.sampleId, row]));
  const referenceById = new Map(referenceRows.map(row => [row.sampleId, row]));
  const regressions = [];
  for (const row of [...trainingRows, ...goldRows]) {
    const ref = referenceById.get(row.sampleId);
    const pri = priorityById.get(row.sampleId);
    if (ref?.correct && pri && !pri.correct) regressions.push({
      sampleId: row.sampleId,
      sourceGroup: row.sourceGroup ?? "training",
      expectedLabel: row.expectedLabel,
      reference: compactJudgment(ref.judgment),
      priority: compactJudgment(pri.judgment),
    });
  }
  const teacherButtons = trainingRows.filter(row => row.expectedLabel === "button" && row.sourceKind === "source");
  const teacherSelects = trainingRows.filter(row => row.expectedLabel === "select" && row.sourceKind === "source");
  const failedButtons = teacherButtons.filter(row => !priorityById.get(row.sampleId)?.correct);
  const failedSelects = teacherSelects.filter(row => !priorityById.get(row.sampleId)?.correct);
  const absoluteFailures = [...trainingRows, ...goldRows]
    .filter(row => row.expectedLabel !== null)
    .filter(row => !priorityById.get(row.sampleId)?.correct)
    .map(row => ({
      sampleId: row.sampleId,
      sourceGroup: row.sourceGroup ?? "training",
      expectedLabel: row.expectedLabel,
      priority: compactJudgment(priorityById.get(row.sampleId).judgment),
    }));
  const accepted = regressions.length === 0
    && failedButtons.length === 0
    && failedSelects.length === 0
    && absoluteFailures.length === 0;
  return {
    candidateAdoption: "not_applied",
    acceptedByContract: accepted,
    independentAccuracyClaimed: false,
    regressions,
    teacherButtonCoverage: {
      requiredRows: 10,
      actualRows: teacherButtons.length,
      failedRows: failedButtons.map(row => row.sampleId),
    },
    teacherSelectCoverage: {
      requiredRows: 2,
      actualRows: teacherSelects.length,
      failedRows: failedSelects.map(row => row.sampleId),
    },
    absoluteSupervisedFailures: absoluteFailures,
    rule: "Reject if any previously known-correct class/status regresses, if any real teacher button/select row is incorrect, or if any supervised row remains incorrect.",
  };
}

function environment() {
  const processors = cpus();
  return {
    platform: platform(),
    arch: arch(),
    nodeVersion: process.versions.node,
    cpuModel: processors[0]?.model ?? "unknown",
    cpuCores: processors.length,
    backend: "handwired-reference-f32",
    clock: "performance.now (ms)",
  };
}

function compactOutcome(outcome) {
  return {
    sampleId: outcome.sampleId,
    expectedLabel: outcome.expectedLabel,
    sourceKind: outcome.sourceKind,
    status: outcome.judgment.judgmentStatus,
    kind: outcome.judgment.basicKind,
    correct: outcome.correct,
    transition: outcome.transition,
  };
}

function buildReportGroups(paired, browser) {
  const training = paired.perRow.filter(row => row.sourceGroup === "training");
  const gold = paired.perRow.filter(row => row.sourceGroup !== "training" && row.expectedLabel !== null);
  const diagnostic = paired.perRow.filter(row => row.expectedLabel === null);
  return {
    teacherTrain: summarizeOutcomes(paired.priority.filter(row => row.sourceGroup === "training"), browser),
    legacyTeacherTrain: summarizeOutcomes(paired.legacy.filter(row => row.sourceGroup === "training"), browser),
    goldRegression: summarizeOutcomes(paired.priority.filter(row => row.sourceGroup !== "training" && row.expectedLabel !== null), browser),
    legacyGoldRegression: summarizeOutcomes(paired.legacy.filter(row => row.sourceGroup !== "training" && row.expectedLabel !== null), browser),
    diagnostic: {
      assessed: false,
      rows: diagnostic.map(row => ({
        sampleId: row.sampleId,
        sourceGroup: row.sourceGroup,
        reference: row.reference,
        legacyRetrain: row.legacyRetrain,
        priorityRetrain: row.priorityRetrain,
      })),
    },
    counts: {
      teacherTrainRows: training.length,
      goldRows: gold.length,
      diagnosticRows: diagnostic.length,
      goldOtherRows: gold.filter(row => row.expectedLabel === "other").length,
    },
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    console.log(HELP);
    return;
  }

  const flags = parsed.flags;
  const paths = {
    input: resolve(flags.get("--input")),
    referenceWeight: resolve(flags.get("--reference-weight")),
    goldReference: resolve(flags.get("--gold-reference")),
    datasetNotes: resolve(flags.get("--dataset-notes")),
    lineage: flags.has("--lineage") ? resolve(flags.get("--lineage")) : null,
    handwiredRoot: resolve(flags.get("--handwired-root")),
    outDir: resolve(flags.get("--out-dir")),
    weightsDir: resolve(flags.get("--weights-dir")),
    fixture: flags.has("--fixture") ? resolve(flags.get("--fixture")) : null,
  };
  requireCondition(paths.outDir !== paths.weightsDir, "--out-dir and --weights-dir must be separate");
  const report = {
    schemaVersion: 1,
    kind: "nnanything.priority-benchmark.v1",
    status: "running",
    runId: runId(),
    generatedAt: new Date().toISOString(),
    inputs: paths,
    environment: environment(),
    trainingContract: {
      taskId: "dom.basic-kinds.v1",
      epochs: FORMAL_EPOCHS,
      learningRate: FORMAL_CONFIG.fit.learningRate,
      anchorLambda: FORMAL_CONFIG.fit.anchorLambda,
      targetScore: FORMAL_CONFIG.objective.targetScore,
      rivalCeiling: FORMAL_CONFIG.objective.rivalCeiling,
      otherGap: FORMAL_CONFIG.objective.otherGap,
      minScore: FORMAL_CONFIG.minScore,
      minMargin: FORMAL_CONFIG.minMargin,
    },
    dataset: null,
    initialization: null,
    fits: {},
    comparison: null,
    timingMatrix: null,
    scalingEstimate: null,
    adoptionGate: null,
    artifacts: {},
    limitations: [
      "Gold rows are used only after fitting; they do not select epochs or parameters.",
      "Teacher train accuracy is not independent validation and is reported separately from gold regression.",
      "Synthetic fixture rows are declared synthetic and are not evidence of real web coverage.",
      "Diagnostic rows without expected labels are reported but never scored.",
      "Timing estimates are local to this host and backend; they are not hardware-independent claims.",
      "Handwired module caching is recorded per fit but cold/warm cache state is not controlled.",
      "The candidate is never applied automatically.",
    ],
  };
  const reportPath = resolve(paths.outDir, "priority-benchmark-report.json");
  report.artifacts.reportFile = reportPath;
  const started = performance.now();

  try {
    await mkdir(paths.outDir, { recursive: true });
    await mkdir(paths.weightsDir, { recursive: true });
    const { training, browser } = await loadPublicModules();
    const prepStarted = performance.now();
    const dataset = await readJson(paths.input, "training request");
    const notes = await readJson(paths.datasetNotes, "dataset notes");
    const lineage = paths.lineage ? await readJson(paths.lineage, "lineage") : null;
    const main = prepareRequest(dataset, training, "input");
    const augmented = augmentationIds(notes);
    const noteCheck = checkDatasetNotes(notes, main.rows, augmented);
    const fixtureSets = [];
    if (paths.fixture) {
      const fixture = await readJson(paths.fixture, "public fixture");
      fixtureSets.push({ label: "public-fixture", ...prepareRequest(fixture, training, "public fixture") });
    }
    const nativeFixture = await readJson(nativeFixturePath, "native fixture");
    const native = { label: "native-fixture", ...prepareRequest(nativeFixture, training, "native fixture") };
    const allRows = [...main.rows, ...fixtureSets.flatMap(item => item.rows), ...native.rows];
    const allFitRows = [...main.fitRows, ...fixtureSets.flatMap(item => item.fitRows), ...native.fitRows];
    assertNoDuplicateIds(allRows, "combined training set");
    const normalizedRows = normalizeTrainingRows(allRows, augmented);
    const sourceUniqueRows = normalizedRows.filter(row => row.sourceKind !== "augmentation");
    const sourceClusters = new Set(normalizedRows.map(row => row.sourceCluster));
    const referenceRaw = await readJson(paths.referenceWeight, "reference weight");
    const referenceProfile = browser.validateBasicKindProfile(referenceRaw.profile);
    const referenceConfig = browser.validateBasicKindConfig(referenceRaw.config ?? referenceRaw.compatibility);
    const goldRaw = await readJson(paths.goldReference, "gold reference");
    const gold = readGoldReference(goldRaw, browser);
    requireCondition(
      gold.profile.id === referenceProfile.id,
      "reference weight profile and gold reference profile must be the same preserved asset",
    );
    requireCondition(
      JSON.stringify(gold.config) === JSON.stringify(referenceConfig),
      "reference weight config and gold reference config differ",
    );
    const inferenceConfig = browser.validateBasicKindConfig({
      taskId: main.request.taskId,
      minScore: FORMAL_CONFIG.minScore,
      minMargin: FORMAL_CONFIG.minMargin,
    });
    const fitConfig = training.validateBasicKindTrainingConfig({
      taskId: main.request.taskId,
      ...FORMAL_CONFIG,
    });
    const legacyBase = zeroLegacyProfile(browser);
    const priorityBase = priorityInitialProfile(browser);
    report.initialization = {
      reference: profileSummary(referenceProfile),
      legacyRetrain: profileSummary(legacyBase),
      priorityRetrain: profileSummary(priorityBase),
      legacyTopologyOmitted: !Object.hasOwn(legacyBase, "topology"),
      priorityTopology: priorityBase.topology,
      note: "Legacy retraining uses a zeroed copy of DEFAULT sparse cells with a distinct id and no topology. Priority retraining uses the fresh zero factory.",
    };
    report.dataset = {
      mainRequest: {
        schemaVersion: main.request.schemaVersion,
        taskId: main.request.taskId,
        rows: main.rows.length,
      },
      datasetNotes: noteCheck,
      lineage,
      rows: {
        mainProcessed: main.rows.length,
        nativeFixture: native.rows.length,
        publicFixture: fixtureSets.reduce((sum, item) => sum + item.rows.length, 0),
        allProcessed: normalizedRows.length,
        sourceUnique: sourceUniqueRows.length,
        sourceClusters: sourceClusters.size,
        augmentation: normalizedRows.filter(row => row.sourceKind === "augmentation").length,
        synthetic: normalizedRows.filter(row => row.sourceKind === "synthetic").length,
        source: normalizedRows.filter(row => row.sourceKind === "source").length,
      },
      sourceKindCounts: sourceKindCounts(normalizedRows),
      labelCoverage: labelCounts(normalizedRows),
      sourceUniqueLabelCoverage: labelCounts(sourceUniqueRows),
      fixtures: [
        { id: "native-fixture", path: nativeFixturePath, rows: native.rows.length, synthetic: true },
        ...(paths.fixture ? [{ id: "public-fixture", path: paths.fixture, rows: fixtureSets[0].rows.length, synthetic: true }] : []),
      ],
    };
    report.phases = { dataPrepMs: performance.now() - prepStarted };

    const compareStarted = performance.now();
    const referenceTrainRows = normalizedRows.map(row => ({
      ...row,
      judgment: browser.classifyBasicKind(row.properties, inferenceConfig, referenceProfile),
    })).map(row => ({ ...row, correct: isCorrect(row.expectedLabel, row.judgment) }));
    const goldEvaluationRows = gold.groups.filter(group => group.name !== "diagnostic25").flatMap(group => group.rows);
    const referenceGoldRows = goldEvaluationRows.map(row => ({
      ...row,
      sourceKind: "gold",
      sourceCluster: groupKey(row.sourceGroup, row.sampleId),
      judgment: row.referenceJudgment,
      correct: isCorrect(row.expectedLabel, row.referenceJudgment),
    }));
    const legacyTrainFit = await runFit({
      report,
      key: "legacyRetrain",
      training,
      handwiredRoot: paths.handwiredRoot,
      rows: allFitRows,
      baseProfile: legacyBase,
      config: fitConfig,
      candidateId: "priority-benchmark-legacy-retrain",
    });
    const priorityTrainFit = await runFit({
      report,
      key: "priorityRetrain",
      training,
      handwiredRoot: paths.handwiredRoot,
      rows: allFitRows,
      baseProfile: priorityBase,
      config: fitConfig,
      candidateId: "priority-benchmark-priority-retrain",
    });
    const legacyProfile = browser.validateBasicKindProfile(legacyTrainFit.profile);
    const priorityProfile = browser.validateBasicKindProfile(priorityTrainFit.profile);
    requireCondition(priorityProfile.topology === "priority_staged_v1", "priority candidate lost topology");
    const legacyAsset = {
      targetOperator: "dom.basic_kinds",
      operatorVersion: "0.1.0",
      contractVersion: 1,
      taskId: main.request.taskId,
      profileId: legacyProfile.id,
      baseProfileId: legacyBase.id,
      calibrated: false,
      compatibility: { taskId: main.request.taskId, minScore: fitConfig.minScore, minMargin: fitConfig.minMargin },
      profile: legacyProfile,
    };
    const priorityAsset = {
      targetOperator: "dom.basic_kinds",
      operatorVersion: "0.1.0",
      contractVersion: 2,
      taskId: main.request.taskId,
      profileId: priorityProfile.id,
      baseProfileId: priorityBase.id,
      calibrated: false,
      compatibility: { taskId: main.request.taskId, minScore: fitConfig.minScore, minMargin: fitConfig.minMargin },
      profile: priorityProfile,
    };
    const legacyAssetPath = resolve(paths.weightsDir, "legacy-zeroed.weight.json");
    const priorityAssetPath = resolve(paths.weightsDir, "priority-candidate.weight.json");
    await writeJson(legacyAssetPath, legacyAsset);
    await writeJson(priorityAssetPath, priorityAsset);
    const legacyReload = browser.parseBrowserWeightAsset(legacyAsset, legacyAssetPath);
    const priorityReload = browser.parseBrowserWeightAsset(priorityAsset, priorityAssetPath);
    requireCondition(legacyReload.profile.topology === undefined || legacyReload.profile.topology === "family_leaf_v1", "legacy asset reloaded with the wrong topology");
    requireCondition(priorityReload.profile.topology === "priority_staged_v1", "priority asset did not reload with priority_staged_v1");
    report.artifacts.weights = {
      legacyZeroed: legacyAssetPath,
      priorityCandidate: priorityAssetPath,
      referencePreserved: paths.referenceWeight,
      legacyContractVersion: legacyAsset.contractVersion,
      priorityContractVersion: priorityAsset.contractVersion,
      priorityReloadTopology: priorityReload.profile.topology,
    };

    const legacyTrainRows = classifyRows(normalizedRows, legacyProfile, inferenceConfig, browser);
    const priorityTrainRows = classifyRows(normalizedRows, priorityProfile, inferenceConfig, browser);
    const legacyGoldRows = classifyRows(
      goldEvaluationRows.map(row => ({
        ...row,
        sourceKind: "gold",
        sourceCluster: groupKey(row.sourceGroup, row.sampleId),
      })),
      legacyProfile,
      inferenceConfig,
      browser,
    );
    const priorityGoldRows = classifyRows(
      goldEvaluationRows.map(row => ({
        ...row,
        sourceKind: "gold",
        sourceCluster: groupKey(row.sourceGroup, row.sampleId),
      })),
      priorityProfile,
      inferenceConfig,
      browser,
    );
    const pairedTrain = pairOutcomes(referenceTrainRows, legacyTrainRows, priorityTrainRows, normalizedRows);
    const pairedGold = pairOutcomes(referenceGoldRows, legacyGoldRows, priorityGoldRows, goldEvaluationRows.map(row => ({
      ...row,
      sourceKind: "gold",
      sourceCluster: groupKey(row.sourceGroup, row.sampleId),
    })));
    const goldTrainingById = new Map(normalizedRows.map(row => [row.sampleId, row]));
    const diagnosticRows = gold.groups.find(group => group.name === "diagnostic25")?.rows ?? [];
    const diagnosticPaired = pairOutcomes(
      diagnosticRows.map(row => ({
        sampleId: row.sampleId,
        expectedLabel: null,
        sourceKind: "diagnostic",
        sourceCluster: row.sampleId,
        judgment: row.referenceJudgment,
        correct: false,
      })),
      classifyRows(diagnosticRows.map(row => ({ ...row, sourceKind: "diagnostic", sourceCluster: row.sampleId })), legacyProfile, inferenceConfig, browser),
      classifyRows(diagnosticRows.map(row => ({ ...row, sourceKind: "diagnostic", sourceCluster: row.sampleId })), priorityProfile, inferenceConfig, browser),
      diagnosticRows.map(row => ({ ...row, sourceKind: "diagnostic", sourceCluster: row.sampleId })),
    );
    const allPairedRows = [
      ...pairedTrain.perRow,
      ...pairedGold.perRow,
      ...diagnosticPaired.perRow.map(row => ({ ...row, sourceGroup: "diagnostic25" })),
    ];
    const trainingPriority = pairedTrain.priority.map(row => ({ ...row, sourceGroup: "training" }));
    const goldPriority = pairedGold.priority.map(row => ({ ...row, sourceGroup: row.sourceGroup ?? "gold" }));
    const diagnosticPriority = diagnosticPaired.priority.map(row => ({ ...row, sourceGroup: "diagnostic25" }));
    const allReference = [...pairedTrain.reference, ...pairedGold.reference, ...diagnosticPaired.reference];
    const allLegacy = [...pairedTrain.legacy, ...pairedGold.legacy, ...diagnosticPaired.legacy];
    const allPriority = [...trainingPriority, ...goldPriority, ...diagnosticPriority];
    const allRowsForGate = [
      ...normalizedRows,
      ...goldEvaluationRows.map(row => ({ ...row, sourceKind: "gold", sourceGroup: row.sourceGroup })),
    ];
    const comparison = {
      arms: {
        reference: profileSummary(referenceProfile),
        legacyRetrain: profileSummary(legacyProfile),
        priorityRetrain: profileSummary(priorityProfile),
      },
      parameterDifferences: {
        legacyVsReferenceSparseCells: sparseCellCount(legacyProfile) - sparseCellCount(referenceProfile),
        priorityVsLegacySparseCells: sparseCellCount(priorityProfile) - sparseCellCount(legacyProfile),
        priorityVsLegacyNonzeroCells: nonzeroCellCount(priorityProfile) - nonzeroCellCount(legacyProfile),
      },
      teacherTrain: buildReportGroups({ perRow: allPairedRows, reference: allReference, legacy: allLegacy, priority: allPriority }, browser).teacherTrain,
      legacyTeacherTrain: buildReportGroups({ perRow: allPairedRows, reference: allReference, legacy: allLegacy, priority: allPriority }, browser).legacyTeacherTrain,
      goldRegression: buildReportGroups({ perRow: allPairedRows, reference: allReference, legacy: allLegacy, priority: allPriority }, browser).goldRegression,
      legacyGoldRegression: buildReportGroups({ perRow: allPairedRows, reference: allReference, legacy: allLegacy, priority: allPriority }, browser).legacyGoldRegression,
      diagnostic: buildReportGroups({ perRow: allPairedRows, reference: allReference, legacy: allLegacy, priority: allPriority }, browser).diagnostic,
      counts: {
        trainingRows: normalizedRows.length,
        sourceUniqueRows: sourceUniqueRows.length,
        goldRows: goldEvaluationRows.length,
        diagnosticRows: diagnosticRows.length,
        diagnosticRowsWithoutLabels: diagnosticRows.filter(row => row.expectedLabel === null).length,
        diagnosticRowsAlreadyInTraining: diagnosticRows.filter(row => goldTrainingById.has(row.sampleId)).length,
      },
      perRow: allPairedRows,
    };
    const adoptionGate = buildAdoptionGate({
      trainingRows: normalizedRows,
      goldRows: goldEvaluationRows.map(row => ({ ...row, sourceGroup: row.sourceGroup })),
      referenceRows: referenceTrainRows.concat(referenceGoldRows),
      priorityRows: priorityTrainRows.concat(priorityGoldRows),
    });
    report.comparison = comparison;
    report.adoptionGate = adoptionGate;
    report.phases.evalCompareMs = performance.now() - compareStarted
      - report.fits.legacyRetrain.wallElapsedMs - report.fits.priorityRetrain.wallElapsedMs;
    const matrixStarted = performance.now();
    const timingMatrix = await runTimingMatrix({
      report,
      training,
      browser,
      handwiredRoot: paths.handwiredRoot,
      rows: normalizedRows,
      config: fitConfig,
    });
    report.timingMatrix = {
      formalFitReused: {
        id: "all-e500-formal",
        status: report.fits.priorityRetrain?.status,
        processedRowCount: allFitRows.length,
        uniqueSourceRowCount: sourceUniqueRows.length,
        timing: report.fits.priorityRetrain?.timing ?? null,
        note: "Formal 500-epoch fit is reused and is not rerun in the matrix.",
      },
      cases: timingMatrix,
      units: {
        gradientRowEpochs: "completedEpochs * processedRowCount",
        totalRowPasses: "(2 * completedEpochs + 2) * processedRowCount",
        note: "The matrix is not a full Cartesian product.",
      },
    };
    const formalTiming = report.fits.priorityRetrain?.timing;
    const estimatePoints = formalTiming
      ? [...timingMatrix, {
          id: "all-e500-formal",
          processedRowCount: allFitRows.length,
          completedEpochs: formalTiming.completedEpochs,
          trainableParamCount: formalTiming.trainableParamCount,
          timing: formalTiming,
        }]
      : timingMatrix;
    report.scalingEstimate = linearEstimate(estimatePoints);
    report.phases.timingMatrixMs = performance.now() - matrixStarted;
    report.status = "completed";
    report.completedAt = new Date().toISOString();
    report.timing = {
      dataPrepMs: report.phases.dataPrepMs,
      evalCompareMs: report.phases.evalCompareMs,
      timingMatrixMs: report.phases.timingMatrixMs,
      totalElapsedMs: performance.now() - started,
      formalFits: {
        legacyRetrain: report.fits.legacyRetrain?.timing ?? null,
        priorityRetrain: report.fits.priorityRetrain?.timing ?? null,
      },
    };
    report.elapsedMs = report.timing.totalElapsedMs;
    await writeReport(reportPath, report);
    console.log(JSON.stringify({
      status: report.status,
      reportFile: reportPath,
      candidateAdoption: adoptionGate.candidateAdoption,
      acceptedByContract: adoptionGate.acceptedByContract,
      teacherTrainAccuracy: report.comparison.teacherTrain.accuracy,
      goldAccuracy: report.comparison.goldRegression.accuracy,
      goldTransitions: report.comparison.goldRegression.transitions,
      priorityAsset: priorityAssetPath,
      timingMatrixCases: timingMatrix.length,
    }, null, 2));
  } catch (error) {
    report.status = "failed";
    report.failure = errorDetails(error);
    report.timing = {
      ...(report.phases ?? {}),
      totalElapsedMs: performance.now() - started,
    };
    report.elapsedMs = report.timing.totalElapsedMs;
    try {
      await writeReport(reportPath, report);
    } catch (writeError) {
      report.failure.reportWriteError = errorDetails(writeError);
    }
    console.error(`priority benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function groupKey(group, sampleId) {
  return `${group}:${sampleId}`;
}

async function writeReport(path, report) {
  try {
    await writeJson(path, report);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const fallback = path.replace(/\.json$/, `.${report.runId}.json`);
    await writeJson(fallback, report);
    report.artifacts.reportFile = fallback;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(`priority benchmark failed before report setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
