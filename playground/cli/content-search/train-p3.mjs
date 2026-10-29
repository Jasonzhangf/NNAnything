import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const policy = await import("nnanything/cli-goal");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`--${name} requires a value`);
  return value;
}

function requiredArgument(name) {
  const value = argument(name, undefined);
  if (value === undefined || value.length === 0) throw new TypeError(`--${name} is required`);
  return value;
}

const samplesPath = resolve(requiredArgument("samples"));
const profilePath = resolve(requiredArgument("profile"));
const handwiredRoot = resolve(requiredArgument("handwired-root"));
const outputRoot = resolve(argument("output-root", join("training", "results", "p3-content-search")));
const receiptPath = resolve(argument("receipt", join("training", "results", "p3-content-search", `${randomUUID()}-train.json`)));
const epochs = Number(argument("epochs", "200"));
const learningRate = Number(argument("learning-rate", "0.1"));
if (!isAbsolute(handwiredRoot)) throw new TypeError("--handwired-root must be absolute");
if (!isAbsolute(outputRoot)) throw new TypeError("--output-root must be absolute");

const samples = JSON.parse(await readFile(samplesPath, "utf8"));
if (!["p3-content-search-samples.v1", "p3-content-search-samples.v2"].includes(samples?.schemaVersion)) {
  throw new TypeError(`samples schema must be p3-content-search-samples.v1 or v2, got ${samples?.schemaVersion}`);
}
const preferenceRows = (Array.isArray(samples.preferenceRows) ? samples.preferenceRows : [])
  .filter(row => row.partition === "train");
if (preferenceRows.length === 0) throw new TypeError("samples file has no train preference rows");
if (samples.schemaVersion === "p3-content-search-samples.v2") {
  const dispatchIndex = new Set(Object.keys(samples.evidence?.dispatches ?? {}));
  const unresolved = preferenceRows.flatMap(row => row.evidenceRefs ?? [])
    .filter(ref => !dispatchIndex.has(ref));
  if (unresolved.length > 0) {
    throw new TypeError(`preference rows reference ${unresolved.length} unresolved dispatch ids`);
  }
}

const rawProfile = JSON.parse(await readFile(profilePath, "utf8"));
const schema = policy.detectCliCommandProfileSchema(rawProfile);
const initial = policy.migrateCliCommandProfileToCurrent(rawProfile);

const startedAt = new Date().toISOString(), started = performance.now();
await mkdir(outputRoot, { recursive: true });
const receipt = await policy.runCliCommandTraining({
  task: "candidate-preference",
  preferenceRows: preferenceRows.map(row => ({
    id: row.id,
    sourceGroup: row.sourceGroup,
    partition: row.partition,
    preferredName: row.preferredName,
    otherName: row.otherName,
    preferredFeatures: [...row.preferredFeatures],
    otherFeatures: [...row.otherFeatures],
    evidenceRefs: [...(row.evidenceRefs ?? [])],
  })),
  initial,
  initialSource: profilePath,
  epochs,
  learningRate,
}, {
  handwiredRoot,
  outputRoot,
  grantedEffects: ["filesystem.read", "filesystem.write"],
});
if (receipt?.task !== "candidate-preference") {
  throw new TypeError(`public training entry returned an unexpected task receipt: ${receipt?.task ?? "none"}`);
}

const reload = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { readFile } from "node:fs/promises";
  const policy = await import("nnanything/cli-goal");
  const profile = policy.validateCliCommandProfile(JSON.parse(await readFile(${JSON.stringify(receipt.paths.profile)}, "utf8")));
  console.log(JSON.stringify({
    processId: process.pid,
    contract: profile.contract,
    heads: profile.heads.length,
    wires: profile.wires.length,
    weightRows: profile.weights.length,
    weightColumns: profile.weights[0].length,
    nameColumn: profile.wires.indexOf("search.nameNeedleSegment"),
    nameWeight: profile.weights[profile.heads.indexOf("entry.inspect")][profile.wires.indexOf("search.nameNeedleSegment")],
    calibration: profile.calibration,
    adoption: profile.adoption,
  }));
`], { cwd: process.cwd(), encoding: "utf8" });
if (reload.status !== 0) {
  throw new Error(`saved candidate failed public reload validation: ${reload.stderr || reload.stdout}`);
}
const reloadEvidence = JSON.parse(reload.stdout.trim());

const report = {
  schemaVersion: "p3-content-search-workflow-training.v1",
  generatedAt: new Date().toISOString(),
  startedAt,
  samplesPath,
  sourceProfilePath: profilePath,
  sourceProfileSchema: schema,
  entry: "runCliCommandTraining",
  workflow: "cli-filesystem-training/0.3.0.0000 8N8E",
  runId: receipt.runId,
  accepted: receipt.accepted,
  fullyVerified: receipt.fullyVerified,
  paths: receipt.paths,
  candidateStatus: { calibration: receipt.profile.calibration, adoption: receipt.profile.adoption },
  dataset: receipt.dataset,
  trainable: receipt.trainable,
  loss: receipt.loss,
  execution: { count: receipt.execution.count, correct: receipt.execution.correct },
  timing: receipt.timing,
  reload: { ...reloadEvidence, exitCode: reload.status },
  consumerMs: performance.now() - started,
};

await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
