import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CLI_COMMAND_HEADS,
  CLI_COMMAND_WIRES,
  createCliFilesystemSandbox,
  isBatch1CommandCase,
  makeCliCommandFixture,
  migrateCliCommandProfileStage0ToStage1,
  migrateCliCommandProfileToCurrent,
  prepareCliCandidatePreferenceDataset,
  prepareCliCommandDataset,
  runCliCommandTraining,
  validateCliCommandProfile,
} from "nnanything/cli-goal";

const execFileAsync = promisify(execFile);
const DEFAULT_P3_PREFERENCE_SAMPLES =
  "/Volumes/Intel/playground/nnanything-runs/cli-programming-search-p3-20261024/rework/workflow-training/samples/filesystem/command/ba10a538-4d1f-46f6-9a0f-09e1287d6e88/samples.json";
const ALLOWED_FLAGS = new Set([
  "--stage",
  "--mode",
  "--handwired-root",
  "--output-root",
  "--initial-source",
  "--p3-preference-samples",
  "--epochs",
  "--learning-rate",
]);

const STAGE1_CASES = new Set([
  "path-realpath",
  "inspect-resolved-target",
  "inspect-resolved-target-broken",
]);

function isStage1Sample(sample) {
  return STAGE1_CASES.has(sample.case) || sample.variant === "link-target-c";
}

const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!ALLOWED_FLAGS.has(flag) || value === undefined || options.has(flag)) {
    throw new Error(
      "Expected --stage stage1-11x34 --mode <validate-only|train> --initial-source PATH --output-root PATH " +
      "[--handwired-root PATH --epochs 200 --learning-rate 0.1]",
    );
  }
  options.set(flag, value);
}

const stage = options.get("--stage");
if (stage !== "stage1-11x34") {
  throw new Error(`Explicit --stage stage1-11x34 required (received ${String(stage)})`);
}

const mode = options.get("--mode");
if (mode !== "validate-only" && mode !== "train") {
  throw new Error(`Explicit --mode <validate-only|train> required (received ${String(mode)})`);
}

if (!options.has("--initial-source")) {
  throw new Error("Explicit --initial-source PATH required");
}
if (!options.has("--output-root")) {
  throw new Error("Explicit --output-root PATH required");
}

const initialSource = resolve(options.get("--initial-source"));
const outputRoot = resolve(options.get("--output-root"));
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

function verifyNamedMigration(rawSource, migrated) {
  assert.equal(migrated.heads.length, 11);
  assert.equal(migrated.wires.length, 34);
  assert.equal(migrated.weights.length, 11);
  assert.equal(migrated.weights.every(row => row.length === 34), true);
  assert.equal(migrated.weights.flat().length, 374);
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

function mapPreferenceRowFeaturesToStage1(rawRow, sourceWires) {
  const mapVector = vec => {
    if (!Array.isArray(vec)) {
      throw new TypeError(`Preference row ${rawRow.id} feature vector must be an array`);
    }
    if (vec.length === CLI_COMMAND_WIRES.length) {
      return [...vec];
    }
    if (Array.isArray(sourceWires) && vec.length === sourceWires.length) {
      return CLI_COMMAND_WIRES.map(wire => {
        const sourceCol = sourceWires.indexOf(wire);
        return sourceCol === -1 ? 0 : vec[sourceCol];
      });
    }
    throw new TypeError(
      `Preference row ${rawRow.id} feature length ${vec.length} does not match Stage 1 (${CLI_COMMAND_WIRES.length}) or source (${sourceWires?.length ?? "unknown"})`,
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
    features.reduce((sum, value, col) => Math.fround(sum + Math.fround(Math.fround(inspectWeights[col]) * value)), 0);

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

async function buildDevelopmentDerivedDiagnosticDataset(baseDataset, rootDir) {
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
  const preparedDiagnostic = prepareCliCommandDataset(diagnosticDataset, ["development"]);
  assert.equal(preparedDiagnostic.samples.length, 52);
  return { diagnosticDataset, preparedDiagnostic };
}

try {
  await mkdir(outputRoot, { recursive: true });
  const rawSource = JSON.parse(await readFile(initialSource, "utf8"));
  const initial = migrateCliCommandProfileToCurrent(rawSource, stage);
  validateCliCommandProfile(initial, stage);
  if (Array.isArray(rawSource.heads) && rawSource.heads.length === 10 && Array.isArray(rawSource.wires) && rawSource.wires.length === 31) {
    assert.deepEqual(migrateCliCommandProfileStage0ToStage1(rawSource), initial);
  }
  const migrationCheck = verifyNamedMigration(rawSource, initial);
  const rawP3Samples = JSON.parse(await readFile(p3PreferenceSamplesPath, "utf8"));
  const mappedP3Rows = (rawP3Samples.preferenceRows ?? []).map(row =>
    mapPreferenceRowFeaturesToStage1(row, rawSource.wires),
  );
  const initialP3Preference = evaluateP3PreferencePairs(initial, mappedP3Rows, p3PreferenceSamplesPath, initial);

  const { dataset } = await makeCliCommandFixture({ root: ownerRoot, extended: true });
  const prepared = prepareCliCommandDataset(dataset, ["train", "development"]);
  const { diagnosticDataset, preparedDiagnostic } = await buildDevelopmentDerivedDiagnosticDataset(dataset, ownerRoot);
  const diagnosticDatasetPath = join(outputRoot, "development-derived-diagnostic-samples.json");
  await writeFile(diagnosticDatasetPath, `${JSON.stringify(diagnosticDataset, null, 2)}\n`, "utf8");
  assert.equal(dataset.version, 3);
  assert.equal(dataset.samples.length, 310);

  const trainSamples = dataset.samples.filter(sample => sample.partition === "train");
  const devSamples = dataset.samples.filter(sample => sample.partition === "development");
  const legacySamples = dataset.samples.filter(sample => !isBatch1CommandCase(sample.case));
  const batch1Samples = dataset.samples.filter(sample => isBatch1CommandCase(sample.case));
  const stage0Samples = dataset.samples.filter(sample => !isStage1Sample(sample));
  const stage1Samples = dataset.samples.filter(sample => isStage1Sample(sample));

  assert.equal(trainSamples.length, 206);
  assert.equal(devSamples.length, 104);
  assert.equal(legacySamples.length, 58);
  assert.equal(batch1Samples.length, 252);
  assert.equal(stage0Samples.length, 262);
  assert.equal(stage1Samples.length, 48);
  assert.equal(stage0Samples.filter(sample => sample.partition === "train").length, 174);
  assert.equal(stage0Samples.filter(sample => sample.partition === "development").length, 88);
  assert.equal(stage1Samples.filter(sample => sample.partition === "train").length, 32);
  assert.equal(stage1Samples.filter(sample => sample.partition === "development").length, 16);

  const postAchieved = dataset.samples.filter(sample => sample.expectedStatus === "achieved" && sample.expectedSatisfaction === 100);
  const postUnmet = dataset.samples.filter(sample => sample.expectedStatus === "unmet" && sample.expectedSatisfaction === 0);
  const postUnknown = dataset.samples.filter(sample => sample.expectedStatus === "unknown" && sample.expectedSatisfaction === null);
  assert.equal(postAchieved.length, 286);
  assert.equal(postAchieved.filter(sample => sample.partition === "train").length, 190);
  assert.equal(postAchieved.filter(sample => sample.partition === "development").length, 96);
  assert.equal(postUnmet.length, 6);
  assert.equal(postUnmet.filter(sample => sample.partition === "train").length, 4);
  assert.equal(postUnmet.filter(sample => sample.partition === "development").length, 2);
  assert.equal(postUnmet.every(sample => sample.case === "inspect-resolved-target-broken" && sample.expectedHead === "entry.inspect"), true);
  assert.equal(postUnknown.length, 18);
  assert.equal(postUnknown.filter(sample => sample.partition === "train").length, 12);
  assert.equal(postUnknown.filter(sample => sample.partition === "development").length, 6);

  const trainGroups = new Set(trainSamples.map(sample => sample.sourceGroup));
  const devGroups = new Set(devSamples.map(sample => sample.sourceGroup));
  for (const group of trainGroups) {
    assert.equal(devGroups.has(group), false, `Source group ${group} crosses train and development`);
  }

  if (mode === "validate-only") {
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
      schema: {
        heads: CLI_COMMAND_HEADS.length,
        wires: CLI_COMMAND_WIRES.length,
        parameters: CLI_COMMAND_HEADS.length * CLI_COMMAND_WIRES.length,
        headNames: CLI_COMMAND_HEADS,
        wireNames: CLI_COMMAND_WIRES,
      },
      migration: migrationCheck,
      counts: {
        total: dataset.samples.length,
        train: trainSamples.length,
        development: devSamples.length,
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
              "inspect-link-target": stage1Samples.filter(sample => sample.case === "inspect-link-target").length,
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
        originalSourceGroups: [...new Set(diagnosticDataset.samples.map(sample => sample.sourceGroup))].sort(),
      },
      featureValidation: {
        checkedRows: prepared.samples.length,
        featureLength: 34,
        conflictingFeatureLabelPairs: 0,
      },
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
        reloadConsumer: "node playground/cli/command-learning/reload.mjs --stage stage1-11x34 <profilePath> <datasetPath> <reportPath>",
        independentSuite: "NN_CLI_COMMAND_PROFILE=<profilePath> NN_I7_REPORT=<reportPath> node --test tests/cli-path-primitives-independent.test.mjs",
        independentDenominators: {
          scenarios: 48,
          probes: 23,
          totalExecutedCases: 71,
          historicalStage0RegressionCases: 56,
          newStage1VerificationCases: 15,
          explicitUnverifiedEnvironmentItems: 5,
        },
        trainingReceiptVerificationStatus: "not_provided (fullyVerified=false; bounded verification supplied by external 71-case suite)",
        p3ContentSearchReload: "node playground/cli/content-search/reload-p3.mjs --profile <profilePath> --cases /Volumes/Intel/playground/nnanything-runs/cli-programming-search-p3-20261024/rework/verification-cases.json --report <reportPath>",
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
    const receipt = await runCliCommandTraining({
      dataset,
      initial,
      initialSource,
      epochs,
      learningRate,
    }, {
      handwiredRoot: options.get("--handwired-root"),
      outputRoot,
      grantedEffects: ["filesystem.read", "filesystem.write"],
    });

    const reloadStarted = performance.now();
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("./reload.mjs", import.meta.url)),
      "--stage",
      stage,
      receipt.paths.profile,
      receipt.paths.samples,
      receipt.paths.report,
    ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const reload = JSON.parse(stdout);
    const reloadPath = join(dirname(receipt.paths.report), "reload.json");
    await writeFile(reloadPath, JSON.stringify({ ...reload, reloadMs: performance.now() - reloadStarted }, null, 2) + "\n", { flag: "wx" });

    assert.equal(receipt.accepted, true);
    assert.equal(reload.fitted, false);
    assert.equal(reload.checked, dataset.samples.length);
    assert.equal(reload.executed, dataset.samples.length);
    assert.equal(reload.executedLegacy, 58);
    assert.equal(reload.executedBatch1, 252);
    assert.equal(reload.unverified, 0);
    assert.equal(reload.failed, 0);
    assert.equal(reload.schema.heads, 11);
    assert.equal(reload.schema.wires, 34);
    assert.equal(reload.schema.parameters, 374);
    assert.equal(reload.profileMatchesSavedFile, true);

    const postTrainP3Preference = evaluateP3PreferencePairs(
      receipt.profile,
      mappedP3Rows,
      p3PreferenceSamplesPath,
      initial,
    );
    const p3PreferencePath = join(dirname(receipt.paths.report), "p3-preference-regression.json");
    await writeFile(p3PreferencePath, `${JSON.stringify(postTrainP3Preference, null, 2)}\n`, { flag: "wx" });

    console.log(JSON.stringify({
      runId: receipt.runId,
      stage,
      mode,
      startedAt,
      initialSource,
      counts: {
        total: dataset.samples.length,
        train: 206,
        development: 104,
        legacy: 58,
        batch1: 252,
      },
      comparison: {
        train: compactSummary(receipt.comparison.train),
        development: compactSummary(receipt.comparison.development),
        verification: receipt.verification.status === "evaluated" ? compactSummary(receipt.verification.evaluation) : null,
      },
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
