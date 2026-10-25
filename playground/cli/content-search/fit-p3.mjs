import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const policy = await import("nnanything/cli-goal");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const samplesArgument = argument("samples", undefined);
if (samplesArgument === undefined) throw new Error("--samples <samples.json> is required");
const samplesPath = resolve(samplesArgument);
const receiptPath = resolve(argument("receipt", `training/results/p3-content-search/${randomUUID()}/fit.json`));
const epochs = Number(argument("epochs", "200"));
const learningRate = Number(argument("learning-rate", "0.1"));
const profilePath = argument("profile", process.env.NN_CLI_COMMAND_PROFILE);
if (typeof profilePath !== "string" || profilePath.length === 0) {
  throw new Error("--profile or NN_CLI_COMMAND_PROFILE is required");
}
const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");

const samples = JSON.parse(await readFile(samplesPath, "utf8"));
const rows = Array.isArray(samples.preferenceRows) ? samples.preferenceRows : [];
const trainRows = rows.filter(row => row.partition === "train");
const prepared = policy.prepareCliCandidatePreferenceDataset(trainRows);

const rawProfile = JSON.parse(await readFile(profilePath, "utf8"));
const schema = policy.detectCliCommandProfileSchema(rawProfile);
const initial = schema === "rejected-10x30"
  ? policy.migrateCliCommandProfileV10x30(rawProfile)
  : policy.validateCliCommandProfile(rawProfile);

const fit = await policy.fitCliCandidateNamePreference({
  initial,
  rows: prepared.rows,
  handwiredRoot,
  epochs,
  learningRate,
});

const candidateDirectoryArgument = argument("candidate-dir", undefined);
const candidateDirectory = resolve(
  candidateDirectoryArgument ?? join("training", "weights", "filesystem", "command", randomUUID()),
);
const candidateId = basename(candidateDirectory);
const candidatePath = join(candidateDirectory, "candidate.json");
await mkdir(candidateDirectory, { recursive: true });
await writeFile(candidatePath, `${JSON.stringify(fit.profile, null, 2)}\n`);

const reload = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { readFile } from "node:fs/promises";
  const policy = await import("nnanything/cli-goal");
  const profile = policy.validateCliCommandProfile(JSON.parse(await readFile(${JSON.stringify(candidatePath)}, "utf8")));
  console.log(JSON.stringify({
    processId: process.pid,
    contract: profile.contract,
    heads: profile.heads.length,
    wires: profile.wires.length,
    weightRows: profile.weights.length,
    weightColumns: profile.weights[0].length,
    nameColumn: profile.wires.indexOf("search.nameNeedleSegment"),
    calibration: profile.calibration,
    adoption: profile.adoption,
  }));
`], { cwd: process.cwd(), encoding: "utf8" });
if (reload.status !== 0) {
  throw new Error(`saved candidate failed public reload validation: ${reload.stderr || reload.stdout}`);
}
const reloadEvidence = JSON.parse(reload.stdout.trim());

const inspectRow = fit.profile.heads.indexOf("entry.inspect");
const nameColumn = fit.profile.wires.indexOf("search.nameNeedleSegment");
const before = fit.initialProfile.weights.map(row => [...row]);
const after = fit.profile.weights.map(row => [...row]);
const changed = [];
for (let row = 0; row < after.length; row += 1) {
  for (let column = 0; column < after[row].length; column += 1) {
    if (before[row][column] !== after[row][column]) changed.push({
      head: fit.profile.heads[row],
      wire: fit.profile.wires[column],
      before: before[row][column],
      after: after[row][column],
    });
  }
}
const report = {
  schemaVersion: "p3-content-search-fit.v1",
  generatedAt: new Date().toISOString(),
  samplesPath,
  sourceProfilePath: profilePath,
  sourceProfileSchema: schema,
  candidateId,
  candidatePath,
  candidateStatus: { calibration: fit.profile.calibration, adoption: fit.profile.adoption },
  budget: { epochs, learningRate },
  dataset: {
    sampleCount: Array.isArray(samples.samples) ? samples.samples.length : 0,
    preferenceRows: rows.length,
    trainPreferenceRows: trainRows.length,
    validPairCount: prepared.validPairCount,
    deltaZeroCount: prepared.deltaZeroCount,
    deltaOneCount: prepared.deltaOneCount,
  },
  trainable: {
    head: "entry.inspect",
    wire: "search.nameNeedleSegment",
    index: inspectRow * fit.profile.wires.length + nameColumn,
    parameterBefore: fit.parameterBefore,
    parameterAfter: fit.parameterAfter,
    initialGradient: fit.initialGradient,
    frozenParameterCount: fit.frozenParameterCount,
    frozenDelta: fit.frozenDelta,
    changed,
  },
  loss: {
    before: fit.initialLoss,
    after: fit.finalLoss,
    trajectoryHead: fit.trajectory.slice(0, 3),
    trajectoryTail: fit.trajectory.slice(-3),
    completedEpochs: fit.timing.completedEpochs,
    rowPasses: fit.timing.totalRowPasses,
  },
  timing: fit.timing,
  reload: { ...reloadEvidence, exitCode: reload.status },
  fullyVerified: false,
  note: "Increment B fits and saves one candidate. Held-out matrix, t2 replay comparison, and independent evaluation belong to increment C.",
};
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
