// Config sweep for the ignore capability fit. Same public consumer pipeline as
// playground/training/demo.mjs, but the fit hyper-parameters come from argv so a
// small, documented comparison can run. Nothing here changes repository code.
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  compileWorkflow,
  createWorkflowInputEvent,
  loadWorkflow,
  runWorkflow,
} from "nnanything";
import { DEFAULT_BASIC_KIND_PROFILE } from "nnanything/browser";
import {
  BASIC_KIND_TASK_ID,
  createTrainingNodeDefinitions,
  loadTrainingProfiles,
  readBasicKindTrainingRequest,
} from "nnanything/training";

const repo = "/Volumes/Intel/playground/nnanything/browser-foundation";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const inputPath = resolve(args.get("--input"));
const handwiredRoot = resolve(args.get("--handwired-root"));
const outputRoot = resolve(args.get("--output-root"));
const epochs = Number(args.get("--epochs"));
const learningRate = Number(args.get("--lr"));
const anchorLambda = Number(args.get("--anchor"));
const trainable = args.get("--trainable");
const seed = Number(args.get("--seed") ?? "20261021");
const objectiveMode = args.get("--objective");
const boundarySlack = args.get("--boundary-slack");
const stopWhen = args.get("--stop-when");
await mkdir(outputRoot, { recursive: true });

const dataset = JSON.parse(await readFile(inputPath, "utf8"));
const request = readBasicKindTrainingRequest(dataset);
const configPath = join(repo, "workflows/node-training.workflow.json");
const definition = await loadWorkflow({ configPath, allowedRoot: repo });
definition.bindings["准备节点输入与期望输出"].config = { taskId: BASIC_KIND_TASK_ID, inputScope: "candidate_qualified" };
definition.bindings["按来源分组并划分用途"].config = {
  mode: "source_group_holdout",
  seed,
  evalFraction: 0.3,
  allowInSampleEval: false,
};
const baseProfile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
const profileId = baseProfile.id;
const target = {
  taskId: BASIC_KIND_TASK_ID,
  minScore: 0.6,
  minMargin: 0.15,
  objective: {
    targetScore: 0.8,
    rivalCeiling: 0.4,
    otherGap: 0.05,
    ...(objectiveMode === undefined ? {} : { mode: objectiveMode }),
    ...(boundarySlack === undefined ? {} : { boundarySlack: Number(boundarySlack) }),
  },
  fit: {
    epochs,
    learningRate,
    anchorLambda,
    ...(trainable === undefined ? {} : { trainableWires: trainable.split(",") }),
    ...(stopWhen === undefined ? {} : { stopWhen }),
  },
};
definition.bindings["拟合目标节点参数"] = { config: target, profileId };
definition.bindings["比较新旧节点在相同样本的输出"] = { config: target, profileId };

const compiled = compileWorkflow(definition, {
  nodeDefinitions: createTrainingNodeDefinitions({ handwiredRoot, allowedRoot: outputRoot }),
  grantedEffects: ["filesystem.read", "filesystem.write"],
  profiles: loadTrainingProfiles({ profileId, profile: baseProfile }),
});
const runId = `ignore-capability-${randomUUID()}`;
const result = await runWorkflow(compiled, createWorkflowInputEvent({
  runId,
  eventId: `${runId}:input`,
  port: compiled.entryArc.id,
  type: "training.request.v1",
  payload: request,
}));
if (result.status !== "completed") throw new Error(`${result.error.category}: ${result.error.message}`);
const receipt = result.outputEvent.payload;
console.log(JSON.stringify({
  runId,
  epochs,
  learningRate,
  anchorLambda,
  trainable: trainable ?? null,
  persistStatus: receipt.persistStatus,
  candidateAdoption: receipt.candidateAdoption,
  calibrated: receipt.calibrated,
  recommendation: receipt.recommendation,
  weightFileRef: receipt.weightFileRef,
  resultFileRef: receipt.resultFileRef,
  summary: receipt.summary,
  stoppingReason: receipt.stoppingReason,
}));
