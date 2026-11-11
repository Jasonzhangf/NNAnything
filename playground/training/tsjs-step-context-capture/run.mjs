// Real consumer for the public TS/JS step-context capture entry.
//
// It imports only the package public surface, prints the typed result, and sets
// the exit status from it.

import { runTsjsStepContextCaptureFromFile } from "nnanything/tsjs-step-context-capture";

const configPath = process.argv[2];

if (typeof configPath !== "string" || configPath.length === 0) {
  console.log(JSON.stringify({
    status: "failed",
    error: {
      code: "CONFIG_PATH_REQUIRED",
      message: "usage: node playground/training/tsjs-step-context-capture/run.mjs <config.json>",
      detail: null,
    },
  }, null, 2));
  process.exitCode = 2;
} else {
  const result = await runTsjsStepContextCaptureFromFile(configPath);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "completed" ? 0 : 1;
}
