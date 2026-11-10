// Raw public-producer observation over the committed DEV sources. The producer
// is the accepted `runTsJsSymbolTable` entry; this script records the exact raw
// output per case and never labels a producer rejection as a negative relation.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const familyRoot = join(here, "..");
const receiptsDir = join(familyRoot, "receipts");
const repoRoot = join(here, "..", "..", "..", "..", "..", "..");

const { runTsJsSymbolTable } = await import(
  join(repoRoot, "dist", "adapters", "cli", "tsjs-symbol-table-adapter.js")
);

const cases = [
  { id: "dv-c01", files: ["src/dv-c01-direct.ts", "src/dispatch.ts"] },
  { id: "dv-c02", files: ["src/dv-c02-alias.ts", "src/dispatch.ts"] },
  { id: "control-static-selector", files: ["src/control-static-selector.ts", "src/dispatch.ts"] },
  { id: "control-direct-table-index", files: ["src/control-direct-table-index.ts", "src/dispatch.ts"] },
  { id: "control-branch-helper", files: ["src/control-branch-helper.ts"] },
];

const results = [];
for (const entry of cases) {
  const outcome = await runTsJsSymbolTable({
    repo: familyRoot,
    language: "typescript",
    scope: ["src"],
    files: entry.files,
  });
  if (outcome.status !== "ok") {
    results.push({ id: entry.id, files: entry.files, status: outcome.status, error: outcome });
    continue;
  }
  const result = outcome.result;
  results.push({
    id: entry.id,
    files: entry.files,
    status: "ok",
    observationCount: result.runtimeSelectorObservations.length,
    gapCount: result.runtimeSelectorGaps.length,
    gapReasons: result.runtimeSelectorGaps.map(gap => gap.reason),
    observations: result.runtimeSelectorObservations.map(observation => ({
      callSiteRef: observation.callSiteRef,
      sourceReadRef: observation.sourceReadRef,
      binding: observation.binding,
      facts: observation.facts,
      sourceReadReceipt: observation.sourceReadReceipt,
    })),
    coverage: {
      partial: result.coverage.partial,
      scopeFilesDiscovered: result.coverage.scopeFilesDiscovered,
      scopeFilesParsed: result.coverage.scopeFilesParsed,
    },
    parserSemanticBinding: result.parser.semanticBinding,
  });
}

const receipt = {
  schema: "nnanything.tsjs.dev.producer-receipt.v1",
  producedAt: new Date().toISOString(),
  producer: "runTsJsSymbolTable",
  producerModule: "dist/adapters/cli/tsjs-symbol-table-adapter.js",
  repo: familyRoot,
  cases: results,
};

mkdirSync(receiptsDir, { recursive: true });
writeFileSync(join(receiptsDir, "producer-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
