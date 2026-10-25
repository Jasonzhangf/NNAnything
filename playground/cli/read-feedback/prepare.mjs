// Prepare real samples: measure the sandbox cases and report true per-label
// counts. Coverage is counted from the real oracle per sample, never by
// multiplying a family's sample count by its label list.
//
// The measured receipts are also persisted content-free for replay: hidden
// bytes are stripped before writing, so the pretraining corpus (a) stays a real
// controlled run and (b) can be replayed by a later fitting entry without
// re-executing any read.
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

// Content-free replay capture. The measured receipt facts are real; the hidden
// bytes are replaced by "" so no file content can enter a later model input.
const pretrainPartitions = { train: 0, dev: 0, verification: 0 };
const pretrainRuns = prepared.measurements.map(measurement => {
  pretrainPartitions[measurement.spec.partition] += 1;
  return Object.freeze({
    task: {
      id: measurement.spec.id,
      family: measurement.spec.family,
      partition: measurement.spec.partition,
      provenance: measurement.spec.provenance,
      request: measurement.spec.request,
      context: measurement.spec.context,
    },
    attempts: [{
      attemptId: `${measurement.spec.id}:attempt:1`,
      receiptSource: "measureCase",
      injected: measurement.injected,
      status: measurement.attempt.observation !== null ? "succeeded" : "failed",
      observation: measurement.attempt.observation === null
        ? null
        : { ...measurement.attempt.observation, bytes: "" },
      failure: measurement.attempt.failure,
      priorCoverage: measurement.attempt.priorCoverage,
    }],
  });
});
const pretrain = {
  schema: "nnanything.cli-read-feedback.pretrain-samples.v1",
  generatedBy: "playground/cli/read-feedback/prepare.mjs",
  corpus: "buildCases() measured by prepareSamples()",
  partitions: pretrainPartitions,
  runs: pretrainRuns,
};
await writeFile(join(outDir, "pretrain-samples.json"), JSON.stringify(pretrain, null, 2));

console.log(JSON.stringify({
  cases: prepared.measurements.length,
  perPartition: prepared.counts.perPartition,
  families: prepared.counts.families,
  shortfalls,
}, null, 2));
assert.deepEqual(shortfalls, [], "real per-label counts must meet train>=3, dev>=1, ver>=1");
