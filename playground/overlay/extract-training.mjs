#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function printUsageAndExit(message) {
  if (message) {
    console.error(`Error: ${message}\n`);
  }
  console.log(`Usage: node extract-training.mjs --input <bundle.json> --out <training-request.json> [--force]

Options:
  --input <path>   Path to the exported browser capture bundle JSON file (required)
  --out <path>     Path where the extracted BasicKindTrainingRequest JSON will be written (required)
  --force          Allow overwriting the output file if it already exists (default: false, create-new only)
`);
  process.exit(message ? 1 : 0);
}

function parseArgs(args) {
  let inputPath = null;
  let outPath = null;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input") {
      inputPath = args[++i];
    } else if (arg === "--out") {
      outPath = args[++i];
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit();
    } else {
      printUsageAndExit(`Unknown argument: ${arg}`);
    }
  }

  if (!inputPath) {
    printUsageAndExit("Missing required argument --input");
  }
  if (!outPath) {
    printUsageAndExit("Missing required argument --out");
  }

  return { inputPath, outPath, force };
}

async function loadExtractor() {
  try {
    const mod = await import("nnanything/browser-classify");
    return mod.extractTrainingRequestFromBundle;
  } catch (err) {
    try {
      const relativeMod = await import("../../lib/browser-classify.js");
      return relativeMod.extractTrainingRequestFromBundle;
    } catch {
      console.error(
        "\n[extract-training] PENDING INTEGRATION DEPENDENCY:\n" +
        "  The foundation module \"nnanything/browser-classify\" is currently being implemented\n" +
        "  by parent in the integration branch. Once parent merges foundation, this CLI will\n" +
        "  execute extractTrainingRequestFromBundle against the bundle.\n"
      );
      process.exit(1);
    }
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsageAndExit();
  }

  const { inputPath, outPath, force } = parseArgs(process.argv.slice(2));

  const resolvedInput = resolve(process.cwd(), inputPath);
  const resolvedOut = resolve(process.cwd(), outPath);

  if (!existsSync(resolvedInput)) {
    console.error(`Error: Input file does not exist: ${resolvedInput}`);
    process.exit(1);
  }

  if (existsSync(resolvedOut) && !force) {
    console.error(`Error: Output file already exists and --force was not specified: ${resolvedOut}`);
    console.error("By default, extract-training creates a new file to prevent overwriting existing data.");
    process.exit(1);
  }

  const extractTrainingRequestFromBundle = await loadExtractor();

  let rawBundle;
  try {
    const content = readFileSync(resolvedInput, "utf8");
    rawBundle = JSON.parse(content);
  } catch (err) {
    console.error(`Error: Failed to read or parse input JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let trainingRequest;
  try {
    trainingRequest = extractTrainingRequestFromBundle(rawBundle);
  } catch (err) {
    console.error(`Error: Failed to extract training request from bundle: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    writeFileSync(resolvedOut, JSON.stringify(trainingRequest, null, 2), "utf8");
    console.log(`Successfully extracted BasicKindTrainingRequest (${trainingRequest.rows?.length ?? 0} rows) to:`);
    console.log(resolvedOut);
  } catch (err) {
    console.error(`Error: Failed to write output file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
