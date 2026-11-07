#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateUnifiedTransfer } from "../../dist/training/unified-transfer-evaluator.js";

function parseArgs(argv) {
  const args = {
    package: null,
    verification: null,
    oracle: null,
    report: "training/results/tsjs-to-rust-transfer-candidate.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument ${key}`);
    }
    const name = key.slice(2);
    if (!Object.hasOwn(args, name)) {
      throw new Error(`unsupported argument ${name}`);
    }
    args[name] = value;
    index += 1;
  }
  if (args.package === null) {
    throw new Error("--package is required");
  }
  return args;

try {
  const args = parseArgs(process.argv.slice(2));
  const report = await evaluateUnifiedTransfer({
    packagePath: resolve(args.package),
    ...(args.verification === null ? {} : { verificationPath: resolve(args.verification) }),
    ...(args.oracle === null ? {} : { oraclePath: resolve(args.oracle) }),
  });
  const reportPath = resolve(args.report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `adapter=${report.adapterSemanticAlignment.status} inference=${report.encodingInferenceConsistency.status} transfer=${report.actualTransferCorrectness.status}`,
  );
  if (report.actualTransferCorrectness.status !== "pass") {
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}