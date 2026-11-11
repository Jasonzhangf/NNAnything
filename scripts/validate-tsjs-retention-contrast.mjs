import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadTsjsRetentionContrastConfig,
  runTsjsRetentionContrastConfigValidation,
} from "../dist/training/tsjs-retention-contrast-config.js";

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const configPath = valueAfter(args, "--config");
  if (configPath === undefined) {
    throw new Error(
      "Usage: node scripts/validate-tsjs-retention-contrast.mjs --config <config.json> [--report <report.json>]",
    );
  }
  const config = await loadTsjsRetentionContrastConfig(configPath);
  const result = await runTsjsRetentionContrastConfigValidation(config);
  const text = `${JSON.stringify(result.report, null, 2)}\n`;
  const reportPath = valueAfter(args, "--report");
  if (reportPath !== undefined) {
    await writeFile(resolve(reportPath), text, "utf8");
  }
  process.stdout.write(text);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    process.stderr.write(
      `${JSON.stringify(
        {
          schema: "nnanything.tsjs.retention-contrast-config-report.v1",
          status: "FAILED",
          error: {
            code: error?.code ?? "VALIDATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
            detail: error?.detail ?? null,
          },
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  });
}
