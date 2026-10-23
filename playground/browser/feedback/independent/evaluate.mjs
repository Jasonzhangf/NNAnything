import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  auditFeedbackProjections,
  predictFeedback,
  validateFeedbackProfile,
} from "nnanything/browser-feedback";
import {
  predictBrowserStrategy,
  validateBrowserStrategyProfile,
} from "nnanything/browser-strategy";
import { INDEPENDENT_CASES } from "./cases.mjs";

const RUN_ROOT = "/Volumes/Intel/playground/nnanything-runs/browser-longhorizon-20261022";
const F1_PROFILE = `${RUN_ROOT}/b-feedback/training/f1/candidate.json`;
const F2_PROFILE = "/Volumes/Intel/playground/nnanything-runs/browser-semantic-single-action-20261020/progressive-strategy/fitted-r1/candidate.json";
const ATOMIC_PROFILE = "/Volumes/Intel/playground/nnanything-runs/browser-semantic-single-action-20261020/fitted/candidate.json";
const DEFAULT_OUT = `${RUN_ROOT}/b-feedback/verification/independent`;

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--out", "--check"].includes(name) || value === undefined && name === "--out") {
      throw new Error(`expected --out <dir> or --check`);
    }
    if (name === "--check") {
      options.set(name, true);
      index -= 1;
      continue;
    }
    if (options.has(name)) throw new Error(`duplicate option ${name}`);
    options.set(name, value);
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(args.get("--out") ?? DEFAULT_OUT);
const checkOnly = args.get("--check") === true;

const f1Profile = validateFeedbackProfile(JSON.parse(await readFile(F1_PROFILE, "utf8")));
const f2Profile = validateBrowserStrategyProfile(JSON.parse(await readFile(F2_PROFILE, "utf8")));
const atomicProfile = JSON.parse(await readFile(ATOMIC_PROFILE, "utf8"));

const headEpisodes = INDEPENDENT_CASES.filter(c => c.teacher !== null).map(c => ({
  id: c.id,
  family: c.family,
  partition: c.partition,
  input: c.input,
  teacher: c.teacher,
}));
const audit = auditFeedbackProjections(headEpisodes);
const uniqueProjections = new Set(INDEPENDENT_CASES.map(c => JSON.stringify(c.features)));
const newProjections = new Set(
  INDEPENDENT_CASES.filter(c => c.sourceType === "new-source-new-projection").map(c => JSON.stringify(c.features)),
);

const fullGroups = new Map();
for (const c of INDEPENDENT_CASES) {
  const key = JSON.stringify(c.features);
  const gold = c.gold === "goal_achieved" ? "goal_achieved" : c.gold;
  const group = fullGroups.get(key);
  if (group === undefined) {
    fullGroups.set(key, { gold, ids: [c.id] });
  } else {
    if (group.gold !== gold) {
      throw new TypeError(`conflicting gold for projection ${key}: ${group.gold} (${group.ids.join(",")}) vs ${gold} (${c.id})`);
    }
    group.ids.push(c.id);
  }
}

const rows = INDEPENDENT_CASES.map(c => {
  const sourceTypeLabel = c.sourceType === "new-source-old-projection"
    ? "新来源旧投影"
    : "新来源新投影";
  const prediction = predictFeedback(c.input, f1Profile);
  const f1Actual = { status: prediction.status, head: prediction.head };
  const f1Pass = prediction.status === c.expected.status && prediction.head === c.expected.head;
  const strategy = predictBrowserStrategy(c.f2.episode.input, {
    profile: f2Profile,
    atomicProfile,
    feedbackProfile: f1Profile,
    registry: c.f2.episode.registry,
    selection: c.f2.episode.selection,
  });
  const actualSkill = strategy.kind === "SELECT" ? strategy.skillId : null;
  const policyPass = strategy.kind === c.f2.policy.kind
    && (c.f2.policy.kind === "DEFER" || actualSkill === c.f2.attemptedSkillId);
  const safetyPass = strategy.kind === c.f2.safety.kind
    && (c.f2.safety.kind === "DEFER" || actualSkill === c.f2.attemptedSkillId);
  let f1FailureClass = null;
  if (!f1Pass) {
    f1FailureClass = c.gold === "goal_achieved"
      ? "goal_achieved_gate"
      : prediction.status === "unknown"
        ? "tie_unknown"
        : "head_misprediction";
  }
  let safetyFailureClass = null;
  if (!safetyPass) {
    safetyFailureClass = c.f2.policy.kind === "SELECT" && c.f2.safety.kind === "DEFER"
      ? "policy_cannot_see_effect_knowledge"
      : "safety_decision_mismatch";
  }
  return {
    id: c.id,
    family: c.family,
    sourceType: sourceTypeLabel,
    sourceTypeKey: c.sourceType,
    gold: c.gold,
    actual: f1Actual.head ?? f1Actual.status,
    passed: f1Pass,
    f1FailureClass,
    projection: c.features,
    f2: {
      gold: c.f2.policy.kind === "SELECT" ? `SELECT:${c.f2.attemptedSkillId}` : "DEFER",
      actual: strategy.kind === "SELECT" ? `SELECT:${actualSkill}` : "DEFER",
      reason: strategy.reason,
      policyPass,
      safetyGold: c.f2.safety.kind === "SELECT" ? `SELECT:${c.f2.attemptedSkillId}` : "DEFER",
      safetyPass,
      safetyFailureClass,
      margins: strategy.candidates.map(candidate => ({
        strategyRef: candidate.strategyRef,
        margin: candidate.margin,
      })),
    },
  };
});

const f1Passed = rows.filter(row => row.passed).length;
const f1Failed = rows.length - f1Passed;
const policyPassed = rows.filter(row => row.f2.policyPass).length;
const policyFailed = rows.length - policyPassed;
const safetyPassed = rows.filter(row => row.f2.safetyPass).length;
const safetyFailed = rows.length - safetyPassed;

const summary = {
  // True only for the first evaluation of these cases by the fixed candidates.
  // A later rerun of the same material is not a first evaluation, and this flag
  // must not be read as "this execution was the first".
  firstEvaluation: true,
  fitted: false,
  processId: process.pid,
  f1Profile: { calibration: f1Profile.calibration, adoption: f1Profile.adoption },
  f2Profile: { calibration: f2Profile.calibration, adoption: f2Profile.adoption },
  count: rows.length,
  familyCounts: { "inspect-table": 12, "sheet-audit": 12 },
  projections: {
    distinct: uniqueProjections.size,
    newProjections: newProjections.size,
    oldProjections: uniqueProjections.size - newProjections.size,
    discernibilityConflicts: 0,
    fullSetConflictCount: 0,
    fullSetProjectionCount: fullGroups.size,
    auditHeadCount: audit.count,
    auditHeadProjectionCount: audit.projectionCount,
  },
  f1: { passed: f1Passed, failed: f1Failed, failures: rows.filter(row => !row.passed).map(row => ({ id: row.id, gold: row.gold, actual: row.actual, class: row.f1FailureClass })) },
  f2: {
    policy: { passed: policyPassed, failed: policyFailed, failures: rows.filter(row => !row.f2.policyPass).map(row => ({ id: row.id, gold: row.f2.gold, actual: row.f2.actual, reason: row.f2.reason })) },
    safetyBoundary: { passed: safetyPassed, failed: safetyFailed, failures: rows.filter(row => !row.f2.safetyPass).map(row => ({ id: row.id, safetyGold: row.f2.safetyGold, actual: row.f2.actual, class: row.f2.safetyFailureClass })) },
  },
};

const lines = [
  "# 独立 24 基例首次评价",
  "",
  `F1 候选：\`${F1_PROFILE}\``,
  `F2 候选：\`${F2_PROFILE}\``,
  "",
  `首次评价结果：F1 ${f1Passed}/${rows.length}，F2 政策层 ${policyPassed}/${rows.length}，F2 安全边界 ${safetyPassed}/${rows.length}。`,
  "",
  "| 家族 | id | 来源类型 | gold | actual | 通过 | F2 政策 | F2 安全 | F2 reason |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(row => {
    const f2Policy = row.f2.policyPass ? "PASS" : "FAIL";
    const f2Safety = row.f2.safetyPass ? "PASS" : "FAIL";
    return `| ${row.family} | ${row.id} | ${row.sourceType} | ${row.gold} | ${row.actual} | ${row.passed ? "PASS" : "FAIL"} | ${f2Policy} | ${f2Safety} | ${row.f2.reason ?? ""} |`;
  }),
  "",
];

if (checkOnly) {
  console.log(JSON.stringify({ count: rows.length, summary: { f1: summary.f1, f2: summary.f2, projections: summary.projections } }, null, 2));
} else {
  await mkdir(outDir, { recursive: true });
  const casesPath = resolve(outDir, "cases.json");
  const rowsPath = resolve(outDir, "rows.jsonl");
  const summaryPath = resolve(outDir, "summary.json");
  const tablePath = resolve(outDir, "table.md");
  const casesPayload = INDEPENDENT_CASES.map(c => ({
    id: c.id,
    family: c.family,
    partition: c.partition,
    title: c.title,
    sourceType: c.sourceType === "new-source-old-projection" ? "新来源旧投影" : "新来源新投影",
    sourceTypeKey: c.sourceType,
    gold: c.gold,
    expected: c.expected,
    projection: c.features,
    f2: {
      id: c.f2.episode.id,
      input: c.f2.episode.input,
      registry: c.f2.episode.registry,
      selection: c.f2.episode.selection,
      teacher: c.f2.episode.teacher,
      policy: c.f2.policy,
      safety: c.f2.safety,
    },
  }));
  await writeFile(casesPath, `${JSON.stringify(casesPayload, null, 2)}\n`);
  await writeFile(rowsPath, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(tablePath, `${lines.join("\n")}\n`);
  const casesStat = await stat(casesPath);
  const rowsStat = await stat(rowsPath);
  // The mtime pair only records the write order of the serialized artifacts, so
  // it cannot prove on its own that the case source existed before the first
  // evaluation. That claim rests on the dispatcher keeping the case files on
  // disk and on the first evaluation output matching every later rerun.
  console.log(JSON.stringify({
    outDir,
    count: rows.length,
    firstEvaluation: summary.firstEvaluation,
    casesWrittenBeforeRows: casesStat.mtimeMs <= rowsStat.mtimeMs,
    casesMtimeMs: casesStat.mtimeMs,
    rowsMtimeMs: rowsStat.mtimeMs,
    f1: summary.f1,
    f2: summary.f2,
    projections: summary.projections,
  }, null, 2));
}
