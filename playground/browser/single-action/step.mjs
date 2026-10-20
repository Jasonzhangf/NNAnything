import {
  predictBrowserSingleAction,
  readSingleActionRequest,
  validateBrowserSingleActionProfile,
} from "nnanything/browser-single-action";
import { parseArgs, readJson } from "./cli.mjs";

const options = parseArgs(process.argv.slice(2), ["--profile", "--request"]);
if (!options.has("--profile") || !options.has("--request")) {
  throw new Error("Usage: step.mjs --profile FILE --request FILE");
}

const profile = validateBrowserSingleActionProfile(await readJson(options.get("--profile")));
const request = readSingleActionRequest(await readJson(options.get("--request")));
console.log(JSON.stringify({
  prediction: predictBrowserSingleAction(request, profile),
}, null, 2));
