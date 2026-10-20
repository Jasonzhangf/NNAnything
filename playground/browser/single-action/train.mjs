import { resolve } from "node:path";
import {
  makeBrowserSingleActionSamples,
  runBrowserSingleActionTraining,
} from "nnanything/browser-single-action";
import { parseArgs, readJson } from "./cli.mjs";

const options = parseArgs(process.argv.slice(2), ["--handwired-root", "--output", "--samples"]);
if (!options.has("--handwired-root") || !options.has("--output")) {
  throw new Error("Usage: train.mjs --handwired-root PATH --output DIR [--samples FILE]");
}

const episodes = options.has("--samples")
  ? await readJson(options.get("--samples"))
  : makeBrowserSingleActionSamples();
const receipt = await runBrowserSingleActionTraining({
  episodes,
  handwiredRoot: resolve(options.get("--handwired-root")),
  outputDirectory: resolve(options.get("--output")),
});

console.log(JSON.stringify({
  runId: receipt.runId,
  accepted: receipt.accepted,
  fullyVerified: receipt.fullyVerified,
  error: receipt.error,
  candidatePath: receipt.candidatePath,
  reportPath: receipt.reportPath,
  casesPath: receipt.casesPath,
  profile: receipt.profile,
  timing: receipt.timing,
  comparison: {
    train: {
      zero: { count: receipt.comparison.train.zero.count, passed: receipt.comparison.train.zero.passed },
      rule: { count: receipt.comparison.train.rule.count, passed: receipt.comparison.train.rule.passed },
      trained: { count: receipt.comparison.train.trained.count, passed: receipt.comparison.train.trained.passed },
    },
    development: {
      zero: { count: receipt.comparison.development.zero.count, passed: receipt.comparison.development.zero.passed },
      rule: { count: receipt.comparison.development.rule.count, passed: receipt.comparison.development.rule.passed },
      trained: { count: receipt.comparison.development.trained.count, passed: receipt.comparison.development.trained.passed },
    },
  },
  assessment: receipt.assessment,
  verification: receipt.verification,
}, null, 2));

if (!receipt.accepted) process.exitCode = 1;
