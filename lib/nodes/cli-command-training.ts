import { appendFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { NodeDefinition } from "../core/contracts.js";
import { expectRecord } from "../core/schema.js";
import { createCliFilesystemSandbox } from "../adapters/cli/filesystem-sandbox.js";
import { cleanupCliFilesystemSandboxes } from "../adapters/cli/sandbox-cleanup.js";
import { expandCliCommandProfile, predictCliCommand, zeroCliCommandProfile, type CliCommandName, type CliCommandProfile } from "../filters/cli-command-policy.js";
import { fitCliCommandProfile } from "../training/cli-command-numeric.js";
import { prepareCliCommandDataset, type CliCommandDataset, type CommandSample, type CommandScenario } from "../training/cli-command-samples.js";
import type { CliCommandBinding, CliCommandRequest, CliCommandTransition } from "./cli-command.js";

export type CliCommandTrainingRequest = Readonly<{
  dataset: CliCommandDataset; commands: readonly CliCommandName[]; initial: CliCommandProfile;
  initialSource: string | null; epochs: number; learningRate: number;
}>;
export type CliCommandTrainingResources = Readonly<{
  handwiredRoot: string; outputRoot: string; grantedEffects: readonly string[]; verification?: CliCommandDataset;
}>;
type Factory = (binding: CliCommandBinding) => { step(request: CliCommandRequest): Promise<CliCommandTransition> };
const record = (value: unknown) => expectRecord(value, "shared training payload");
const port = (name: string) => ({ name, schemaId: `cli.${name}.v1`, eventType: `cli.${name}.v1`, validate: record });

function prepare(value: unknown) {
  const request = expectRecord(value, "command training request") as unknown as CliCommandTrainingRequest;
  if (!Array.isArray(request.commands) || request.commands.length === 0 || Object.keys(request).some(key => !["dataset", "commands", "initial", "initialSource", "epochs", "learningRate"].includes(key))) throw new TypeError("Explicit shared training contract required");
  const initial = expandCliCommandProfile(request.initial, request.commands);
  if (request.initialSource !== null && typeof request.initialSource !== "string") throw new TypeError("initialSource must be a saved profile path or null");
  return { request, initial, prepared: prepareCliCommandDataset(request.dataset, request.commands) };
}
type Prepared = ReturnType<typeof prepare>;
type Fitted = Prepared & { fit: Awaited<ReturnType<typeof fitCliCommandProfile>> };
type Paths = { samples: string; profile: string; report: string; executions: string };
type Saved = Fitted & { paths: Paths };

export type CommandEvaluationRow = Readonly<{
  id: string; sourceGroup: string; partition: string; expectedHead: string; selectedHead: string;
  correct: boolean; effectsOk: boolean; sideEffectsOk: boolean; transition: CliCommandTransition; cleanup: "removed";
}>;

function sameEntries(left: readonly { name: string; type: string }[], right: readonly { name: string; type: string }[]) {
  const normalized = (items: typeof left) => items.map(({ name, type }) => ({ name, type })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function assertDisjointVerificationSources(primary: Prepared["prepared"], verification: Prepared["prepared"]) {
  const primarySources = new Set([...primary.scenes.values()].map(scene => scene.sourceGroup));
  const overlap = [...new Set([...verification.scenes.values()].map(scene => scene.sourceGroup).filter(group => primarySources.has(group)))].sort();
  if (overlap.length) throw new TypeError(`Verification source group overlaps primary train/development sources: ${overlap.join(", ")}`);
}

async function executeSample(sample: CommandSample, scene: CommandScenario, profile: CliCommandProfile, factory: Factory, evidencePath: string): Promise<CommandEvaluationRow> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-shared-evaluation-")));
  let sandbox: Awaited<ReturnType<typeof createCliFilesystemSandbox>> | undefined;
  let cause: unknown;
  try {
    sandbox = await createCliFilesystemSandbox({ root, recipe: scene.recipe, ownerGrantedEffects: ["filesystem.write"] });
    const session = sandbox.bindSession("s"), foreign = sandbox.bindSession("other");
    const before = sandbox.getSession(session), foreignBefore = sandbox.getSession(foreign), parentCwd = process.cwd();
    const target = join(sandbox.scenarioRoot, scene.targetPath), physicalTarget = await realpath(target), physicalStart = await realpath(before.cwd);
    const goal = { kind: sample.goalKind, session: session.sessionId,
      ...(["cd", "ls"].includes(sample.expectedHead) ? { target } : {}) };
    const directory = ["cd", "ls"].includes(sample.expectedHead) ? await sandbox.bindDirectory(session, relative(before.cwd, target) || ".") : undefined;
    const transition = await factory({ profile, sandbox, session }).step({ goal,
      state: { session: session.sessionId, cwdObservation: null, directoryListing: null }, ...(directory ? { directory } : {}) });
    const after = sandbox.getSession(session), observed = transition.execution_result.receipt?.execution;
    const observation = observed?.status === "succeeded" ? observed.observation : null;
    let effectsOk = false;
    if (sample.expectedHead === "unsupported") effectsOk = transition.invocation === null && !transition.execution_result.executorInvoked && transition.goal_result.status === "unmet";
    if (sample.expectedHead === "pwd") effectsOk = transition.goal_result.status === "achieved" && observation?.kind === "pwd" && observation.physicalCwd === physicalStart && after.cwd === before.cwd && after.revision === before.revision;
    if (sample.expectedHead === "cd") effectsOk = transition.goal_result.status === "achieved" && after.cwd === physicalTarget && after.revision === before.revision + 1 && transition.postcondition?.matchedTarget === true;
    if (sample.expectedHead === "ls") effectsOk = transition.goal_result.status === "achieved" && observation?.kind === "directory.list"
      && observation.physicalDirectory === physicalTarget && observation.coverage === "complete" && sameEntries(observation.entries, scene.expectedEntries)
      && after.cwd === before.cwd && after.revision === before.revision;
    const row = { id: sample.id, sourceGroup: sample.sourceGroup, partition: sample.partition, expectedHead: sample.expectedHead,
      selectedHead: transition.policy.selectedHead, correct: sample.expectedHead === transition.policy.selectedHead,
      effectsOk, sideEffectsOk: JSON.stringify(sandbox.getSession(foreign)) === JSON.stringify(foreignBefore) && parentCwd === process.cwd(), transition, cleanup: "removed" as const };
    // Preserve actual evidence before attempting cleanup. The following event records cleanup truth.
    await appendFile(evidencePath, JSON.stringify({ kind: "execution", ...row, cleanup: "pending" }) + "\n");
    return row;
  } catch (error) { cause = error; throw error; }
  finally {
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
  const byCommand = Object.fromEntries(["pwd", "cd", "ls", "unsupported"].map(name => {
    const selected = rows.filter(row => row.expectedHead === name);
    return [name, { count: selected.length, correct: selected.filter(row => row.correct).length,
      effectsCorrect: selected.filter(row => row.effectsOk && row.sideEffectsOk).length,
      executions: selected.filter(row => row.transition.execution_result.executorInvoked).length }];
  }));
  return { count: rows.length, correct: rows.filter(row => row.correct).length, byCommand,
    passed: rows.length > 0 && rows.every(row => row.correct && row.effectsOk && row.sideEffectsOk), rows };
}
function controls(samples: readonly CommandSample[], profile: CliCommandProfile) {
  const rows = samples.map(sample => ({ id: sample.id, expectedHead: sample.expectedHead,
    ...predictCliCommand({ kind: sample.goalKind, session: "s" }, profile) }));
  return { executed: false, count: rows.length, correct: rows.filter(row => row.expectedHead === row.selectedHead).length, rows };
}

async function directory(root: string, category: string, runId: string) {
  let path = root;
  for (const segment of [category, "filesystem", "command", runId]) {
    path = join(path, segment);
    try { await mkdir(path); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Artifact path must be a real directory");
  }
  return path;
}

export type CliCommandTrainingReceipt = {
  runId: string; accepted: boolean; fullyVerified: boolean; paths: Paths; profile: CliCommandProfile;
  initialSource: string | null; initialProfile: CliCommandProfile; sourceProfile: CliCommandProfile;
  comparison: { train: ReturnType<typeof summarize>; development: ReturnType<typeof summarize> };
  controls: { zero: ReturnType<typeof controls>; frozen: ReturnType<typeof controls> };
  regression: Record<string, { retained: number; fixed: number; regressed: number; unresolved: number }>;
  verification: { status: "not_provided" } | { status: "evaluated"; evaluation: ReturnType<typeof summarize> };
  timing: Awaited<ReturnType<typeof fitCliCommandProfile>>["timing"];
};

export function createCliCommandTrainingNodes(resources: CliCommandTrainingResources, factory: Factory, diagnostics: { partialPaths: Partial<Paths> }): readonly NodeDefinition[] {
  if (!isAbsolute(resources.outputRoot) || !isAbsolute(resources.handwiredRoot)) throw new TypeError("Explicit absolute output/backend roots required");
  const ports = ["command_training_request", "command_partition", "command_fit_data", "command_verification_data", "command_fitted", "command_candidate", "command_executions", "command_evaluation", "command_training_receipt"].map(port);
  const node = (operator: string, inputs: number[], output: number, effects: string[], execute: NodeDefinition["execute"]): NodeDefinition => ({ operator: `cli.command.training.${operator}`, version: "0.1.0", inputPorts: inputs.map(index => ports[index]!), outputPort: ports[output]!, effects, execute });
  return [
    node("partition", [0], 1, [], context => {
      const stage = prepare(context.inputs[0]!.payload);
      if (resources.verification !== undefined) {
        const verification = prepareCliCommandDataset(resources.verification, stage.request.commands, ["verification"]);
        assertDisjointVerificationSources(stage.prepared, verification);
      }
      return context.emit(stage);
    }),
    node("prepare", [1], 2, [], context => context.emit(context.inputs[0]!.payload)),
    node("prepare-verification", [1], 3, [], context => {
      const stage = context.inputs[0]!.payload as Prepared;
      return context.emit(resources.verification === undefined ? { status: "not_provided" } : { status: "provided", prepared: prepareCliCommandDataset(resources.verification, stage.request.commands, ["verification"]) });
    }),
    node("fit", [2], 4, ["filesystem.read"], async context => {
      const stage = context.inputs[0]!.payload as Prepared;
      const fit = await fitCliCommandProfile({ initial: stage.request.initial, commands: stage.request.commands,
        rows: stage.prepared.train.map(sample => ({ goal: { kind: sample.goalKind, session: "s" }, expectedHead: sample.expectedHead })),
        handwiredRoot: resources.handwiredRoot, epochs: stage.request.epochs, learningRate: stage.request.learningRate });
      return context.emit({ ...stage, fit });
    }),
    node("save", [4], 5, ["filesystem.write"], async context => {
      const stage = context.inputs[0]!.payload as Fitted, info = await lstat(resources.outputRoot);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Output root must be a real directory");
      const runId = context.runId;
      const samples = join(await directory(resources.outputRoot, "samples", runId), "samples.json");
      const profile = join(await directory(resources.outputRoot, "weights", runId), "candidate.json");
      const result = await directory(resources.outputRoot, "results", runId), paths = { samples, profile, report: join(result, "report.json"), executions: join(result, "executions.jsonl") };
      await writeFile(samples, JSON.stringify(stage.request.dataset, null, 2) + "\n", { flag: "wx" }); diagnostics.partialPaths.samples = samples;
      await writeFile(profile, JSON.stringify(stage.fit.profile, null, 2) + "\n", { flag: "wx" }); diagnostics.partialPaths.profile = profile;
      await writeFile(paths.executions, "", { flag: "wx" }); diagnostics.partialPaths.executions = paths.executions;
      return context.emit({ ...stage, paths });
    }),
    node("execute", [5, 3], 6, ["filesystem.write"], async context => {
      const stage = context.inputs[0]!.payload as Saved, verification = context.inputs[1]!.payload as { status: string; prepared?: Prepared["prepared"] };
      const rows: CommandEvaluationRow[] = [];
      for (const sample of stage.prepared.samples) rows.push(await executeSample(sample, stage.prepared.scenes.get(sample.scenarioId)!, stage.fit.profile, factory, stage.paths.executions));
      if (verification.prepared) for (const sample of verification.prepared.samples) rows.push(await executeSample(sample, verification.prepared.scenes.get(sample.scenarioId)!, stage.fit.profile, factory, stage.paths.executions));
      return context.emit({ ...stage, rows, verificationProvided: verification.status === "provided" });
    }),
    node("verify", [6], 7, [], context => {
      const stage = context.inputs[0]!.payload as Saved & { rows: CommandEvaluationRow[]; verificationProvided: boolean };
      const comparison = { train: summarize(stage.rows.filter(row => row.partition === "train")), development: summarize(stage.rows.filter(row => row.partition === "development")) };
      const regression: CliCommandTrainingReceipt["regression"] = {};
      for (const head of stage.request.initial.heads) {
        const rows = [...stage.prepared.train, ...stage.prepared.development].filter(row => row.expectedHead === head);
        const counts = { retained: 0, fixed: 0, regressed: 0, unresolved: 0 };
        for (const row of rows) {
          const goal = { kind: row.goalKind, session: "s" }, before = predictCliCommand(goal, stage.initial).selectedHead === head, after = predictCliCommand(goal, stage.fit.profile).selectedHead === head;
          counts[before ? after ? "retained" : "regressed" : after ? "fixed" : "unresolved"]++;
        }
        regression[head] = counts;
      }
      return context.emit({ ...stage, comparison, regression, verification: stage.verificationProvided ? { status: "evaluated", evaluation: summarize(stage.rows.filter(row => row.partition === "verification")) } : { status: "not_provided" } });
    }),
    node("report", [7], 8, ["filesystem.write"], async context => {
      const stage = context.inputs[0]!.payload as Saved & Pick<CliCommandTrainingReceipt, "comparison" | "regression" | "verification">;
      const accepted = stage.comparison.train.passed && stage.comparison.development.passed && Object.values(stage.regression).every(item => item.regressed === 0);
      const receipt: CliCommandTrainingReceipt = { runId: context.runId, accepted,
        fullyVerified: accepted && stage.verification.status === "evaluated" && stage.verification.evaluation.passed,
        paths: stage.paths, profile: stage.fit.profile, initialSource: stage.request.initialSource, sourceProfile: stage.request.initial,
        initialProfile: stage.initial, comparison: stage.comparison, regression: stage.regression, verification: stage.verification,
        controls: { zero: controls(stage.prepared.train, zeroCliCommandProfile(stage.request.commands)), frozen: controls(stage.prepared.train, stage.initial) }, timing: stage.fit.timing };
      await writeFile(stage.paths.report, JSON.stringify({ ...receipt, trajectory: stage.fit.trajectory }, null, 2) + "\n", { flag: "wx" }); diagnostics.partialPaths.report = stage.paths.report;
      return context.emit(receipt);
    }),
  ];
}
