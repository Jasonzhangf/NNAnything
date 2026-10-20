import {
  evaluateBrowserSingleActionCases,
  validateBrowserSingleActionProfile,
} from "nnanything/browser-single-action";
import { parseArgs, readJson } from "./cli.mjs";

const options = parseArgs(process.argv.slice(2), ["--profile", "--cases"]);
if (!options.has("--profile") || !options.has("--cases")) {
  throw new Error("Usage: reload.mjs --profile FILE --cases FILE");
}

const profile = validateBrowserSingleActionProfile(await readJson(options.get("--profile")));
const evaluation = evaluateBrowserSingleActionCases(profile, await readJson(options.get("--cases")));
console.log(JSON.stringify({
  fitted: false,
  processId: process.pid,
  profilePath: options.get("--profile"),
  casesPath: options.get("--cases"),
  calibration: profile.calibration,
  adoption: profile.adoption,
  ...evaluation,
}, null, 2));

if (evaluation.failed > 0) process.exitCode = 1;
