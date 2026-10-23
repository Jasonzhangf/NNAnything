// C-RivalCeiling-0.6 acceptance evaluation.
// New-process file reload of the saved candidate, then public classifyBasicKind
// over the original 420, A 18, B 18 (wrapper + child), human native focused 2,
// the exact counterexample, and the 21 two-parameter diagnostic rows.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  classifyBasicKind,
  extractBasicKindWires,
  computeBasicKindStageRawIntervals,
} from "nnanything/browser-classify";
import { parseBrowserWeightAsset } from "nnanything/browser-classify";

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    values.set(flag.replace(/^--/, ""), resolve(value));
  }
  const required = ["request", "usage", "initial-weight", "candidate-weight", "human-capture", "b-capture", "b-oracle", "out"];
  for (const flag of required) {
    if (!values.has(flag)) throw new Error(`missing --${flag}`);
  }
  return Object.fromEntries(values);
}

const args = parseArgs(process.argv.slice(2));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const request = readJson(args.request);
const usage = new Map(readJson(args.usage).map((e) => [e.sampleId, e.usage]));
const initialAsset = parseBrowserWeightAsset(readJson(args["initial-weight"]), args["initial-weight"]);
const candidateAsset = parseBrowserWeightAsset(readJson(args["candidate-weight"]), args["candidate-weight"]);
const human = readJson(args["human-capture"]);
const bCapture = readJson(args["b-capture"]);
const bOracle = readJson(args["b-oracle"]);

const leafInterval = (profile, wires) => {
  const raw = computeBasicKindStageRawIntervals(
    "leaf", Object.keys(profile.leafWeights), profile.leafWeights, wires, profile.topology,
  );
  const family = computeBasicKindStageRawIntervals(
    "family", Object.keys(profile.familyWeights), profile.familyWeights, wires, profile.topology,
  );
  const clamp = (v) => Math.max(0, Math.min(1, v));
  return {
    containerRaw: raw.container ?? null,
    ignoreRaw: raw.ignore ?? null,
    structureFamilyRaw: family.structure ?? null,
    containerClamped: raw.container ? { min: clamp(raw.container.min), max: clamp(raw.container.max) } : null,
    ignoreClamped: raw.ignore ? { min: clamp(raw.ignore.min), max: clamp(raw.ignore.max) } : null,
    structureFamilyClamped: family.structure ? { min: clamp(family.structure.min), max: clamp(family.structure.max) } : null,
  };
};

function judgmentLine(row, profile, asset, set, labelFor) {
  const old = classifyBasicKind(row.properties, initialAsset.config, initialAsset.profile);
  const now = classifyBasicKind(row.properties, asset.config, asset.profile);
  const oldCorrect = old.judgmentStatus === "judged" && old.basicKind === row.review.expectedLabel;
  const newCorrect = now.judgmentStatus === "judged" && now.basicKind === row.review.expectedLabel;
  const transition = oldCorrect && newCorrect ? "retained"
    : oldCorrect && !newCorrect ? "regressed"
    : !oldCorrect && newCorrect ? "fixed"
    : !oldCorrect && !newCorrect ? "unresolved"
    : "unassessed";
  const intervals = leafInterval(profile, extractBasicKindWires(row.properties));
  return {
    set,
    sampleId: row.sampleId,
    gold: row.review.expectedLabel,
    expectedLabel: labelFor ?? row.review.expectedLabel,
    usage: usage.get(row.sampleId) ?? null,
    oldStatus: old.judgmentStatus,
    oldKind: old.basicKind,
    newStatus: now.judgmentStatus,
    newKind: now.basicKind,
    score: now.score,
    margin: now.margin,
    family: now.family,
    transition,
    ...intervals,
    reasons: now.reasons,
  };
}

const rows = [];
const original = request.rows.filter((r) => !r.sampleId.startsWith("fixture-"));
for (const row of original) rows.push(judgmentLine(row, candidateAsset.profile, candidateAsset, "original-420"));

const aRows = request.rows.filter((r) => r.sampleId.startsWith("fixture-a:"));
for (const row of aRows) rows.push(judgmentLine(row, candidateAsset.profile, candidateAsset, "family-A"));

const bStateRows = [];
const bChildRows = [];
for (const state of bCapture.states) {
  const byRef = new Map(state.properties.map((p) => [p.nodeRef, p]));
  const wrapperRef = state.verification.references.wrapper?.nodeRef;
  const childRef = state.verification.references.child?.nodeRef;
  const expected = state.expectedLabel;
  if (wrapperRef && byRef.has(wrapperRef)) {
    const { nodeRef: _wrapperNodeRef, ...wrapper } = byRef.get(wrapperRef);
    const oldJ = classifyBasicKind(wrapper, initialAsset.config, initialAsset.profile);
    const newJ = classifyBasicKind(wrapper, candidateAsset.config, candidateAsset.profile);
    const intervals = leafInterval(candidateAsset.profile, extractBasicKindWires(wrapper));
    rows.push({
      set: "family-B",
      sampleId: `fixture-b:${state.construction}:${state.state}:wrapper`,
      gold: expected,
      expectedLabel: expected,
      usage: "not_in_fit",
      oldStatus: oldJ.judgmentStatus, oldKind: oldJ.basicKind,
      newStatus: newJ.judgmentStatus, newKind: newJ.basicKind,
      score: newJ.score, margin: newJ.margin, family: newJ.family,
      transition: oldJ.judgmentStatus === "judged" && oldJ.basicKind === expected && newJ.judgmentStatus === "judged" && newJ.basicKind === expected ? "retained"
        : oldJ.judgmentStatus === "judged" && oldJ.basicKind === expected ? "regressed"
        : newJ.judgmentStatus === "judged" && newJ.basicKind === expected ? "fixed" : "unresolved",
      ...intervals, reasons: newJ.reasons,
    });
    bStateRows.push({ state: `${state.construction}:${state.state}`, expected, wrapper: newJ });
  }
  if (childRef && byRef.has(childRef)) {
    const { nodeRef: _childNodeRef, ...child } = byRef.get(childRef);
    const oldJ = classifyBasicKind(child, initialAsset.config, initialAsset.profile);
    const newJ = classifyBasicKind(child, candidateAsset.config, candidateAsset.profile);
    bChildRows.push({
      state: `${state.construction}:${state.state}`,
      construction: state.construction,
      childNodeRef: childRef,
      childTag: child.tag,
      oldStatus: oldJ.judgmentStatus, oldKind: oldJ.basicKind,
      newStatus: newJ.judgmentStatus, newKind: newJ.basicKind,
      preserved: newJ.judgmentStatus === "judged" && newJ.basicKind !== null && newJ.basicKind !== "other",
    });
  }
}

const humanRows = [];
for (let i = 0; i < human.runs.length; i++) {
  const run = human.runs[i];
  const focused = run.states.find((s) => s.recipe === "native" && s.state === "focused");
  if (!focused) throw new Error(`run ${i} has no native focused state`);
  const { nodeRef, ...properties } = focused.snapshot.wrapperRow;
  const row = {
    sampleId: `human-native:${run.label}:focused`,
    review: { expectedLabel: "container" },
    properties,
  };
  humanRows.push({ label: run.label, ...judgmentLine(row, candidateAsset.profile, candidateAsset, "human-native-focused") });
}
for (const row of humanRows) rows.push(row);

const counterexample = request.rows.find((r) => r.sampleId === "actual-focus-native:actual-focus-candidate-112");
if (!counterexample) throw new Error("counterexample row missing");
const cexWires = extractBasicKindWires(counterexample.properties);
const cexInitial = classifyBasicKind(counterexample.properties, initialAsset.config, initialAsset.profile);
const cexLine = judgmentLine(counterexample, candidateAsset.profile, candidateAsset, "counterexample");
const cexDetail = {
  sampleId: counterexample.sampleId,
  expectedLabel: counterexample.review.expectedLabel,
  wires: cexWires,
  initial: { status: cexInitial.judgmentStatus, kind: cexInitial.basicKind, score: cexInitial.score, margin: cexInitial.margin },
  candidate: {
    status: cexLine.newStatus, kind: cexLine.newKind, score: cexLine.score, margin: cexLine.margin,
    family: cexLine.family,
    structureFamilyRaw: cexLine.structureFamilyRaw,
    containerRaw: cexLine.containerRaw,
    ignoreRaw: cexLine.ignoreRaw,
    containerClamped: cexLine.containerClamped,
    ignoreClamped: cexLine.ignoreClamped,
  },
};
rows.push({ ...cexLine, set: "counterexample" });

// Two-parameter diagnostic rows: initial in-memory copy with the plan's two
// focus addresses; the 21 originally-correct ignore rows that flipped unknown.
const diagProfile = structuredClone(initialAsset.profile);
diagProfile.leafWeights.container.neutral_actual_focus = 0.28;
diagProfile.leafWeights.ignore.neutral_actual_focus = -0.15;
const twoParamRows = [];
for (const row of original) {
  const oldJ = classifyBasicKind(row.properties, initialAsset.config, initialAsset.profile);
  if (row.review.expectedLabel !== "ignore" || oldJ.judgmentStatus !== "judged" || oldJ.basicKind !== "ignore") continue;
  const diagJ = classifyBasicKind(row.properties, initialAsset.config, diagProfile);
  if (diagJ.judgmentStatus === "judged" && diagJ.basicKind === "ignore") continue;
  const candJ = classifyBasicKind(row.properties, candidateAsset.config, candidateAsset.profile);
  twoParamRows.push({
    set: "two-param-diagnostic",
    sampleId: row.sampleId,
    gold: "ignore",
    usage: usage.get(row.sampleId),
    candidateStatus: candJ.judgmentStatus,
    candidateKind: candJ.basicKind,
    candidateScore: candJ.score,
    candidateMargin: candJ.margin,
    preserved: candJ.judgmentStatus === "judged" && candJ.basicKind === "ignore",
  });
}
for (const row of twoParamRows) {
  rows.push({
    set: row.set,
    sampleId: row.sampleId,
    gold: row.gold,
    usage: row.usage,
    newStatus: row.candidateStatus,
    newKind: row.candidateKind,
    score: row.candidateScore,
    margin: row.candidateMargin,
    transition: row.preserved ? "retained" : "regressed",
  });
}

// Original-420 metrics.
const orig = rows.filter((r) => r.set === "original-420");
const initialCorrect = orig.filter((r) => r.oldStatus === "judged" && r.oldKind === r.gold).length;
const ignoreGold = orig.filter((r) => r.gold === "ignore");
const initialIgnoreRecall = ignoreGold.filter((r) => r.oldStatus === "judged" && r.oldKind === "ignore").length;
const candidateIgnoreRecall = ignoreGold.filter((r) => r.newStatus === "judged" && r.newKind === "ignore").length;
const initiallyCorrectIgnore = ignoreGold.filter((r) => r.oldStatus === "judged" && r.oldKind === "ignore");
const initialCorrectIgnoreNowCorrect = initiallyCorrectIgnore.filter((r) => r.newStatus === "judged" && r.newKind === "ignore").length;
const transitions = {};
for (const t of ["fixed", "regressed", "retained", "unresolved", "unassessed"]) {
  transitions[t] = orig.filter((r) => r.transition === t).length;
}

const a = rows.filter((r) => r.set === "family-A");
const aCorrect = a.filter((r) => r.newStatus === "judged" && r.newKind === r.gold).length;
const b = rows.filter((r) => r.set === "family-B");
const bCorrect = b.filter((r) => r.newStatus === "judged" && r.newKind === r.gold).length;
  const bCompact = bStateRows.map(({ state, expected, wrapper }) => ({
    state,
    expected,
    newStatus: wrapper.judgmentStatus,
    newKind: wrapper.basicKind,
    score: wrapper.score,
    margin: wrapper.margin,
  }));
const humanOk = humanRows.filter((r) => r.newStatus === "judged" && r.newKind === "container");
const twoParamPreserved = twoParamRows.filter((r) => r.preserved).length;
const childPreserved = bChildRows.filter((r) => r.preserved).length;

const summary = {
  candidateWeight: args["candidate-weight"],
  candidateProfileId: candidateAsset.profile.id,
  initialWeight: args["initial-weight"],
  thresholds: { minScore: candidateAsset.config.minScore, minMargin: candidateAsset.config.minMargin },
  original420: { total: orig.length, initialCorrect, transitions, ignoreGold: ignoreGold.length, initialIgnoreRecall, candidateIgnoreRecall, initiallyCorrectIgnore: initiallyCorrectIgnore.length, initialCorrectIgnoreNowCorrect },
  twoParamDiagnosticRows: { total: twoParamRows.length, train: twoParamRows.filter((r) => r.usage === "train").length, eval: twoParamRows.filter((r) => r.usage === "eval").length, preserved: twoParamPreserved },
  familyA: { total: a.length, correct: aCorrect },
  familyB: { total: b.length, correct: bCorrect, bStateRows: bCompact },
  humanNative: { total: humanRows.length, containerPassed: humanOk.length, rows: humanRows },
  counterexample: cexDetail,
  childRetention: { childRows: bChildRows.length, childPreserved },
};

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(`${args.out.replace(/\.json$/, "")}-rows.jsonl`, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
writeFileSync(`${args.out.replace(/\.json$/, "")}-two-param.json`, `${JSON.stringify(twoParamRows, null, 2)}\n`);
console.log(JSON.stringify({
  original: { total: orig.length, initialCorrect, transitions, ignoreRecall: `${initialIgnoreRecall}/${ignoreGold.length} -> ${candidateIgnoreRecall}/${ignoreGold.length}`, initiallyCorrectIgnoreNowCorrect: `${initialCorrectIgnoreNowCorrect}/${initiallyCorrectIgnore.length}` },
  twoParam: { total: twoParamRows.length, preserved: twoParamPreserved },
  familyA: `${aCorrect}/18`, familyB: `${bCorrect}/${b.length}`,
  humanNative: { total: humanRows.length, containerPassed: humanOk.length },
  counterexample: cexDetail.candidate,
  childRetention: { childRows: bChildRows.length, childPreserved },
}));
