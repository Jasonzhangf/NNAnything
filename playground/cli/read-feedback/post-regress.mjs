// Per-case regression gate: the same old gold, the initial candidate and the
// post-use candidate side by side.
//
// This entry answers one narrow question: did any old, required capability that
// the initial candidate already delivered get worse after post-training? It
// compares per case and per head/requirement on the pretraining verification
// partition (the old gold). That slice was learned by the legacy initial
// candidate (which fitted all 76 cases), so it is retained as a known-regression
// reference; for a train-only clean initial it is held out relative to that
// initial. Either way it is evaluation only, never mixed into any fit here.
//
// Non-regression (post vs initial per case, zero regressed) is reported in
// `nonRegression` and is deliberately separate from `overallQualification`,
// which is always false this round: independent-source generalization is not
// established, efficiency is not proven, and supervision positive gaps remain.
//
// Exit code is 0 whenever the report is written. Exit 0 is NOT a pass.
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  BASE_LABELS,
  REASONING_LABELS,
  buildCases,
  measureCase,
  measureBase,
  measureReasoning,
  readReadFeedbackUnit,
  superviseBase,
  superviseReasoning,
} from "nnanything/cli-read-feedback";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";
const initialDir = process.env.NN_INITIAL_DIR ?? outDir;
const postDir = process.env.NN_POST_DIR ?? join(outDir, "post");
const zeroDir = process.env.NN_ZERO_DIR ?? join(outDir, "post-zero");

const VERDICT = ["retained", "fixed", "regressed", "unknown"];
const classify = (initialCorrect, postCorrect) => {
  if (initialCorrect && postCorrect) return "retained";
  if (!initialCorrect && postCorrect) return "fixed";
  if (initialCorrect && !postCorrect) return "regressed";
  return "unknown";
};

// Determine whether the initial candidate's own training fit included the
// verification partition. The legacy pretraining entry fitted all 76 cases;
// the clean entry fits the train partition only. The report words the corpus
// provenance from the recorded evidence, never from a hardcoded claim.
function readInitialFitScope() {
  const scope = process.env.NN_INITIAL_FIT_SCOPE;
  if (scope === "legacy_all_cases" || scope === "clean_train_only") return scope;
  try {
    const text = readFileSync(join(initialDir, "training-report.json"), "utf8");
    const report = JSON.parse(text);
    if (report?.contamination?.fittedPartitions?.includes("verification")) return "legacy_all_cases";
    const baseVerification = report?.fitted?.base?.partitionCounts?.verification;
    if (typeof baseVerification === "number" && baseVerification === 0) return "clean_train_only";
  } catch {
    // Fall through to the explicit scope requirement below.
  }
  throw new Error("NN_INITIAL_FIT_SCOPE must be legacy_all_cases or clean_train_only, or the initial training-report must record the fitted partitions");
}
const initialFitScope = readInitialFitScope();

const cases = buildCases().filter(spec => spec.partition === "verification");
assert.ok(cases.length > 0, "the old gold verification partition must not be empty");
const measurements = [];
for (const spec of cases) measurements.push(await measureCase(spec));

const initialUnit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: join(initialDir, "base-profile.json"),
  reasoningProfilePath: join(initialDir, "reasoning-profile.json"),
});
const postUnit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: join(postDir, "base-profile.json"),
  reasoningProfilePath: join(postDir, "reasoning-profile.json"),
});

/** Compare two units case by case on the old gold. */
function compare(initial, candidate) {
  const basePerHead = Object.fromEntries(BASE_LABELS.map(label => [label, {
    scored: 0, initialCorrect: 0, candidateCorrect: 0,
    retained: 0, fixed: 0, regressed: 0, unknown: 0,
  }]));
  const reasoningByFamily = {};
  const reasoningByAllowed = Object.fromEntries(REASONING_LABELS.map(label => [label, {
    scored: 0, initialCorrect: 0, candidateCorrect: 0,
    retained: 0, fixed: 0, regressed: 0, unknown: 0,
  }]));
  const casesOut = [];
  let reasoningScored = 0;
  let reasoningInitialCorrect = 0;
  let reasoningCandidateCorrect = 0;

  for (const measurement of measurements) {
    const attempt = measurement.attempt;
    const context = measurement.spec.context;
    const gold = superviseBase(attempt);
    const initialBase = initial.inferBase(measureBase(attempt));
    const candidateBase = candidate.inferBase(measureBase(attempt));

    const perHead = {};
    for (const label of BASE_LABELS) {
      if (gold.mask[label] === 0) { perHead[label] = "masked"; continue; }
      const initialCorrect = initialBase[label] === gold.label[label];
      const candidateCorrect = candidateBase[label] === gold.label[label];
      const verdict = classify(initialCorrect, candidateCorrect);
      perHead[label] = verdict;
      const bucket = basePerHead[label];
      bucket.scored += 1;
      if (initialCorrect) bucket.initialCorrect += 1;
      if (candidateCorrect) bucket.candidateCorrect += 1;
      bucket[verdict] += 1;
    }

    const allowed = superviseReasoning(attempt, context).allowed;
    const initialPrediction = initial.inferReasoning(measureReasoning(initialBase, attempt, context));
    const candidatePrediction = candidate.inferReasoning(measureReasoning(candidateBase, attempt, context));
    const initialCorrect = allowed.includes(initialPrediction);
    const candidateCorrect = allowed.includes(candidatePrediction);
    const verdict = classify(initialCorrect, candidateCorrect);
    reasoningScored += 1;
    if (initialCorrect) reasoningInitialCorrect += 1;
    if (candidateCorrect) reasoningCandidateCorrect += 1;

    const family = measurement.spec.family;
    reasoningByFamily[family] ??= { scored: 0, initialCorrect: 0, candidateCorrect: 0, retained: 0, fixed: 0, regressed: 0, unknown: 0 };
    const familyBucket = reasoningByFamily[family];
    familyBucket.scored += 1;
    if (initialCorrect) familyBucket.initialCorrect += 1;
    if (candidateCorrect) familyBucket.candidateCorrect += 1;
    familyBucket[verdict] += 1;
    for (const label of allowed) {
      const bucket = reasoningByAllowed[label];
      bucket.scored += 1;
      if (initialCorrect) bucket.initialCorrect += 1;
      if (candidateCorrect) bucket.candidateCorrect += 1;
      bucket[verdict] += 1;
    }

    casesOut.push({
      caseId: measurement.spec.id,
      family,
      base: perHead,
      reasoning: {
        initialPrediction,
        candidatePrediction,
        allowed,
        verdict,
      },
    });
  }

  const baseRegressed = BASE_LABELS.flatMap(label => casesOut
    .filter(item => item.base[label] === "regressed")
    .map(item => `${item.caseId}/${label}`));
  const reasoningRegressed = casesOut
    .filter(item => item.reasoning.verdict === "regressed")
    .map(item => item.caseId);
  const baseTotals = {
    scored: Object.values(basePerHead).reduce((sum, bucket) => sum + bucket.scored, 0),
    initialCorrect: Object.values(basePerHead).reduce((sum, bucket) => sum + bucket.initialCorrect, 0),
    candidateCorrect: Object.values(basePerHead).reduce((sum, bucket) => sum + bucket.candidateCorrect, 0),
    retained: Object.values(basePerHead).reduce((sum, bucket) => sum + bucket.retained, 0),
    fixed: Object.values(basePerHead).reduce((sum, bucket) => sum + bucket.fixed, 0),
    regressed: Object.values(basePerHead).reduce((sum, bucket) => sum + bucket.regressed, 0),
    unknown: Object.values(basePerHead).reduce((sum, bucket) => sum + bucket.unknown, 0),
  };

  const reasons = [];
  if (baseTotals.regressed > 0) {
    reasons.push(`base regressed on ${baseTotals.regressed} head(s): ${baseRegressed.join(", ")}`);
  }
  if (reasoningRegressed.length > 0) {
    reasons.push(`reasoning regressed on ${reasoningRegressed.length} case(s): ${reasoningRegressed.join(", ")}`);
  }
  if (baseTotals.candidateCorrect < baseTotals.initialCorrect && baseTotals.regressed === 0) {
    reasons.push("base correct heads decreased without a classified regression");
  }
  if (reasoningCandidateCorrect < reasoningInitialCorrect && reasoningRegressed.length === 0) {
    reasons.push("reasoning correct cases decreased without a classified regression");
  }

  return {
    cases: casesOut,
    base: {
      totals: {
        ...baseTotals,
        initialAccuracy: baseTotals.scored === 0 ? null : baseTotals.initialCorrect / baseTotals.scored,
        candidateAccuracy: baseTotals.scored === 0 ? null : baseTotals.candidateCorrect / baseTotals.scored,
      },
      perHead: basePerHead,
      regressed: baseRegressed,
    },
    reasoning: {
      totals: {
        scored: reasoningScored,
        initialCorrect: reasoningInitialCorrect,
        candidateCorrect: reasoningCandidateCorrect,
        initialAccuracy: reasoningScored === 0 ? null : reasoningInitialCorrect / reasoningScored,
        candidateAccuracy: reasoningScored === 0 ? null : reasoningCandidateCorrect / reasoningScored,
        retained: casesOut.filter(item => item.reasoning.verdict === "retained").length,
        fixed: casesOut.filter(item => item.reasoning.verdict === "fixed").length,
        regressed: reasoningRegressed.length,
        unknown: casesOut.filter(item => item.reasoning.verdict === "unknown").length,
      },
      byFamily: reasoningByFamily,
      byAllowedLabel: reasoningByAllowed,
      regressed: reasoningRegressed,
    },
    qualified: reasons.length === 0,
    reasons,
  };
}

const post = compare(initialUnit, postUnit);
const zero = compare(initialUnit, await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: join(zeroDir, "base-profile.json"),
  reasoningProfilePath: join(zeroDir, "reasoning-profile.json"),
}));

const report = {
  schema: "nnanything.cli-read-feedback.post-regression-report.v1",
  generatedBy: "playground/cli/read-feedback/post-regress.mjs",
  corpus: {
    partition: "verification",
    cases: measurements.length,
    provenance: initialFitScope,
    note: initialFitScope === "legacy_all_cases"
      ? "the old gold verification partition was inside the legacy initial candidate's own fit; it is a known-regression reference only and is never claimed as unseen"
      : "the old gold verification partition is a known-regression reference; the clean initial candidate did not fit it, but it is not independent unseen evidence because the same old gold was already used by the legacy candidate",
    headVerdicts: VERDICT,
    evaluationOnly: true,
  },
  profiles: {
    initial: { base: join(initialDir, "base-profile.json"), reasoning: join(initialDir, "reasoning-profile.json") },
    post: { base: join(postDir, "base-profile.json"), reasoning: join(postDir, "reasoning-profile.json") },
    zeroStartDiagnostic: { base: join(zeroDir, "base-profile.json"), reasoning: join(zeroDir, "reasoning-profile.json") },
  },
  nonRegression: {
    candidate: "post",
    baseline: "initial candidate",
    policy: "continued post-training (warm start + pretraining train replay + new sourced usage supervision)",
    passed: post.qualified,
    regressedBase: post.base.totals.regressed,
    regressedReasoning: post.reasoning.totals.regressed,
    reasons: post.reasons,
    scope: "per-case retained/fixed/regressed/unknown on the old gold; passing means no old capability got worse, it is not an overall qualification",
    headVerdicts: VERDICT,
  },
  overallQualification: {
    qualified: false,
    status: "INCOMPLETE",
    reasons: [
      "independent-source generalization is not established: the 12 families are deterministic templates from one author, and no independent-source corpus was evaluated",
      initialFitScope === "legacy_all_cases"
        ? "the legacy initial candidate was fitted on all 76 cases, so the old verification slice is no longer unseen"
        : "the clean initial candidate is train-only, so this verification slice is held out relative to it, but independent-source generalization remains unestablished",
      "efficiency is not proven: the three arms request the same 74 held-out bytes",
      "supervision positive gaps remain: several base heads and reasoning requirements have no usage positives",
    ],
    note: "non-regression passing does not make the candidate qualified; exit code 0 is not a pass and the candidate stays unapplied",
  },
  post: {
    base: post.base,
    reasoning: post.reasoning,
  },
  perCase: {
    note: "one row per old gold case: initial vs post verdict per base head and for the reasoning requirement",
    cases: post.cases,
  },
  zeroStartDiagnostic: {
    label: "all-zero start diagnostic control; kept as failure evidence, not a post-training deliverable",
    qualified: zero.qualified,
    reasons: zero.reasons,
    cases: zero.cases,
    base: { totals: zero.base.totals, regressed: zero.base.regressed },
    reasoning: { totals: zero.reasoning.totals, regressed: zero.reasoning.regressed },
  },
  applied: false,
};
// The report belongs beside the candidate it judges. A foreign candidate
// directory (for example a deliberately degraded one) must never overwrite the
// delivered candidate's report.
const deliveredPostDir = join(outDir, "post");
const reportPath = process.env.NN_REPORT_PATH
  ?? (postDir === deliveredPostDir ? join(outDir, "post-regression-report.json") : join(postDir, "post-regression-report.json"));
report.reportPath = reportPath;
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
