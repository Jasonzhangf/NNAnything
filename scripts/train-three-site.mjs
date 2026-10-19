#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALUE_FLAGS = new Set([
  "--input", "--base-weight", "--gold-reference", "--handwired-root", "--out-dir",
  "--weights-dir", "--trainable-wires", "--epochs", "--learning-rate", "--anchor-lambda",
  "--objective", "--stop-when",
]);
const REQUIRED = ["--input", "--base-weight", "--handwired-root", "--out-dir", "--weights-dir"];
const INFERENCE = Object.freeze({ taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 });
const OBJECTIVE = Object.freeze({ targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 });
const HELP = `Three-site warm-start training consumer

Usage:
  node scripts/train-three-site.mjs \\
    --input <prepared-training-request.json> \\
    --base-weight <current-weight-asset.json> \\
    [--gold-reference <legacy-reference.json>] \\
    --handwired-root <source-root> \\
    --out-dir <report-dir> --weights-dir <weight-dir> \\
    [--trainable-wires <wire[,wire...]>] \\
    [--epochs 500] [--learning-rate 0.01] [--anchor-lambda 0.02]
    [--objective priority_decision_v1] [--stop-when objective_feasible]

Training is development-only. Gold is evaluated after fitting, never trained on.
The candidate is uncalibrated and not applied. No browser work or build is run.
`;
class CliError extends Error {}
function parseArgs(argv) {
  const flags = new Map();
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!VALUE_FLAGS.has(key)) throw new CliError(`Unknown option: ${key}`);
    if (flags.has(key)) throw new CliError(`Duplicate option: ${key}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new CliError(`Missing value for ${key}`);
    flags.set(key, value);
  }
  for (const key of REQUIRED) if (!flags.has(key)) throw new CliError(`Missing required option: ${key}`);
  return { help: false, flags };
}
function numberFlag(flags, key, fallback, check, label) {
  if (!flags.has(key)) return fallback;
  const value = Number(flags.get(key));
  if (!Number.isFinite(value) || !check(value)) throw new CliError(`${label} is invalid`);
  return value;
}
function errorInfo(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, ...(typeof error.code === "string" ? { code: error.code } : {}) }
    : { name: "Error", message: String(error) };
}
async function readJson(path, label) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`${label}: ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function writeJsonNew(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
function correct(expectedLabel, judgment) {
  return expectedLabel !== null && expectedLabel !== "other"
    && judgment.judgmentStatus === "judged"
    && judgment.basicKind === expectedLabel;
}
function transition(oldCorrect, newCorrect, expectedLabel) {
  if (expectedLabel === null) return "unassessed";
  if (oldCorrect && newCorrect) return "retained";
  if (!oldCorrect && newCorrect) return "fixed";
  if (oldCorrect && !newCorrect) return "regressed";
  return "unresolved";
}
function summarize(rows) {
  const transitions = { fixed: 0, regressed: 0, retained: 0, unresolved: 0, unassessed: 0 };
  const statuses = { judged: 0, unknown: 0, conflict: 0 };
  for (const row of rows) {
    transitions[row.transition]++;
    statuses[row.new.judgmentStatus] = (statuses[row.new.judgmentStatus] ?? 0) + 1;
  }
  return { rows: rows.length, statuses, transitions };
}
function compact(judgment, expectedLabel) {
  return {
    familyStatus: judgment.familyStatus, family: judgment.family,
    judgmentStatus: judgment.judgmentStatus, basicKind: judgment.basicKind,
    score: judgment.score, margin: judgment.margin,
    correct: correct(expectedLabel, judgment), path: judgment.evidence.path,
  };
}
function compareRows(browser, rows, oldProfile, newProfile) {
  return rows.map(row => {
    const old = browser.classifyBasicKind(row.properties, INFERENCE, oldProfile);
    const next = browser.classifyBasicKind(row.properties, INFERENCE, newProfile);
    const oldCorrect = correct(row.expectedLabel, old), newCorrect = correct(row.expectedLabel, next);
    return {
      sampleId: row.sampleId, integration: row.integration, expectedLabel: row.expectedLabel,
      transition: transition(oldCorrect, newCorrect, row.expectedLabel),
      old: compact(old, row.expectedLabel),
      new: compact(next, row.expectedLabel),
    };
  });
}
function readGold(raw, browser) {
  if (raw === undefined) return [];
  if (!raw || !Array.isArray(raw.groups)) throw new TypeError("gold reference must contain groups");
  const labels = new Set([...Object.values(browser.BASIC_KIND_FAMILIES).flat(), "other"]);
  const rows = [];
  for (const [groupIndex, group] of raw.groups.entries()) {
    if (!group || typeof group.name !== "string" || !Array.isArray(group.rows)) {
      throw new TypeError(`gold reference group ${groupIndex} is invalid`);
    }
    if (group.name === "gold" && group.rows.length !== 357) {
      throw new TypeError(`gold reference group gold must contain 357 rows, got ${group.rows.length}`);
    }
    for (const [rowIndex, row] of group.rows.entries()) {
      if (!row || typeof row.sampleId !== "string" || !("properties" in row) || !("expectedLabel" in row)) {
        throw new TypeError(`gold reference ${group.name}[${rowIndex}] is invalid`);
      }
      if (row.expectedLabel !== null && !labels.has(row.expectedLabel)) {
        throw new TypeError(`gold reference ${group.name}[${rowIndex}] has an invalid label`);
      }
      rows.push({
        sampleId: row.sampleId,
        integration: `gold:${group.name}`,
        expectedLabel: row.expectedLabel,
        properties: browser.validateBasicKindProperties(row.properties),
      });
    }
  }
  return rows;
}
function makeWarmBase(browser, oldProfile, runId) {
  const initial = browser.PRIORITY_BASIC_KIND_INITIAL_PROFILE;
  const profile = {
    id: `${runId}-warm-base`, topology: "priority_staged_v1",
    familyWeights: structuredClone(initial.familyWeights),
    leafWeights: structuredClone(initial.leafWeights),
  };
  for (const group of ["familyWeights", "leafWeights"]) {
    for (const [target, weights] of Object.entries(oldProfile[group])) {
      if (profile[group][target] === undefined) throw new TypeError(`base profile target ${group}.${target} has no priority layout`);
      Object.assign(profile[group][target], weights);
    }
  }
  return browser.validateBasicKindProfile(profile);
}
function fitConfig(training, flags) {
  const mode = flags.get("--objective");
  if (mode !== undefined && mode !== "priority_decision_v1") throw new CliError("--objective must be priority_decision_v1");
  const trainableWires = flags.get("--trainable-wires")
    ?.split(",").map(value => value.trim()).filter(Boolean);
  const target = {
    taskId: "dom.basic-kinds.v1", ...INFERENCE, objective: { ...OBJECTIVE,
      ...(mode ? { mode, boundarySlack: 0.0001 } : {}),
    },
    fit: {
      epochs: numberFlag(flags, "--epochs", 500, value => Number.isInteger(value) && value >= 0, "--epochs"),
      learningRate: numberFlag(flags, "--learning-rate", 0.01, value => value > 0, "--learning-rate"),
      anchorLambda: numberFlag(flags, "--anchor-lambda", 0.02, value => value >= 0, "--anchor-lambda"),
      ...(trainableWires ? { trainableWires } : {}),
      ...(flags.has("--stop-when") ? { stopWhen: flags.get("--stop-when") } : {}),
    },
  };
  return training.validateBasicKindTrainingConfig(target);
}
function weightAsset(profile, baseProfileId) {
  return {
    targetOperator: "dom.basic_kinds", operatorVersion: "0.1.0", contractVersion: 2,
    taskId: "dom.basic-kinds.v1", profileId: profile.id, baseProfileId, calibrated: false,
    compatibility: INFERENCE, profile,
  };
}
function commonRoot(left, right) {
  let root = left;
  while (isAbsolute(relative(root, right)) || relative(root, right).startsWith("..")) root = dirname(root);
  return root;
}
async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help) { process.stdout.write(HELP); return 0; }
  let training, browser, workflow;
  try {
    [training, browser, workflow] = await Promise.all([
      import("nnanything/training"), import("nnanything/browser-classify"), import("nnanything"),
    ]);
  } catch (error) {
    throw new CliError(`Public package modules are unavailable; build the package first. ${errorInfo(error).message}`);
  }

  const flags = parsed.flags;
  const inputPath = resolve(flags.get("--input")), basePath = resolve(flags.get("--base-weight"));
  const outDir = resolve(flags.get("--out-dir")), weightsDir = resolve(flags.get("--weights-dir"));
  const handwiredRoot = resolve(flags.get("--handwired-root"));
  const goldPath = flags.has("--gold-reference") ? resolve(flags.get("--gold-reference")) : null;
  const runId = `three-site-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;
  await Promise.all([mkdir(outDir, { recursive: true }), mkdir(weightsDir, { recursive: true })]);
  const request = training.readBasicKindTrainingRequest(await readJson(inputPath, "training request"));
  const prepared = training.prepareBasicKindSamples(request, {
    taskId: "dom.basic-kinds.v1", inputScope: "candidate_qualified",
  });
  const trainRows = training.toBasicKindFitRows(prepared);
  if (!trainRows.length) throw new CliError("training request has no verified candidate-qualified rows");
  const oldProfile = browser.parseBrowserWeightAsset(await readJson(basePath, "base weight"), basePath).profile;
  const warmBase = makeWarmBase(browser, oldProfile, runId);
  const warmBasePath = join(weightsDir, `${runId}.warm-base.weight.json`);
  await writeJsonNew(warmBasePath, weightAsset(warmBase, oldProfile.id));
  const config = fitConfig(training, flags);
  const allowedRoot = commonRoot(outDir, weightsDir);
  const definition = await workflow.loadWorkflow({
    configPath: join(repositoryRoot, "workflows/node-training.workflow.json"), allowedRoot: repositoryRoot,
  });
  definition.bindings["准备节点输入与期望输出"].config = {
    taskId: "dom.basic-kinds.v1", inputScope: "candidate_qualified",
  };
  definition.bindings["按来源分组并划分用途"].config = {
    mode: "development_only", seed: 20261018, evalFraction: 0.25, allowInSampleEval: false,
  };
  definition.bindings["拟合目标节点参数"] = { config, profileId: warmBase.id };
  definition.bindings["比较新旧节点在相同样本的输出"] = { config, profileId: warmBase.id };
  definition.bindings["评估修复退化与证据不足"] = { config: { forbidGoldRegression: false } };
  definition.bindings["保存候选参数与训练报告"] = {
    config: {
      weightsDirectory: relative(allowedRoot, weightsDir),
      resultsDirectory: relative(allowedRoot, outDir),
    },
  };
  let progress, fitFailure;
  const nodeDefinitions = training.createTrainingNodeDefinitions({
    handwiredRoot, allowedRoot, onFitProgress: current => { progress = current; },
  }).map(node => node.operator !== "training.fit" ? node : {
    ...node, execute: async context => {
      try { return await node.execute(context); }
      catch (error) { fitFailure = error; throw error; }
    },
  });
  const compiled = workflow.compileWorkflow(definition, {
    nodeDefinitions,
    grantedEffects: ["filesystem.read", "filesystem.write"],
    profiles: training.loadTrainingProfiles({ profileId: warmBase.id, profile: warmBase }),
  });
  const result = await workflow.runWorkflow(compiled, workflow.createWorkflowInputEvent({
    runId, eventId: `${runId}:input`, port: compiled.entryArc.id,
    type: "training.request.v1",
    payload: request,
  }));
  if (result.status !== "completed") {
    const report = {
      schemaVersion: 1, taskId: "dom.basic-kinds.v1", runId, status: "failed",
      candidateAdoption: "not_applied", calibrated: false, warmBasePath, error: result.error,
      partialTiming: fitFailure?.timing ?? (progress ? {
        completedEpochs: progress.epoch, totalEpochs: progress.totalEpochs,
        lastLoss: progress.loss, sampleCount: progress.sampleCount,
      } : { completedEpochs: 0 }),
    };
    await writeJsonNew(join(outDir, `${runId}.failure.json`), report);
    console.error(JSON.stringify(report, null, 2));
    return 1;
  }
  const receipt = result.outputEvent.payload;
  if (result.outputEvent.status !== "ok" || receipt.weightFileRef === null) {
    const report = {
      schemaVersion: 1, taskId: "dom.basic-kinds.v1", runId, status: result.outputEvent.status,
      candidateAdoption: "not_applied", calibrated: false, receipt, warmBasePath,
    };
    await writeJsonNew(join(outDir, `${runId}.training.report.json`), report);
    console.log(JSON.stringify(report, null, 2));
    return 2;
  }
  const candidateAsset = await readJson(receipt.weightFileRef, "candidate weight");
  const candidate = browser.parseBrowserWeightAsset(candidateAsset, receipt.weightFileRef);
  if (candidate.profile.topology !== "priority_staged_v1") throw new Error("candidate is not priority_staged_v1");
  const train = compareRows(browser, trainRows.map((row, index) => ({
    ...row, sampleId: prepared.rows[prepared.includedIndices[index]].sampleId, integration: "train",
  })), oldProfile, candidate.profile);
  const developmentAccepted = train.every(row => row.new.correct);
  const requireDevelopment = config.objective.mode === "priority_decision_v1";
  const evaluateGold = goldPath !== null && (!requireDevelopment || developmentAccepted);
  const referenceRows = readGold(evaluateGold ? await readJson(goldPath, "gold reference") : undefined, browser);
  const goldRows = referenceRows.filter(row => row.expectedLabel !== null);
  const gold = compareRows(browser, goldRows, oldProfile, candidate.profile);
  const goldRegressions = gold.filter(row => row.transition === "regressed").length;
  const accepted = (!requireDevelopment || developmentAccepted) && goldRegressions === 0;
  const report = {
    schemaVersion: 1, taskId: "dom.basic-kinds.v1", runId, status: accepted ? "completed" : "rejected",
    developmentAccepted,
    dataset: {
      usage: "consumer_development_only", independentAccuracyClaim: false,
      requestRows: request.rows.length, preparedRows: prepared.includedIndices.length,
      trainRows: trainRows.length, goldEvalRows: goldRows.length,
    },
    inference: INFERENCE, objective: config.objective, fit: config.fit,
    candidate: {
      profileId: candidate.profile.id, topology: candidate.profile.topology,
      contractVersion: candidateAsset.contractVersion, adoption: "not_applied",
      calibrated: false, assetPath: receipt.weightFileRef, warmBasePath, reloaded: true,
    },
    workflowReceipt: receipt, timing: receipt.timing,
    stoppingReason: receipt.stoppingReason,
    train: { summary: summarize(train), rows: train },
    goldEvaluation: evaluateGold ? { summary: summarize(gold), rows: gold } : null,
    ...(!evaluateGold && goldPath !== null ? { goldSkippedReason: "development_rejected" } : {}),
    diagnostic: compareRows(browser, referenceRows.filter(row => row.expectedLabel === null), oldProfile, candidate.profile),
  };
  const reportPath = join(outDir, `${runId}.training.report.json`);
  await writeJsonNew(reportPath, report);
  console.log(JSON.stringify({
    status: report.status, reportPath, candidateAssetPath: receipt.weightFileRef,
    timing: report.timing, train: report.train.summary,
    goldEvaluation: report.goldEvaluation?.summary ?? null, candidateAdoption: "not_applied",
  }, null, 2));
  return accepted ? 0 : 3;
}
main().then(
  code => { process.exitCode = code; },
  error => {
    const timing = error && typeof error === "object" && "timing" in error ? error.timing : undefined;
    console.error(JSON.stringify({
      status: "failed", error: errorInfo(error),
      ...(timing && typeof timing === "object" ? { partialTiming: timing } : {}),
    }, null, 2));
    process.exitCode = 1;
  },
);
