// Stage 3b: new-process reload of the post-use profiles.
//
// This entry is a separate Node process from `post-train.mjs`. It loads both
// profiles from `out/post/` through the existing public loader and scores the
// sampled verification partition. It never fits, mutates a profile, or falls
// back to an in-memory profile.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE_LABELS,
  measureBase,
  measureReasoning,
  mergeCoverage,
  readReadFeedbackUnit,
  superviseBase,
} from "nnanything/cli-read-feedback";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";
const postDir = join(outDir, "post");
const baseProfilePath = join(postDir, "base-profile.json");
const reasoningProfilePath = join(postDir, "reasoning-profile.json");

for (const path of [baseProfilePath, reasoningProfilePath]) {
  try {
    await access(path);
  } catch {
    throw new Error(`post-use profile missing: ${path}; run post-train.mjs first`);
  }
  const text = await readFile(path, "utf8");
  if (text.trim().length === 0) throw new Error(`post-use profile is empty: ${path}`);
  const parsed = JSON.parse(text);
  if (Object.hasOwn(parsed, "applied")) throw new Error(`post-use profile must not carry an applied marker: ${path}`);
}

// A same-process shortcut would mean using the in-memory fit results. This
// entry only has the saved files, and the loader rejects missing or invalid
// profiles.
const unit = await readReadFeedbackUnit({ handwiredRoot, baseProfilePath, reasoningProfilePath });

const samples = JSON.parse(await readFile(join(outDir, "usage-samples.json"), "utf8"));
if (samples?.schema !== "nnanything.cli-read-feedback.usage-samples.v1") {
  throw new TypeError("usage samples must use the read-feedback usage schema");
}
const verification = samples.runs.filter(run => run.task.partition === "verification");
if (verification.length === 0) throw new Error("no verification tasks in usage-samples.json");

const perHead = Object.fromEntries(BASE_LABELS.map(label => [label, { correct: 0, scored: 0 }]));
let baseCorrect = 0;
let baseScored = 0;
let attemptsScored = 0;
let reasoningCorrect = 0;
let reasoningScored = 0;
let decisionsScored = 0;
const misses = [];

for (const run of verification) {
  const prior = [];
  const attemptById = new Map();
  for (const record of run.attempts) {
    const attempt = Object.freeze({
      request: run.task.request,
      observation: record.observation === null
        ? null
        : Object.freeze({ ...record.observation, bytes: "" }),
      failure: record.failure,
      priorCoverage: Object.freeze(mergeCoverage([...prior])),
    });
    attemptById.set(record.attemptId, attempt);
    const gold = superviseBase(attempt);
    const predicted = unit.inferBase(measureBase(attempt));
    attemptsScored += 1;
    for (const label of BASE_LABELS) {
      if (gold.mask[label] === 0) continue;
      baseScored += 1;
      perHead[label].scored += 1;
      if (predicted[label] === gold.label[label]) {
        baseCorrect += 1;
        perHead[label].correct += 1;
      } else {
        misses.push({ taskId: run.task.id, attemptId: record.attemptId, unit: "base", label, predicted: predicted[label], gold: gold.label[label] });
      }
    }
    prior.push(...record.coverage);
  }
  for (const decision of run.decisions) {
    const attempt = attemptById.get(decision.attemptId);
    assert.ok(attempt !== undefined, `${decision.attemptId}: decision has no receipt`);
    const basePrediction = unit.inferBase(measureBase(attempt));
    const prediction = unit.inferReasoning(measureReasoning(basePrediction, attempt, decision.context));
    reasoningScored += 1;
    decisionsScored += 1;
    if (decision.allowed.includes(prediction)) {
      reasoningCorrect += 1;
    } else {
      misses.push({ taskId: run.task.id, attemptId: decision.attemptId, unit: "reasoning", predicted: prediction, allowed: decision.allowed });
    }
  }
}

const output = {
  schema: "nnanything.cli-read-feedback.post-reload-report.v1",
  generatedBy: "playground/cli/read-feedback/post-reload.mjs",
  process: {
    pid: process.pid,
    cwd: process.cwd(),
    loadedFrom: { baseProfilePath, reasoningProfilePath },
    sameProcessShortcut: false,
  },
  verification: {
    tasks: verification.length,
    attempts: attemptsScored,
    decisions: decisionsScored,
    base: {
      correct: baseCorrect,
      scored: baseScored,
      accuracy: baseScored === 0 ? null : baseCorrect / baseScored,
      perHead: Object.fromEntries(BASE_LABELS.map(label => [label, {
        correct: perHead[label].correct,
        scored: perHead[label].scored,
        accuracy: perHead[label].scored === 0 ? null : perHead[label].correct / perHead[label].scored,
      }])),
    },
    reasoning: {
      allowedHits: reasoningCorrect,
      scored: reasoningScored,
      accuracy: reasoningScored === 0 ? null : reasoningCorrect / reasoningScored,
    },
  },
  misses,
  uncalibrated: true,
  applied: false,
};
console.log(JSON.stringify(output, null, 2));
assert.ok(attemptsScored > 0, "verification partition must score at least one real attempt");
assert.ok(decisionsScored > 0, "verification partition must score at least one sampled decision");
