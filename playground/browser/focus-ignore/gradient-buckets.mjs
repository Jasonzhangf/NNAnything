// Read-only focus-address gradient buckets for C-RivalCeiling-0.6.
// Computes container/ignore neutral_actual_focus and neutral_focusable_control
// gradients at one saved weight under both the original 0.4 objective and the
// experimental 0.6 objective, separated by train/A source and by gold+wire value.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inspectBasicKindNumericSample } from "nnanything/training";
import { extractBasicKindWires } from "nnanything/browser-classify";
import { parseBrowserWeightAsset } from "nnanything/browser-classify";

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    values.set(flag.replace(/^--/, ""), resolve(value));
  }
  for (const f of ["request", "usage", "weight", "out"]) {
    if (!values.has(f)) throw new Error(`missing --${f}`);
  }
  return Object.fromEntries(values);
}

const args = parseArgs(process.argv.slice(2));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const request = readJson(args.request);
const usage = new Map(readJson(args.usage).map((e) => [e.sampleId, e.usage]));
const asset = parseBrowserWeightAsset(readJson(args.weight), args.weight);
const HANDWIRED_ROOT = "/Volumes/extension/code/handwired";
const ADDRESSES = [
  ["container", "neutral_actual_focus"],
  ["ignore", "neutral_actual_focus"],
  ["container", "neutral_focusable_control"],
  ["ignore", "neutral_focusable_control"],
];
const OBJECTIVES = {
  original: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
  candidate: { targetScore: 0.8, rivalCeiling: 0.6, otherGap: 0.05 },
};

const sources = {
  train: request.rows.filter((r) => usage.get(r.sampleId) === "train" && !r.sampleId.startsWith("fixture-")),
  familyA: request.rows.filter((r) => r.sampleId.startsWith("fixture-a:")),
};
const counterexample = request.rows.find((r) => r.sampleId === "actual-focus-native:actual-focus-candidate-112");
if (!counterexample) throw new Error("counterexample missing");

const result = {
  generatedFor: "C-RivalCeiling-0.6 gradient buckets",
  weight: args.weight,
  profileId: asset.profile.id,
  thresholds: { minScore: asset.config.minScore, minMargin: asset.config.minMargin },
  method: "inspectBasicKindNumericSample with explicit objective config; two objectives never mixed in one metric",
  objectives: {},
};

for (const [objectiveKey, objective] of Object.entries(OBJECTIVES)) {
  const config = {
    taskId: "dom.basic-kinds.v1",
    minScore: asset.config.minScore,
    minMargin: asset.config.minMargin,
    objective,
    fit: { epochs: 1, learningRate: 0.01, anchorLambda: 0 },
  };
  const bySource = {};
  for (const [sourceKey, rows] of Object.entries(sources)) {
    const byAddress = {};
    for (const [leaf, wire] of ADDRESSES) {
      const key = `${leaf}.${wire}`;
      let sum = 0;
      let nonzero = 0;
      const buckets = {};
      for (const row of rows) {
        const insp = await inspectBasicKindNumericSample({
          handwiredRoot: HANDWIRED_ROOT,
          properties: row.properties,
          expectedLabel: row.review.expectedLabel,
          profile: asset.profile,
          config,
        });
        const g = insp.leafGradients?.[leaf]?.[wire] ?? 0;
        if (g !== 0) nonzero += 1;
        sum += g;
        const value = extractBasicKindWires(row.properties)[wire];
        const bucket = `${row.review.expectedLabel}|${wire}=${value === null ? "null" : value}`;
        buckets[bucket] = (buckets[bucket] ?? 0) + g;
      }
      byAddress[key] = {
        rowCount: rows.length,
        gradientSum: sum,
        gradientMean: sum / rows.length,
        nonzeroRows: nonzero,
        bucketsByGoldAndWireValue: Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b))),
      };
    }
    bySource[sourceKey] = byAddress;
  }
  const cexInspect = await inspectBasicKindNumericSample({
    handwiredRoot: HANDWIRED_ROOT,
    properties: counterexample.properties,
    expectedLabel: counterexample.review.expectedLabel,
    profile: asset.profile,
    config,
  });
  result.objectives[objectiveKey] = {
    objective,
    sources: bySource,
    counterexample: {
      sampleId: counterexample.sampleId,
      loss: cexInspect.loss,
      knownLoss: cexInspect.knownLoss,
      otherLoss: cexInspect.otherLoss,
      familyForward: cexInspect.family,
      leafForward: cexInspect.leaf,
      leafGradients: cexInspect.leafGradients,
      containerAfGradient: cexInspect.leafGradients?.container?.neutral_actual_focus ?? null,
      ignoreAfGradient: cexInspect.leafGradients?.ignore?.neutral_actual_focus ?? null,
      containerFcGradient: cexInspect.leafGradients?.container?.neutral_focusable_control ?? null,
      ignoreFcGradient: cexInspect.leafGradients?.ignore?.neutral_focusable_control ?? null,
    },
  };
}

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
const terminal = {
  weight: args.weight,
  objectives: Object.fromEntries(Object.entries(result.objectives).map(([key, value]) => [
    key,
    Object.fromEntries(Object.entries(value.sources).map(([source, byAddress]) => [
      source,
      Object.fromEntries(ADDRESSES.map(([leaf, wire]) => {
        const item = byAddress[`${leaf}.${wire}`];
        return [`${leaf}.${wire}`, item.gradientSum];
      })),
    ])),
  ])),
};
console.log(JSON.stringify(terminal));
