import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyBasicKind,
  DEFAULT_BASIC_KIND_CONFIG,
  extractBasicKindWires,
  computeBasicKindStageRawIntervals,
} from "nnanything/browser";
import { parseBrowserWeightAsset } from "nnanything/browser-classify";

const COUNTEREXAMPLE_ID = "actual-focus-native:actual-focus-candidate-112";

function clampedInterval(interval) {
  if (interval === undefined) return null;
  const clamp = value => Math.max(0, Math.min(1, value));
  return { min: clamp(interval.min), max: clamp(interval.max) };
}

function groupFor(row, usageById) {
  const id = row.sampleId;
  const usage = usageById.get(id);
  if (id === COUNTEREXAMPLE_ID) return "counterexample";
  if (id.startsWith("fixture-a:")) return "family-a";
  if (id.startsWith("fixture-b:")) return "family-b";
  if (id.startsWith("sample-repair-train:")) return "new-train";
  if (id.startsWith("sample-repair-dev:")) return "new-dev";
  if (id.startsWith("sample-repair-verification:")) return "new-verification";
  if (id.startsWith("human-native:")) return "human";
  if (usage === "train" || usage === "eval") return "original";
  return "other";
}

function judgmentLine(row, asset, usageById, options = {}) {
  const judgment = classifyBasicKind(row.properties, asset.config, asset.profile);
  const wires = extractBasicKindWires(row.properties);
  const leaf = computeBasicKindStageRawIntervals(
    "leaf",
    Object.keys(asset.profile.leafWeights),
    asset.profile.leafWeights,
    wires,
    asset.profile.topology,
  );
  const family = computeBasicKindStageRawIntervals(
    "family",
    Object.keys(asset.profile.familyWeights),
    asset.profile.familyWeights,
    wires,
    asset.profile.topology,
  );
  const gold = row.review?.expectedLabel ?? null;
  const group = options.group ?? groupFor(row, usageById);
  return {
    sampleId: row.sampleId,
    group,
    usage: usageById.get(row.sampleId) ?? null,
    gold,
    reviewStatus: row.review?.status ?? null,
    status: judgment.judgmentStatus,
    basicKind: judgment.basicKind,
    family: judgment.family,
    leafInterval: Object.fromEntries(
      Object.entries(leaf).map(([name, interval]) => [name, clampedInterval(interval)]),
    ),
    familyInterval: Object.fromEntries(
      Object.entries(family).map(([name, interval]) => [name, clampedInterval(interval)]),
    ),
    score: judgment.score,
    margin: judgment.margin,
    reasons: judgment.reasons,
    baselineCorrect: options.baselineCorrect ?? null,
  };
}

export function evaluateExperimentRows(rows, asset, usageById, options = {}) {
  const baselineCorrect = options.baselineCorrect;
  const evaluated = rows.map((row, index) => judgmentLine(row, asset, usageById, {
    ...options,
    baselineCorrect: typeof baselineCorrect === "function"
      ? baselineCorrect(row.sampleId)
      : typeof baselineCorrect === "boolean"
        ? baselineCorrect
        : null,
  }));
  return { rows: evaluated };
}

export function assessUnseal(evaluation, options = {}) {
  const rows = evaluation.rows ?? evaluation;
  const derivedGroup = (row) => {
    const id = row.sampleId;
    if (id === COUNTEREXAMPLE_ID) return "counterexample";
    if (String(id).startsWith("human-native:")) return "human";
    if (String(id).startsWith("sample-repair-")) {
      return groupFor(row, new Map());
    }
    if (String(id).startsWith("fixture-a:")) return "family-a";
    if (String(id).startsWith("fixture-b:")) return "family-b";
    return "original";
  };
  const byGroup = new Map();
  for (const row of rows) {
    const group = row.group ?? derivedGroup(row);
    const list = byGroup.get(group) ?? [];
    list.push(row);
    byGroup.set(group, list);
  }
  const groups = id => (byGroup.get(id) ?? []).map(row => row.sampleId);
  const counterexample = byGroup.get("counterexample") ?? [];
  const human = byGroup.get("human") ?? [];
  const newTrain = byGroup.get("new-train") ?? [];
  const newDev = byGroup.get("new-dev") ?? [];
  const oldRows = [
    ...(byGroup.get("original") ?? []),
    ...(byGroup.get("family-a") ?? []),
    ...(byGroup.get("family-b") ?? []),
    ...(byGroup.get("counterexample") ?? []),
  ];
  const baselineRows = oldRows.filter(row => typeof row.baselineCorrect === "boolean");
  const baselineKnown = oldRows.length > 0 && baselineRows.length === oldRows.length;
  const baselineCorrect = baselineRows.filter(row => row.baselineCorrect);

  const container = row => row.status === "judged" && row.basicKind === "container";
  const matchesGold = row => row.status === "judged" && row.basicKind === row.gold;
  const baselineIgnore = baselineCorrect.filter(row => row.gold === "ignore");
  const retainedIgnore = baselineIgnore.filter(matchesGold);
  // Confirmed human positives: gold=container AND independently verified review.
  // Unconfirmed rows (e.g. unlabeled_exploration) are reported but never counted.
  const confirmedHumanPositive = human.filter(row => row.gold === "container" && row.reviewStatus === "verified");

  const gates = [
    {
      id: "counterexampleAndHumanContainer",
      pass: counterexample.length > 0 && counterexample.every(container)
        && (confirmedHumanPositive.length === 0 || confirmedHumanPositive.every(container)),
      details: {
        counterexample: counterexample.map(row => ({ sampleId: row.sampleId, status: row.status, basicKind: row.basicKind })),
        human: human.map(row => ({ sampleId: row.sampleId, gold: row.gold, status: row.status, basicKind: row.basicKind })),
        confirmedHumanPositiveCount: confirmedHumanPositive.length,
        note: confirmedHumanPositive.length === 0
          ? "no independently confirmed human positives (unconfirmed rows are reported only, never gated)"
          : null,
      },
    },
    {
      id: "newTrainDevGold",
      pass: newTrain.length > 0 && newTrain.every(matchesGold) && newDev.length > 0 && newDev.every(matchesGold),
      details: {
        newTrain: newTrain.map(row => ({ sampleId: row.sampleId, gold: row.gold, status: row.status, basicKind: row.basicKind })),
        newDev: newDev.map(row => ({ sampleId: row.sampleId, gold: row.gold, status: row.status, basicKind: row.basicKind })),
      },
    },
    {
      id: "oldRegression",
      pass: baselineKnown && baselineCorrect.every(matchesGold),
      details: {
        baselineKnown,
        baselineRows: baselineRows.length,
        baselineCorrect: baselineCorrect.map(row => ({ sampleId: row.sampleId, gold: row.gold, status: row.status, basicKind: row.basicKind })),
      },
    },
    {
      id: "ignoreRetention",
      pass: baselineKnown && baselineIgnore.length > 0 && retainedIgnore.length === baselineIgnore.length,
      details: {
        baselineKnown,
        baselineIgnore: baselineIgnore.length,
        retainedIgnore: retainedIgnore.length,
        retainedIgnoreSampleIds: retainedIgnore.map(row => row.sampleId),
      },
    },
  ];
  return {
    unseal: gates.every(gate => gate.pass),
    gates,
    groups: {
      counterexample: groups("counterexample").length,
      human: groups("human").length,
      newTrain: groups("new-train").length,
      newDev: groups("new-dev").length,
      old: oldRows.length,
      original: groups("original").length,
      familyA: groups("family-a").length,
      familyB: groups("family-b").length,
    },
  };
}

function parseArgs(argv) {
  const values = { request: null, weight: null, out: null, usage: null, devRequest: null, baselineGold: null, unsealedVerification: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--unsealed-verification") {
      values.unsealedVerification = true;
      continue;
    }
    const name = String(flag).replace(/^--/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!Object.hasOwn(values, name)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    values[name] = value;
    index += 1;
  }
  for (const [name, value] of Object.entries(values)) {
    if (name === "unsealedVerification") continue;
    if (value === null && name !== "usage" && name !== "baselineGold" && name !== "devRequest") throw new Error(`missing required --${name}`);
    // The supplied run command uses a relative weight path; resolve it against cwd.
    values[name] = value === null ? null : path.isAbsolute(value) ? value : path.resolve(value);
  }
  return values;
}

function readJson(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function bump(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function orderedRecord(record) {
  const ordered = {};
  for (const key of Object.keys(record).sort()) ordered[key] = record[key];
  return ordered;
}

function pick(row, names) {
  const picked = {};
  for (const name of names) picked[name] = row?.[name] ?? null;
  return picked;
}

function clampedIntervalWithMargin(intervals, name) {
  const interval = intervals[name];
  if (interval === undefined) return null;
  const clamp = value => Math.max(0, Math.min(1, value));
  const lower = clamp(interval.min);
  const upper = clamp(interval.max);
  const rivalUpper = Math.max(
    0,
    ...Object.entries(intervals)
      .filter(([other]) => other !== name)
      .map(([, score]) => clamp(score.max)),
  );
  return { lower, upper, margin: lower - rivalUpper };
}

export function main() {
  const args = parseArgs(process.argv.slice(2));

  const request = readJson(args.request, "request");
  if (!Array.isArray(request.rows)) throw new Error("request.rows must be an array");
  const combinedRequest = (() => {
    if (args.devRequest === null) return request;
    const devRequest = readJson(args.devRequest, "dev request");
    if (!Array.isArray(devRequest.rows)) throw new Error("dev request.rows must be an array");
    return { ...request, rows: [...request.rows, ...devRequest.rows] };
  })();
  const requestRows = combinedRequest.rows;

  const usageRaw = args.usage === null ? [] : readJson(args.usage, "usage");
  const usageEntries = Array.isArray(usageRaw)
    ? usageRaw
    : Array.isArray(usageRaw.explicitUsage)
      ? usageRaw.explicitUsage
      : ["control", "treatment", "dev", "verification"].flatMap(key => Array.isArray(usageRaw[key]) ? usageRaw[key] : []);
  const usageById = new Map(usageEntries.map(entry => [entry.sampleId, entry.usage]));
  const baselineRaw = args.baselineGold === null ? null : readJson(args.baselineGold, "baseline gold");
  const baselineEntries = baselineRaw === null
    ? null
    : Array.isArray(baselineRaw)
      ? baselineRaw
      : baselineRaw.experimentRows ?? baselineRaw.rows ?? null;
  if (baselineEntries !== null && !Array.isArray(baselineEntries)) {
    throw new Error("baseline gold must be an array or contain experimentRows/rows");
  }
  const baselineCorrectIds = new Set(
    (baselineEntries ?? [])
      .filter(entry => entry.baselineCorrect === undefined || entry.baselineCorrect === true)
      .map(entry => entry.sampleId),
  );

  const asset = parseBrowserWeightAsset(readJson(args.weight, "weight asset"), args.weight);
  const profile = asset.profile;
  if (asset.config.minScore !== DEFAULT_BASIC_KIND_CONFIG.minScore || asset.config.minMargin !== DEFAULT_BASIC_KIND_CONFIG.minMargin) {
    throw new Error(
      `weight asset thresholds differ from the fixed experiment (minScore 0.6/minMargin 0.15): ${asset.config.minScore}/${asset.config.minMargin}`,
    );
  }
  const config = asset.config;

  if (!args.unsealedVerification) {
    const sealed = requestRows.find(row => String(row.sampleId).startsWith("sample-repair-verification:"));
    if (sealed !== undefined) {
      throw new Error(`verification row ${sealed.sampleId} is sealed; pass --unsealed-verification only after the independent verifier is allowed to evaluate`);
    }
  }

  const total = requestRows.length;
  const byBasicKind = {};
  const judgedByBasicKind = {};
  const byStatus = {};
  const confusion = {};
  const ignoreRows = [];
  const falseIgnoreCandidates = [];
  const rowLines = [];
  let counterexample = null;

  for (const row of requestRows) {
    const line = judgmentLine(row, asset, usageById);
    const { status: judgmentStatus, basicKind, score, margin, family, gold: expectedLabel } = line;
    const hit = expectedLabel === basicKind;

    bump(byBasicKind, String(basicKind));
    if (judgmentStatus === "judged") bump(judgedByBasicKind, String(basicKind));
    bump(byStatus, judgmentStatus);
    const confusionByExpected = confusion[String(expectedLabel)] ?? (confusion[String(expectedLabel)] = {});
    bump(confusionByExpected, String(basicKind));

    const detail = {
      sampleId: row.sampleId,
      expectedLabel,
      judgmentStatus,
      basicKind,
      score,
      margin,
      family,
      leafInterval: line.leafInterval,
      familyInterval: line.familyInterval,
      hit,
    };
    rowLines.push(JSON.stringify(detail));

    if (expectedLabel === "ignore") ignoreRows.push(detail);
    if (basicKind === "ignore" && expectedLabel !== "ignore") {
      falseIgnoreCandidates.push({ sampleId: row.sampleId, expectedLabel, basicKind, score, margin, family });
    }

    if (row.sampleId === "actual-focus-native:actual-focus-candidate-112") {
      const wires = extractBasicKindWires(row.properties);
      const profileRows = {
        ignore: profile.leafWeights.ignore,
        container: profile.leafWeights.container,
        structure: profile.familyWeights.structure,
      };
      const focusWireNames = ["neutral_actual_focus", "neutral_focusable_control"];
      const wrapperWireNames = [
        "neutral_single_child",
        "neutral_single_element_wrapper",
        "neutral_single_positive_wrapper",
      ];
      const leafIntervals = computeBasicKindStageRawIntervals(
        "leaf",
        Object.keys(profile.leafWeights),
        profile.leafWeights,
        wires,
        profile.topology,
      );
      counterexample = {
        sampleId: row.sampleId,
        expectedLabel,
        judgmentStatus,
        basicKind,
        score,
        margin,
        family,
        focusWires: {
          extracted: pick(wires, focusWireNames),
          profile: Object.fromEntries(
            Object.entries(profileRows).map(([name, weights]) => [name, pick(weights, focusWireNames)]),
          ),
        },
        wrapperWires: {
          extracted: pick(wires, wrapperWireNames),
          profile: Object.fromEntries(
            Object.entries(profileRows).map(([name, weights]) => [name, pick(weights, wrapperWireNames)]),
          ),
        },
        containerInterval: clampedIntervalWithMargin(leafIntervals, "container"),
        ignoreInterval: clampedIntervalWithMargin(leafIntervals, "ignore"),
        reproducedAsIgnore: judgmentStatus === "judged" && basicKind === "ignore",
      };
    }
  }

  const recalled = ignoreRows.filter((row) => row.basicKind === "ignore").length;
  const byExpectedLabel = {};
  for (const [expectedLabel, outcomes] of Object.entries(confusion)) {
    const expectedTotal = Object.values(outcomes).reduce((sum, count) => sum + count, 0);
    const hit = outcomes[expectedLabel] ?? 0;
    byExpectedLabel[expectedLabel] = { total: expectedTotal, hit, miss: expectedTotal - hit, outcomes };
  }
  const summary = {
    request: args.request,
    devRequest: args.devRequest,
    weight: args.weight,
    profileId: profile.id,
    total,
    byBasicKind: orderedRecord(byBasicKind),
    judgedByBasicKind: orderedRecord(judgedByBasicKind),
    byStatus: orderedRecord(byStatus),
    confusion: orderedRecord(confusion),
    byExpectedLabel: orderedRecord(byExpectedLabel),
    ignoreRecall: {
      expectedIgnore: ignoreRows.length,
      recalled,
      rows: ignoreRows,
    },
    falseIgnoreCandidates,
    counterexample,
    experimentRows: null,
    unseal: null,
  };
  const evaluated = evaluateExperimentRows(requestRows, asset, usageById, {
    baselineCorrect: baselineEntries === null ? null : sampleId => baselineCorrectIds.has(sampleId),
  });
  summary.experimentRows = evaluated.rows;
  summary.unseal = assessUnseal(evaluated);

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  const rowsOut = `${args.out.endsWith(".json") ? args.out.slice(0, -".json".length) : args.out}-rows.jsonl`;
  fs.writeFileSync(rowsOut, `${rowLines.join("\n")}\n`);

  const terminal = {
    total,
    ignoreRecall: { expectedIgnore: ignoreRows.length, recalled },
    unseal: summary.unseal,
    counterexample: counterexample
      ? {
          basicKind: counterexample.basicKind,
          judgmentStatus: counterexample.judgmentStatus,
          score: counterexample.score,
          reproducedAsIgnore: counterexample.reproducedAsIgnore,
        }
      : null,
  };
  process.stdout.write(`${JSON.stringify(terminal)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main();
}
