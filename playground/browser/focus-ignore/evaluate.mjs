import fs from "node:fs";
import path from "node:path";
import {
  classifyBasicKind,
  DEFAULT_BASIC_KIND_CONFIG,
  extractBasicKindWires,
  computeBasicKindStageRawIntervals,
} from "nnanything/browser";
import { parseBrowserWeightAsset } from "nnanything/browser-classify";

function parseArgs(argv) {
  const values = { request: null, weight: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!Object.hasOwn(values, flag?.replace(/^--/, "") ?? "")) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    values[flag.replace(/^--/, "")] = value;
    index += 1;
  }
  for (const [name, value] of Object.entries(values)) {
    if (value === null) throw new Error(`missing required --${name}`);
    // The supplied run command uses a relative weight path; resolve it against cwd.
    values[name] = path.isAbsolute(value) ? value : path.resolve(value);
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

function main() {
  const args = parseArgs(process.argv.slice(2));

  const request = readJson(args.request, "request");
  if (!Array.isArray(request.rows)) throw new Error("request.rows must be an array");

  const asset = parseBrowserWeightAsset(readJson(args.weight, "weight asset"), args.weight);
  const profile = asset.profile;
  if (asset.config.minScore !== DEFAULT_BASIC_KIND_CONFIG.minScore || asset.config.minMargin !== DEFAULT_BASIC_KIND_CONFIG.minMargin) {
    throw new Error(
      `weight asset thresholds differ from the fixed experiment (minScore 0.6/minMargin 0.15): ${asset.config.minScore}/${asset.config.minMargin}`,
    );
  }
  const config = asset.config;

  const total = request.rows.length;
  const byBasicKind = {};
  const judgedByBasicKind = {};
  const byStatus = {};
  const confusion = {};
  const ignoreRows = [];
  const falseIgnoreCandidates = [];
  const rowLines = [];
  let counterexample = null;

  for (const row of request.rows) {
    const judgment = classifyBasicKind(row.properties, config, profile);
    const expectedLabel = row.review?.expectedLabel ?? null;
    const { judgmentStatus, basicKind, score, margin, family } = judgment;
    const hit = expectedLabel === basicKind;

    bump(byBasicKind, String(basicKind));
    if (judgmentStatus === "judged") bump(judgedByBasicKind, String(basicKind));
    bump(byStatus, judgmentStatus);
    const confusionByExpected = confusion[String(expectedLabel)] ?? (confusion[String(expectedLabel)] = {});
    bump(confusionByExpected, String(basicKind));

    const detail = { sampleId: row.sampleId, expectedLabel, judgmentStatus, basicKind, score, margin, family, hit };
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
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  const rowsOut = `${args.out.endsWith(".json") ? args.out.slice(0, -".json".length) : args.out}-rows.jsonl`;
  fs.writeFileSync(rowsOut, `${rowLines.join("\n")}\n`);

  const terminal = {
    total,
    ignoreRecall: { expectedIgnore: ignoreRows.length, recalled },
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

main();
