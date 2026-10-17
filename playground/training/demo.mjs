import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileWorkflow,
  createWorkflowInputEvent,
  loadWorkflow,
  runWorkflow,
} from "nnanything";
import {
  DEFAULT_BASIC_KIND_PROFILE,
  classifyBasicKind,
  validateBasicKindProfile,
} from "nnanything/browser";
import {
  BASIC_KIND_TASK_ID,
  createTrainingNodeDefinitions,
  loadTrainingProfiles,
  readBasicKindTrainingRequest,
} from "nnanything/training";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!["--input", "--output-root", "--handwired-root", "--input-scope", "--seed"].includes(key)
    || !value || value.startsWith("--") || flags.has(key)) {
    throw new Error("Use --input <reviewed.json> --output-root <dir> --handwired-root <dir> --input-scope <candidate_qualified|properties_offline> --seed <uint32>");
  }
  flags.set(key, value);
}

const inputPath = resolve(flags.get("--input") ?? join(repositoryRoot, "playground/training/reviewed.fixture.json"));
const configuredHandwiredRoot = flags.get("--handwired-root") ?? process.env.HANDWIRED_ROOT;
if (!configuredHandwiredRoot) throw new Error("Set --handwired-root or HANDWIRED_ROOT explicitly");
const handwiredRoot = resolve(configuredHandwiredRoot);
const outputRoot = resolve(flags.get("--output-root") ?? repositoryRoot);
await mkdir(outputRoot, { recursive: true });
const inputScope = flags.get("--input-scope") ?? "candidate_qualified";
if (!["candidate_qualified", "properties_offline"].includes(inputScope)) throw new Error("invalid --input-scope");
const seed = Number(flags.get("--seed") ?? "20261017");
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("--seed must be a uint32");

const dataset = JSON.parse(await readFile(inputPath, "utf8"));
const request = readBasicKindTrainingRequest(dataset);
const configPath = join(repositoryRoot, "workflows/node-training.workflow.json");
const definition = await loadWorkflow({ configPath, allowedRoot: repositoryRoot });
definition.bindings["准备节点输入与期望输出"].config = { taskId: BASIC_KIND_TASK_ID, inputScope };
definition.bindings["按来源分组并划分用途"].config = {
  mode: "source_group_holdout",
  seed,
  evalFraction: 0.3,
  allowInSampleEval: false,
};
const baseProfile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
if (!flags.has("--input")) {
  baseProfile.id = "training-demo-deliberately-weak-base";
  for (const group of [baseProfile.familyWeights, baseProfile.leafWeights]) {
    for (const weights of Object.values(group)) {
      for (const key of Object.keys(weights)) weights[key] = 0;
    }
  }
}
const profileId = baseProfile.id;
const target = {
  taskId: BASIC_KIND_TASK_ID,
  minScore: 0.6,
  minMargin: 0.15,
  objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
  fit: { epochs: 40, learningRate: 0.02, anchorLambda: 0.001 },
};
definition.bindings["拟合目标节点参数"] = { config: target, profileId };
definition.bindings["比较新旧节点在相同样本的输出"] = { config: target, profileId };

const compiled = compileWorkflow(definition, {
  nodeDefinitions: createTrainingNodeDefinitions({ handwiredRoot, allowedRoot: outputRoot }),
  grantedEffects: ["filesystem.read", "filesystem.write"],
  profiles: loadTrainingProfiles({ profileId, profile: baseProfile }),
});
const runId = `training-public-consumer-${randomUUID()}`;
const result = await runWorkflow(compiled, createWorkflowInputEvent({
  runId,
  eventId: `${runId}:input`,
  port: compiled.entryArc.id,
  type: "training.request.v1",
  payload: request,
}));
if (result.status !== "completed") throw new Error(`${result.error.category}: ${result.error.message}`);
if (result.events.length !== 6) throw new Error(`Expected six terminal events, got ${result.events.length}`);
const receipt = result.outputEvent.payload;
if (result.outputEvent.status === "ok") {
  if (receipt.persistStatus !== "saved") throw new Error(`Expected saved receipt, got ${receipt.persistStatus}`);
  if (!receipt.weightFileRef || !isAbsolute(receipt.weightFileRef)) throw new Error("saved result has no absolute weightFileRef");
  const weightAsset = JSON.parse(await readFile(receipt.weightFileRef, "utf8"));
  const weights = validateBasicKindProfile(weightAsset.profile);
  const reloaded = classifyBasicKind(
    { tag: "button", role: null, inputType: null, hrefPresent: null, contentEditable: null,
      directTextPresent: false, childElementCount: 0, positiveAreaChildCount: 0,
      repeatedChildGeometry: false, inVerifiedListParent: false, disabled: null, hidden: null },
    { taskId: BASIC_KIND_TASK_ID, minScore: 0.6, minMargin: 0.15 },
    weights,
  );
  if (reloaded.calibratedConfidence !== null) throw new Error("Reloaded candidate unexpectedly claims calibration");
  console.log(JSON.stringify({
    status: "completed",
    receipt,
    reloadedKind: reloaded.basicKind,
    judgmentStatus: reloaded.judgmentStatus,
    calibrated: false,
  }, null, 2));
} else {
  if (receipt.persistStatus !== "evidence_insufficient") throw new Error("Non-ok run did not report evidence_insufficient");
  if (receipt.weightFileRef !== null) throw new Error("Non-ok run wrote a weight profile");
  await readFile(receipt.resultFileRef, "utf8");
  console.log(JSON.stringify({ status: result.outputEvent.status, receipt }, null, 2));
}
