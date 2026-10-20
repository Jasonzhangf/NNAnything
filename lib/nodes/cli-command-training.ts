import { appendFile, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
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
  predictCliCommand,
  validateCliCommandProfile,
  type CliCommandProfile,
} from "../filters/cli-command-policy.js";
import {
  CWD_PROPERTY,
  ENTRIES_PROPERTY,
  PATH_ABSOLUTE_PROPERTY,
  PATH_RELATIVE_PROPERTY,
  type EntryRef,
  type FilePropertyGoal,
  type FileRef,
  type InspectRef,
  type ObservedDirectoryRef,
} from "../filters/cli-file-property.js";
import type { ExplicitFileState } from "../filters/cli-state.js";
import { fitCliCommandProfile } from "../training/cli-command-numeric.js";
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
import type { CliCommandBinding, CliCommandRequest, CliCommandTransition } from "./cli-command.js";

export type CliCommandTrainingRequest = Readonly<{
  dataset: CliCommandDataset;
  initial: CliCommandProfile;
  initialSource: string | null;
  epochs: number;
  learningRate: number;
}>;

export type CliCommandTrainingResources = Readonly<{
  handwiredRoot: string;
  outputRoot: string;
  grantedEffects: readonly string[];
  verification?: CliCommandDataset;
}>;

type Factory = (binding: CliCommandBinding) => { step(request: CliCommandRequest): Promise<CliCommandTransition> };
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
  status: string;
  satisfaction: 0 | 100 | null;
  reason: string;
  errorCode: string | null;
  invocation: CliCommandTransition["invocation"];
  transition: CliCommandTransition;
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
  timing: Awaited<ReturnType<typeof fitCliCommandProfile>>["timing"];
};

function prepare(value: unknown) {
  const request = expectRecord(value, "command training request") as unknown as CliCommandTrainingRequest;
  if (Object.keys(request).some(key => !["dataset", "initial", "initialSource", "epochs", "learningRate"].includes(key))) {
    throw new TypeError("Explicit shared training contract required");
  }
  const initial = validateCliCommandProfile(request.initial);
  if (request.initialSource !== null && typeof request.initialSource !== "string") throw new TypeError("initialSource must be a saved profile path or null");
  return { request: { ...request, initial }, prepared: prepareCliCommandDataset(request.dataset) };
}

type Prepared = ReturnType<typeof prepare>;
type Fitted = Prepared & { fit: Awaited<ReturnType<typeof fitCliCommandProfile>> };
type Saved = Fitted & { paths: Paths };

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
  const fixture = fixtures.inspect.find(item => item.id === sample.variant);
  if (fixture === undefined) throw new TypeError(`Missing inspect fixture for ${sample.id}`);
  const absolutePath = sceneAbsolute(sandbox.scenarioRoot, fixture.path);
  let ref: InspectRef;
  if (fixture.refKind === "cli.path") ref = sandbox.bindPath(session, absolutePath);
  else if (fixture.refKind === "cli.entry") ref = await sandbox.bindEntry(session, absolutePath) as EntryRef;
  else if (fixture.refKind === "cli.file") ref = await sandbox.bindFile(session, absolutePath) as FileRef;
  else ref = await sandbox.bindDirectoryObject(session, absolutePath) as ObservedDirectoryRef;
  return Object.freeze({
    kind: "file.property",
    property: query.property,
    target: Object.freeze({ kind: "cli.entry-query", ref, followSymlinks: query.followSymlinks }),
    requirement: observed,
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

function effectsOk(
  sample: CommandSample,
  scene: CommandScenario,
  transition: CliCommandTransition,
  before: SessionSnapshot,
  targetPhysical: string,
  startPhysical: string,
  expected: { status: string; satisfaction: 0 | 100 | null },
): boolean {
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
    case "inspect-exists":
    case "inspect-type":
    case "inspect-size":
    case "inspect-mode":
    case "inspect-owner":
    case "inspect-times":
    case "inspect-link-target":
    case "inspect-entry-identity":
      return expectedOutcome && transition.policy.selectedHead === sample.expectedHead
        && before.grantedEffects.includes("filesystem.read") && before.grantedEffects.includes("process.exec")
        && invocation?.[0] === "entry.inspect" && transition.execution_result.executorInvoked && sessionUnchanged
        && observation?.kind === "entry.inspect";
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

export async function executeCliCommandTrainingSample(sample: CommandSample, scene: CommandScenario, profile: CliCommandProfile, factory: Factory, evidencePath: string, expected: { status: string; satisfaction: 0 | 100 | null }): Promise<CommandEvaluationRow> {
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
    const policy = factory({ profile, sandbox, session });
    let state = emptyState(session), transition: CliCommandTransition;
    if (sample.case === "entries-observed-old-listing") {
      const first = await policy.step({ goal: await goalFor(sample, scene, session, startRef, targetRef, sandbox), satisfactionThreshold: 100, state });
      if (first.status !== "achieved") throw new Error(`old listing setup failed for ${sample.id}`);
      state = first.observed_state_after;
    }
    if (sample.case === "cwd-equals-fresh-equal" || sample.case === "cwd-equals-fresh-unequal" || sample.case === "cwd-equals-stale-equal") {
      const observed = await policy.step({
        goal: { kind: "file.property", property: CWD_PROPERTY, target: cwdQuery(session), requirement: { kind: "observed", freshness: "this_run" } },
        satisfactionThreshold: 100,
        state,
      });
      if (observed.status !== "achieved") throw new Error(`cwd setup failed for ${sample.id}`);
      state = observed.observed_state_after;
    }
    if (sample.case === "cwd-equals-stale-equal") {
      const moved = await sandbox.execute({ operation: "cwd.set", parameters: { session, directory: targetRef } });
      if (moved.execution.status !== "succeeded") throw new Error(`stale setup move failed for ${sample.id}`);
      const backToStart = await sandbox.bindDirectory(session, relative(targetAbsolute, startPhysical) || ".");
      transition = await policy.step({ goal: await goalFor(sample, scene, session, backToStart, targetRef, sandbox), satisfactionThreshold: 100, state });
    } else {
      transition = await policy.step({ goal: await goalFor(sample, scene, session, startRef, targetRef, sandbox), satisfactionThreshold: 100, state });
    }
    const foreignAfter = sandbox.getSession(foreign);
    const effects = effectsOk(sample, scene, transition, before, targetPhysical, startPhysical, expected);
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
      status: transition.status,
      satisfaction: transition.satisfaction,
      reason: transition.reason,
      errorCode: transition.execution_result.receipt?.execution.status === "failed"
        ? transition.execution_result.receipt.execution.error.code
        : null,
      invocation: transition.invocation,
      transition,
      cleanup: "removed" as const,
    };
    await appendFile(evidencePath, JSON.stringify({ kind: "execution", id: row.id, selectedHead: row.selectedHead, correct: row.correct, effectsOk: row.effectsOk, sideEffectsOk: row.sideEffectsOk, status: row.status, satisfaction: row.satisfaction, cleanup: "pending" }) + "\n");
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

function controls(samples: readonly CommandSample[], scenes: Map<string, CommandScenario>, profile: CliCommandProfile) {
  const rows = samples.map(sample => {
    const scene = scenes.get(sample.scenarioId)!;
    return {
      id: sample.id,
      expectedHead: sample.expectedHead,
      selectedHead: predictCliCommand(sampleGoal(sample, scene), sampleFacts(sample), profile).selectedHead,
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

function assertDisjointVerificationSources(primary: Prepared["prepared"], verification: Prepared["prepared"]) {
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
      if (resources.verification !== undefined) {
        assertDisjointVerificationSources(stage.prepared, prepareCliCommandDataset(resources.verification, ["verification"]));
      }
      return context.emit(stage);
    }),
    node("prepare", [1], 2, [], context => context.emit(context.inputs[0]!.payload)),
    node("prepare-verification", [1], 3, [], context => {
      const stage = context.inputs[0]!.payload as Prepared;
      return context.emit(resources.verification === undefined ? { status: "not_provided" } : { status: "provided", prepared: prepareCliCommandDataset(resources.verification, ["verification"]) });
    }),
    node("fit", [2], 4, ["filesystem.read"], async context => {
      const stage = context.inputs[0]!.payload as Prepared;
      const fit = await fitCliCommandProfile({
        initial: stage.request.initial,
        rows: stage.prepared.train.map(sample => ({ features: sampleFeatures(sample, stage.prepared.scenes.get(sample.scenarioId)!), expectedHead: sample.expectedHead })),
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
      await writeFile(samples, JSON.stringify(stage.request.dataset, null, 2) + "\n", { flag: "wx" }); diagnostics.partialPaths.samples = samples;
      await writeFile(profile, JSON.stringify(stage.fit.profile, null, 2) + "\n", { flag: "wx" }); diagnostics.partialPaths.profile = profile;
      await writeFile(paths.executions, "", { flag: "wx" }); diagnostics.partialPaths.executions = paths.executions;
      return context.emit({ ...stage, paths });
    }),
    node("execute", [5, 3], 6, ["filesystem.write"], async context => {
      const stage = context.inputs[0]!.payload as Saved, verification = context.inputs[1]!.payload as { status: string; prepared?: Prepared["prepared"] };
      const rows: CommandEvaluationRow[] = [];
      for (const sample of stage.prepared.samples) {
        rows.push(await executeCliCommandTrainingSample(sample, stage.prepared.scenes.get(sample.scenarioId)!, stage.fit.profile, factory, stage.paths.executions,
          { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction }));
      }
      if (verification.prepared) for (const sample of verification.prepared.samples) {
        rows.push(await executeCliCommandTrainingSample(sample, verification.prepared.scenes.get(sample.scenarioId)!, stage.fit.profile, factory, stage.paths.executions,
          { status: sample.expectedStatus, satisfaction: sample.expectedSatisfaction }));
      }
      return context.emit({ ...stage, rows, verificationProvided: verification.status === "provided" });
    }),
    node("verify", [6], 7, [], context => {
      const stage = context.inputs[0]!.payload as Saved & { rows: CommandEvaluationRow[]; verificationProvided: boolean };
      const comparison = { train: summarize(stage.rows.filter(row => row.partition === "train")), development: summarize(stage.rows.filter(row => row.partition === "development")) };
      const regression: CliCommandTrainingReceipt["regression"] = {};
      for (const head of CLI_COMMAND_HEADS) {
        const rows = [...stage.prepared.train, ...stage.prepared.development].filter(row => row.expectedHead === head);
        const counts = { retained: 0, fixed: 0, regressed: 0, unresolved: 0 };
        for (const row of rows) {
          const scene = stage.prepared.scenes.get(row.scenarioId)!;
          const before = predictCliCommand(sampleGoal(row, scene), sampleFacts(row), stage.fit.initialProfile).selectedHead === head;
          const after = predictCliCommand(sampleGoal(row, scene), sampleFacts(row), stage.fit.profile).selectedHead === head;
          counts[before ? after ? "retained" : "regressed" : after ? "fixed" : "unresolved"] += 1;
        }
        regression[head] = counts;
      }
      const semanticChanges = stage.prepared.samples.filter(row => row.case === "cwd-equals-fresh-equal")
        .map(row => ({ id: row.id, legacyExpectedHead: "cd" as const, currentExpectedHead: "NOOP" as const, observedHead: predictCliCommand(sampleGoal(row, stage.prepared.scenes.get(row.scenarioId)!), sampleFacts(row), stage.fit.profile).selectedHead }));
      return context.emit({ ...stage, comparison, regression, semanticChanges,
        verification: stage.verificationProvided ? { status: "evaluated", evaluation: summarize(stage.rows.filter(row => row.partition === "verification")) } : { status: "not_provided" } });
    }),
    node("report", [7], 8, ["filesystem.write"], async context => {
      const stage = context.inputs[0]!.payload as Saved & Pick<CliCommandTrainingReceipt, "comparison" | "regression" | "semanticChanges" | "verification">;
      const accepted = stage.comparison.train.passed && stage.comparison.development.passed
        && Object.values(stage.regression).every(item => item.regressed === 0);
      const receipt: CliCommandTrainingReceipt = {
        runId: context.runId,
        accepted,
        fullyVerified: accepted && stage.verification.status === "evaluated" && stage.verification.evaluation.passed,
        paths: stage.paths,
        profile: stage.fit.profile,
        initialSource: stage.request.initialSource,
        sourceProfile: stage.request.initial,
        initialProfile: stage.fit.initialProfile,
        comparison: stage.comparison,
        regression: stage.regression,
        semanticChanges: stage.semanticChanges,
        verification: stage.verification,
        controls: {
          zero: controls(stage.prepared.train, stage.prepared.scenes, validateCliCommandProfile({ ...stage.fit.initialProfile, weights: stage.fit.initialProfile.weights.map(row => row.map(() => 0)) })),
          frozen: controls(stage.prepared.train, stage.prepared.scenes, stage.fit.initialProfile),
        },
        timing: stage.fit.timing,
      };
      await writeFile(stage.paths.report, JSON.stringify({ ...receipt, trajectory: stage.fit.trajectory }, null, 2) + "\n", { flag: "wx" });
      diagnostics.partialPaths.report = stage.paths.report;
      return context.emit(receipt);
    }),
  ];
}
