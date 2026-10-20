import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  SINGLE_ACTION_RELATION_WIRES,
  type BrowserSingleActionProfile,
  type SingleActionPrediction,
  type SingleActionRelationPrediction,
  type SingleActionRequest,
  type SingleActionTeacherEpisode,
} from "../adapters/browser/single-action-contract.js";
import {
  predictBrowserSingleAction,
  singleActionCapabilityFeatures,
  singleActionRelationFeatures,
  validateBrowserSingleActionProfile,
} from "../filters/browser-single-action-policy.js";
import type {
  BrowserSingleActionFitTiming,
  BrowserSingleActionFitTrajectory,
} from "./browser-single-action-numeric.js";
import {
  readBrowserSingleActionPartitions,
  readBrowserSingleActionTeacherEpisodes,
  type BrowserSingleActionPartitions,
} from "./browser-single-action-samples.js";

const CONTROLS_KNOWN = SINGLE_ACTION_RELATION_WIRES.indexOf("controls.known");
const ENABLED_KNOWN = SINGLE_ACTION_RELATION_WIRES.indexOf("enabled.known");
const HIT_KNOWN = SINGLE_ACTION_RELATION_WIRES.indexOf("hit.known");

export interface BrowserSingleActionCaseEvaluation {
  readonly id: string;
  readonly family: string;
  readonly partition: SingleActionTeacherEpisode["partition"];
  readonly expectedCapability: SingleActionTeacherEpisode["teacher"]["capability"];
  readonly selectedCapability: SingleActionPrediction["capability"];
  readonly expectedProviderRefs: readonly string[];
  readonly predictedProviderRefs: readonly string[];
  readonly proposedTargetRef: string | null;
  readonly relationCorrect: boolean;
  readonly capabilityCorrect: boolean;
  readonly targetCorrect: boolean;
  readonly passed: boolean;
}

export interface BrowserSingleActionCandidateComparison {
  readonly count: number;
  readonly passed: number;
  readonly failed: number;
  readonly rows: readonly BrowserSingleActionCaseEvaluation[];
}

export interface BrowserSingleActionComparison {
  readonly train: Readonly<{
    zero: BrowserSingleActionCandidateComparison;
    rule: BrowserSingleActionCandidateComparison;
    trained: BrowserSingleActionCandidateComparison;
  }>;
  readonly development: Readonly<{
    zero: BrowserSingleActionCandidateComparison;
    rule: BrowserSingleActionCandidateComparison;
    trained: BrowserSingleActionCandidateComparison;
  }>;
}

export interface BrowserSingleActionTrainingAssessment {
  readonly accepted: boolean;
  readonly fullyVerified: false;
  readonly candidateStrictlyBetterThanZero: boolean;
  readonly reasons: readonly string[];
  readonly error: string | null;
}

export interface BrowserSingleActionTrainingReceipt {
  readonly contract: "browser.single-action-training-result.v1";
  readonly runId: string;
  readonly accepted: boolean;
  readonly fullyVerified: false;
  readonly error: string | null;
  readonly candidatePath: string;
  readonly reportPath: string;
  readonly casesPath: string;
  readonly profile: BrowserSingleActionProfile;
  readonly timing: BrowserSingleActionFitTiming;
  readonly comparison: BrowserSingleActionComparison;
  readonly assessment: BrowserSingleActionTrainingAssessment;
  readonly verification: Readonly<{ status: "not_provided" }>;
}

function readPredictionRelations(prediction: SingleActionPrediction): readonly string[] {
  return prediction.relations
    .filter(relation => relation.judgment === "actionable_provider")
    .map(relation => relation.ref);
}

function rulePrediction(request: SingleActionRequest): SingleActionPrediction {
  const relations: SingleActionRelationPrediction[] = request.state.elements.map(element => {
    const features = singleActionRelationFeatures(request, element);
    const controlsTarget = element.controls.status === "observed"
      && element.controls.value.includes(request.goal.regionRef);
    const enabled = element.enabled.status === "observed" ? element.enabled.value : null;
    const hit = element.hit.status === "observed" ? element.hit.value : null;
    const button = element.buttonSemantics.status === "observed" ? element.buttonSemantics.value : null;
    const decisive = features[CONTROLS_KNOWN] === 1
      && features[ENABLED_KNOWN] === 1
      && features[HIT_KNOWN] === 1
      && button !== null;
    const provider = decisive && controlsTarget && enabled === true && hit === true && button === true;
    return Object.freeze({
      ref: element.ref,
      features,
      scores: Object.freeze(provider ? [1, 0] : decisive ? [0, 1] : [0, 0]),
      judgment: provider ? "actionable_provider" : decisive ? "not_provider" : "unknown",
    });
  });
  const region = request.state.regions.find(item => item.ref === request.goal.regionRef);
  const expanded = region?.expanded.status === "observed" ? region.expanded.value : null;
  const providers = relations.filter(relation => relation.judgment === "actionable_provider");
  const capability = expanded === true
    ? "NOOP"
    : providers.length === 1
      ? "CLICK"
      : "DEFER";
  return Object.freeze({
    relations: Object.freeze(relations),
    capability,
    capabilityFeatures: singleActionCapabilityFeatures(request, relations),
    capabilityScores: Object.freeze(capability === "CLICK" ? [1, 0, 0] : capability === "NOOP" ? [0, 1, 0] : [0, 0, 1]),
    proposedTargetRef: capability === "CLICK" ? providers[0]!.ref : null,
  });
}

function evaluatePrediction(
  episode: SingleActionTeacherEpisode,
  prediction: SingleActionPrediction,
): BrowserSingleActionCaseEvaluation {
  const expectedProviders = new Set(episode.teacher.providerRefs);
  const unknownRefs = new Set(episode.teacher.unknownRefs);
  const predictionByRef = new Map(prediction.relations.map(relation => [relation.ref, relation]));
  let relationCorrect = true;
  for (const element of episode.request.state.elements) {
    const predicted = predictionByRef.get(element.ref);
    if (!predicted) throw new TypeError(`prediction omitted element ${element.ref}`);
    const decisive = predicted.features[CONTROLS_KNOWN] === 1
      && predicted.features[ENABLED_KNOWN] === 1
      && predicted.features[HIT_KNOWN] === 1;
    const expected = unknownRefs.has(element.ref) || !decisive
      ? "unknown"
      : expectedProviders.has(element.ref)
        ? "actionable_provider"
        : "not_provider";
    if (predicted.judgment !== expected) relationCorrect = false;
  }
  const predictedProviders = readPredictionRelations(prediction);
  const expectedTarget = episode.teacher.capability === "CLICK" && episode.teacher.providerRefs.length === 1
    ? episode.teacher.providerRefs[0]!
    : null;
  const capabilityCorrect = prediction.capability === episode.teacher.capability;
  const targetCorrect = prediction.proposedTargetRef === expectedTarget;
  return Object.freeze({
    id: episode.id,
    family: episode.family,
    partition: episode.partition,
    expectedCapability: episode.teacher.capability,
    selectedCapability: prediction.capability,
    expectedProviderRefs: Object.freeze([...episode.teacher.providerRefs]),
    predictedProviderRefs: Object.freeze(predictedProviders),
    proposedTargetRef: prediction.proposedTargetRef,
    relationCorrect,
    capabilityCorrect,
    targetCorrect,
    passed: relationCorrect && capabilityCorrect && targetCorrect,
  });
}

function evaluateWith(
  episodes: readonly SingleActionTeacherEpisode[],
  predictor: (request: SingleActionRequest) => SingleActionPrediction,
): BrowserSingleActionCandidateComparison {
  const rows = episodes.map(episode => evaluatePrediction(episode, predictor(episode.request)));
  const passed = rows.filter(row => row.passed).length;
  return Object.freeze({
    count: rows.length,
    passed,
    failed: rows.length - passed,
    rows: Object.freeze(rows),
  });
}

export function evaluateBrowserSingleActionComparison(
  partitionsValue: unknown,
  profileValue: unknown,
): BrowserSingleActionComparison {
  const partitions = readBrowserSingleActionPartitions(partitionsValue);
  const profile = validateBrowserSingleActionProfile(profileValue);
  const candidate = (request: SingleActionRequest) => predictBrowserSingleAction(request, profile);
  return Object.freeze({
    train: Object.freeze({
      zero: evaluateWith(partitions.train, request => predictBrowserSingleAction(
        request,
        validateBrowserSingleActionProfile({
          ...profile,
          relationWeights: profile.relationWeights.map(row => row.map(() => 0)),
          capabilityWeights: profile.capabilityWeights.map(row => row.map(() => 0)),
        }),
      )),
      rule: evaluateWith(partitions.train, rulePrediction),
      trained: evaluateWith(partitions.train, candidate),
    }),
    development: Object.freeze({
      zero: evaluateWith(partitions.development, request => predictBrowserSingleAction(
        request,
        validateBrowserSingleActionProfile({
          ...profile,
          relationWeights: profile.relationWeights.map(row => row.map(() => 0)),
          capabilityWeights: profile.capabilityWeights.map(row => row.map(() => 0)),
        }),
      )),
      rule: evaluateWith(partitions.development, rulePrediction),
      trained: evaluateWith(partitions.development, candidate),
    }),
  });
}

export function assessBrowserSingleActionTraining(
  comparison: BrowserSingleActionComparison,
): BrowserSingleActionTrainingAssessment {
  const candidateStrictlyBetterThanZero = comparison.train.trained.passed > comparison.train.zero.passed
    && comparison.development.trained.passed > comparison.development.zero.passed;
  const reasons: string[] = [];
  if (!candidateStrictlyBetterThanZero) reasons.push("candidate_not_strictly_better_than_zero");
  if (comparison.train.trained.failed > 0) reasons.push("train_cases_failed");
  if (comparison.development.trained.failed > 0) reasons.push("development_cases_failed");
  const accepted = reasons.length === 0;
  return Object.freeze({
    accepted,
    fullyVerified: false,
    candidateStrictlyBetterThanZero,
    reasons: Object.freeze(reasons),
    error: accepted ? null : reasons.join(", "),
  });
}

async function ensureOutputDirectory(outputDirectory: string): Promise<string> {
  if (!isAbsolute(outputDirectory)) throw new TypeError("outputDirectory must be absolute");
  await mkdir(outputDirectory, { recursive: true });
  const info = await lstat(outputDirectory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new TypeError("outputDirectory must resolve to a real directory");
  }
  return outputDirectory;
}

async function writeNew(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

export async function writeBrowserSingleActionTrainingArtifacts(input: Readonly<{
  outputDirectory: string;
  runId: string;
  profile: BrowserSingleActionProfile;
  timing: BrowserSingleActionFitTiming;
  trajectory: BrowserSingleActionFitTrajectory;
  comparison: BrowserSingleActionComparison;
  assessment: BrowserSingleActionTrainingAssessment;
  onPartial?: (paths: Readonly<{ candidatePath?: string; reportPath?: string; casesPath?: string }>) => void;
}>): Promise<Readonly<{
  candidatePath: string;
  reportPath: string;
  casesPath: string;
  receipt: BrowserSingleActionTrainingReceipt;
}>> {
  const directory = await ensureOutputDirectory(input.outputDirectory);
  const profile = validateBrowserSingleActionProfile(input.profile);
  const candidatePath = join(directory, "candidate.json");
  const reportPath = join(directory, "report.json");
  const casesPath = join(directory, "cases.jsonl");
  await writeNew(candidatePath, `${JSON.stringify(profile, null, 2)}\n`);
  input.onPartial?.({ candidatePath });
  await writeNew(casesPath, [
    ...input.comparison.train.trained.rows,
    ...input.comparison.development.trained.rows,
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  input.onPartial?.({ candidatePath, casesPath });
  const receipt: BrowserSingleActionTrainingReceipt = Object.freeze({
    contract: "browser.single-action-training-result.v1",
    runId: input.runId,
    accepted: input.assessment.accepted,
    fullyVerified: false,
    error: input.assessment.error,
    candidatePath,
    reportPath,
    casesPath,
    profile,
    timing: input.timing,
    comparison: input.comparison,
    assessment: input.assessment,
    verification: Object.freeze({ status: "not_provided" }),
  });
  await writeNew(reportPath, `${JSON.stringify({
    ...receipt,
    trajectory: input.trajectory,
  }, null, 2)}\n`);
  input.onPartial?.({ candidatePath, reportPath, casesPath });
  return Object.freeze({ candidatePath, reportPath, casesPath, receipt });
}

export function evaluateBrowserSingleActionCases(
  profileValue: unknown,
  casesValue: unknown,
): Readonly<{
  count: number;
  passed: number;
  failed: number;
  rows: readonly BrowserSingleActionCaseEvaluation[];
}> {
  const profile = validateBrowserSingleActionProfile(profileValue);
  const cases = readBrowserSingleActionTeacherEpisodes(casesValue, { allowVerification: true });
  return evaluateWith(cases, request => predictBrowserSingleAction(request, profile));
}

export function readBrowserSingleActionTrainingReceipt(value: unknown): BrowserSingleActionTrainingReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("browser single action training receipt must be an object");
  }
  const input = value as BrowserSingleActionTrainingReceipt;
  if (input.contract !== "browser.single-action-training-result.v1") {
    throw new TypeError("browser single action training receipt contract is invalid");
  }
  return Object.freeze({
    ...input,
    profile: validateBrowserSingleActionProfile(input.profile),
    fullyVerified: false,
    verification: Object.freeze({ status: "not_provided" }),
  });
}
