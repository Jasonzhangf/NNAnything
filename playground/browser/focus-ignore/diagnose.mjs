// B1 §10.4 失败诊断：可复跑的最小只读入口。
// 用法（cwd 必须是 browser-foundation 工作树，以便解析 nnanything/* 包）：
//   node playground/browser/focus-ignore/diagnose.mjs \
//     --request <prepared-request.json> --usage <explicit-usage.json> \
//     --weight <任一 weight.json> --out <diagnostic-<name>.json>
// 同一入口分别以 initial、T1、T2 三个权重运行，得到三份对应诊断。
// 只读取文件与公开接口；不写权重、不改请求、不训练。

import { readFileSync, writeFileSync } from "node:fs";
import { inspectBasicKindNumericSample } from "nnanything/training";
import {
  classifyBasicKind,
  parseBrowserWeightAsset,
  extractBasicKindWires,
  computeBasicKindStageRawIntervals,
  DEFAULT_BASIC_KIND_CONFIG,
} from "nnanything/browser-classify";

const HANDWIRED_ROOT = "/Volumes/extension/code/handwired";
const COUNTEREXAMPLE = "actual-focus-native:actual-focus-candidate-112";

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--request", "--usage", "--weight", "--out"].includes(flag) || value === undefined || value.startsWith("--")) {
      throw new Error("expected --request --usage --weight --out");
    }
    values.set(flag, value);
  }
  for (const f of ["--request", "--usage", "--weight", "--out"]) if (!values.has(f)) throw new Error(`missing ${f}`);
  return {
    request: values.get("--request"),
    usage: values.get("--usage"),
    weight: values.get("--weight"),
    out: values.get("--out"),
  };
}

const args = parseArgs(process.argv.slice(2));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const request = readJson(args.request);
const usageRaw = readJson(args.usage);
const usage = Array.isArray(usageRaw) ? usageRaw : usageRaw.explicitUsage;
const usageById = new Map(usage.map((e) => [e.sampleId, e.usage]));
const asset = parseBrowserWeightAsset(readJson(args.weight), args.weight);
const profile = asset.profile;

const trainRows = request.rows.filter((r) => usageById.get(r.sampleId) === "train" && !r.sampleId.startsWith("fixture-"));
const allOriginal = request.rows.filter((r) => !r.sampleId.startsWith("fixture-"));
const aRows = request.rows.filter((r) => r.sampleId.startsWith("fixture-a:"));

// 1) 精确反例的端点、区间与 wire 事实
const cex = request.rows.find((r) => r.sampleId === COUNTEREXAMPLE);
const cexJudgment = classifyBasicKind(cex.properties, DEFAULT_BASIC_KIND_CONFIG, profile);
const cexWires = extractBasicKindWires(cex.properties);
const cexLeafIntervals = computeBasicKindStageRawIntervals(
  "leaf", Object.keys(profile.leafWeights), profile.leafWeights, cexWires, profile.topology,
);
const cexInspect = await inspectBasicKindNumericSample({
  handwiredRoot: HANDWIRED_ROOT, properties: cex.properties, expectedLabel: cex.review.expectedLabel, profile,
});

// 2) 训练分区上两条焦点 wire 的聚合梯度与分桶（这是 A3 报告里没有落盘的部分）
const FOCUS = ["neutral_actual_focus", "neutral_focusable_control"];
const aggregate = {};
for (const wire of FOCUS) {
  for (const leaf of ["container", "ignore"]) {
    const key = `${leaf}.${wire}`;
    let sum = 0, nonzero = 0;
    const buckets = {};
    for (const row of trainRows) {
      const insp = await inspectBasicKindNumericSample({
        handwiredRoot: HANDWIRED_ROOT, properties: row.properties, expectedLabel: row.review.expectedLabel, profile,
      });
      const g = insp.leafGradients?.[leaf]?.[wire] ?? 0;
      if (g !== 0) nonzero += 1;
      sum += g;
      const value = extractBasicKindWires(row.properties)[wire];
      const bucket = `${row.review.expectedLabel}|${wire}=${value === null ? "null" : value}`;
      buckets[bucket] = (buckets[bucket] ?? 0) + g;
    }
    aggregate[key] = {
      trainRowCount: trainRows.length,
      gradientSum: sum,
      gradientMean: sum / trainRows.length,
      nonzeroRows: nonzero,
      bucketsByGoldAndWireValue: Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}

// 3) A 家族在初始候选上的 loss 与梯度（证明“分类正确 ≠ 零梯度”）
const aFamily = [];
for (const row of aRows) {
  const insp = await inspectBasicKindNumericSample({
    handwiredRoot: HANDWIRED_ROOT, properties: row.properties, expectedLabel: row.review.expectedLabel, profile,
  });
  const j = classifyBasicKind(row.properties, DEFAULT_BASIC_KIND_CONFIG, profile);
  aFamily.push({
    sampleId: row.sampleId,
    expectedLabel: row.review.expectedLabel,
    judgmentStatus: j.judgmentStatus,
    basicKind: j.basicKind,
    classifiedCorrectly: j.judgmentStatus === "judged" && j.basicKind === row.review.expectedLabel,
    loss: insp.loss,
    knownLoss: insp.knownLoss,
    container_af_gradient: insp.leafGradients?.container?.neutral_actual_focus ?? null,
    ignore_af_gradient: insp.leafGradients?.ignore?.neutral_actual_focus ?? null,
  });
}

// 4) endpoint/clamp 事实：仅抬 container 的理论上限
const ignoreScore = cexJudgment.leafScores.ignore.min;
const containerScore = cexJudgment.leafScores.container.min;

// 5) 全 420 行原始逐行区间（family + leaf raw/clamped），保存到文件以便复核
const perRowIntervals = allOriginal.map((row) => {
  const j = classifyBasicKind(row.properties, DEFAULT_BASIC_KIND_CONFIG, profile);
  const wires = extractBasicKindWires(row.properties);
  const leaf = computeBasicKindStageRawIntervals("leaf", Object.keys(profile.leafWeights), profile.leafWeights, wires, profile.topology);
  return {
    sampleId: row.sampleId,
    expectedLabel: row.review.expectedLabel,
    usage: usageById.get(row.sampleId),
    judgmentStatus: j.judgmentStatus,
    basicKind: j.basicKind,
    score: j.score,
    margin: j.margin,
    containerRaw: leaf.container ?? null,
    ignoreRaw: leaf.ignore ?? null,
    containerAfWire: wires.neutral_actual_focus,
    focusableControlWire: wires.neutral_focusable_control,
  };
});

const out = {
  generatedFor: "B1 §10.4 failure diagnostics, read-only",
  handwiredRoot: HANDWIRED_ROOT,
  weightSource: args.weight,
  profileId: profile.id,
  thresholds: { minScore: asset.config.minScore, minMargin: asset.config.minMargin },
  counterexample: {
    sampleId: COUNTEREXAMPLE,
    expectedLabel: cex.review.expectedLabel,
    judgmentStatus: cexJudgment.judgmentStatus,
    basicKind: cexJudgment.basicKind,
    score: cexJudgment.score,
    margin: cexJudgment.margin,
    family: cexJudgment.family,
    wires: cexWires,
    publicLeafScores: cexJudgment.leafScores ?? null,
    leafRawIntervals: cexLeafIntervals,
    numericLoss: cexInspect.loss,
    numericFamilyForward: cexInspect.family,
    numericLeafForward: cexInspect.leaf,
    numericFamilyGradients: cexInspect.familyGradients,
    numericLeafGradients: cexInspect.leafGradients,
  },
  endpointFacts: {
    counterexampleIgnoreScore: ignoreScore,
    counterexampleContainerScore: containerScore,
    containerTheoreticalMax: 1.0,
    maxAchievableMarginIfOnlyContainerRises: 1.0 - ignoreScore,
    minMarginRequired: asset.config.minMargin,
    onlyContainerInsufficient: 1.0 - ignoreScore < asset.config.minMargin,
    note: "Endpoint fact only: it does not by itself prove no joint parameter setting exists.",
  },
  observedFocusGradientSummary: aggregate,
  aFamilyLossAndGradient: aFamily,
  aFamilyNonZeroLossCount: aFamily.filter((r) => r.loss > 0).length,
  perRowIntervals,
};

writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  out: args.out,
  trainRows: trainRows.length,
  perRowIntervals: perRowIntervals.length,
  aFamilyNonZeroLossCount: out.aFamilyNonZeroLossCount,
  endpoint: out.endpointFacts.maxAchievableMarginIfOnlyContainerRises,
  containerAfGradientSum: aggregate["container.neutral_actual_focus"].gradientSum,
  ignoreAfGradientSum: aggregate["ignore.neutral_actual_focus"].gradientSum,
}));
