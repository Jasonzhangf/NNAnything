import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CLI_COMMAND_HEADS,
  CLI_COMMAND_WIRES,
  ENTRIES_PROPERTY,
  createCliCommandPolicy,
  createCliFilesystemSandbox,
  executeCliCommandTrainingSample,
  isBatch1CommandCase,
  makeCliCommandFixture,
  migrateCliCommandProfileToCurrent,
  predictCliCommand,
  prepareCliCandidatePreferenceDataset,
  prepareCliCommandDataset,
  runCliCommandTraining,
  sampleFacts,
  sampleFeatures,
  sampleGoal,
  validateCliCommandProfile,
} from "nnanything/cli-goal";
import { validateEntrySelectProfile } from "../../../dist/filters/cli-entry-select-relation.js";

const execFileAsync = promisify(execFile);
const DEFAULT_P3_PREFERENCE_SAMPLES =
  "/Volumes/Intel/playground/nnanything-runs/cli-programming-search-p3-20261024/rework/workflow-training/samples/filesystem/command/ba10a538-4d1f-46f6-9a0f-09e1287d6e88/samples.json";
const DEFAULT_ORIGINAL_358_SAMPLES_REFERENCE =
  "/Volumes/Intel/playground/nnanything-runs/cli-p3-stage2/training-output/samples/filesystem/command/4e249c32-0809-4016-beb6-5b3d336a9f16/samples.json";
const ALLOWED_FLAGS = new Set([
  "--stage",
  "--mode",
  "--handwired-root",
  "--output-root",
  "--initial-source",
  "--b-directory-profile",
  "--b-file-profile",
  "--p3-preference-samples",
  "--epochs",
  "--learning-rate",
]);

const STAGE1_CASES = new Set([
  "path-realpath",
  "inspect-resolved-target",
  "inspect-resolved-target-broken",
]);

const STAGE2_CASES = new Set([
  "select-entry-dir-ready",
  "select-entry-file-ready",
  "select-entry-dir-not-found",
  "select-entry-file-not-found",
  "select-entry-dir-unobserved",
  "select-entry-file-unobserved",
  "select-entry-dir-satisfied-noop",
  "select-entry-file-satisfied-noop",
]);

function isStage1Sample(sample) {
  return STAGE1_CASES.has(sample.case) || sample.variant === "link-target-c";
}

function isStage2Sample(sample) {
  return STAGE2_CASES.has(sample.case);
}

function isAppendedStage2Sample(sampleOrRow) {
  return (
    sampleOrRow.variant === "select-entry-dir-unobserved-stale"
    || sampleOrRow.variant === "select-entry-file-unobserved-stale"
    || (typeof sampleOrRow.id === "string" && sampleOrRow.id.endsWith("-unobserved-stale"))
  );
}

const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!ALLOWED_FLAGS.has(flag) || value === undefined || options.has(flag)) {
    throw new TypeError(
      "Expected --stage <stage1-11x34|stage2-13x38> --mode <validate-only|train> --initial-source PATH --output-root PATH " +
      "[--b-directory-profile PATH --b-file-profile PATH --handwired-root PATH --epochs 200 --learning-rate 0.1]",
    );
  }
  options.set(flag, value);
}

const stage = options.get("--stage");
if (stage !== "stage1-11x34" && stage !== "stage2-13x38") {
  throw new TypeError(`Explicit --stage stage1-11x34 or stage2-13x38 required (received ${String(stage)})`);
}

const mode = options.get("--mode");
if (mode !== "validate-only" && mode !== "train") {
  throw new TypeError(`Explicit --mode <validate-only|train> required (received ${String(mode)})`);
}

if (!options.has("--initial-source")) {
  throw new TypeError("Explicit --initial-source PATH required");
}
if (!options.has("--output-root")) {
  throw new TypeError("Explicit --output-root PATH required");
}
if (stage === "stage2-13x38") {
  if (!options.has("--b-directory-profile") || !options.has("--b-file-profile")) {
    throw new TypeError("Stage 2 requires explicit --b-directory-profile and --b-file-profile disk paths");
  }
}

const initialSource = resolve(options.get("--initial-source"));
const outputRoot = resolve(options.get("--output-root"));
const bDirectoryProfilePath = options.has("--b-directory-profile") ? resolve(options.get("--b-directory-profile")) : null;
const bFileProfilePath = options.has("--b-file-profile") ? resolve(options.get("--b-file-profile")) : null;
const p3PreferenceSamplesPath = resolve(options.get("--p3-preference-samples") ?? DEFAULT_P3_PREFERENCE_SAMPLES);

if (mode === "train") {
  if (!options.has("--handwired-root")) {
    throw new Error("Explicit --handwired-root PATH required in --mode train");
  }
  if (!options.has("--epochs") || Number(options.get("--epochs")) !== 200) {
    throw new Error("Explicit --epochs 200 required in --mode train");
  }
  if (!options.has("--learning-rate") || Number(options.get("--learning-rate")) !== 0.1) {
    throw new Error("Explicit --learning-rate 0.1 required in --mode train");
  }
}

const ownerRoot = await mkdtemp(join(tmpdir(), "nn-shared-training-consumer-"));
const startedAt = new Date().toISOString();
const started = performance.now();

function compactSummary(summary) {
  return {
    count: summary.count,
    correct: summary.correct,
    passed: summary.passed,
    effectsCorrect: Object.values(summary.byCase).reduce((total, item) => total + item.effectsCorrect, 0),
  };
}

function compactRowSubsetSummary(rows) {
  const count = rows.length;
  const correct = rows.filter(row => row.correct).length;
  const effectsCorrect = rows.filter(row => row.effectsOk && row.sideEffectsOk).length;
  return {
    count,
    correct,
    effectsCorrect,
    passed: count > 0 && rows.every(row => row.correct && row.effectsOk && row.sideEffectsOk),
  };
}

async function verifyOriginal358SemanticPreservation(dataset, prepared, referenceSamplesPath, expectedStage) {
  const rawReference = JSON.parse(await readFile(referenceSamplesPath, "utf8"));
  const referencePrepared = prepareCliCommandDataset(rawReference, ["train", "development"], expectedStage);
  assert.equal(referencePrepared.samples.length, 358);
  const currentOriginalSamples = dataset.samples.filter(sample => !isAppendedStage2Sample(sample));
  assert.equal(currentOriginalSamples.length, 358);

  const currentById = new Map(currentOriginalSamples.map(sample => [sample.id, sample]));
  assert.equal(currentById.size, 358);

  let comparedRows = 0;
  let preservedUnobservedRows = 0;
  let preservedRun4e249c32FailingStaleRows = 0;
  const preservedUnobservedDetails = [];

  for (const refSample of referencePrepared.samples) {
    const curSample = currentById.get(refSample.id);
    assert.ok(curSample, `Missing original sample ID ${refSample.id} in 370-row dataset`);
    assert.equal(curSample.scenarioId, refSample.scenarioId, `scenarioId mismatch on ${refSample.id}`);
    assert.equal(curSample.sourceGroup, refSample.sourceGroup, `sourceGroup mismatch on ${refSample.id}`);
    assert.equal(curSample.partition, refSample.partition, `partition mismatch on ${refSample.id}`);
    assert.equal(curSample.case, refSample.case, `case mismatch on ${refSample.id}`);
    assert.equal(curSample.variant ?? null, refSample.variant ?? null, `variant mismatch on ${refSample.id}`);
    assert.equal(curSample.expectedHead, refSample.expectedHead, `expectedHead mismatch on ${refSample.id}`);
    assert.equal(curSample.expectedStatus, refSample.expectedStatus, `expectedStatus mismatch on ${refSample.id}`);
    assert.equal(curSample.expectedSatisfaction, refSample.expectedSatisfaction, `expectedSatisfaction mismatch on ${refSample.id}`);
    assert.equal(curSample.query?.kind ?? null, refSample.query?.kind ?? null, `query.kind mismatch on ${refSample.id}`);
    if (refSample.query?.kind === "entry.select") {
      assert.equal(curSample.query.targetType, refSample.query.targetType, `query.targetType mismatch on ${refSample.id}`);
      assert.equal(curSample.query.selectorName, refSample.query.selectorName, `query.selectorName mismatch on ${refSample.id}`);
      assert.equal(curSample.query.listingState, refSample.query.listingState, `query.listingState mismatch on ${refSample.id}`);
      assert.equal(curSample.query.target.path, refSample.query.target.path, `query.target.path mismatch on ${refSample.id}`);
    }
    const refFacts = sampleFacts(refSample);
    const curFacts = sampleFacts(curSample);
    assert.deepEqual(curFacts, refFacts, `sampleFacts mismatch on ${refSample.id}`);

    const refScene = referencePrepared.scenes.get(refSample.scenarioId);
    const curScene = prepared.scenes.get(curSample.scenarioId);
    const refFeatures = sampleFeatures(refSample, refScene, expectedStage);
    const curFeatures = sampleFeatures(curSample, curScene, expectedStage);
    assert.deepEqual(curFeatures, refFeatures, `sampleFeatures mismatch on ${refSample.id}`);

    if (
      refSample.case === "select-entry-dir-unobserved"
      || refSample.case === "select-entry-file-unobserved"
    ) {
      preservedUnobservedRows += 1;
      if (refSample.query.listingState === "stale_listing" || refSample.query.listingState === "stale_selected") {
        preservedRun4e249c32FailingStaleRows += 1;
      }
      preservedUnobservedDetails.push({
        id: curSample.id,
        partition: curSample.partition,
        case: curSample.case,
        variant: curSample.variant,
        listingState: curSample.query.listingState,
        facts: [
          curFacts.hasFreshEvidence,
          curFacts.knownValue,
          curFacts.requiredConditionHolds,
          curFacts.hasDestinationRef,
        ],
        expectedHead: curSample.expectedHead,
      });
    }
    comparedRows += 1;
  }

  assert.equal(comparedRows, 358);
  assert.equal(preservedUnobservedRows, 12);
  assert.equal(preservedRun4e249c32FailingStaleRows, 9);

  return {
    referenceSamplesPath,
    comparedRows,
    trainRows: currentOriginalSamples.filter(sample => sample.partition === "train").length,
    developmentRows: currentOriginalSamples.filter(sample => sample.partition === "development").length,
    preservedUnobservedRows,
    preservedRun4e249c32FailingStaleRows,
    allFieldsFactsAndFeaturesIdentical: true,
    preservedUnobservedDetails,
  };
}

function verifyNamedMigration(rawSource, migrated, expectedStage) {
  const expectedHeads = expectedStage === "stage2-13x38" ? 13 : 11;
  const expectedWires = expectedStage === "stage2-13x38" ? 38 : 34;
  const expectedParameters = expectedHeads * expectedWires;
  assert.equal(migrated.heads.length, expectedHeads);
  assert.equal(migrated.wires.length, expectedWires);
  assert.equal(migrated.weights.length, expectedHeads);
  assert.equal(migrated.weights.every(row => row.length === expectedWires), true);
  assert.equal(migrated.weights.flat().length, expectedParameters);
  assert.equal(migrated.calibration, "uncalibrated");
  assert.equal(migrated.adoption, "not_applied");

  let copiedCount = 0;
  let zeroFilledCount = 0;
  for (let rowIndex = 0; rowIndex < migrated.heads.length; rowIndex += 1) {
    const head = migrated.heads[rowIndex];
    const sourceRow = Array.isArray(rawSource.heads) ? rawSource.heads.indexOf(head) : -1;
    for (let colIndex = 0; colIndex < migrated.wires.length; colIndex += 1) {
      const wire = migrated.wires[colIndex];
      const sourceCol = Array.isArray(rawSource.wires) ? rawSource.wires.indexOf(wire) : -1;
      const actual = migrated.weights[rowIndex][colIndex];
      if (sourceRow !== -1 && sourceCol !== -1) {
        const expected = rawSource.weights[sourceRow][sourceCol];
        assert.equal(actual, expected, `Named migration mismatch at (${head}, ${wire})`);
        copiedCount += 1;
      } else {
        assert.equal(actual, 0, `New slot (${head}, ${wire}) must be zero-filled`);
        zeroFilledCount += 1;
      }
    }
  }

  const inspectHeadIdx = migrated.heads.indexOf("entry.inspect");
  const nameWireIdx = migrated.wires.indexOf("search.nameNeedleSegment");
  const p3NameWeightAfter = migrated.weights[inspectHeadIdx][nameWireIdx];
  const srcInspectIdx = Array.isArray(rawSource.heads) ? rawSource.heads.indexOf("entry.inspect") : -1;
  const srcNameWireIdx = Array.isArray(rawSource.wires) ? rawSource.wires.indexOf("search.nameNeedleSegment") : -1;
  const p3NameWeightBefore =
    srcInspectIdx !== -1 && srcNameWireIdx !== -1
      ? rawSource.weights[srcInspectIdx][srcNameWireIdx]
      : null;
  if (p3NameWeightBefore !== null) {
    assert.equal(p3NameWeightAfter, p3NameWeightBefore);
  }

  return {
    sourceHeads: Array.isArray(rawSource.heads) ? rawSource.heads.length : null,
    sourceWires: Array.isArray(rawSource.wires) ? rawSource.wires.length : null,
    sourceParameters: Array.isArray(rawSource.weights) ? rawSource.weights.flat().length : null,
    targetHeads: migrated.heads.length,
    targetWires: migrated.wires.length,
    targetParameters: migrated.weights.flat().length,
    copiedByName: copiedCount,
    zeroFilledNewSlots: zeroFilledCount,
    p3NameNeedleWeightBefore: p3NameWeightBefore,
    p3NameNeedleWeightAfter: p3NameWeightAfter,
    p3NameNeedleDelta: p3NameWeightBefore === null ? null : p3NameWeightAfter - p3NameWeightBefore,
  };
}

const STAGE1_NEW_WIRES = new Set([
  "property.path.physical",
  "predicate.observe.physical",
  "predicate.observe.resolvedTarget",
]);
const STAGE2_NEW_WIRES = new Set([
  "predicate.select.entry",
  "selectorTargetType.unspecified",
  "selectorTargetType.regular",
  "selectorTargetType.directory",
]);
const STAGE0_31_WIRES = CLI_COMMAND_WIRES.filter(
  wire => !STAGE1_NEW_WIRES.has(wire) && !STAGE2_NEW_WIRES.has(wire),
);
const STAGE1_34_WIRES = CLI_COMMAND_WIRES.filter(
  wire => !STAGE2_NEW_WIRES.has(wire),
);

function mapPreferenceRowFeaturesToStage1(rawRow, sourceWires) {
  const mapVector = vec => {
    if (!Array.isArray(vec)) {
      throw new TypeError(`Preference row ${rawRow.id} feature vector must be an array`);
    }
    if (vec.length === CLI_COMMAND_WIRES.length) {
      return [...vec];
    }
    const candidateWireTables = [
      ...(Array.isArray(sourceWires) ? [sourceWires] : []),
      STAGE1_34_WIRES,
      STAGE0_31_WIRES,
    ];
    const matchedWires = candidateWireTables.find(wires => wires.length === vec.length);
    if (matchedWires !== undefined) {
      return CLI_COMMAND_WIRES.map(wire => {
        const sourceCol = matchedWires.indexOf(wire);
        return sourceCol === -1 ? 0 : vec[sourceCol];
      });
    }
    throw new TypeError(
      `Preference row ${rawRow.id} feature length ${vec.length} does not match current (${CLI_COMMAND_WIRES.length}), Stage 1 (${STAGE1_34_WIRES.length}), or Stage 0 (${STAGE0_31_WIRES.length})`,
    );
  };
  return Object.freeze({
    id: rawRow.id,
    sourceGroup: rawRow.sourceGroup,
    partition: rawRow.partition,
    preferredName: rawRow.preferredName,
    otherName: rawRow.otherName,
    preferredFeatures: Object.freeze(mapVector(rawRow.preferredFeatures)),
    otherFeatures: Object.freeze(mapVector(rawRow.otherFeatures)),
    evidenceRefs: Object.freeze([...(rawRow.evidenceRefs ?? [])]),
  });
}

function evaluateP3PreferencePairs(profile, mappedRows, p3SamplesPath, referenceProfile = null) {
  const preparedPref = prepareCliCandidatePreferenceDataset(mappedRows);
  assert.equal(preparedPref.validPairCount, 24);
  assert.equal(preparedPref.deltaOneCount, 24);
  assert.equal(preparedPref.deltaZeroCount, 0);

  const inspectRow = profile.heads.indexOf("entry.inspect");
  const nameCol = profile.wires.indexOf("search.nameNeedleSegment");
  assert.notEqual(inspectRow, -1);
  assert.notEqual(nameCol, -1);
  const inspectWeights = profile.weights[inspectRow];
  const nameWeight = inspectWeights[nameCol];
  const referenceNameWeight =
    referenceProfile !== null
      ? referenceProfile.weights[referenceProfile.heads.indexOf("entry.inspect")][
          referenceProfile.wires.indexOf("search.nameNeedleSegment")
        ]
      : nameWeight;
  const nameWeightDelta = nameWeight - referenceNameWeight;
  assert.equal(nameWeightDelta, 0, "entry.inspect × search.nameNeedleSegment must remain invariant (delta=0)");

  const dotUtility = features =>
    profile.wires.reduce((sum, wire, col) => {
      const featureCol = CLI_COMMAND_WIRES.indexOf(wire);
      return Math.fround(sum + Math.fround(Math.fround(inspectWeights[col]) * features[featureCol]));
    }, 0);

  const evaluatedRows = preparedPref.rows.map(row => {
    const preferredUtility = dotUtility(row.preferredFeatures);
    const otherUtility = dotUtility(row.otherFeatures);
    const margin = preferredUtility - otherUtility;
    return Object.freeze({
      id: row.id,
      sourceGroup: row.sourceGroup,
      partition: row.partition,
      preferredName: row.preferredName,
      otherName: row.otherName,
      preferredUtility,
      otherUtility,
      margin,
      correct: margin > 0,
    });
  });
  const correctCount = evaluatedRows.filter(row => row.correct).length;
  assert.equal(correctCount, 24, `Expected 24/24 P3 candidate preference pairs to pass, got ${correctCount}/24`);
  return {
    samplesPath: p3SamplesPath,
    validPairCount: preparedPref.validPairCount,
    deltaOneCount: preparedPref.deltaOneCount,
    deltaZeroCount: preparedPref.deltaZeroCount,
    correct: correctCount,
    passed: correctCount === preparedPref.validPairCount,
    head: "entry.inspect",
    wire: "search.nameNeedleSegment",
    weightBefore: referenceNameWeight,
    weightAfter: nameWeight,
    weightDelta: nameWeightDelta,
    rows: evaluatedRows,
  };
}

function summarizeExecutionTiming(rows, headNames) {
  const perHeadSetup = Object.fromEntries(headNames.map(head => [head, { count: 0, totalMs: 0, meanMs: 0 }]));
  const perHeadCandidate = Object.fromEntries(headNames.map(head => [head, { count: 0, totalMs: 0, meanMs: 0 }]));
  const perHeadTotal = Object.fromEntries(headNames.map(head => [head, { count: 0, totalMs: 0, meanMs: 0 }]));
  let setupTotalMs = 0;
  let candidateStepTotalMs = 0;
  let evaluationTotalMs = 0;
  for (const row of rows) {
    const head = row.selectedHead;
    const setupMs = row.setupWallTimeMs ?? 0;
    const candidateMs = row.candidateStepWallTimeMs ?? 0;
    const totalMs = row.totalWallTimeMs ?? (setupMs + candidateMs);
    setupTotalMs += setupMs;
    candidateStepTotalMs += candidateMs;
    evaluationTotalMs += totalMs;
    if (perHeadSetup[head]) {
      perHeadSetup[head].count += 1;
      perHeadSetup[head].totalMs += setupMs;
      perHeadCandidate[head].count += 1;
      perHeadCandidate[head].totalMs += candidateMs;
      perHeadTotal[head].count += 1;
      perHeadTotal[head].totalMs += totalMs;
    }
  }
  for (const head of headNames) {
    if (perHeadSetup[head].count > 0) {
      perHeadSetup[head].meanMs = perHeadSetup[head].totalMs / perHeadSetup[head].count;
      perHeadCandidate[head].meanMs = perHeadCandidate[head].totalMs / perHeadCandidate[head].count;
      perHeadTotal[head].meanMs = perHeadTotal[head].totalMs / perHeadTotal[head].count;
    }
  }
  return {
    includesPreStepSetupInTotal: true,
    setupTotalMs,
    candidateStepTotalMs,
    evaluationTotalMs,
    perHeadSetupWallTimeMs: perHeadSetup,
    perHeadCandidateStepWallTimeMs: perHeadCandidate,
    perHeadEvalWallTimeMs: perHeadTotal,
  };
}

function replaceScenarioPrefix(value, oldId, newId, oldGroup, newGroup, oldToken, newToken, oldStart, newStart, oldTarget, newTarget) {
  if (typeof value === "string") {
    return value
      .replaceAll(oldId, newId)
      .replaceAll(oldGroup, newGroup)
      .replaceAll(oldStart, newStart)
      .replaceAll(oldTarget, newTarget)
      .replaceAll(oldToken, newToken);
  }
  if (Array.isArray(value)) {
    return value.map(item =>
      replaceScenarioPrefix(item, oldId, newId, oldGroup, newGroup, oldToken, newToken, oldStart, newStart, oldTarget, newTarget),
    );
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = replaceScenarioPrefix(v, oldId, newId, oldGroup, newGroup, oldToken, newToken, oldStart, newStart, oldTarget, newTarget);
    }
    return out;
  }
  return value;
}

async function buildDevelopmentDerivedDiagnosticDataset(baseDataset, rootDir, expectedStage = "stage2-13x38") {
  const legacyTemplate = baseDataset.scenarios.find(scene => scene.id === "development-extension-types");
  const batch1Template = baseDataset.scenarios.find(scene => scene.id === "development-path-siblings");
  assert.ok(legacyTemplate && batch1Template);

  const legacyScene = {
    ...replaceScenarioPrefix(
      structuredClone(legacyTemplate),
      "development-extension-types",
      "diagnostic-derived-extension-types",
      "development-extension-types",
      "development-extension-types",
      "folder.txt",
      "verify-folder.txt",
      "source/start",
      "verify-source/start",
      "ending/root",
      "verify-ending/root",
    ),
    sourceGroup: "development-extension-types",
    partition: "development",
  };
  legacyScene.recipe = {
    ...legacyScene.recipe,
    entries: legacyScene.recipe.entries.map(entry => {
      if (entry.path === "source") return { ...entry, path: "verify-source" };
      if (entry.path === "ending") return { ...entry, path: "verify-ending" };
      return entry;
    }),
  };

  const batch1Scene = {
    ...replaceScenarioPrefix(
      structuredClone(batch1Template),
      "development-path-siblings",
      "diagnostic-derived-path-siblings",
      "development-path-siblings",
      "development-path-siblings",
      "dev-left",
      "verify-ind",
      "families/dev/sibling/left/entry",
      "families/verify/sibling/left/entry",
      "families/dev/sibling/right/exit",
      "families/verify/sibling/right/exit",
    ),
    sourceGroup: "development-path-siblings",
    partition: "development",
  };
  batch1Scene.recipe = {
    ...batch1Scene.recipe,
    entries: batch1Scene.recipe.entries.map(entry => ({
      ...entry,
      path: entry.path.replace("families/dev", "families/verify"),
    })),
  };

  const legacySamples = baseDataset.samples
    .filter(sample => sample.scenarioId === legacyTemplate.id)
    .map(sample => ({
      ...replaceScenarioPrefix(
        structuredClone(sample),
        "development-extension-types",
        "diagnostic-derived-extension-types",
        "development-extension-types",
        "development-extension-types",
        "folder.txt",
        "verify-folder.txt",
        "source/start",
        "verify-source/start",
        "ending/root",
        "verify-ending/root",
      ),
      sourceGroup: "development-extension-types",
      partition: "development",
    }));

  const sandbox = await createCliFilesystemSandbox({
    root: rootDir,
    recipe: batch1Scene.recipe,
    ownerGrantedEffects: ["filesystem.write"],
  });
  let batch1Samples = [];
  try {
    for (const item of batch1Scene.pathFixtures.symlinks) {
      await symlink(item.target, join(sandbox.scenarioRoot, item.path));
    }
    const session = sandbox.bindSession("s");
    const queries = new Map();
    for (const item of batch1Scene.pathFixtures.resolve) {
      queries.set(item.id, {
        kind: "path.resolve",
        base: sandbox.bindPath(session, join(sandbox.scenarioRoot, item.base)),
        input: item.input,
      });
    }
    for (const item of batch1Scene.pathFixtures.relative) {
      queries.set(item.id, {
        kind: "path.relative",
        from: sandbox.bindPath(session, join(sandbox.scenarioRoot, item.from)),
        to: sandbox.bindPath(session, join(sandbox.scenarioRoot, item.to)),
      });
    }
    for (const item of batch1Scene.pathFixtures.parts) {
      queries.set(item.id, {
        kind: "path.parts",
        property: item.property,
        path: sandbox.bindPath(session, join(sandbox.scenarioRoot, item.path)),
      });
    }
    for (const item of batch1Scene.pathFixtures.realpath ?? []) {
      const abs = join(sandbox.scenarioRoot, item.path);
      const ref = item.refKind === "cli.path"
        ? sandbox.bindPath(session, abs)
        : item.refKind === "cli.entry"
          ? await sandbox.bindEntry(session, abs)
          : item.refKind === "cli.file"
            ? await sandbox.bindFile(session, abs)
            : await sandbox.bindDirectoryObject(session, abs);
      queries.set(item.id, { kind: "path.realpath", ref });
    }
    for (const item of batch1Scene.pathFixtures.inspect) {
      const abs = join(sandbox.scenarioRoot, item.path);
      const ref = item.refKind === "cli.path"
        ? sandbox.bindPath(session, abs)
        : item.refKind === "cli.entry"
          ? await sandbox.bindEntry(session, abs)
          : item.refKind === "cli.file"
            ? await sandbox.bindFile(session, abs)
            : await sandbox.bindDirectoryObject(session, abs);
      queries.set(item.id, {
        kind: "inspect",
        property: item.property,
        ref,
        followSymlinks: item.followSymlinks,
        ...(item.requirementKind === "resolvedTarget" ? { requirementKind: "resolvedTarget" } : {}),
      });
    }
    if (expectedStage === "stage2-13x38" && (batch1Scene.pathFixtures.entrySelect ?? []).length > 0) {
      const targetAbsolute = join(sandbox.scenarioRoot, batch1Scene.targetPath);
      const targetDirectory = await sandbox.bindDirectory(
        session,
        relative(sandbox.getSession(session).cwd, targetAbsolute) || ".",
      );
      const targetPhysical = await realpath(targetAbsolute);
      for (const item of batch1Scene.pathFixtures.entrySelect ?? []) {
        queries.set(item.id, {
          kind: "entry.select",
          target: targetDirectory,
          parent: targetPhysical,
          targetType: item.targetType,
          selectorName: item.selectorName,
          listingState: item.listingState,
        });
      }
    }
    batch1Samples = baseDataset.samples
      .filter(sample => sample.scenarioId === batch1Template.id)
      .map(sample => ({
        ...structuredClone(sample),
        id: sample.id.replace("development-path-siblings", "diagnostic-derived-path-siblings"),
        scenarioId: "diagnostic-derived-path-siblings",
        sourceGroup: "development-path-siblings",
        partition: "development",
        query: queries.get(sample.variant),
      }));
  } finally {
    await sandbox.cleanup();
  }

  const diagnosticDataset = {
    version: 3,
    role: "development-derived-diagnostic-only",
    admittedAsIndependentVerification: false,
    usedForFittingOrSelection: false,
    scenarios: [legacyScene, batch1Scene],
    samples: [...legacySamples, ...batch1Samples],
  };
  const preparedDiagnostic = prepareCliCommandDataset(diagnosticDataset, ["development"], expectedStage);
  assert.equal(preparedDiagnostic.samples.length, expectedStage === "stage1-11x34" ? 52 : 62);
  return { diagnosticDataset, preparedDiagnostic };
}

function buildEngineeringPrefitWitnessProfile(migratedZeroFillProfile, expectedStage) {
  if (expectedStage === "stage1-11x34") {
    return validateCliCommandProfile(migratedZeroFillProfile, expectedStage);
  }
  const weights = migratedZeroFillProfile.weights.map(row => [...row]);
  // 18 analytical slots inside the 120 new Stage 2 slots (cols 28..31 and rows 11..12)
  // 1. row 0 (unsupported): +6 on col 28 (predicate.select.entry), -6 on col 30 (regular), -6 on col 31 (directory)
  weights[0][28] = 6;
  weights[0][30] = -6;
  weights[0][31] = -6;
  // 2. row 1 (DEFER): +4 on col 28 (predicate.select.entry)
  weights[1][28] = 4;
  // 3. row 11 (directory.select): 7 slots
  weights[11][28] = -4;
  weights[11][29] = -10;
  weights[11][30] = -10;
  weights[11][31] = 4;
  weights[11][32] = 4;
  weights[11][35] = 2;
  weights[11][37] = -6;
  // 4. row 12 (file.select): 7 slots
  weights[12][28] = -4;
  weights[12][29] = -10;
  weights[12][30] = 4;
  weights[12][31] = -10;
  weights[12][32] = 4;
  weights[12][35] = 2;
  weights[12][37] = -6;
  return validateCliCommandProfile({
    contract: migratedZeroFillProfile.contract,
    heads: migratedZeroFillProfile.heads,
    properties: migratedZeroFillProfile.properties,
    predicates: migratedZeroFillProfile.predicates,
    wires: migratedZeroFillProfile.wires,
    weights: weights.map(row => Object.freeze(row)),
    calibration: "uncalibrated",
    adoption: "not_applied",
  }, expectedStage);
}

async function verifyEngineeringPrefitWitness({
  migratedProfile,
  witnessProfile,
  prepared,
  stage0Samples,
  stage1Samples,
  stage2Samples,
  mappedP3Rows,
  p3SamplesPath,
  entrySelectProfiles,
  outputRoot,
  expectedStage,
}) {
  if (expectedStage === "stage1-11x34") {
    const stage0And1Samples = [...stage0Samples, ...stage1Samples];
    assert.equal(stage0And1Samples.length, 310);
    assert.equal(stage2Samples.length, 0);
    let stage0And1Correct = 0;
    for (const sample of stage0And1Samples) {
      const scene = prepared.scenes.get(sample.scenarioId);
      const goal = sampleGoal(sample, scene);
      const facts = sampleFacts(sample);
      const pred = predictCliCommand(goal, facts, witnessProfile, sample.case !== "unregistered-property", expectedStage);
      assert.equal(pred.selectedHead, sample.expectedHead);
      stage0And1Correct += 1;
    }
    assert.equal(stage0And1Correct, 310);
    const witnessP3Preference = evaluateP3PreferencePairs(
      witnessProfile,
      mappedP3Rows,
      p3SamplesPath,
      migratedProfile,
    );
    const runtimeEvidencePath = join(outputRoot, "witness-runtime-executions.jsonl");
    await writeFile(runtimeEvidencePath, "", "utf8");
    let runtimeChecked = 0;
    let runtimeFactsMatched = 0;
    let runtimeFeaturesMatched = 0;
    let runtimeEffectsCorrect = 0;
    const executedRows = [];
    for (const sample of prepared.samples) {
      const scene = prepared.scenes.get(sample.scenarioId);
      const row = await executeCliCommandTrainingSample(
        sample,
        scene,
        witnessProfile,
        (binding, authority) => createCliCommandPolicy({
          ...binding,
          stage: binding.stage ?? expectedStage,
        }, authority),
        runtimeEvidencePath,
        { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
        { stage: expectedStage },
      );
      executedRows.push(row);
      runtimeChecked += 1;
      if (row.factsMatched) runtimeFactsMatched += 1;
      if (row.featuresMatched) runtimeFeaturesMatched += 1;
      if (row.correct && row.effectsOk && row.sideEffectsOk) runtimeEffectsCorrect += 1;
      assert.equal(row.factsMatched, true, `Runtime facts mismatch on ${sample.id}`);
      assert.equal(row.featuresMatched, true, `Runtime features mismatch on ${sample.id}`);
      assert.equal(row.correct, true, `Runtime selectedHead mismatch on ${sample.id}`);
      assert.equal(row.effectsOk, true, `Runtime effectsOk failed on ${sample.id} (reason=${row.reason})`);
      assert.equal(row.sideEffectsOk, true, `Runtime sideEffectsOk failed on ${sample.id}`);
    }
    assert.equal(runtimeChecked, 310);
    assert.equal(runtimeFactsMatched, 310);
    assert.equal(runtimeFeaturesMatched, 310);
    assert.equal(runtimeEffectsCorrect, 310);
    const timing = summarizeExecutionTiming(executedRows, witnessProfile.heads);
    return {
      provenance: {
        fitted: false,
        role: "stage1_11x34_validation_witness",
        notATrainedCapabilityResult: true,
      },
      stage0And1Invariance: {
        total: 310,
        correct: stage0And1Correct,
        maxStage01LogitAbsDelta: 0,
        passed: stage0And1Correct === 310,
      },
      p3PreferenceRegression: {
        validPairCount: witnessP3Preference.validPairCount,
        correct: witnessP3Preference.correct,
        weightDelta: witnessP3Preference.weightDelta,
        passed: witnessP3Preference.passed,
      },
      runtimeFactsAndFeaturesMatch: {
        checked: runtimeChecked,
        factsMatched: runtimeFactsMatched,
        featuresMatched: runtimeFeaturesMatched,
        effectsCorrect: runtimeEffectsCorrect,
        passed: runtimeFactsMatched === 310 && runtimeFeaturesMatched === 310 && runtimeEffectsCorrect === 310,
        executionsPath: runtimeEvidencePath,
      },
      timing,
    };
  }

  // 1. Verify 374 inherited Stage 1 slots are bitwise identical and exactly 18 of 120 new Stage 2 slots are non-zero
  const newStage2Cols = new Set([28, 29, 30, 31]);
  let inheritedBitwiseIdentical = 0;
  let newSlotsNonZero = 0;
  let newSlotsZero = 0;
  for (let r = 0; r < 13; r += 1) {
    for (let c = 0; c < 38; c += 1) {
      const isNewSlot = r >= 11 || newStage2Cols.has(c);
      if (!isNewSlot) {
        assert.equal(
          Object.is(witnessProfile.weights[r][c], migratedProfile.weights[r][c]),
          true,
          `Inherited Stage 1 slot (${r}, ${c}) must be bitwise identical`,
        );
        inheritedBitwiseIdentical += 1;
      } else {
        assert.equal(migratedProfile.weights[r][c], 0);
        if (witnessProfile.weights[r][c] !== 0) newSlotsNonZero += 1;
        else newSlotsZero += 1;
      }
    }
  }
  assert.equal(inheritedBitwiseIdentical, 374);
  assert.equal(newSlotsNonZero, 18);
  assert.equal(newSlotsZero, 102);

  // 2. Verify 310/310 Stage 0/1 logit invariance on rows 0..10 and overall argmax invariance across all 13 heads
  const stage0And1Samples = [...stage0Samples, ...stage1Samples];
  assert.equal(stage0And1Samples.length, 310);
  let stage0And1Correct = 0;
  let maxStage01LogitAbsDelta = 0;
  for (const sample of stage0And1Samples) {
    const scene = prepared.scenes.get(sample.scenarioId);
    const goal = sampleGoal(sample, scene);
    const facts = sampleFacts(sample);
    const basePred = predictCliCommand(goal, facts, migratedProfile, sample.case !== "unregistered-property", expectedStage);
    const witnessPred = predictCliCommand(goal, facts, witnessProfile, sample.case !== "unregistered-property", expectedStage);
    for (let r = 0; r < 11; r += 1) {
      const delta = Math.abs(witnessPred.scores[r] - basePred.scores[r]);
      if (delta > maxStage01LogitAbsDelta) maxStage01LogitAbsDelta = delta;
      assert.equal(delta, 0, `Stage 0/1 head ${r} logit changed on ${sample.id}`);
    }
    assert.equal(witnessPred.selectedHead, basePred.selectedHead);
    assert.equal(witnessPred.selectedHead, sample.expectedHead);
    stage0And1Correct += 1;
  }
  assert.equal(stage0And1Correct, 310);

  // 3. Verify 60/60 Stage 2 predictions (48 original + 12 appended) across all 5 bound PropertyFacts vectors
  assert.equal(stage2Samples.length, 60);
  let stage2Correct = 0;
  let stage2OriginalCorrect = 0;
  let stage2AppendedCorrect = 0;
  const boundFactsCounts = new Map();
  for (const sample of stage2Samples) {
    const scene = prepared.scenes.get(sample.scenarioId);
    const goal = sampleGoal(sample, scene);
    const facts = sampleFacts(sample);
    const key = `[${facts.hasFreshEvidence},${facts.knownValue},${facts.requiredConditionHolds},${facts.hasDestinationRef}]`;
    boundFactsCounts.set(key, (boundFactsCounts.get(key) ?? 0) + 1);
    const witnessPred = predictCliCommand(goal, facts, witnessProfile, true, expectedStage);
    assert.equal(witnessPred.selectedHead, sample.expectedHead, `Witness Stage 2 mismatch on ${sample.id} (${key})`);
    stage2Correct += 1;
    if (isAppendedStage2Sample(sample)) stage2AppendedCorrect += 1;
    else stage2OriginalCorrect += 1;
  }
  assert.equal(stage2Correct, 60);
  assert.equal(stage2OriginalCorrect, 48);
  assert.equal(stage2AppendedCorrect, 12);
  assert.deepEqual(
    [...boundFactsCounts.keys()].sort(),
    ["[0,0,0,1]", "[0,1,0,1]", "[0,1,1,1]", "[1,1,0,1]", "[1,1,1,1]"],
  );

  // 4. Separate engineering probe for unbound DirectoryQuery [0,0,0,0] -> DEFER (outside the 358/370-row denominators)
  const unboundGoal = Object.freeze({
    kind: "file.property",
    property: ENTRIES_PROPERTY,
    target: Object.freeze({
      kind: "cli.file-query",
      relation: "entrySelector",
      scopes: Object.freeze([]),
      selector: Object.freeze({ type: "directory", name: "work" }),
      cardinality: "one",
    }),
    requirement: Object.freeze({
      kind: "matches",
      predicate: Object.freeze({
        kind: "entrySelector",
        selector: Object.freeze({ name: "humanagent", parent: "/tmp/work", type: "directory" }),
        cardinality: "one",
      }),
    }),
  });
  const unboundFacts = Object.freeze({
    hasFreshEvidence: 0,
    knownValue: 0,
    requiredConditionHolds: 0,
    hasDestinationRef: 0,
  });
  const unboundDirPred = predictCliCommand(unboundGoal, unboundFacts, witnessProfile, true, expectedStage);
  assert.equal(unboundDirPred.selectedHead, "DEFER");

  // 5. Verify 24/24 P3 preference pairs on witnessProfile
  const witnessP3Preference = evaluateP3PreferencePairs(
    witnessProfile,
    mappedP3Rows,
    p3SamplesPath,
    migratedProfile,
  );
  assert.equal(witnessP3Preference.passed, true);
  assert.equal(witnessP3Preference.correct, 24);
  assert.equal(witnessP3Preference.weightDelta, 0);

  // 6. Execute all 370 rows (358 original + 12 appended) through executeCliCommandTrainingSample
  const runtimeEvidencePath = join(outputRoot, "witness-runtime-executions.jsonl");
  await writeFile(runtimeEvidencePath, "", "utf8");
  let runtimeChecked = 0;
  let runtimeFactsMatched = 0;
  let runtimeFeaturesMatched = 0;
  let runtimeEffectsCorrect = 0;
  let original358Checked = 0;
  let original358EffectsCorrect = 0;
  let appended12Checked = 0;
  let appended12EffectsCorrect = 0;
  const executedRows = [];
  for (const sample of prepared.samples) {
    const scene = prepared.scenes.get(sample.scenarioId);
    const row = await executeCliCommandTrainingSample(
      sample,
      scene,
      witnessProfile,
      (binding, authority) => createCliCommandPolicy({
        ...binding,
        stage: binding.stage ?? expectedStage,
        entrySelectProfiles,
      }, authority),
      runtimeEvidencePath,
      { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
      { stage: expectedStage, entrySelectProfiles },
    );
    executedRows.push(row);
    runtimeChecked += 1;
    if (row.factsMatched) runtimeFactsMatched += 1;
    if (row.featuresMatched) runtimeFeaturesMatched += 1;
    if (row.correct && row.effectsOk && row.sideEffectsOk) runtimeEffectsCorrect += 1;
    if (isAppendedStage2Sample(sample)) {
      appended12Checked += 1;
      if (row.correct && row.effectsOk && row.sideEffectsOk) appended12EffectsCorrect += 1;
    } else {
      original358Checked += 1;
      if (row.correct && row.effectsOk && row.sideEffectsOk) original358EffectsCorrect += 1;
    }
    assert.equal(row.factsMatched, true, `Runtime facts mismatch on ${sample.id}`);
    assert.equal(row.featuresMatched, true, `Runtime features mismatch on ${sample.id}`);
    assert.equal(row.correct, true, `Runtime selectedHead mismatch on ${sample.id}`);
    assert.equal(row.effectsOk, true, `Runtime effectsOk failed on ${sample.id} (reason=${row.reason})`);
    assert.equal(row.sideEffectsOk, true, `Runtime sideEffectsOk failed on ${sample.id}`);
  }
  assert.equal(runtimeChecked, 370);
  assert.equal(runtimeFactsMatched, 370);
  assert.equal(runtimeFeaturesMatched, 370);
  assert.equal(runtimeEffectsCorrect, 370);
  assert.equal(original358Checked, 358);
  assert.equal(original358EffectsCorrect, 358);
  assert.equal(appended12Checked, 12);
  assert.equal(appended12EffectsCorrect, 12);
  const timing = summarizeExecutionTiming(executedRows, witnessProfile.heads);

  return {
    provenance: {
      fitted: false,
      role: "engineering_prefit_witness_only",
      notATrainedCapabilityResult: true,
    },
    inheritedStage1SlotsBitwiseIdentical: inheritedBitwiseIdentical,
    newStage2SlotsTotal: 120,
    newStage2SlotsNonZero: newSlotsNonZero,
    newStage2SlotsZero: newSlotsZero,
    stage0And1Invariance: {
      total: 310,
      correct: stage0And1Correct,
      maxStage01LogitAbsDelta,
      passed: stage0And1Correct === 310 && maxStage01LogitAbsDelta === 0,
    },
    stage2KnownReplay: {
      total: 60,
      correct: stage2Correct,
      original48: {
        total: 48,
        correct: stage2OriginalCorrect,
        passed: stage2OriginalCorrect === 48,
      },
      appended12: {
        total: 12,
        correct: stage2AppendedCorrect,
        passed: stage2AppendedCorrect === 12,
      },
      boundPropertyFactsVectorsCovered: Object.fromEntries(boundFactsCounts),
      passed: stage2Correct === 60 && stage2OriginalCorrect === 48 && stage2AppendedCorrect === 12,
    },
    unboundDirectoryQueryEngineeringProbe: {
      includedIn358Denominator: false,
      includedIn370Denominator: false,
      factsVector: [0, 0, 0, 0],
      selectedHead: unboundDirPred.selectedHead,
      expectedHead: "DEFER",
      passed: unboundDirPred.selectedHead === "DEFER",
    },
    p3PreferenceRegression: {
      validPairCount: witnessP3Preference.validPairCount,
      correct: witnessP3Preference.correct,
      weightDelta: witnessP3Preference.weightDelta,
      passed: witnessP3Preference.passed,
    },
    runtimeFactsAndFeaturesMatch: {
      checked: runtimeChecked,
      factsMatched: runtimeFactsMatched,
      featuresMatched: runtimeFeaturesMatched,
      effectsCorrect: runtimeEffectsCorrect,
      original358: {
        checked: original358Checked,
        effectsCorrect: original358EffectsCorrect,
        passed: original358EffectsCorrect === 358,
      },
      appended12: {
        checked: appended12Checked,
        effectsCorrect: appended12EffectsCorrect,
        passed: appended12EffectsCorrect === 12,
      },
      passed: runtimeFactsMatched === 370 && runtimeFeaturesMatched === 370 && runtimeEffectsCorrect === 370,
      executionsPath: runtimeEvidencePath,
    },
    timing,
  };
}

try {
  await mkdir(outputRoot, { recursive: true });
  const rawSource = JSON.parse(await readFile(initialSource, "utf8"));
  const initial =
    stage === "stage1-11x34" &&
    Array.isArray(rawSource.heads) &&
    rawSource.heads.length === 11 &&
    Array.isArray(rawSource.wires) &&
    rawSource.wires.length === 34
      ? validateCliCommandProfile(rawSource, stage)
      : migrateCliCommandProfileToCurrent(rawSource, stage);
  validateCliCommandProfile(initial, stage);
  const migrationCheck = verifyNamedMigration(rawSource, initial, stage);
  if (stage === "stage2-13x38") {
    assert.equal(migrationCheck.copiedByName, 374);
    assert.equal(migrationCheck.zeroFilledNewSlots, 120);
    assert.equal(migrationCheck.p3NameNeedleWeightBefore, 2.9020536351949002);
    assert.equal(migrationCheck.p3NameNeedleWeightAfter, 2.9020536351949002);
    assert.equal(migrationCheck.p3NameNeedleDelta, 0);
  } else {
    assert.equal(migrationCheck.copiedByName, 374);
    assert.equal(migrationCheck.zeroFilledNewSlots, 0);
  }

  let entrySelectProfiles = undefined;
  let trackBProfilesSummary = null;
  if (stage === "stage2-13x38") {
    const directoryProfile = validateEntrySelectProfile(
      JSON.parse(await readFile(bDirectoryProfilePath, "utf8")),
    );
    const fileProfile = validateEntrySelectProfile(
      JSON.parse(await readFile(bFileProfilePath, "utf8")),
    );
    assert.equal(directoryProfile.contract, "cli.directory-select-relation.v1");
    assert.equal(fileProfile.contract, "cli.file-select-relation.v1");
    assert.equal(directoryProfile.calibration, "uncalibrated");
    assert.equal(directoryProfile.adoption, "not_applied");
    assert.equal(fileProfile.calibration, "uncalibrated");
    assert.equal(fileProfile.adoption, "not_applied");
    entrySelectProfiles = Object.freeze({
      directory: directoryProfile,
      regular: fileProfile,
    });
    trackBProfilesSummary = {
      directoryProfilePath: bDirectoryProfilePath,
      fileProfilePath: bFileProfilePath,
      directoryContract: directoryProfile.contract,
      fileContract: fileProfile.contract,
      directoryWeights: directoryProfile.weights,
      fileWeights: fileProfile.weights,
      calibration: "uncalibrated",
      adoption: "not_applied",
      frozenDuringStage2: true,
    };
  }

  const rawP3Samples = JSON.parse(await readFile(p3PreferenceSamplesPath, "utf8"));
  const mappedP3Rows = (rawP3Samples.preferenceRows ?? []).map(row =>
    mapPreferenceRowFeaturesToStage1(row, rawSource.wires),
  );
  const initialP3Preference = evaluateP3PreferencePairs(initial, mappedP3Rows, p3PreferenceSamplesPath, initial);

  const { dataset } = await makeCliCommandFixture({ root: ownerRoot, extended: true, stage });
  const prepared = prepareCliCommandDataset(dataset, ["train", "development"], stage);
  const { diagnosticDataset, preparedDiagnostic } = await buildDevelopmentDerivedDiagnosticDataset(dataset, ownerRoot, stage);
  const diagnosticDatasetPath = join(outputRoot, "development-derived-diagnostic-samples.json");
  await writeFile(diagnosticDatasetPath, `${JSON.stringify(diagnosticDataset, null, 2)}\n`, "utf8");
  assert.equal(dataset.version, 3);
  assert.equal(dataset.samples.length, stage === "stage1-11x34" ? 310 : 370);

  const trainSamples = dataset.samples.filter(sample => sample.partition === "train");
  const devSamples = dataset.samples.filter(sample => sample.partition === "development");
  const original358Samples = dataset.samples.filter(sample => !isAppendedStage2Sample(sample));
  const appended12Samples = dataset.samples.filter(sample => isAppendedStage2Sample(sample));
  const legacySamples = dataset.samples.filter(sample => !isBatch1CommandCase(sample.case));
  const batch1Samples = dataset.samples.filter(sample => isBatch1CommandCase(sample.case));
  const stage0Samples = dataset.samples.filter(sample => !isStage1Sample(sample) && !isStage2Sample(sample));
  const stage1Samples = dataset.samples.filter(sample => isStage1Sample(sample));
  const stage2Samples = dataset.samples.filter(sample => isStage2Sample(sample));

  assert.equal(trainSamples.length, stage === "stage1-11x34" ? 206 : 246);
  assert.equal(devSamples.length, stage === "stage1-11x34" ? 104 : 124);
  assert.equal(original358Samples.length, stage === "stage1-11x34" ? 310 : 358);
  assert.equal(original358Samples.filter(sample => sample.partition === "train").length, stage === "stage1-11x34" ? 206 : 238);
  assert.equal(original358Samples.filter(sample => sample.partition === "development").length, stage === "stage1-11x34" ? 104 : 120);
  assert.equal(appended12Samples.length, stage === "stage1-11x34" ? 0 : 12);
  assert.equal(appended12Samples.filter(sample => sample.partition === "train").length, stage === "stage1-11x34" ? 0 : 8);
  assert.equal(appended12Samples.filter(sample => sample.partition === "development").length, stage === "stage1-11x34" ? 0 : 4);
  assert.equal(legacySamples.length, 58);
  assert.equal(batch1Samples.length, stage === "stage1-11x34" ? 252 : 312);
  assert.equal(stage0Samples.length, 262);
  assert.equal(stage1Samples.length, 48);
  assert.equal(stage2Samples.length, stage === "stage1-11x34" ? 0 : 60);
  assert.equal(stage0Samples.filter(sample => sample.partition === "train").length, 174);
  assert.equal(stage0Samples.filter(sample => sample.partition === "development").length, 88);
  assert.equal(stage1Samples.filter(sample => sample.partition === "train").length, 32);
  assert.equal(stage1Samples.filter(sample => sample.partition === "development").length, 16);
  assert.equal(stage2Samples.filter(sample => sample.partition === "train").length, stage === "stage1-11x34" ? 0 : 40);
  assert.equal(stage2Samples.filter(sample => sample.partition === "development").length, stage === "stage1-11x34" ? 0 : 20);

  const postAchieved = dataset.samples.filter(sample => sample.expectedStatus === "achieved" && sample.expectedSatisfaction === 100);
  const postUnmet = dataset.samples.filter(sample => sample.expectedStatus === "unmet" && sample.expectedSatisfaction === 0);
  const postUnknown = dataset.samples.filter(sample => sample.expectedStatus === "unknown" && sample.expectedSatisfaction === null);
  assert.equal(postAchieved.length, stage === "stage1-11x34" ? 286 : 310);
  assert.equal(postAchieved.filter(sample => sample.partition === "train").length, stage === "stage1-11x34" ? 190 : 206);
  assert.equal(postAchieved.filter(sample => sample.partition === "development").length, stage === "stage1-11x34" ? 96 : 104);
  assert.equal(postUnmet.length, stage === "stage1-11x34" ? 6 : 18);
  assert.equal(postUnmet.filter(sample => sample.partition === "train").length, stage === "stage1-11x34" ? 4 : 12);
  assert.equal(postUnmet.filter(sample => sample.partition === "development").length, stage === "stage1-11x34" ? 2 : 6);
  assert.equal(
    postUnmet.every(
      sample =>
        (sample.case === "inspect-resolved-target-broken" && sample.expectedHead === "entry.inspect")
        || (sample.case === "select-entry-dir-not-found" && sample.expectedHead === "directory.select")
        || (sample.case === "select-entry-file-not-found" && sample.expectedHead === "file.select"),
    ),
    true,
  );
  assert.equal(postUnknown.length, stage === "stage1-11x34" ? 18 : 42);
  assert.equal(postUnknown.filter(sample => sample.partition === "train").length, stage === "stage1-11x34" ? 12 : 28);
  assert.equal(postUnknown.filter(sample => sample.partition === "development").length, stage === "stage1-11x34" ? 6 : 14);

  const trainGroups = new Set(trainSamples.map(sample => sample.sourceGroup));
  const devGroups = new Set(devSamples.map(sample => sample.sourceGroup));
  for (const group of trainGroups) {
    assert.equal(devGroups.has(group), false, `Source group ${group} crosses train and development`);
  }

  const original358Preservation = stage === "stage2-13x38"
    ? await verifyOriginal358SemanticPreservation(dataset, prepared, DEFAULT_ORIGINAL_358_SAMPLES_REFERENCE, stage)
    : null;

  if (mode === "validate-only") {
    const migratedZeroFillProfilePath = join(outputRoot, "migrated-zero-fill-profile.json");
    await writeFile(migratedZeroFillProfilePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

    const witnessProfilePath = join(outputRoot, "engineering-prefit-witness-profile.json");
    const witnessProfile = buildEngineeringPrefitWitnessProfile(initial, stage);
    await writeFile(witnessProfilePath, `${JSON.stringify(witnessProfile, null, 2)}\n`, "utf8");

    const witnessVerification = await verifyEngineeringPrefitWitness({
      migratedProfile: initial,
      witnessProfile,
      prepared,
      stage0Samples,
      stage1Samples,
      stage2Samples,
      mappedP3Rows,
      p3SamplesPath: p3PreferenceSamplesPath,
      entrySelectProfiles,
      outputRoot,
      expectedStage: stage,
    });

    let publicWorkflowZeroEpochProbe = null;
    if (stage === "stage2-13x38") {
      const probeOutputRoot = join(outputRoot, "public-workflow-zero-epoch-probe");
      await rm(probeOutputRoot, { recursive: true, force: true });
      await mkdir(probeOutputRoot, { recursive: true });
      const probeReceipt = await runCliCommandTraining({
        dataset,
        initial: witnessProfile,
        initialSource: witnessProfilePath,
        epochs: 0,
        learningRate: 0.1,
        stage,
        entrySelectProfiles,
      }, {
        handwiredRoot: outputRoot,
        outputRoot: probeOutputRoot,
        grantedEffects: ["filesystem.read", "filesystem.write"],
        entrySelectProfiles,
      });
      assert.equal(probeReceipt.accepted, true);
      assert.equal(probeReceipt.fullyVerified, false);
      assert.equal(probeReceipt.timing.completedEpochs, 0);
      assert.equal(probeReceipt.timing.gradientRowEpochs, 0);
      assert.equal(probeReceipt.timing.totalRowPasses, 0);
      assert.equal(probeReceipt.timing.backendLoadMs, 0);
      assert.equal(probeReceipt.timing.circuitBuildMs, 0);
      assert.equal(probeReceipt.timing.trainEpochGradMs, 0);
      assert.deepEqual(probeReceipt.profile, witnessProfile);

      const probeOriginal358 = {
        train: compactRowSubsetSummary(probeReceipt.comparison.train.rows.filter(row => !isAppendedStage2Sample(row))),
        development: compactRowSubsetSummary(probeReceipt.comparison.development.rows.filter(row => !isAppendedStage2Sample(row))),
      };
      const probeAppended12 = {
        train: compactRowSubsetSummary(probeReceipt.comparison.train.rows.filter(row => isAppendedStage2Sample(row))),
        development: compactRowSubsetSummary(probeReceipt.comparison.development.rows.filter(row => isAppendedStage2Sample(row))),
      };
      assert.equal(probeOriginal358.train.count, 238);
      assert.equal(probeOriginal358.train.correct, 238);
      assert.equal(probeOriginal358.train.passed, true);
      assert.equal(probeOriginal358.development.count, 120);
      assert.equal(probeOriginal358.development.correct, 120);
      assert.equal(probeOriginal358.development.passed, true);
      assert.equal(probeAppended12.train.count, 8);
      assert.equal(probeAppended12.train.correct, 8);
      assert.equal(probeAppended12.train.passed, true);
      assert.equal(probeAppended12.development.count, 4);
      assert.equal(probeAppended12.development.correct, 4);
      assert.equal(probeAppended12.development.passed, true);

      const savedProbeReport = JSON.parse(await readFile(probeReceipt.paths.report, "utf8"));
      await writeFile(
        probeReceipt.paths.report,
        `${JSON.stringify({ ...savedProbeReport, original358: probeOriginal358, appended12: probeAppended12 }, null, 2)}\n`,
        "utf8",
      );

      const probeReloadStarted = performance.now();
      const probeReloadArgs = [
        fileURLToPath(new URL("./reload.mjs", import.meta.url)),
        "--stage",
        stage,
        "--b-directory-profile",
        bDirectoryProfilePath,
        "--b-file-profile",
        bFileProfilePath,
        probeReceipt.paths.profile,
        probeReceipt.paths.samples,
        probeReceipt.paths.report,
      ];
      const { stdout: probeReloadStdout } = await execFileAsync(process.execPath, probeReloadArgs, {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      const probeReload = JSON.parse(probeReloadStdout);
      const probeReloadPath = join(dirname(probeReceipt.paths.report), "reload.json");
      await writeFile(probeReloadPath, JSON.stringify({ ...probeReload, reloadMs: performance.now() - probeReloadStarted }, null, 2) + "\n", { flag: "wx" });
      assert.equal(probeReload.fitted, false);
      assert.equal(probeReload.checked, dataset.samples.length);
      assert.equal(probeReload.executed, dataset.samples.length);
      assert.equal(probeReload.failed, 0);
      assert.equal(probeReload.unverified, 0);
      assert.equal(probeReload.original358.checked, 358);
      assert.equal(probeReload.original358.failed, 0);
      assert.equal(probeReload.original358.passed, true);
      assert.equal(probeReload.appended12.checked, 12);
      assert.equal(probeReload.appended12.failed, 0);
      assert.equal(probeReload.appended12.passed, true);
      assert.equal(probeReload.profileMatchesSavedFile, true);

      publicWorkflowZeroEpochProbe = {
        provenance: {
          fitted: false,
          epochs: 0,
          role: "engineering_prefit_witness_8n8e_wiring_probe_only",
          notATrainedCapabilityResult: true,
          notFormalTrainingInitialization: true,
          formalB2InitializerPath: migratedZeroFillProfilePath,
        },
        runId: probeReceipt.runId,
        accepted: probeReceipt.accepted,
        fullyVerified: probeReceipt.fullyVerified,
        paths: { ...probeReceipt.paths, reload: probeReloadPath },
        comparison: {
          train: compactSummary(probeReceipt.comparison.train),
          development: compactSummary(probeReceipt.comparison.development),
        },
        original358: probeOriginal358,
        appended12: probeAppended12,
        timing: probeReceipt.timing,
        reload: probeReload,
      };
    }

    const validationReceipt = {
      contract: "cli.command-training.validation.v1",
      stage,
      mode: "validate-only",
      startedAt,
      completedAt: new Date().toISOString(),
      completedEpochs: 0,
      trainingSteps: 0,
      handwiredLoaded: false,
      initialSource,
      migratedZeroFillProfilePath,
      witnessProfilePath,
      trackBProfiles: trackBProfilesSummary,
      schema: {
        heads: initial.heads.length,
        wires: initial.wires.length,
        parameters: initial.heads.length * initial.wires.length,
        headNames: initial.heads,
        wireNames: initial.wires,
      },
      migration: migrationCheck,
      counts: {
        total: dataset.samples.length,
        train: trainSamples.length,
        development: devSamples.length,
        original358: {
          total: original358Samples.length,
          train: original358Samples.filter(sample => sample.partition === "train").length,
          development: original358Samples.filter(sample => sample.partition === "development").length,
        },
        appended12: {
          total: appended12Samples.length,
          train: appended12Samples.filter(sample => sample.partition === "train").length,
          development: appended12Samples.filter(sample => sample.partition === "development").length,
        },
        legacy: legacySamples.length,
        batch1: batch1Samples.length,
        byStage: {
          stage0: {
            total: stage0Samples.length,
            train: stage0Samples.filter(sample => sample.partition === "train").length,
            development: stage0Samples.filter(sample => sample.partition === "development").length,
          },
          stage1: {
            total: stage1Samples.length,
            train: stage1Samples.filter(sample => sample.partition === "train").length,
            development: stage1Samples.filter(sample => sample.partition === "development").length,
            byCase: {
              "path-realpath": stage1Samples.filter(sample => sample.case === "path-realpath").length,
              "inspect-resolved-target": stage1Samples.filter(sample => sample.case === "inspect-resolved-target").length,
              "inspect-resolved-target-broken": stage1Samples.filter(sample => sample.case === "inspect-resolved-target-broken").length,
              "inspect-link-target": stage1Samples.filter(sample => sample.variant === "link-target-c").length,
            },
          },
          stage2: {
            total: stage2Samples.length,
            train: stage2Samples.filter(sample => sample.partition === "train").length,
            development: stage2Samples.filter(sample => sample.partition === "development").length,
            original48: {
              total: stage2Samples.filter(sample => !isAppendedStage2Sample(sample)).length,
              train: stage2Samples.filter(sample => !isAppendedStage2Sample(sample) && sample.partition === "train").length,
              development: stage2Samples.filter(sample => !isAppendedStage2Sample(sample) && sample.partition === "development").length,
            },
            appended12: {
              total: stage2Samples.filter(sample => isAppendedStage2Sample(sample)).length,
              train: stage2Samples.filter(sample => isAppendedStage2Sample(sample) && sample.partition === "train").length,
              development: stage2Samples.filter(sample => isAppendedStage2Sample(sample) && sample.partition === "development").length,
            },
            byCase: {
              "select-entry-dir-ready": stage2Samples.filter(sample => sample.case === "select-entry-dir-ready").length,
              "select-entry-file-ready": stage2Samples.filter(sample => sample.case === "select-entry-file-ready").length,
              "select-entry-dir-not-found": stage2Samples.filter(sample => sample.case === "select-entry-dir-not-found").length,
              "select-entry-file-not-found": stage2Samples.filter(sample => sample.case === "select-entry-file-not-found").length,
              "select-entry-dir-unobserved": stage2Samples.filter(sample => sample.case === "select-entry-dir-unobserved").length,
              "select-entry-file-unobserved": stage2Samples.filter(sample => sample.case === "select-entry-file-unobserved").length,
              "select-entry-dir-satisfied-noop": stage2Samples.filter(sample => sample.case === "select-entry-dir-satisfied-noop").length,
              "select-entry-file-satisfied-noop": stage2Samples.filter(sample => sample.case === "select-entry-file-satisfied-noop").length,
            },
          },
        },
        byExpectedPostcondition: {
          achieved: {
            total: postAchieved.length,
            train: postAchieved.filter(sample => sample.partition === "train").length,
            development: postAchieved.filter(sample => sample.partition === "development").length,
          },
          unmet: {
            total: postUnmet.length,
            train: postUnmet.filter(sample => sample.partition === "train").length,
            development: postUnmet.filter(sample => sample.partition === "development").length,
          },
          unknown: {
            total: postUnknown.length,
            train: postUnknown.filter(sample => sample.partition === "train").length,
            development: postUnknown.filter(sample => sample.partition === "development").length,
          },
        },
      },
      original358Preservation,
      partitionIsolation: {
        trainSourceGroups: [...trainGroups].sort(),
        developmentSourceGroups: [...devGroups].sort(),
        overlapCount: 0,
      },
      developmentDerivedDiagnostic: {
        role: "development-derived-diagnostic-only",
        admittedAsIndependentVerification: false,
        usedForFittingOrSelection: false,
        path: diagnosticDatasetPath,
        preservedHistoricalReceiptPath: join(outputRoot, "verification-samples.json"),
        total: preparedDiagnostic.samples.length,
        legacy: diagnosticDataset.samples.filter(sample => !isBatch1CommandCase(sample.case)).length,
        batch1: diagnosticDataset.samples.filter(sample => isBatch1CommandCase(sample.case)).length,
        stage1: diagnosticDataset.samples.filter(sample => isStage1Sample(sample)).length,
        stage2: diagnosticDataset.samples.filter(sample => isStage2Sample(sample)).length,
        originalSourceGroups: [...new Set(diagnosticDataset.samples.map(sample => sample.sourceGroup))].sort(),
      },
      featureValidation: {
        checkedRows: prepared.samples.length,
        featureLength: initial.wires.length,
        conflictingFeatureLabelPairs: 0,
      },
      runtimeFactsAndFeaturesMatch: witnessVerification.runtimeFactsAndFeaturesMatch,
      timing: witnessVerification.timing,
      witnessVerification,
      publicWorkflowZeroEpochProbe,
      p3PreferenceRegression: {
        samplesPath: initialP3Preference.samplesPath,
        validPairCount: initialP3Preference.validPairCount,
        deltaOneCount: initialP3Preference.deltaOneCount,
        deltaZeroCount: initialP3Preference.deltaZeroCount,
        correct: initialP3Preference.correct,
        passed: initialP3Preference.passed,
        head: initialP3Preference.head,
        wire: initialP3Preference.wire,
        weightBefore: initialP3Preference.weightBefore,
        weightAfter: initialP3Preference.weightAfter,
        weightDelta: initialP3Preference.weightDelta,
      },
      evaluationEntries: {
        reloadConsumer: "node playground/cli/command-learning/reload.mjs --stage stage2-13x38 --b-directory-profile <dirProfile> --b-file-profile <fileProfile> <profilePath> <datasetPath> <reportPath>",
        independentSuite: "NN_CLI_COMMAND_STAGE=stage2-13x38 NN_CLI_COMMAND_PROFILE=<profilePath> NN_CLI_B_DIRECTORY_PROFILE=<dirProfile> NN_CLI_B_FILE_PROFILE=<fileProfile> NN_I7_REPORT=<reportPath> node --test tests/cli-path-primitives-independent.test.mjs",
        independentDenominators: {
          scenarios: 64,
          probes: 31,
          totalExecutedCases: 95,
          historicalKnownRegressionCases: 71,
          historicalStage0RegressionCases: 56,
          historicalStage1RegressionCases: 15,
          newStage2VerificationCases: 24,
          explicitUnverifiedEnvironmentItems: 5,
        },
        trainingReceiptVerificationStatus: "not_provided (fullyVerified=false; bounded verification supplied by external 95-case suite)",
        p3ContentSearchReload: "node playground/cli/content-search/reload-p3.mjs --profile <profilePath> --cases /Volumes/Intel/playground/nnanything-runs/cli-programming-search-p3-20261024/rework/verification-cases.json --condition <natural|forced-first> --output <reportPath>",
      },
      calibration: initial.calibration,
      adoption: initial.adoption,
      consumerMs: performance.now() - started,
    };
    const receiptPath = join(outputRoot, "validation-receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(validationReceipt, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...validationReceipt, receiptPath }, null, 2));
  } else {
    const epochs = Number(options.get("--epochs"));
    const learningRate = Number(options.get("--learning-rate"));
    const stageStatuses = {
      fit: "pending",
      reload: "not_run",
      p3PreferenceRegression: "not_run",
    };
    const receipt = await runCliCommandTraining({
      dataset,
      initial,
      initialSource,
      epochs,
      learningRate,
      stage,
      ...(entrySelectProfiles === undefined ? {} : { entrySelectProfiles }),
    }, {
      handwiredRoot: options.get("--handwired-root"),
      outputRoot,
      grantedEffects: ["filesystem.read", "filesystem.write"],
      ...(entrySelectProfiles === undefined ? {} : { entrySelectProfiles }),
    });

    const original358Summary = {
      train: compactRowSubsetSummary(receipt.comparison.train.rows.filter(row => !isAppendedStage2Sample(row))),
      development: compactRowSubsetSummary(receipt.comparison.development.rows.filter(row => !isAppendedStage2Sample(row))),
    };
    const appended12Summary = {
      train: compactRowSubsetSummary(receipt.comparison.train.rows.filter(row => isAppendedStage2Sample(row))),
      development: compactRowSubsetSummary(receipt.comparison.development.rows.filter(row => isAppendedStage2Sample(row))),
    };
    const savedReport = JSON.parse(await readFile(receipt.paths.report, "utf8"));
    await writeFile(
      receipt.paths.report,
      `${JSON.stringify({ ...savedReport, original358: original358Summary, appended12: appended12Summary }, null, 2)}\n`,
      "utf8",
    );

    stageStatuses.fit = receipt.accepted ? "passed" : "failed";
    if (!receipt.accepted) {
      throw new Error(`Stage 2 fit/evaluation did not pass acceptance gate (runId=${receipt.runId}, stageStatuses=${JSON.stringify(stageStatuses)})`);
    }

    if (stage === "stage2-13x38") {
      assert.equal(original358Summary.train.count, 238);
      assert.equal(original358Summary.train.correct, 238);
      assert.equal(original358Summary.train.passed, true);
      assert.equal(original358Summary.development.count, 120);
      assert.equal(original358Summary.development.correct, 120);
      assert.equal(original358Summary.development.passed, true);
      assert.equal(appended12Summary.train.count, 8);
      assert.equal(appended12Summary.train.correct, 8);
      assert.equal(appended12Summary.train.passed, true);
      assert.equal(appended12Summary.development.count, 4);
      assert.equal(appended12Summary.development.correct, 4);
      assert.equal(appended12Summary.development.passed, true);
    }

    const reloadStarted = performance.now();
    const reloadArgs = [
      fileURLToPath(new URL("./reload.mjs", import.meta.url)),
      "--stage",
      stage,
      ...(stage === "stage2-13x38"
        ? ["--b-directory-profile", bDirectoryProfilePath, "--b-file-profile", bFileProfilePath]
        : []),
      receipt.paths.profile,
      receipt.paths.samples,
      receipt.paths.report,
    ];
    const { stdout } = await execFileAsync(process.execPath, reloadArgs, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const reload = JSON.parse(stdout);
    const reloadPath = join(dirname(receipt.paths.report), "reload.json");
    await writeFile(reloadPath, JSON.stringify({ ...reload, reloadMs: performance.now() - reloadStarted }, null, 2) + "\n", { flag: "wx" });

    assert.equal(receipt.accepted, true);
    assert.equal(reload.fitted, false);
    assert.equal(reload.checked, dataset.samples.length);
    assert.equal(reload.executed, dataset.samples.length);
    assert.equal(reload.executedLegacy, 58);
    assert.equal(reload.executedBatch1, stage === "stage1-11x34" ? 252 : 312);
    assert.equal(reload.unverified, 0);
    assert.equal(reload.failed, 0);
    if (stage === "stage2-13x38") {
      assert.equal(reload.original358.checked, 358);
      assert.equal(reload.original358.failed, 0);
      assert.equal(reload.original358.passed, true);
      assert.equal(reload.appended12.checked, 12);
      assert.equal(reload.appended12.failed, 0);
      assert.equal(reload.appended12.passed, true);
    }
    assert.equal(reload.schema.heads, initial.heads.length);
    assert.equal(reload.schema.wires, initial.wires.length);
    assert.equal(reload.schema.parameters, initial.heads.length * initial.wires.length);
    assert.equal(reload.profileMatchesSavedFile, true);
    stageStatuses.reload = "passed";

    const postTrainP3Preference = evaluateP3PreferencePairs(
      receipt.profile,
      mappedP3Rows,
      p3PreferenceSamplesPath,
      initial,
    );
    const p3PreferencePath = join(dirname(receipt.paths.report), "p3-preference-regression.json");
    await writeFile(p3PreferencePath, `${JSON.stringify(postTrainP3Preference, null, 2)}\n`, { flag: "wx" });
    stageStatuses.p3PreferenceRegression = postTrainP3Preference.passed ? "passed" : "failed";

    console.log(JSON.stringify({
      runId: receipt.runId,
      stage,
      mode,
      startedAt,
      initialSource,
      stageStatuses,
      counts: {
        total: dataset.samples.length,
        train: trainSamples.length,
        development: devSamples.length,
        original358: {
          total: original358Samples.length,
          train: original358Samples.filter(sample => sample.partition === "train").length,
          development: original358Samples.filter(sample => sample.partition === "development").length,
        },
        appended12: {
          total: appended12Samples.length,
          train: appended12Samples.filter(sample => sample.partition === "train").length,
          development: appended12Samples.filter(sample => sample.partition === "development").length,
        },
        legacy: legacySamples.length,
        batch1: batch1Samples.length,
      },
      comparison: {
        train: compactSummary(receipt.comparison.train),
        development: compactSummary(receipt.comparison.development),
        verification: receipt.verification.status === "evaluated" ? compactSummary(receipt.verification.evaluation) : null,
      },
      original358: original358Summary,
      appended12: appended12Summary,
      fullyVerified: receipt.fullyVerified,
      p3PreferenceRegression: {
        samplesPath: postTrainP3Preference.samplesPath,
        validPairCount: postTrainP3Preference.validPairCount,
        correct: postTrainP3Preference.correct,
        passed: postTrainP3Preference.passed,
        weightBefore: postTrainP3Preference.weightBefore,
        weightAfter: postTrainP3Preference.weightAfter,
        weightDelta: postTrainP3Preference.weightDelta,
        reportPath: p3PreferencePath,
      },
      paths: { ...receipt.paths, reload: reloadPath, p3PreferenceRegression: p3PreferencePath },
      reload,
      timing: {
        ...receipt.timing,
        consumerMs: performance.now() - started,
      },
      calibration: receipt.profile.calibration,
      adoption: receipt.profile.adoption,
    }, null, 2));
  }
} finally {
  await rm(ownerRoot, { recursive: true, force: true });
}
