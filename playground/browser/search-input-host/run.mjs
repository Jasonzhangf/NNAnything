import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inferSearchInputHostBinding,
  neutralSearchInputHostProfile,
  trainSearchInputHostBinder,
  validateSearchInputHostProfile,
} from "nnanything/search-input-host";

// Public consumer for the search-input-host binder unit.
//
//   --mode infer   --request FILE [--profile FILE]
//   --mode train   --rows FILE --weights FILE [--epochs N] [--learning-rate X] [--margin M]
//                  [--objective pairwise|absolute]
//   --mode observe --profile FILE --cases FILE
//
// The unit never writes weights itself. `train` writes only to the explicit
// --weights path and refuses the production training/weights directory.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (typeof key !== "string" || !key.startsWith("--") || value === undefined || args.has(key)) {
      throw new Error("Arguments must be unique --key value pairs");
    }
    args.set(key, value);
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function readProfile(raw) {
  return validateSearchInputHostProfile(raw?.profile ?? raw);
}

const args = parseArgs(process.argv.slice(2));
const mode = args.get("--mode") ?? "infer";

if (mode === "infer") {
  if (!args.has("--request")) throw new Error("Use --mode infer --request FILE [--profile FILE]");
  const request = await readJson(args.get("--request"));
  const profile = args.has("--profile")
    ? readProfile(await readJson(args.get("--profile")))
    : neutralSearchInputHostProfile();
  const result = inferSearchInputHostBinding(request, { profile });
  console.log(JSON.stringify({
    mode,
    processId: process.pid,
    profileSource: args.has("--profile") ? resolve(args.get("--profile")) : "neutral",
    profileState: { calibration: profile.calibration, adoption: profile.adoption },
    theta: profile.threshold,
    result,
  }, null, 2));
} else if (mode === "train") {
  if (!args.has("--rows") || !args.has("--weights")) {
    throw new Error("Use --mode train --rows FILE --weights FILE [--epochs N] [--learning-rate X] [--margin M]");
  }
  const rows = await readJson(args.get("--rows"));
  const batches = Array.isArray(rows) ? rows : rows.batches;
  if (!Array.isArray(batches)) throw new Error("Training rows must be an array or { batches: [...] }");
  const output = resolve(args.get("--weights"));
  const productionWeights = join(repoRoot, "training", "weights");
  if (output === productionWeights || output.startsWith(productionWeights + sep)) {
    throw new Error("Refusing to write into training/weights: this candidate is not production weight");
  }
  const resources = {};
  if (args.has("--epochs")) resources.epochs = Number(args.get("--epochs"));
  if (args.has("--learning-rate")) resources.learningRate = Number(args.get("--learning-rate"));
  if (args.has("--margin")) resources.margin = Number(args.get("--margin"));
  if (args.has("--objective")) resources.objective = args.get("--objective");
  const result = trainSearchInputHostBinder({ batches }, resources);
  await writeFile(output, `${JSON.stringify({ profile: result.profile, fit: result.fit }, null, 2)}\n`);
  console.log(JSON.stringify({
    mode,
    processId: process.pid,
    fitted: true,
    weightsPath: output,
    calibration: result.profile.calibration,
    adoption: result.profile.adoption,
    theta: result.profile.threshold,
    objective: result.fit.objective,
    weights: result.profile.weights,
    fit: result.fit,
  }, null, 2));
} else if (mode === "observe") {
  if (!args.has("--profile") || !args.has("--cases")) {
    throw new Error("Use --mode observe --profile FILE --cases FILE");
  }
  const profile = readProfile(await readJson(args.get("--profile")));
  const raw = await readJson(args.get("--cases"));
  const cases = Array.isArray(raw) ? raw : raw.cases;
  if (!Array.isArray(cases)) throw new Error("Observation cases must be an array or { cases: [...] }");
  const results = cases.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || entry.request === undefined) {
      throw new Error(`Observation case ${index} must have an id and a request`);
    }
    const result = inferSearchInputHostBinding(entry.request, { profile });
    return { id: entry.id, ...result };
  });
  console.log(JSON.stringify({
    mode,
    processId: process.pid,
    fitted: false,
    profileState: { calibration: profile.calibration, adoption: profile.adoption },
    theta: profile.threshold,
    results,
  }, null, 2));
} else {
  throw new Error(`Unknown --mode ${mode}; use infer, train or observe`);
}
