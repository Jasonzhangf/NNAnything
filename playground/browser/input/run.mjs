import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runBrowserInputGoal } from "nnanything/browser-input";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!["--request", "--io"].includes(key) || !value || args.has(key)) {
    throw new Error("Use --request FILE --io MODULE");
  }
  args.set(key, value);
}
if (!args.has("--request") || !args.has("--io")) {
  throw new Error("Explicit --request FILE and --io MODULE required");
}

const request = JSON.parse(await readFile(resolve(args.get("--request")), "utf8"));
const io = await import(pathToFileURL(resolve(args.get("--io"))).href);
const resources = typeof io.createResources === "function"
  ? await io.createResources(request)
  : io.resources;
if (!resources) throw new Error("IO module must export resources or createResources(request)");

let episode;
let sideEffects = null;
let closeErrors = [];
try {
  episode = await runBrowserInputGoal(request, resources);
} finally {
  if (typeof io.close === "function") {
    const closed = await io.close();
    sideEffects = closed?.sideEffects ?? null;
    closeErrors = closed?.closeErrors ?? [];
  }
}

console.log(JSON.stringify({ episode, sideEffects, closeErrors }, null, 2));
const normalSuccess = episode.goalFact === "satisfied" && episode.executionErrors.length === 0;
if (!normalSuccess) process.exitCode = 1;
