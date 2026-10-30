import { appendFile, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import type { NodeDefinition } from "../core/contracts.js";
import { expectRecord } from "../core/schema.js";
import {
  createCliFilesystemSandbox,
  type CliFilesystemSandbox,
  type DirectoryRef,
  type SessionRef,
  type SessionSnapshot,
} from "../adapters/cli/filesystem-sandbox.js";
import { cleanupCliFilesystemSandboxes } from "../adapters/cli/sandbox-cleanup.js";
import {
  CLI_COMMAND_HEADS,
  detectCliCommandProfileSchema,
  predictCliCommand,
  validateCliCommandProfile,
  zeroCliCommandProfile,
  type CliCommandHead,
  type CliCommandProfile,
  type CliCommandStageId,
} from "../filters/cli-command-policy.js";
import { validateEntrySelectProfile } from "../filters/cli-entry-select-relation.js";
import {
  CWD_PROPERTY,
  ENTRIES_PROPERTY,
  PATH_ABSOLUTE_PROPERTY,
  PATH_PHYSICAL_PROPERTY,
  PATH_RELATIVE_PROPERTY,
  computePropertyFacts,
  expectedDirectoryOf,
  type EntryRef,
  type FilePropertyGoal,
  type FileRef,
  type InspectRef,
  type ObservedDirectoryRef,
  type PropertyFacts,
} from "../filters/cli-file-property.js";
import {
  createEvidenceAuthority,
  type EvidenceAuthority,
  type ExplicitFileState,
} from "../filters/cli-state.js";
import { fitCliCommandProfile } from "../training/cli-command-numeric.js";
import {
  evaluateCliCandidateNamePreference,
  fitCliCandidateNamePreference,
  prepareCliCandidatePreferenceDataset,
  type CliCandidatePreferenceDataset,
  type CliCandidatePreferenceEvaluationRow,
  type CliCandidatePreferenceInputRow,
} from "../training/cli-candidate-preference.js";
import {
  prepareCliCommandDataset,
  isBatch1CommandCase,
  sampleFacts,
  sampleFeatures,
  sampleGoal,
  type CliCommandDataset,
  type CommandSample,
  type CommandScenario,
} from "../training/cli-command-samples.js";
import type {
  CliCommandBinding,
  CliCommandRequest,
  CliCommandTransition,
  CliEntrySelectProfiles,
} from "./cli-command.js";

export type CliCommandDatasetTrainingRequest = Readonly<{
  task?: "command";
  stage?: CliCommandStageId;
  dataset: CliCommandDataset;
  initial: CliCommandProfile;
  initialSource: string | null;
  epochs: number;
  learningRate: number;
  entrySelectProfiles?: CliEntrySelectProfiles;
}>;

/**
 * Same 8N8E cli-filesystem-training workflow, second typed task branch. The
 * dataset is a candidate preference comparison set instead of command episodes.
 * Only the entry.inspect row of search.nameNeedleSegment is trainable.
 */
export type CliCommandPreferenceTrainingRequest = Readonly<{
  task: "candidate-preference";
  preferenceRows: readonly CliCandidatePreferenceInputRow[];
  initial: CliCommandProfile;
  initialSource: string | null;
  epochs: number;
  learningRate: number;
}>;

export type CliCommandTrainingRequest = CliCommandDatasetTrainingRequest | CliCommandPreferenceTrainingRequest;

export type CliCommandTrainingResources = Readonly<{
  handwiredRoot: string;
  outputRoot: string;
  grantedEffects: readonly string[];
  verification?: CliCommandDataset;
  entrySelectProfiles?: CliEntrySelectProfiles;
}>;

type Factory = (
  binding: CliCommandBinding,
  authority?: EvidenceAuthority,
) => { step(request: CliCommandRequest): Promise<CliCommandTransition> };
type Paths = { samples: string; profile: string; report: string; executions: string };

const port = (name: string, eventType: string) => ({ name, schemaId: eventType, eventType, validate: (value: unknown) => expectRecord(value, eventType) });
const record = (value: unknown) => expectRecord(value, "shared training payload");
const generic = (name: string) => ({ name, schemaId: `cli.${name}.v1`, eventType: `cli.${name}.v1`, validate: record });

export type CommandEvaluationRow = Readonly<{
  id: string;
  sourceGroup: string;
  partition: string;
  case: string;
  expectedHead: string;
  selectedHead: string;
  correct: boolean;
  effectsOk: boolean;
  sideEffectsOk: boolean;
  actualFacts: PropertyFacts;
  factsMatched: boolean;
  featuresMatched: boolean;
  status: string;
  satisfaction: 0 | 100 | null;
  reason: string;
  errorCode: string | null;
  invocation: CliCommandTransition["invocation"];
  transition: CliCommandTransition;
  setupWallTimeMs: number;
  candidateStepWallTimeMs: number;
  totalWallTimeMs: number;
  cleanup: "removed";
}>;

export type CliCommandTrainingReceipt = {
  runId: string;
  accepted: boolean;
  fullyVerified: boolean;
  paths: Paths;
  profile: CliCommandProfile;
  initialSource: string | null;
  initialProfile: CliCommandProfile;
  sourceProfile: CliCommandProfile;
  comparison: { train: ReturnType<typeof summarize>; development: ReturnType<typeof summarize> };
  controls: { zero: ReturnType<typeof controls>; frozen: ReturnType<typeof controls> };
  regression: Record<string, { retained: number; fixed: number; regressed: number; unresolved: number }>;
  semanticChanges: readonly Readonly<{ id: string; legacyExpectedHead: "cd"; currentExpectedHead: "NOOP"; observedHead: string }>[];
  verification: { status: "not_provided" } | { status: "evaluated"; evaluation: ReturnType<typeof summarize> };
  timing: Awaited<ReturnType<typeof fitCliCommandProfile>>["timing"] & Readonly<{
    includesPreStepSetupInTotal?: boolean;
    setupTotalMs?: number;
    candidateStepTotalMs?: number;
    evaluationTotalMs?: number;
    perHeadSetupWallTimeMs?: Readonly<Record<string, number>>;
    perHeadCandidateStepWallTimeMs?: Readonly<Record<string, number>>;
    perHeadEvalWallTimeMs?: Readonly<Record<string, number>>;
  }>;
};

export type CliCandidatePreferenceTrainingReceipt = {
  task: "candidate-preference";
  runId: string;
  accepted: boolean;
  fullyVerified: false;
  paths: Paths;
  profile: CliCommandProfile;
  initialProfile: CliCommandProfile;
  initialSource: string | null;
  dataset: Readonly<{ validPairCount: number; deltaOneCount: number; deltaZeroCount: number }>;
  trainable: Readonly<{
    head: string;
    wire: string;
    index: number;
    before: number;
    after: number;
    initialGradient: number;
    frozenParameterCount: number;
    frozenDelta: number;
  }>;
  loss: Readonly<{ before: number; after: number }>;
  execution: Readonly<{
    count: number;
    correct: number;
    rows: readonly CliCandidatePreferenceEvaluationRow[];
  }>;
  timing: Awaited<ReturnType<typeof fitCliCandidateNamePreference>>["timing"];
};

const COMMAND_REQUEST_KEYS = [
  "task",
  "stage",
  "dataset",
  "initial",
  "initialSource",
  "epochs",
  "learningRate",
  "entrySelectProfiles",
];
const PREFERENCE_REQUEST_KEYS = ["task", "preferenceRows", "initial", "initialSource", "epochs", "learningRate"];

function validateOptionalEntrySelectProfiles(
  profiles: CliEntrySelectProfiles | undefined,
): CliEntrySelectProfiles | undefined {
  if (profiles === undefined) return undefined;
  return Object.freeze({
    directory: validateEntrySelectProfile(profiles.directory),
    regular: validateEntrySelectProfile(profiles.regular),
  });
}

function requireEntrySelectProfiles(
  profiles: CliEntrySelectProfiles | undefined,
): CliEntrySelectProfiles {
  if (profiles === undefined) {
    throw new TypeError(
      "Stage 2 entry.select training/evaluation requires explicit validated entrySelectProfiles (directory and regular); embedded fallback weights are forbidden",
    );
  }
  return validateOptionalEntrySelectProfiles(profiles)!;
}

function resolveCommandStage(
  explicitStage: CliCommandStageId | undefined,
  profile: unknown,
): CliCommandStageId {
  if (explicitStage !== undefined) {
    if (explicitStage !== "stage1-11x34" && explicitStage !== "stage2-13x38") {
      throw new TypeError(`Command stage must be stage1-11x34 or stage2-13x38 (received ${String(explicitStage)})`);
    }
    return explicitStage;
  }
  return detectCliCommandProfileSchema(profile) === "current-11x34" ? "stage1-11x34" : "stage2-13x38";
}

function prepare(value: unknown): Prepared {
  const request = expectRecord(value, "command training request") as unknown as CliCommandTrainingRequest;
  const isPreference = (request as Readonly<{ task?: unknown }>).task === "candidate-preference";
  const allowed = isPreference ? PREFERENCE_REQUEST_KEYS : COMMAND_REQUEST_KEYS;
  if (Object.keys(request).some(key => !allowed.includes(key))) {
    throw new TypeError("Explicit shared training contract required");
  }
  if (request.initialSource !== null && typeof request.initialSource !== "string") throw new TypeError("initialSource must be a saved profile path or null");
  if (isPreference) {
    const preference = request as CliCommandPreferenceTrainingRequest;
    const initial = validateCliCommandProfile(preference.initial);
    return {
      kind: "candidate-preference" as const,
      request: { ...preference, initial },
      prepared: prepareCliCandidatePreferenceDataset(preference.preferenceRows),
      rows: Object.freeze([...preference.preferenceRows]),
    };
  }
  const command = request as CliCommandDatasetTrainingRequest;
  const stage = resolveCommandStage(command.stage, command.initial);
  const initial = validateCliCommandProfile(command.initial, stage);
  const entrySelectProfiles = validateOptionalEntrySelectProfiles(command.entrySelectProfiles);
  return {
    kind: "command" as const,
    stage,
    request: {
      ...command,
      stage,
      initial,
      ...(entrySelectProfiles === undefined ? {} : { entrySelectProfiles }),
    },
    prepared: prepareCliCommandDataset(command.dataset, ["train", "development"], stage),
  };
}

type PreparedCommand = {
  kind: "command";
  stage: CliCommandStageId;
  request: CliCommandDatasetTrainingRequest & { stage: CliCommandStageId; initial: CliCommandProfile };
  prepared: ReturnType<typeof prepareCliCommandDataset>;
};
type PreparedPreference = {
  kind: "candidate-preference";
  request: CliCommandPreferenceTrainingRequest & { initial: CliCommandProfile };
  prepared: CliCandidatePreferenceDataset;
  rows: readonly CliCandidatePreferenceInputRow[];
};
type Prepared = PreparedCommand | PreparedPreference;
type CommandPrepared = PreparedCommand;
type FittedCommand = PreparedCommand & { fit: Awaited<ReturnType<typeof fitCliCommandProfile>> };
type FittedPreference = PreparedPreference & { fit: Awaited<ReturnType<typeof fitCliCandidateNamePreference>> };
type Fitted = FittedCommand | FittedPreference;
type CommandSaved = FittedCommand & { paths: Paths };
type PreferenceSaved = FittedPreference & { paths: Paths };
type Saved = CommandSaved | PreferenceSaved;
type PreferenceSummary = Readonly<{ count: number; correct: number; passed: boolean }>;
type ExecutedCommand = CommandSaved & {
  rows: CommandEvaluationRow[];
  verificationProvided: boolean;
  setupTotalMs: number;
  candidateStepTotalMs: number;
  evaluationTotalMs: number;
  perHeadSetupWallTimeMs: Readonly<Record<string, number>>;
  perHeadCandidateStepWallTimeMs: Readonly<Record<string, number>>;
  perHeadEvalWallTimeMs: Readonly<Record<string, number>>;
};
type ExecutedPreference = PreferenceSaved & {
  preferenceRows: readonly CliCandidatePreferenceEvaluationRow[];
  preferenceEvaluation: PreferenceSummary;
};
type VerifiedCommand = ExecutedCommand & Pick<CliCommandTrainingReceipt, "comparison" | "regression" | "semanticChanges" | "verification">;
type VerifiedPreference = ExecutedPreference & {
  comparison: Readonly<{ train: PreferenceSummary; development: PreferenceSummary }>;
  regression: Record<string, never>;
  semanticChanges: readonly never[];
  verification: { status: "not_provided" };
};

function sameEntries(left: readonly { name: string; type: string }[], right: readonly { name: string; type: string }[]) {
  const normalized = (items: typeof left) => items.map(({ name, type }) => ({ name, type })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function query(name: string) {
  return Object.freeze({
    kind: "cli.file-query" as const,
    relation: "entrySelector" as const,
    scopes: Object.freeze([]),
    selector: Object.freeze({ type: "directory" as const, ...(name ? { name } : {}) }),
    cardinality: "one" as const,
  });
}

function cwdQuery(session: SessionRef) {
  return Object.freeze({ kind: "cli.file-query" as const, relation: "sessionCwd" as const, session });
}

function sceneAbsolute(sceneRoot: string, path: string) {
  return isAbsolute(path) ? path : join(sceneRoot, path);
}

async function batch1GoalFor(
  sample: CommandSample,
  scene: CommandScenario,
  session: SessionRef,
  sandbox: CliFilesystemSandbox,
): Promise<FilePropertyGoal> {
  const query = sample.query, fixtures = scene.pathFixtures;
  if (query === undefined || fixtures === undefined) throw new TypeError(`Batch1 training sample ${sample.id} needs a typed query and fixtures`);
  const observed = Object.freeze({ kind: "observed" as const, freshness: "this_run" as const });
  if (query.kind === "entry.select") {
    const targetAbsolute = join(sandbox.scenarioRoot, scene.targetPath);
    const targetPhysical = await realpath(targetAbsolute);
    const targetDirectory = await sandbox.bindDirectory(
      session,
      relative(sandbox.getSession(session).cwd, targetAbsolute) || ".",
    );
    return Object.freeze({
      kind: "file.property",
      property: ENTRIES_PROPERTY,
      target: targetDirectory,
      requirement: Object.freeze({
        kind: "matches",
        predicate: Object.freeze({
          kind: "entrySelector",
          selector: Object.freeze({
            name: query.selectorName,
            parent: targetPhysical,
            type: query.targetType,
          }),
          cardinality: "one",
        }),
      }),
    });
  }
  if (query.kind === "path.resolve") {
    const fixture = fixtures.resolve.find(item => item.id === sample.variant);
    if (fixture === undefined) throw new TypeError(`Missing resolve fixture for ${sample.id}`);
    const base = sandbox.bindPath(session, sceneAbsolute(sandbox.scenarioRoot, fixture.base));
    return Object.freeze({
      kind: "file.property",
      property: PATH_ABSOLUTE_PROPERTY,
      target: Object.freeze({ kind: "cli.path-query", base, input: query.input }),
      requirement: observed,
    });
  }
  if (query.kind === "path.relative") {
    const fixture = fixtures.relative.find(item => item.id === sample.variant);
    if (fixture === undefined) throw new TypeError(`Missing relative fixture for ${sample.id}`);
    return Object.freeze({
      kind: "file.property",
      property: PATH_RELATIVE_PROPERTY,
      target: Object.freeze({
        kind: "cli.path-query",
        from: sandbox.bindPath(session, sceneAbsolute(sandbox.scenarioRoot, fixture.from)),
        to: sandbox.bindPath(session, sceneAbsolute(sandbox.scenarioRoot, fixture.to)),
      }),
      requirement: observed,
    });
  }
  if (query.kind === "path.parts") {
    const fixture = fixtures.parts.find(item => item.id === sample.variant);
    if (fixture === undefined) throw new TypeError(`Missing parts fixture for ${sample.id}`);
    return Object.freeze({
      kind: "file.property",
      property: query.property,
      target: sandbox.bindPath(session, sceneAbsolute(sandbox.scenarioRoot, fixture.path)),
      requirement: observed,
    });
  }
  if (query.kind === "path.realpath") {
    const fixture = (fixtures.realpath ?? []).find(item => item.id === sample.variant);
    if (fixture === undefined) throw new TypeError(`Missing realpath fixture for ${sample.id}`);
    const absolutePath = sceneAbsolute(sandbox.scenarioRoot, fixture.path);
    let ref: InspectRef;
    if (fixture.refKind === "cli.path") ref = sandbox.bindPath(session, absolutePath);
    else if (fixture.refKind === "cli.entry") ref = await sandbox.bindEntry(session, absolutePath) as EntryRef;
    else if (fixture.refKind === "cli.file") ref = await sandbox.bindFile(session, absolutePath) as FileRef;
    else ref = await sandbox.bindDirectoryObject(session, absolutePath) as ObservedDirectoryRef;
    return Object.freeze({
      kind: "file.property",
      property: PATH_PHYSICAL_PROPERTY,
      target: ref,
      requirement: observed,
    });
  }
  const fixture = fixtures.inspect.find(item => item.id === sample.variant);
  if (fixture === undefined) throw new TypeError(`Missing inspect fixture for ${sample.id}`);
  const absolutePath = sceneAbsolute(sandbox.scenarioRoot, fixture.path);
  let ref: InspectRef;
  if (fixture.refKind === "cli.path") ref = sandbox.bindPath(session, absolutePath);
  else if (fixture.refKind === "cli.entry") ref = await sandbox.bindEntry(session, absolutePath) as EntryRef;
  else if (fixture.refKind === "cli.file") ref = await sandbox.bindFile(session, absolutePath) as FileRef;
  else ref = await sandbox.bindDirectoryObject(session, absolutePath) as ObservedDirectoryRef;
  const requirement = query.requirementKind === "resolvedTarget"
    || sample.case === "inspect-resolved-target"
    || sample.case === "inspect-resolved-target-broken"
    ? Object.freeze({ kind: "matches" as const, predicate: Object.freeze({ kind: "resolvedTarget" as const }) })
    : observed;
  return Object.freeze({
    kind: "file.property",
    property: query.property,
    target: Object.freeze({ kind: "cli.entry-query", ref, followSymlinks: query.followSymlinks }),
    requirement,
  });
}

async function goalFor(
  sample: CommandSample,
  scene: CommandScenario,
  session: SessionRef,
  startRef: DirectoryRef,
  targetRef: DirectoryRef,
  sandbox: CliFilesystemSandbox,
): Promise<FilePropertyGoal> {
  const observed = Object.freeze({ kind: "observed" as const, freshness: "this_run" as const });
  if (isBatch1CommandCase(sample.case)) return batch1GoalFor(sample, scene, session, sandbox);
  if (sample.case === "unregistered-property") {
    return Object.freeze({ kind: "file.property", property: "file.property.exists", target: targetRef, requirement: Object.freeze({ kind: "equals", expected: true }) });
  }
  if (sample.case === "entries-observed" || sample.case === "entries-observed-old-listing") {
    return Object.freeze({ kind: "file.property", property: ENTRIES_PROPERTY, target: targetRef, requirement: observed });
  }
  if (sample.case === "entries-observed-unbound") {
    return Object.freeze({ kind: "file.property", property: ENTRIES_PROPERTY, target: query(scene.targetPath), requirement: observed });
  }
  if (sample.case === "cwd-observed") {
    return Object.freeze({ kind: "file.property", property: CWD_PROPERTY, target: cwdQuery(session), requirement: observed });
  }
  const expected: DirectoryRef | ReturnType<typeof query> = sample.case === "cwd-equals-unbound" ? query(scene.targetPath)
    : sample.case === "cwd-equals-fresh-equal" || sample.case === "cwd-equals-stale-equal" ? startRef : targetRef;
  return Object.freeze({
    kind: "file.property",
    property: CWD_PROPERTY,
    target: cwdQuery(session),
    requirement: Object.freeze({ kind: "equals", expected }),
  });
}

function emptyState(session: SessionRef): ExplicitFileState {
  return Object.freeze({ session: session.sessionId, cwdObservation: null, directoryListing: null });
}

function createPolicyWithSharedAuthority(
  factory: Factory,
  binding: CliCommandBinding,
  authority: EvidenceAuthority,
): { step(request: CliCommandRequest): Promise<CliCommandTransition> } {
  return factory(binding, authority);
}

function buildDeterministicSetupProfile(): CliCommandProfile {
  const base = zeroCliCommandProfile();
  const weights = base.weights.map(row => [...row]);
  // row 2 (NOOP): state.requiredConditionHolds*state.hasFreshEvidence (col 37) = +15
  weights[2]![37] = 15;
  // row 3 (pwd): goalObserveCwd (col 1) = +10
  weights[3]![1] = 10;
  // row 4 (cd): goalSetCwd (col 2) = +10, interaction (col 37) = -20
  weights[4]![2] = 10;
  weights[4]![37] = -20;
  // row 5 (ls): predicate.observe.entries (col 21) = +10, state.hasDestinationRef (col 35) = +4
  weights[5]![21] = 10;
  weights[5]![35] = 4;
  // row 11 (directory.select): 7 witness slots
  weights[11]![28] = -4;
  weights[11]![29] = -10;
  weights[11]![30] = -10;
  weights[11]![31] = 4;
  weights[11]![32] = 4;
  weights[11]![35] = 2;
  weights[11]![37] = -6;
  // row 12 (file.select): 7 witness slots
  weights[12]![28] = -4;
  weights[12]![29] = -10;
  weights[12]![30] = 4;
  weights[12]![31] = -10;
  weights[12]![32] = 4;
  weights[12]![35] = 2;
  weights[12]![37] = -6;
  return validateCliCommandProfile({
    ...base,
    weights: weights.map(row => Object.freeze(row)),
  });
}

const DETERMINISTIC_SETUP_PROFILE = buildDeterministicSetupProfile();

function effectsOk(
  sample: CommandSample,
  scene: CommandScenario,
  transition: CliCommandTransition,
  before: SessionSnapshot,
  targetPhysical: string,
  startPhysical: string,
  expected: { status: string; satisfaction: 0 | 100 | null },
  factsMatched: boolean,
  featuresMatched: boolean,
): boolean {
  if (!factsMatched || !featuresMatched) return false;
  const after = transition.session_after;
  const invocation = transition.invocation;
  const sessionUnchanged = after.cwd === before.cwd && after.revision === before.revision;
  const observation = transition.execution_result.receipt?.execution.status === "succeeded"
    ? transition.execution_result.receipt.execution.observation
    : null;
  const expectedOutcome = transition.status === expected.status && transition.satisfaction === expected.satisfaction;
  switch (sample.case) {
    case "path-resolve":
      return expectedOutcome && transition.policy.selectedHead === sample.expectedHead
        && invocation?.[0] === "path.resolve" && transition.execution_result.executorInvoked && sessionUnchanged
        && observation?.kind === "path.resolve";
    case "path-relative":
      return expectedOutcome && transition.policy.selectedHead === sample.expectedHead
        && invocation?.[0] === "path.relative" && transition.execution_result.executorInvoked && sessionUnchanged
        && observation?.kind === "path.relative";
    case "path-parts-parent":
    case "path-parts-name":
      return expectedOutcome && transition.policy.selectedHead === sample.expectedHead
        && invocation?.[0] === "path.parts" && transition.execution_result.executorInvoked && sessionUnchanged
        && observation?.kind === "path.parts";
    case "path-realpath":
      return expectedOutcome && transition.policy.selectedHead === sample.expectedHead
        && before.grantedEffects.includes("filesystem.read") && before.grantedEffects.includes("process.exec")
        && invocation?.[0] === "path.realpath" && transition.execution_result.executorInvoked && sessionUnchanged
        && observation?.kind === "path.realpath"
        && typeof observation.snapshot.physicalPath === "string"
        && observation.snapshot.entryExists === true
        && observation.snapshot.resolvedTargetExists === true;
    case "inspect-exists":
    case "inspect-type":
    case "inspect-size":
    case "inspect-mode":
    case "inspect-owner":
    case "inspect-times":
    case "inspect-link-target":
    case "inspect-entry-identity":
    case "inspect-resolved-target":
    case "inspect-resolved-target-broken":
      return expectedOutcome && transition.policy.selectedHead === sample.expectedHead
        && before.grantedEffects.includes("filesystem.read") && before.grantedEffects.includes("process.exec")
        && invocation?.[0] === "entry.inspect" && transition.execution_result.executorInvoked && sessionUnchanged
        && observation?.kind === "entry.inspect";
    case "select-entry-dir-ready":
    case "select-entry-file-ready":
      return expectedOutcome && transition.policy.selectedHead === sample.expectedHead
        && invocation?.[0] === sample.expectedHead && transition.execution_result.executorInvoked && sessionUnchanged
        && transition.reason === "entry_selected"
        && transition.observed_state_after.entrySelection?.outcome === "selected"
        && typeof transition.observed_state_after.entrySelection?.ref === "string";
    case "select-entry-dir-not-found":
    case "select-entry-file-not-found":
      return expectedOutcome && transition.policy.selectedHead === sample.expectedHead
        && invocation?.[0] === sample.expectedHead && transition.execution_result.executorInvoked && sessionUnchanged
        && transition.reason === "entry_not_found"
        && transition.observed_state_after.entrySelection?.outcome === "not_found"
        && transition.observed_state_after.entrySelection?.ref === null;
    case "select-entry-dir-unobserved":
    case "select-entry-file-unobserved":
      return expectedOutcome && transition.policy.selectedHead === "DEFER"
        && invocation === null && !transition.execution_result.executorInvoked && sessionUnchanged
        && transition.reason === "listing_unobserved"
        && transition.defer?.code === "binding_unresolved";
    case "select-entry-dir-satisfied-noop":
    case "select-entry-file-satisfied-noop":
      return expectedOutcome && transition.policy.selectedHead === "NOOP"
        && invocation === null && !transition.execution_result.executorInvoked && sessionUnchanged
        && transition.reason === "already_satisfied";
    case "cwd-observed":
      return expectedOutcome
        && invocation?.[0] === "pwd" && transition.execution_result.executorInvoked
        && after.cwd === before.cwd && after.revision === before.revision
        && transition.observed_state_after.cwdObservation?.physicalCwd === startPhysical;
    case "entries-observed":
    case "entries-observed-old-listing": {
      const listing = transition.observed_state_after.directoryListing;
      return expectedOutcome
        && invocation?.[0] === "ls" && transition.execution_result.executorInvoked
        && after.cwd === before.cwd && after.revision === before.revision
        && listing !== null && listing !== undefined && listing.physicalDirectory === targetPhysical
        && sameEntries(listing.entries, scene.expectedEntries);
    }
    case "cwd-equals-fresh-equal": {
      return expectedOutcome
        && transition.policy.selectedHead === "NOOP"
        && invocation === null && !transition.execution_result.executorInvoked
        && after.cwd === startPhysical && after.revision === before.revision;
    }
    case "cwd-equals-stale-equal": {
      return expectedOutcome
        && invocation?.[0] === "cd" && transition.execution_result.executorInvoked
        && after.cwd === startPhysical && transition.postcondition?.matchedTarget === true;
    }
    case "cwd-equals-fresh-unequal":
    case "cwd-equals-unknown":
      return expectedOutcome
        && invocation?.[0] === "cd" && transition.execution_result.executorInvoked
        && after.cwd === targetPhysical && transition.postcondition?.matchedTarget === true;
    case "cwd-equals-unbound":
    case "entries-observed-unbound":
      return expectedOutcome
        && invocation === null && !transition.execution_result.executorInvoked && transition.defer?.code === "binding_unresolved";
    case "unregistered-property":
      return expectedOutcome
        && invocation === null && !transition.execution_result.executorInvoked && transition.execution_result.status === "unsupported";
    default:
      return false;
  }
}

export async function executeCliCommandTrainingSample(
  sample: CommandSample,
  scene: CommandScenario,
  profile: CliCommandProfile,
  factory: Factory,
  evidencePath: string,
  expected: { status: string; satisfaction: 0 | 100 | null },
  options?: Readonly<{ entrySelectProfiles?: CliEntrySelectProfiles; stage?: CliCommandStageId }>,
): Promise<CommandEvaluationRow> {
  const sampleTotalStarted = performance.now();
  const stage = resolveCommandStage(options?.stage, profile);
  const entrySelectProfiles = sample.query?.kind === "entry.select"
    ? requireEntrySelectProfiles(options?.entrySelectProfiles)
    : validateOptionalEntrySelectProfiles(options?.entrySelectProfiles);
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-shared-evaluation-")));
  let sandbox: Awaited<ReturnType<typeof createCliFilesystemSandbox>> | undefined;
  let cause: unknown;
  try {
    sandbox = await createCliFilesystemSandbox({ root, recipe: scene.recipe, ownerGrantedEffects: ["filesystem.write"] });
    for (const item of scene.pathFixtures?.symlinks ?? []) {
      await symlink(item.target, sceneAbsolute(sandbox.scenarioRoot, item.path));
    }
    const session = sandbox.bindSession("s"), foreign = sandbox.bindSession("other");
    const before = sandbox.getSession(session), foreignBefore = sandbox.getSession(foreign), parentCwd = process.cwd();
    const startPhysical = await realpath(sandbox.getSession(session).cwd);
    const targetAbsolute = join(sandbox.scenarioRoot, scene.targetPath), targetPhysical = await realpath(targetAbsolute);
    const targetRef = await sandbox.bindDirectory(session, relative(before.cwd, targetAbsolute) || ".");
    const startRef = await sandbox.bindDirectory(session, ".");
    const authority = createEvidenceAuthority();
    const setupPolicy = createPolicyWithSharedAuthority(
      factory,
      {
        profile: DETERMINISTIC_SETUP_PROFILE,
        stage: "stage2-13x38",
        sandbox,
        session,
        ...(entrySelectProfiles === undefined ? {} : { entrySelectProfiles }),
      },
      authority,
    );
    const policy = createPolicyWithSharedAuthority(
      factory,
      {
        profile,
        stage,
        sandbox,
        session,
        ...(entrySelectProfiles === undefined ? {} : { entrySelectProfiles }),
      },
      authority,
    );
    let state = emptyState(session), transition: CliCommandTransition;
    let backToStart: DirectoryRef | null = null;
    if (sample.case === "entries-observed-old-listing") {
      const first = await setupPolicy.step({ goal: await goalFor(sample, scene, session, startRef, targetRef, sandbox), satisfactionThreshold: 100, state });
      if (first.status !== "achieved") throw new Error(`old listing setup failed for ${sample.id}`);
      state = first.observed_state_after;
    }
    if (sample.case === "cwd-equals-fresh-equal" || sample.case === "cwd-equals-fresh-unequal" || sample.case === "cwd-equals-stale-equal") {
      const observed = await setupPolicy.step({
        goal: { kind: "file.property", property: CWD_PROPERTY, target: cwdQuery(session), requirement: { kind: "observed", freshness: "this_run" } },
        satisfactionThreshold: 100,
        state,
      });
      if (observed.status !== "achieved") throw new Error(`cwd setup failed for ${sample.id}`);
      state = observed.observed_state_after;
    }
    if (sample.query?.kind === "entry.select") {
      if (
        sample.query.listingState === "ready"
        || sample.query.listingState === "satisfied"
        || sample.query.listingState === "stale_listing"
        || sample.query.listingState === "stale_selected"
      ) {
        const lsStep = await setupPolicy.step({
          goal: Object.freeze({
            kind: "file.property",
            property: ENTRIES_PROPERTY,
            target: targetRef,
            requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
          }),
          satisfactionThreshold: 100,
          state,
        });
        if (lsStep.status !== "achieved") throw new Error(`entry.select ls setup failed for ${sample.id}`);
        state = lsStep.observed_state_after;
      }
      if (sample.query.listingState === "satisfied" || sample.query.listingState === "stale_selected") {
        const selectGoalBeforeMove = await goalFor(sample, scene, session, startRef, targetRef, sandbox);
        const firstSelect = await setupPolicy.step({
          goal: selectGoalBeforeMove,
          satisfactionThreshold: 100,
          state,
        });
        if (firstSelect.status !== "achieved") throw new Error(`entry.select initial selection setup failed for ${sample.id}`);
        state = firstSelect.observed_state_after;
      }
      if (sample.query.listingState === "stale_listing" || sample.query.listingState === "stale_selected") {
        const moved = await sandbox.execute({ operation: "cwd.set", parameters: { session, directory: targetRef } });
        if (moved.execution.status !== "succeeded") throw new Error(`entry.select stale setup move failed for ${sample.id}`);
      }
    }
    if (sample.case === "cwd-equals-stale-equal") {
      const moved = await sandbox.execute({ operation: "cwd.set", parameters: { session, directory: targetRef } });
      if (moved.execution.status !== "succeeded") throw new Error(`stale setup move failed for ${sample.id}`);
      backToStart = await sandbox.bindDirectory(session, relative(targetAbsolute, startPhysical) || ".");
    }
    const candidateGoal = sample.case === "cwd-equals-stale-equal"
      ? await goalFor(sample, scene, session, backToStart!, targetRef, sandbox)
      : await goalFor(sample, scene, session, startRef, targetRef, sandbox);
    const stepBefore = sandbox.getSession(session);
    const expectedDirRef = expectedDirectoryOf(candidateGoal);
    let expectedPhysical: string | null = null;
    if (expectedDirRef !== null) {
      try {
        expectedPhysical = (await sandbox.resolveDirectory(expectedDirRef)).physicalPath;
      } catch {
        expectedPhysical = null;
      }
    }
    const actualFacts = computePropertyFacts({
      goal: candidateGoal,
      state,
      session,
      revision: stepBefore.revision,
      authority,
      expectedPhysical,
    });
    const expectedFacts = sampleFacts(sample);
    const factsMatched =
      actualFacts.hasFreshEvidence === expectedFacts.hasFreshEvidence
      && actualFacts.knownValue === expectedFacts.knownValue
      && actualFacts.requiredConditionHolds === expectedFacts.requiredConditionHolds
      && actualFacts.hasDestinationRef === expectedFacts.hasDestinationRef;
    const setupWallTimeMs = performance.now() - sampleTotalStarted;
    const candidateStepStarted = performance.now();
    transition = await policy.step({ goal: candidateGoal, satisfactionThreshold: 100, state });
    const expectedFeatures = sampleFeatures(sample, scene, stage);
    const featuresMatched =
      transition.policy.features.length === expectedFeatures.length
      && transition.policy.features.every((value, index) => value === expectedFeatures[index]);
    const foreignAfter = sandbox.getSession(foreign);
    const effects = effectsOk(
      sample,
      scene,
      transition,
      stepBefore,
      targetPhysical,
      startPhysical,
      expected,
      factsMatched,
      featuresMatched,
    );
    const candidateStepWallTimeMs = performance.now() - candidateStepStarted;
    const totalWallTimeMs = performance.now() - sampleTotalStarted;
    const row: CommandEvaluationRow = {
      id: sample.id,
      sourceGroup: sample.sourceGroup,
      partition: sample.partition,
      case: sample.case,
      expectedHead: sample.expectedHead,
      selectedHead: transition.policy.selectedHead,
      correct: transition.policy.selectedHead === sample.expectedHead,
      effectsOk: effects,
      sideEffectsOk: JSON.stringify(foreignAfter) === JSON.stringify(foreignBefore) && parentCwd === process.cwd(),
      actualFacts,
      factsMatched,
      featuresMatched,
      status: transition.status,
      satisfaction: transition.satisfaction,
      reason: transition.reason,
      errorCode: transition.execution_result.receipt?.execution.status === "failed"
        ? transition.execution_result.receipt.execution.error.code
        : null,
      invocation: transition.invocation,
      transition,
      setupWallTimeMs,
      candidateStepWallTimeMs,
      totalWallTimeMs,
      cleanup: "removed" as const,
    };
    await appendFile(evidencePath, JSON.stringify({ kind: "execution", id: row.id, selectedHead: row.selectedHead, correct: row.correct, effectsOk: row.effectsOk, sideEffectsOk: row.sideEffectsOk, factsMatched: row.factsMatched, featuresMatched: row.featuresMatched, status: row.status, satisfaction: row.satisfaction, cleanup: "pending" }) + "\n");
    return row;
  } catch (error) {
    cause = error;
    throw error;
  } finally {
    try {
      if (sandbox) await cleanupCliFilesystemSandboxes([sandbox], cause);
      await rm(root, { recursive: true, force: true });
      await appendFile(evidencePath, JSON.stringify({ kind: "cleanup", sampleId: sample.id, status: "removed" }) + "\n");
    } catch (error) {
      await appendFile(evidencePath, JSON.stringify({ kind: "cleanup", sampleId: sample.id, status: "failed", message: error instanceof Error ? error.message : String(error) }) + "\n");
      throw error;
    }
  }
}

function summarize(rows: readonly CommandEvaluationRow[]) {
  const group = (key: (row: CommandEvaluationRow) => string) =>
    Object.fromEntries([...new Set(rows.map(key))].sort().map(name => {
      const selected = rows.filter(row => key(row) === name);
      return [name, {
        count: selected.length,
        correct: selected.filter(row => row.correct).length,
        effectsCorrect: selected.filter(row => row.effectsOk && row.sideEffectsOk).length,
      }];
    }));
  return {
    count: rows.length,
    correct: rows.filter(row => row.correct).length,
    byCase: group(row => row.case),
    byHead: group(row => row.expectedHead),
    byError: group(row => row.errorCode ?? row.reason),
    passed: rows.length > 0 && rows.every(row => row.correct && row.effectsOk && row.sideEffectsOk),
    rows,
  };
}

function controls(
  samples: readonly CommandSample[],
  scenes: Map<string, CommandScenario>,
  profile: CliCommandProfile,
  stage: CliCommandStageId = "stage2-13x38",
) {
  const rows = samples.map(sample => {
    const scene = scenes.get(sample.scenarioId)!;
    return {
      id: sample.id,
      expectedHead: sample.expectedHead,
      selectedHead: predictCliCommand(sampleGoal(sample, scene), sampleFacts(sample), profile, sample.case !== "unregistered-property", stage).selectedHead,
    };
  });
  return { executed: false, count: rows.length, correct: rows.filter(row => row.expectedHead === row.selectedHead).length, rows };
}

async function artifactDirectory(root: string, category: string, runId: string) {
  let path = root;
  for (const segment of [category, "filesystem", "command", runId]) {
    path = join(path, segment);
    try { await mkdir(path); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Artifact path must be a real directory");
  }
  return path;
}

function assertDisjointVerificationSources(primary: CommandPrepared["prepared"], verification: CommandPrepared["prepared"]) {
  const primarySources = new Set([...primary.scenes.values()].map(scene => scene.sourceGroup));
  const overlap = [...new Set([...verification.scenes.values()].map(scene => scene.sourceGroup).filter(group => primarySources.has(group)))].sort();
  if (overlap.length) throw new TypeError(`Verification source group overlaps primary train/development sources: ${overlap.join(", ")}`);
}

export function createCliCommandTrainingNodes(resources: CliCommandTrainingResources, factory: Factory, diagnostics: { partialPaths: Partial<Paths> }): readonly NodeDefinition[] {
  if (!isAbsolute(resources.outputRoot) || !isAbsolute(resources.handwiredRoot)) throw new TypeError("Explicit absolute output/backend roots required");
  const ports = ["command_training_request", "command_partition", "command_fit_data", "command_verification_data", "command_fitted", "command_candidate", "command_executions", "command_evaluation", "command_training_receipt"].map(generic);
  const node = (operator: string, inputs: number[], output: number, effects: string[], execute: NodeDefinition["execute"]): NodeDefinition => ({ operator: `cli.command.training.${operator}`, version: "0.3.0.0000", inputPorts: inputs.map(index => ports[index]!), outputPort: ports[output]!, effects, execute });
  return [
    node("partition", [0], 1, [], context => {
      const stage = prepare(context.inputs[0]!.payload);
      if (stage.kind === "command" && resources.verification !== undefined) {
        assertDisjointVerificationSources(stage.prepared, prepareCliCommandDataset(resources.verification, ["verification"], stage.stage));
      }
      return context.emit(stage);
    }),
    node("prepare", [1], 2, [], context => context.emit(context.inputs[0]!.payload)),
    node("prepare-verification", [1], 3, [], context => {
      const stage = context.inputs[0]!.payload as Prepared;
      if (stage.kind === "candidate-preference") return context.emit({ status: "not_provided" });
      return context.emit(resources.verification === undefined ? { status: "not_provided" } : { status: "provided", prepared: prepareCliCommandDataset(resources.verification, ["verification"], stage.stage) });
    }),
    node("fit", [2], 4, ["filesystem.read"], async context => {
      const stage = context.inputs[0]!.payload as Prepared;
      if (stage.kind === "candidate-preference") {
        const fit = await fitCliCandidateNamePreference({
          initial: stage.request.initial,
          rows: stage.prepared.rows,
          handwiredRoot: resources.handwiredRoot,
          epochs: stage.request.epochs,
          learningRate: stage.request.learningRate,
        });
        return context.emit({ ...stage, fit });
      }
      const fit = await fitCliCommandProfile({
        initial: stage.request.initial,
        rows: stage.prepared.train.map(sample => ({ features: sampleFeatures(sample, stage.prepared.scenes.get(sample.scenarioId)!, stage.stage), expectedHead: sample.expectedHead })),
        handwiredRoot: resources.handwiredRoot,
        epochs: stage.request.epochs,
        learningRate: stage.request.learningRate,
      });
      return context.emit({ ...stage, fit });
    }),
    node("save", [4], 5, ["filesystem.write"], async context => {
      const stage = context.inputs[0]!.payload as Fitted, info = await lstat(resources.outputRoot);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Output root must be a real directory");
      const runId = context.runId;
      const samples = join(await artifactDirectory(resources.outputRoot, "samples", runId), "samples.json");
      const profile = join(await artifactDirectory(resources.outputRoot, "weights", runId), "candidate.json");
      const result = await artifactDirectory(resources.outputRoot, "results", runId);
      const paths = { samples, profile, report: join(result, "report.json"), executions: join(result, "executions.jsonl") };
      const sampleDocument = stage.kind === "candidate-preference"
        ? {
            schemaVersion: "cli.candidate-preference-training.v1",
            preferenceRows: stage.request.preferenceRows,
            dataset: {
              validPairCount: stage.prepared.validPairCount,
              deltaOneCount: stage.prepared.deltaOneCount,
              deltaZeroCount: stage.prepared.deltaZeroCount,
            },
          }
        : stage.request.dataset;
      await writeFile(samples, JSON.stringify(sampleDocument, null, 2) + "\n", { flag: "wx" }); diagnostics.partialPaths.samples = samples;
      await writeFile(profile, JSON.stringify(stage.fit.profile, null, 2) + "\n", { flag: "wx" }); diagnostics.partialPaths.profile = profile;
      await writeFile(paths.executions, "", { flag: "wx" }); diagnostics.partialPaths.executions = paths.executions;
      return context.emit({ ...stage, paths });
    }),
    node("execute", [5, 3], 6, ["filesystem.write"], async context => {
      const stage = context.inputs[0]!.payload as Saved, verification = context.inputs[1]!.payload as { status: string; prepared?: ReturnType<typeof prepareCliCommandDataset> };
      if (stage.kind === "candidate-preference") {
        const evaluation = await evaluateCliCandidateNamePreference({
          profile: stage.fit.profile,
          rows: stage.prepared.rows,
          handwiredRoot: resources.handwiredRoot,
        });
        await appendFile(stage.paths.executions, evaluation.rows.map(row => JSON.stringify({ kind: "preference-execution", ...row })).join("\n") + (evaluation.rows.length === 0 ? "" : "\n"));
        return context.emit({ ...stage, preferenceRows: evaluation.rows, preferenceEvaluation: { count: evaluation.count, correct: evaluation.correct } });
      }
      const resolvedEntrySelectProfiles = validateOptionalEntrySelectProfiles(
        stage.request.entrySelectProfiles ?? resources.entrySelectProfiles,
      );
      const needsEntrySelect =
        stage.prepared.samples.some(sample => sample.query?.kind === "entry.select")
        || (verification.prepared?.samples.some(sample => sample.query?.kind === "entry.select") ?? false);
      if (needsEntrySelect) {
        requireEntrySelectProfiles(resolvedEntrySelectProfiles);
      }
      const activeHeads = stage.fit.profile.heads;
      const perHeadSetupWallTimeMs = Object.fromEntries(activeHeads.map(head => [head, 0])) as Record<string, number>;
      const perHeadCandidateStepWallTimeMs = Object.fromEntries(activeHeads.map(head => [head, 0])) as Record<string, number>;
      const perHeadEvalWallTimeMs = Object.fromEntries(activeHeads.map(head => [head, 0])) as Record<string, number>;
      let setupTotalMs = 0;
      let candidateStepTotalMs = 0;
      const evalStarted = performance.now();
      const rows: CommandEvaluationRow[] = [];
      for (const sample of stage.prepared.samples) {
        const row = await executeCliCommandTrainingSample(
          sample,
          stage.prepared.scenes.get(sample.scenarioId)!,
          stage.fit.profile,
          factory,
          stage.paths.executions,
          { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
          {
            stage: stage.stage,
            ...(resolvedEntrySelectProfiles === undefined ? {} : { entrySelectProfiles: resolvedEntrySelectProfiles }),
          },
        );
        rows.push(row);
        setupTotalMs += row.setupWallTimeMs;
        candidateStepTotalMs += row.candidateStepWallTimeMs;
        perHeadSetupWallTimeMs[sample.expectedHead] = (perHeadSetupWallTimeMs[sample.expectedHead] ?? 0) + row.setupWallTimeMs;
        perHeadCandidateStepWallTimeMs[sample.expectedHead] = (perHeadCandidateStepWallTimeMs[sample.expectedHead] ?? 0) + row.candidateStepWallTimeMs;
        perHeadEvalWallTimeMs[sample.expectedHead] = (perHeadEvalWallTimeMs[sample.expectedHead] ?? 0) + row.totalWallTimeMs;
      }
      if (verification.prepared) for (const sample of verification.prepared.samples) {
        const row = await executeCliCommandTrainingSample(
          sample,
          verification.prepared.scenes.get(sample.scenarioId)!,
          stage.fit.profile,
          factory,
          stage.paths.executions,
          { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction },
          {
            stage: stage.stage,
            ...(resolvedEntrySelectProfiles === undefined ? {} : { entrySelectProfiles: resolvedEntrySelectProfiles }),
          },
        );
        rows.push(row);
        setupTotalMs += row.setupWallTimeMs;
        candidateStepTotalMs += row.candidateStepWallTimeMs;
        perHeadSetupWallTimeMs[sample.expectedHead] = (perHeadSetupWallTimeMs[sample.expectedHead] ?? 0) + row.setupWallTimeMs;
        perHeadCandidateStepWallTimeMs[sample.expectedHead] = (perHeadCandidateStepWallTimeMs[sample.expectedHead] ?? 0) + row.candidateStepWallTimeMs;
        perHeadEvalWallTimeMs[sample.expectedHead] = (perHeadEvalWallTimeMs[sample.expectedHead] ?? 0) + row.totalWallTimeMs;
      }
      const evaluationTotalMs = performance.now() - evalStarted;
      return context.emit({
        ...stage,
        rows,
        verificationProvided: verification.status === "provided",
        setupTotalMs,
        candidateStepTotalMs,
        evaluationTotalMs,
        perHeadSetupWallTimeMs: Object.freeze(perHeadSetupWallTimeMs),
        perHeadCandidateStepWallTimeMs: Object.freeze(perHeadCandidateStepWallTimeMs),
        perHeadEvalWallTimeMs: Object.freeze(perHeadEvalWallTimeMs),
      });
    }),
    node("verify", [6], 7, [], context => {
      const stage = context.inputs[0]!.payload as ExecutedCommand | ExecutedPreference;
      if (stage.kind === "candidate-preference") {
        const preferenceRows = stage.preferenceRows;
        const summary = (partition: string) => {
          const selected = preferenceRows.filter(row => row.partition === partition);
          return {
            count: selected.length,
            correct: selected.filter(row => row.correct).length,
            passed: selected.length > 0 && selected.every(row => row.correct),
          };
        };
        return context.emit({
          ...stage,
          comparison: { train: summary("train"), development: summary("development") },
          regression: {},
          semanticChanges: [],
          verification: { status: "not_provided" as const },
        });
      }
      const rows = stage.rows;
      const comparison = { train: summarize(rows.filter(row => row.partition === "train")), development: summarize(rows.filter(row => row.partition === "development")) };
      const regression: CliCommandTrainingReceipt["regression"] = {};
      for (const head of stage.fit.profile.heads) {
        const rows = [...stage.prepared.train, ...stage.prepared.development].filter(row => row.expectedHead === head);
        const counts = { retained: 0, fixed: 0, regressed: 0, unresolved: 0 };
        for (const row of rows) {
          const scene = stage.prepared.scenes.get(row.scenarioId)!;
          const registered = row.case !== "unregistered-property";
          const before = predictCliCommand(sampleGoal(row, scene), sampleFacts(row), stage.fit.initialProfile, registered, stage.stage).selectedHead === head;
          const after = predictCliCommand(sampleGoal(row, scene), sampleFacts(row), stage.fit.profile, registered, stage.stage).selectedHead === head;
          counts[before ? after ? "retained" : "regressed" : after ? "fixed" : "unresolved"] += 1;
        }
        regression[head] = counts;
      }
      const semanticChanges = stage.prepared.samples.filter(row => row.case === "cwd-equals-fresh-equal")
        .map(row => ({ id: row.id, legacyExpectedHead: "cd" as const, currentExpectedHead: "NOOP" as const, observedHead: predictCliCommand(sampleGoal(row, stage.prepared.scenes.get(row.scenarioId)!), sampleFacts(row), stage.fit.profile, true, stage.stage).selectedHead }));
      return context.emit({ ...stage, comparison, regression, semanticChanges,
        verification: stage.verificationProvided ? { status: "evaluated", evaluation: summarize(rows.filter(row => row.partition === "verification")) } : { status: "not_provided" } });
    }),
    node("report", [7], 8, ["filesystem.write"], async context => {
      const stage = context.inputs[0]!.payload as VerifiedCommand | VerifiedPreference;
      if (stage.kind === "candidate-preference") {
        const fitted = stage.fit as Awaited<ReturnType<typeof fitCliCandidateNamePreference>>;
        const preferenceRows = stage.preferenceRows;
        const receipt: CliCandidatePreferenceTrainingReceipt = {
          task: "candidate-preference",
          runId: context.runId,
          accepted: preferenceRows.length > 0 && preferenceRows.every(row => row.correct),
          fullyVerified: false,
          paths: stage.paths,
          profile: fitted.profile,
          initialProfile: fitted.initialProfile,
          initialSource: stage.request.initialSource,
          dataset: {
            validPairCount: stage.prepared.validPairCount,
            deltaOneCount: stage.prepared.deltaOneCount,
            deltaZeroCount: stage.prepared.deltaZeroCount,
          },
          trainable: {
            head: fitted.trainableParameter.head,
            wire: fitted.trainableParameter.wire,
            index: fitted.trainableParameter.index,
            before: fitted.parameterBefore,
            after: fitted.parameterAfter,
            initialGradient: fitted.initialGradient,
            frozenParameterCount: fitted.frozenParameterCount,
            frozenDelta: fitted.frozenDelta,
          },
          loss: { before: fitted.initialLoss, after: fitted.finalLoss },
          execution: {
            count: preferenceRows.length,
            correct: preferenceRows.filter(row => row.correct).length,
            rows: preferenceRows,
          },
          timing: fitted.timing,
        };
        await writeFile(stage.paths.report, JSON.stringify({ ...receipt, trajectory: fitted.trajectory }, null, 2) + "\n", { flag: "wx" });
        diagnostics.partialPaths.report = stage.paths.report;
        return context.emit(receipt);
      }
      const comparison = stage.comparison;
      const regression = stage.regression;
      const semanticChanges = stage.semanticChanges;
      const verification = stage.verification;
      const accepted = comparison.train.passed && comparison.development.passed
        && Object.values(regression).every(item => item.regressed === 0);
      const receipt: CliCommandTrainingReceipt = {
        runId: context.runId,
        accepted,
        fullyVerified: accepted && verification.status === "evaluated" && verification.evaluation.passed,
        paths: stage.paths,
        profile: stage.fit.profile,
        initialSource: stage.request.initialSource,
        sourceProfile: stage.request.initial,
        initialProfile: stage.fit.initialProfile,
        comparison,
        regression,
        semanticChanges,
        verification,
        controls: {
          zero: controls(stage.prepared.train, stage.prepared.scenes, validateCliCommandProfile({ ...stage.fit.initialProfile, weights: stage.fit.initialProfile.weights.map(row => row.map(() => 0)) }, stage.stage), stage.stage),
          frozen: controls(stage.prepared.train, stage.prepared.scenes, stage.fit.initialProfile, stage.stage),
        },
        timing: {
          ...stage.fit.timing,
          includesPreStepSetupInTotal: true,
          setupTotalMs: stage.setupTotalMs,
          candidateStepTotalMs: stage.candidateStepTotalMs,
          evaluationTotalMs: stage.evaluationTotalMs,
          perHeadSetupWallTimeMs: stage.perHeadSetupWallTimeMs,
          perHeadCandidateStepWallTimeMs: stage.perHeadCandidateStepWallTimeMs,
          perHeadEvalWallTimeMs: stage.perHeadEvalWallTimeMs,
        },
      };
      await writeFile(stage.paths.report, JSON.stringify({ ...receipt, trajectory: stage.fit.trajectory }, null, 2) + "\n", { flag: "wx" });
      diagnostics.partialPaths.report = stage.paths.report;
      return context.emit(receipt);
    }),
  ];
}
