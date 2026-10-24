// Prepare real samples: measure the sandbox cases and report true per-label
// counts. Coverage is counted from the real oracle per sample, never by
// multiplying a family's sample count by its label list.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCases, prepareSamples, buildReasoningEpisodes, superviseBase } from "nnanything/cli-read-feedback";

const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";
await mkdir(outDir, { recursive: true });

const prepared = await prepareSamples(buildCases());
const reasoning = buildReasoningEpisodes(prepared.measurements, attempt => superviseBase(attempt).label);

// Every label must have enough real instances for train/dev/verification.
const shortfalls = [];
for (const [label, counts] of Object.entries(prepared.counts.baseLabels)) {
  if (counts.train < 3 || counts.dev < 1 || counts.verification < 1) shortfalls.push({ label, counts });
}
for (const [label, counts] of Object.entries(reasoning.counts)) {
  if (counts.train < 3 || counts.dev < 1 || counts.verification < 1) shortfalls.push({ label, counts });
}

await writeFile(join(outDir, "samples.json"), JSON.stringify({
  counts: prepared.counts,
  reasoningCounts: reasoning.counts,
  shortfalls,
}, null, 2));
console.log(JSON.stringify({
  cases: prepared.measurements.length,
  perPartition: prepared.counts.perPartition,
  families: prepared.counts.families,
  shortfalls,
}, null, 2));
assert.deepEqual(shortfalls, [], "real per-label counts must meet train>=3, dev>=1, ver>=1");
