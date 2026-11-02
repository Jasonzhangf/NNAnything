// Black-box acceptance for the L2 usage-log consumer.
//
// The test uses only the public package entries and the neutral value-flow
// contract. It does not start fitting, create a candidate, or write weights.
import assert from "node:assert/strict";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const contractModulePath = join(repoRoot, "dist", "adapters", "cli", "value-flow-contract.js");
const runnerModulePath = join(repoRoot, "dist", "training", "value-flow-l2-runner.js");
const USAGE_LOG_SCHEMA = "nnanything.nn-code.usage-log.v2";

const VALUE_FLOW_FEATURE_NAMES = Object.freeze([
  "r00_dir_is_origin",
  "r01_dir_is_sink",
  "r02_same_dir_as_exported_module",
  "r03_is_test_or_fixture_path",
  "r04_same_line_has_call_open_paren",
  "r05_same_line_call_parens_closed",
  "r06_same_line_has_receive_or_return_prefix",
  "r07_same_line_is_standalone_stmt_prefix",
  "r08_same_line_has_comment_or_type_syntax",
  "r09_same_line_is_import_or_decl_header",
  "r10_same_line_arg_count_covers_target",
  "m00_mask_arg_count_observable",
  "m01_mask_multiline_receive_unobserved",
  "m02_mask_enclosing_block_comment_or_template_unknown",
  "m03_mask_cross_file_module_binding_unverified",
]);

const VALUE_FLOW_LABELS = Object.freeze(["holds", "insufficient", "refuted"]);
const TARGET_UNIT_CONTRACT = Object.freeze({
  unitId: "cli.value-flow.candidate-relevance.v1",
  semanticContractRef: "value-flow-training-design.md#r9",
  featureSchema: "cli.value-flow.candidate-features.v1",
  labelSchema: "cli.value-flow.candidate-labels-3.v1",
  trainerEntry: "lib/training/value-flow-l2-runner.ts",
  featureDim: 15,
  paramCount: 579,
  classes: ["insufficient", "holds", "refuted"],
});

const DEFAULT_EXISTING_PARTITIONS = Object.freeze({
  trainFamilies: ["VF_TR_1", "VF_TR_2"],
  devFamilies: ["VF_DEV_1"],
  verificationFamilies: ["VF_VER_1"],
  demotedVerificationFamilies: [],
});

const EMPTY_EXISTING_PARTITIONS = Object.freeze({
  trainFamilies: [],
  devFamilies: [],
  verificationFamilies: [],
  demotedVerificationFamilies: [],
});

const BASE_FEATURES = Object.freeze([
  0.25, 0.5, 0.75, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.1, 0.2, 0.3,
]);

const cliApi = () => import("nnanything/cli-call-depth");
const trainingApi = () => import("nnanything/training");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeTempDir(t, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function makeStagingPath(t, prefix) {
  const parent = await makeTempDir(t, prefix);
  return join(parent, "batch");
}

async function snapshotTree(root) {
  const entries = {};
  async function visit(current, relativePath) {
    const names = (await readdir(current)).sort();
    for (const name of names) {
      const path = join(current, name);
      const rel = relativePath.length === 0 ? name : `${relativePath}/${name}`;
      const info = await lstat(path);
      entries[rel] = {
        type: info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : info.isSymbolicLink()
              ? "symlink"
              : "other",
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
      };
      if (info.isDirectory() && !info.isSymbolicLink()) await visit(path, rel);
    }
  }
  await visit(root, "");
  return entries;
}

async function snapshotDirectoryTopLevel(root) {
  const entries = {};
  for (const name of (await readdir(root)).sort()) {
    const info = await lstat(join(root, name));
    entries[name] = {
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      size: Number(info.size),
      mtimeMs: Number(info.mtimeMs),
    };
  }
  return entries;
}

function readJsonl(text) {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.filter(line => line.trim().length > 0).map(line => JSON.parse(line));
}

async function drainUsageLogGenerator(generator) {
  const items = [];
  let summary;
  while (true) {
    const next = await generator.next();
    if (next.done) {
      summary = next.value;
      break;
    }
    items.push(next.value);
  }
  return { items, summary };
}

async function readJsonlFile(path) {
  return readJsonl(await readFile(path, "utf8"));
}

function eventBase(runId, seq, kind, modelRef = null) {
  return {
    schema: USAGE_LOG_SCHEMA,
    runId,
    seq,
    kind,
    observedAt: new Date(1700000000000 + seq).toISOString(),
    elapsedMs: seq,
    modelRef,
  };
}

async function writeUsageRun(root, runId, candidateCount, options = {}) {
  const lines = [JSON.stringify(eventBase(runId, 0, "start"))];
  let seq = 1;
  for (let index = 0; index < candidateCount; index += 1) {
    const kind = options.kindCycle?.[index % options.kindCycle.length] ?? "decision";
    const extra = options.payload?.(index) ?? {};
    lines.push(JSON.stringify({
      ...eventBase(runId, seq, kind, options.modelRef ?? "cli-value-flow-test-model"),
      callsiteKey: `src/run-${runId}.ts:${index + 1}:1`,
      candidateKey: `src/candidate-${index}.ts#target@param0`,
      syntaxPatternKey: "test_pattern",
      unitId: "cli.value-flow.candidate-relevance.v1",
      profileRef: "cli-value-flow-test-profile",
      featureSchema: "cli.value-flow.candidate-features.v1",
      preDecisionFeatures: BASE_FEATURES,
      inputMissingMask: Array(15).fill(false),
      legalCandidates: [...VALUE_FLOW_LABELS],
      originalChoice: "insufficient",
      expectedLabel: "holds",
      ...extra,
    }));
    seq += 1;
  }
  lines.push(JSON.stringify({
    ...eventBase(runId, seq, "finish"),
    outcome: { status: "achieved" },
    coverage: null,
    resultReceipt: null,
    error: null,
  }));
  const path = join(root, `${runId}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

async function pathStatAndBytes(path) {
  return {
    stat: await lstat(path),
    bytes: await readFile(path),
  };
}

function makeValidLearningCase(overrides = {}) {
  const base = {
    caseId: "VALID_CASE",
    runId: "run-valid",
    seq: 1,
    runState: "complete",
    logRoot: "default_log_root",
    familyId: "VF_TR_1",
    assignedPartition: "train",
    sourceOrigin: {
      repoCanonicalId: "github.com/example/valid-repo",
      repoEvidenceRef: "valid-repo@main:src/file.ts",
      repoIndependenceConfirmed: true,
      renameRelationConfirmed: true,
      sourceConsistentAcrossRuns: true,
      provenIndependentFromUnresolvedGroups: true,
    },
    callsiteKey: "src/file.ts:10:5",
    candidateKey: "src/target.ts#target@param0",
    syntaxPatternKey: "valid_pattern",
    reviewState: "confirmed_learning_case",
    confirmationSource: "ast_posterior_verified",
    labelAuthority: {
      kind: "ast_posterior_verified",
      reviewer: "NNAnything.Carol",
      confirmedAt: "2026-11-01T07:00:00Z",
      evidenceRefs: ["src/file.ts:10", "src/target.ts:4"],
    },
    posteriorFact: {
      expectedLabel: "holds",
      supervisionMasked: false,
      oracleKind: "ast_reaching_definition_oracle",
      verifiedSpanOrEdgeRef: "span-ref",
    },
    sourceExcerptComplete: true,
    sourceChangedDuringRun: false,
    decisionEvent: {
      unitId: TARGET_UNIT_CONTRACT.unitId,
      profileRef: "cli-value-flow-test-profile",
      featureSchema: TARGET_UNIT_CONTRACT.featureSchema,
      preDecisionFeatures: [...BASE_FEATURES],
      inputMissingMask: Array(15).fill(false),
      legalCandidates: [...VALUE_FLOW_LABELS],
      originalChoice: "insufficient",
    },
  };
  return {
    ...base,
    ...overrides,
    sourceOrigin: overrides.sourceOrigin === undefined ? base.sourceOrigin : overrides.sourceOrigin,
    labelAuthority: overrides.labelAuthority === undefined ? base.labelAuthority : overrides.labelAuthority,
    posteriorFact: overrides.posteriorFact === undefined ? base.posteriorFact : overrides.posteriorFact,
    decisionEvent: overrides.decisionEvent === undefined ? base.decisionEvent : overrides.decisionEvent,
  };
}

function simplifyConversionResult(result) {
  return {
    converterReadiness: result.converterReadiness,
    trainCount: result.train.length,
    devCount: result.dev.length,
    verificationCount: result.verificationRefs.length,
    familyAssignments: result.familyAssignments.map(group => ({
      familyId: group.familyId,
      assignmentState: group.assignmentState,
      holdReason: group.holdReason,
      partition: group.partition,
    })),
  };
}

test("1 import has zero output and zero file side effects", async t => {
  const cwd = process.cwd();
  const tempDir = await makeTempDir(t, "nn-code-import-side-effect-");
  await writeFile(join(tempDir, "sentinel.txt"), "sentinel\n");
  const cwdBefore = await snapshotDirectoryTopLevel(cwd);
  const tempBefore = await snapshotTree(tempDir);

  const stdoutChunks = [];
  const stderrChunks = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let cli;
  let training;
  process.stdout.write = (chunk, ...args) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return typeof args[1] === "function" ? args[1]() : true;
  };
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return typeof args[1] === "function" ? args[1]() : true;
  };
  try {
    cli = await cliApi();
    training = await trainingApi();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  assert.equal(Buffer.concat(stdoutChunks).byteLength, 0);
  assert.equal(Buffer.concat(stderrChunks).byteLength, 0);
  assert.deepEqual(await snapshotDirectoryTopLevel(cwd), cwdBefore);
  assert.deepEqual(await snapshotTree(tempDir), tempBefore);
  assert.equal(cli.convertLogObservationsToDataset, undefined);
  assert.equal(cli.buildMechanicalFamilyAssignments, undefined);
  assert.equal(typeof training.convertLogObservationsToDataset, "function");
  assert.equal(typeof training.buildMechanicalFamilyAssignments, "function");
});

test("2 neutral constants are one source and the confirmation mask only zeros input", async () => {
  const contract = await import(pathToFileURL(contractModulePath).href);
  const runner = await import(pathToFileURL(runnerModulePath).href);
  const { convertLogObservationsToDataset } = await trainingApi();

  assert.equal(runner.VALUE_FLOW_FEATURE_NAMES, contract.VALUE_FLOW_FEATURE_NAMES);
  assert.equal(runner.VALUE_FLOW_LABELS, contract.VALUE_FLOW_LABELS);
  assert.deepEqual(contract.VALUE_FLOW_FEATURE_NAMES, VALUE_FLOW_FEATURE_NAMES);
  assert.equal(contract.VALUE_FLOW_FEATURE_NAMES.length, 15);
  assert.equal(contract.VALUE_FLOW_FEATURE_NAMES[14], "m03_mask_cross_file_module_binding_unverified");
  assert.deepEqual(contract.VALUE_FLOW_LABELS, VALUE_FLOW_LABELS);
  assert.equal(contract.VALUE_FLOW_HR_UNIT_ID, "cli.value-flow.candidate-relevance.v1");
  assert.equal(contract.VALUE_FLOW_FEATURE_SCHEMA, "cli.value-flow.candidate-features.v1");
  assert.deepEqual(contract.VALUE_FLOW_HR_ARCHITECTURE, [15, 16, 16, 3]);
  assert.equal(contract.VALUE_FLOW_HR_PARAMETER_COUNT, 579);

  const features = [...BASE_FEATURES];
  features[11] = 1;
  const mask = Array(15).fill(false);
  mask[11] = true;
  const result = convertLogObservationsToDataset({
    acceptedCases: [
      makeValidLearningCase({
        caseId: "MASK_CASE",
        runId: "run-mask",
        decisionEvent: {
          ...makeValidLearningCase().decisionEvent,
          preDecisionFeatures: features,
          inputMissingMask: mask,
          legalCandidates: ["refuted", "holds", "insufficient"],
        },
      }),
    ],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    baselineProfile: null,
  });

  assert.equal(result.train.length, 1);
  assert.equal(result.train[0].inputMissingMask[11], true);
  assert.equal(result.train[0].x[11], 0);
  assert.equal(result.train[0].supervisionMasked, false);
  assert.equal(result.train[0].goldLabel, "holds");
  assert.deepEqual(result.train[0].allowed, [VALUE_FLOW_LABELS.indexOf("holds")]);
});

test("3 each single missing required confirmation field is rejected", async () => {
  const { convertLogObservationsToDataset } = await trainingApi();
  const invalidCases = [
    makeValidLearningCase({
      caseId: "INVALID_AUTHORITY",
      runId: "run-invalid-authority",
      labelAuthority: "not-an-object",
    }),
    makeValidLearningCase({
      caseId: "INVALID_REVIEWER",
      runId: "run-invalid-reviewer",
      labelAuthority: {
        kind: "ast_posterior_verified",
        reviewer: "",
        confirmedAt: "2026-11-01T07:00:00Z",
        evidenceRefs: ["ref"],
      },
    }),
    makeValidLearningCase({
      caseId: "INVALID_TIMESTAMP",
      runId: "run-invalid-timestamp",
      labelAuthority: {
        kind: "ast_posterior_verified",
        reviewer: "Carol",
        confirmedAt: "not-a-date",
        evidenceRefs: ["ref"],
      },
    }),
    makeValidLearningCase({
      caseId: "INVALID_EVIDENCE",
      runId: "run-invalid-evidence",
      labelAuthority: {
        kind: "ast_posterior_verified",
        reviewer: "Carol",
        confirmedAt: "2026-11-01T07:00:00Z",
        evidenceRefs: [],
      },
    }),
    makeValidLearningCase({
      caseId: "INVALID_SOURCE_ORIGIN",
      runId: "run-invalid-origin",
      sourceOrigin: null,
    }),
    makeValidLearningCase({
      caseId: "INVALID_CALLSITE",
      runId: "run-invalid-callsite",
      callsiteKey: " ",
    }),
    makeValidLearningCase({
      caseId: "INVALID_FEATURE",
      runId: "run-invalid-feature",
      decisionEvent: {
        ...makeValidLearningCase().decisionEvent,
        preDecisionFeatures: [Number.NaN, ...BASE_FEATURES.slice(1)],
      },
    }),
    makeValidLearningCase({
      caseId: "INVALID_PARTITION",
      runId: "run-invalid-partition",
      assignedPartition: "staging",
    }),
    makeValidLearningCase({
      caseId: "INVALID_LABEL",
      runId: "run-invalid-label",
      posteriorFact: {
        expectedLabel: "DEFER",
        supervisionMasked: false,
        oracleKind: "ast_reaching_definition_oracle",
        verifiedSpanOrEdgeRef: "ref",
      },
    }),
  ];

  const result = convertLogObservationsToDataset({
    acceptedCases: [
      makeValidLearningCase({ caseId: "VALID_CONTROL", runId: "run-valid-control" }),
      ...invalidCases,
    ],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    baselineProfile: null,
  });

  assert.equal(result.train.length, 1);
  assert.equal(result.excludedWithReasons.length, invalidCases.length);
  const reasonCodes = new Set(result.excludedWithReasons.map(item => item.reasonCode));
  assert.equal(reasonCodes.has("MISSING_OR_NON_OBJECT_LABEL_AUTHORITY"), true);
  assert.equal(reasonCodes.has("MISSING_LABEL_AUTHORITY_REVIEWER"), true);
  assert.equal(reasonCodes.has("MISSING_OR_INVALID_CONFIRMED_AT_TIMESTAMP"), true);
  assert.equal(reasonCodes.has("MISSING_OR_EMPTY_EVIDENCE_REFS"), true);
  assert.equal(reasonCodes.has("MISSING_SOURCE_ORIGIN_EVIDENCE_OBJECT"), true);
  assert.equal(reasonCodes.has("MISSING_OR_EMPTY_CALLSITE_KEY"), true);
  assert.equal(reasonCodes.has("NON_FINITE_OR_WRONG_DIM_PRE_DECISION_FEATURES"), true);
  assert.equal(reasonCodes.has("INVALID_OR_UNKNOWN_PARTITION:staging"), true);
  assert.equal(reasonCodes.has("INVALID_EXPECTED_LABEL_NOT_IN_3CLASS_CONTRACT:DEFER"), true);
});

test("4 large run streams through spool without retaining candidate bodies", async t => {
  const { spoolVerifiedUsageLogCandidates } = await cliApi();
  const logRoot = await makeTempDir(t, "nn-code-large-log-");
  const batchDir = await makeStagingPath(t, "nn-code-large-batch-");
  const runs = [
    { runId: "run-large", count: 2000 },
    { runId: "run-small-a", count: 7 },
    { runId: "run-small-b", count: 11 },
    { runId: "run-small-c", count: 13 },
  ];
  for (const run of runs) {
    await writeUsageRun(logRoot, run.runId, run.count, {
      kindCycle: ["decision", "relation_unknown"],
      payload: index => ({
        padding: "x".repeat(run.runId === "run-large" ? 64 : 8),
        eventIndex: index,
      }),
    });
  }

  const committed = [];
  const diagnostics = [];
  const receipt = await spoolVerifiedUsageLogCandidates({
    logRoot,
    batchStagingDir: batchDir,
    protectedRoots: [],
    onDiagnostic: async item => {
      diagnostics.push(item);
    },
    onRunCommitted: async info => {
      await delay(5);
      const lines = await readJsonlFile(info.committedFilePath);
      committed.push({ info, lines });
    },
  });

  assert.equal(receipt.status, "completed");
  assert.equal(receipt.reason, null);
  assert.equal(receipt.committedRunCount, runs.length);
  assert.equal(receipt.committedCandidateCount, runs.reduce((sum, run) => sum + run.count, 0));
  assert.equal(receipt.committedRunFiles.length, runs.length);
  assert.equal(receipt.rolledBackRunCount, 0);
  assert.equal(diagnostics.filter(item => item.status === "verified_complete").length, runs.length);
  assert.equal(committed.length, runs.length);
  for (const entry of committed) {
    assert.equal(entry.lines.length, entry.info.candidateCount);
    assert.equal(entry.lines.every(line => line.type === "candidate"), true);
    assert.equal(entry.lines.every(line => line.logRoot === logRoot), true);
    assert.equal(entry.lines.every(line => line.runId === entry.info.runId), true);
  }

  const summaryKeys = Object.keys(receipt.summary).sort();
  assert.deepEqual(summaryKeys, [
    "corruptedFileCount",
    "corruptedLogEntryCount",
    "logRoot",
    "modifiedDuringPass2RunCount",
    "rotatedBeforePass2RunCount",
    "totalDecisionEventsObserved",
    "totalNonNullModelRefObserved",
    "totalRelationUnknownEventsObserved",
    "v1LegacyRunsCount",
    "v2ActiveIncompleteCount",
    "v2CompleteRuns",
    "v2IncompleteMissingFinishCount",
    "v2IncompleteMissingStartCount",
  ]);
  assert.equal(receipt.summary.logRoot, logRoot);
  for (const [key, value] of Object.entries(receipt.summary)) {
    if (key !== "logRoot") assert.equal(typeof value, "number");
  }
  assert.equal(receipt.summary.v2CompleteRuns, runs.length);
  assert.equal(receipt.summary.totalDecisionEventsObserved + receipt.summary.totalRelationUnknownEventsObserved,
    receipt.committedCandidateCount);

  const largePath = join(batchDir, "unconfirmed-candidates-run-large.jsonl");
  const largeLines = await readJsonlFile(largePath);
  assert.equal(largeLines.length, 2000);
  assert.deepEqual(
    largeLines.map(line => line.seq),
    Array.from({ length: 2000 }, (_, index) => index + 1),
  );
  const batchEntries = await readdir(batchDir);
  assert.equal(batchEntries.some(name => name.startsWith(".spool-")), false);
});

test("5 exclusive staging, concurrent ownership, no overwrite, and exact rollback", async t => {
  const { spoolVerifiedUsageLogCandidates } = await cliApi();
  const logRoot = await makeTempDir(t, "nn-code-exclusive-log-");
  await writeUsageRun(logRoot, "run-active", 5);

  const existingBatchDir = await makeStagingPath(t, "nn-code-existing-batch-");
  await mkdir(existingBatchDir);
  await writeFile(join(existingBatchDir, ".spool-runActive.jsonl"), "active\n");
  await writeFile(join(existingBatchDir, "unconfirmed-candidates-run0.jsonl"), "committed\n");
  const activePath = join(existingBatchDir, ".spool-runActive.jsonl");
  const committedPath = join(existingBatchDir, "unconfirmed-candidates-run0.jsonl");
  const activeBefore = await pathStatAndBytes(activePath);
  const committedBefore = await pathStatAndBytes(committedPath);

  const occupied = await spoolVerifiedUsageLogCandidates({
    logRoot,
    batchStagingDir: existingBatchDir,
    protectedRoots: [],
  });
  assert.equal(occupied.status, "staging_batch_dir_occupied");
  assert.equal(occupied.reason, "STAGING_BATCH_DIR_ALREADY_EXISTS");
  assert.equal(occupied.summary, null);
  assert.deepEqual((await pathStatAndBytes(activePath)).bytes, activeBefore.bytes);
  assert.equal((await pathStatAndBytes(activePath)).stat.mtimeMs, activeBefore.stat.mtimeMs);
  assert.deepEqual((await pathStatAndBytes(committedPath)).bytes, committedBefore.bytes);
  assert.equal((await pathStatAndBytes(committedPath)).stat.mtimeMs, committedBefore.stat.mtimeMs);

  const concurrentBatchDir = await makeStagingPath(t, "nn-code-concurrent-batch-");
  const [left, right] = await Promise.all([
    spoolVerifiedUsageLogCandidates({ logRoot, batchStagingDir: concurrentBatchDir, protectedRoots: [] }),
    spoolVerifiedUsageLogCandidates({ logRoot, batchStagingDir: concurrentBatchDir, protectedRoots: [] }),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.deepEqual(statuses, ["completed", "staging_batch_dir_occupied"]);
  const winner = left.status === "completed" ? left : right;
  assert.equal(winner.committedRunCount, 1);
  const concurrentLines = await readJsonlFile(join(concurrentBatchDir, "unconfirmed-candidates-run-active.jsonl"));
  assert.equal(concurrentLines.length, 5);
  assert.equal((await readdir(concurrentBatchDir)).some(name => name.startsWith(".spool-")), false);

  const logRootOther = await makeTempDir(t, "nn-code-other-log-");
  await writeUsageRun(logRootOther, "run-shared", 3, {
    payload: () => ({ sourceMarker: "other-root" }),
  });
  const sharedBatchOne = await makeStagingPath(t, "nn-code-shared-batch-one-");
  const sharedBatchTwo = await makeStagingPath(t, "nn-code-shared-batch-two-");
  await spoolVerifiedUsageLogCandidates({ logRoot, batchStagingDir: sharedBatchOne, protectedRoots: [] });
  const batchOneFile = join(sharedBatchOne, "unconfirmed-candidates-run-active.jsonl");
  const batchOneBefore = await pathStatAndBytes(batchOneFile);
  await spoolVerifiedUsageLogCandidates({
    logRoot: logRootOther,
    batchStagingDir: sharedBatchTwo,
    protectedRoots: [],
  });
  assert.deepEqual((await pathStatAndBytes(batchOneFile)).bytes, batchOneBefore.bytes);
  const otherLines = await readJsonlFile(join(sharedBatchTwo, "unconfirmed-candidates-run-shared.jsonl"));
  assert.equal(otherLines.length, 3);
  assert.equal(otherLines.every(line => line.logRoot === logRootOther), true);
  assert.equal(otherLines.every(line => line.body.sourceMarker === "other-root"), true);

  const rollbackRoot = await makeTempDir(t, "nn-code-rollback-log-");
  await writeUsageRun(rollbackRoot, "run1", 12);
  const run2Path = await writeUsageRun(rollbackRoot, "run2", 2000, {
    payload: index => ({ padding: "y".repeat(512), eventIndex: index }),
  });
  const rollbackBatchDir = await makeStagingPath(t, "nn-code-rollback-batch-");
  let mutated = false;
  const mutationSeen = (async () => {
    const deadline = Date.now() + 8000;
    while (!mutated && Date.now() < deadline) {
      try {
        const info = await lstat(join(rollbackBatchDir, ".spool-run2.jsonl"));
        if (info.size >= 400 * 512) {
          mutated = true;
          await appendFile(run2Path, "{\"mutated\":true}\n");
          return;
        }
      } catch {
        // The spool creates the temp file only after the batch dir is owned.
      }
      await delay(2);
    }
    throw new Error("run2 was not modified during pass 2");
  })();
  const spoolPromise = spoolVerifiedUsageLogCandidates({
    logRoot: rollbackRoot,
    batchStagingDir: rollbackBatchDir,
    protectedRoots: [],
  });
  await mutationSeen;
  const rollbackReceipt = await spoolPromise;
  assert.equal(rollbackReceipt.status, "completed");
  assert.equal(rollbackReceipt.committedRunCount, 1);
  assert.equal(rollbackReceipt.rolledBackRunCount, 1);
  assert.deepEqual(rollbackReceipt.committedRunFiles, [
    join(rollbackBatchDir, "unconfirmed-candidates-run1.jsonl"),
  ]);
  const rollbackEntries = await readdir(rollbackBatchDir);
  assert.deepEqual(rollbackEntries.sort(), ["unconfirmed-candidates-run1.jsonl"]);
  assert.equal((await readJsonlFile(join(rollbackBatchDir, "unconfirmed-candidates-run1.jsonl"))).length, 12);

  const callbackFailureRoot = await makeTempDir(t, "nn-code-callback-failure-log-");
  await writeUsageRun(callbackFailureRoot, "run3", 9);
  const callbackFailureBatchDir = await makeStagingPath(t, "nn-code-callback-failure-batch-");
  await assert.rejects(
    () => spoolVerifiedUsageLogCandidates({
      logRoot: callbackFailureRoot,
      batchStagingDir: callbackFailureBatchDir,
      protectedRoots: [],
      onDiagnostic: item => {
        if (item.status === "verified_complete") throw new Error("consumer interrupted");
      },
    }),
    /consumer interrupted/,
  );
  assert.deepEqual(await readdir(callbackFailureBatchDir), []);
  assert.deepEqual((await pathStatAndBytes(activePath)).bytes, activeBefore.bytes);
  assert.equal((await pathStatAndBytes(activePath)).stat.mtimeMs, activeBefore.stat.mtimeMs);
});

test("6 unconfirmed spool output stays pending until independent confirmation", async t => {
  const { spoolVerifiedUsageLogCandidates } = await cliApi();
  const { convertLogObservationsToDataset } = await trainingApi();
  const logRoot = await makeTempDir(t, "nn-code-confirm-log-");
  const batchDir = await makeStagingPath(t, "nn-code-confirm-batch-");
  await writeUsageRun(logRoot, "run-confirm", 1, {
    payload: () => ({
      callsiteKey: "src/confirm.ts:20:3",
      candidateKey: "src/confirm-target.ts#target@param0",
      syntaxPatternKey: "confirm_pattern",
    }),
  });
  const receipt = await spoolVerifiedUsageLogCandidates({
    logRoot,
    batchStagingDir: batchDir,
    protectedRoots: [],
  });
  assert.equal(receipt.status, "completed");
  const [rawItem] = await readJsonlFile(join(batchDir, "unconfirmed-candidates-run-confirm.jsonl"));
  const rawDecision = rawItem.body;

  const pendingCase = {
    ...rawDecision,
    logRoot: rawItem.logRoot,
    runId: rawItem.runId,
    seq: rawItem.seq,
    runState: "complete",
    reviewState: "unreviewed",
    missingReasonCode: "UNREVIEWED_RAW_OBSERVATION",
  };
  const pendingResult = convertLogObservationsToDataset({
    acceptedCases: [pendingCase],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    baselineProfile: null,
  });
  assert.equal(pendingResult.train.length, 0);
  assert.equal(pendingResult.dev.length, 0);
  assert.equal(pendingResult.pendingReview.length, 1);
  assert.equal(pendingResult.pendingReview[0].reasonCode, "UNREVIEWED_RAW_OBSERVATION");

  const confirmedCase = makeValidLearningCase({
    caseId: "CONFIRMED_FROM_SPOOL",
    runId: rawItem.runId,
    seq: rawItem.seq,
    logRoot: rawItem.logRoot,
    callsiteKey: rawDecision.callsiteKey,
    candidateKey: rawDecision.candidateKey,
    syntaxPatternKey: rawDecision.syntaxPatternKey,
    decisionEvent: {
      unitId: rawDecision.unitId,
      profileRef: rawDecision.profileRef,
      featureSchema: rawDecision.featureSchema,
      preDecisionFeatures: rawDecision.preDecisionFeatures,
      inputMissingMask: rawDecision.inputMissingMask,
      legalCandidates: rawDecision.legalCandidates,
      originalChoice: rawDecision.originalChoice,
    },
  });
  const confirmedResult = convertLogObservationsToDataset({
    acceptedCases: [confirmedCase],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    baselineProfile: null,
  });
  assert.equal(confirmedResult.train.length, 1);
  assert.equal(confirmedResult.dev.length, 0);
  assert.equal(confirmedResult.pendingReview.length, 0);
});

test("7 no partition is defaulted to train and connected partition conflicts stay not ready", async () => {
  const { convertLogObservationsToDataset } = await trainingApi();

  const unassignedResult = convertLogObservationsToDataset({
    acceptedCases: [
      makeValidLearningCase({
        caseId: "UNASSIGNED",
        runId: "run-unassigned",
        familyId: "NEW_UNASSIGNED_FAMILY",
        assignedPartition: undefined,
      }),
    ],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: EMPTY_EXISTING_PARTITIONS,
    confirmedFamilyAssignments: [],
    baselineProfile: null,
  });
  assert.equal(unassignedResult.converterReadiness, "NOT_READY");
  assert.equal(unassignedResult.train.length, 0);
  assert.equal(unassignedResult.dev.length, 0);

  const bareFamilyResult = convertLogObservationsToDataset({
    acceptedCases: [
      makeValidLearningCase({
        caseId: "BARE_FAMILY",
        runId: "run-bare-family",
        familyId: "CALLER_FAMILY_WITHOUT_RECEIPT",
        assignedPartition: "train",
      }),
    ],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: EMPTY_EXISTING_PARTITIONS,
    confirmedFamilyAssignments: [],
    baselineProfile: null,
  });
  assert.equal(bareFamilyResult.converterReadiness, "NOT_READY");
  assert.equal(bareFamilyResult.train.length, 0);

  const confirmedAssignments = [
    {
      familyId: "CONFIRMED_TRAIN",
      repoOrTemplateOrigins: ["repo:github.com/example/shared-source"],
      partition: "train",
      independentSourceEvidence: "train-evidence",
      confirmedBy: "Carol",
      confirmedAt: "2026-11-01T07:35:00Z",
    },
    {
      familyId: "CONFIRMED_DEV",
      repoOrTemplateOrigins: ["repo:github.com/example/shared-source"],
      partition: "dev",
      independentSourceEvidence: "dev-evidence",
      confirmedBy: "Carol",
      confirmedAt: "2026-11-01T07:35:00Z",
    },
  ];
  const trainCase = makeValidLearningCase({
    caseId: "SHARED_TRAIN",
    runId: "run-shared-train",
    familyId: "CONFIRMED_TRAIN",
    assignedPartition: undefined,
    sourceOrigin: {
      repoCanonicalId: "github.com/example/shared-source",
      repoEvidenceRef: "shared-source:train.ts",
      repoIndependenceConfirmed: true,
      renameRelationConfirmed: true,
      sourceConsistentAcrossRuns: true,
      provenIndependentFromUnresolvedGroups: true,
    },
  });
  const devCase = makeValidLearningCase({
    caseId: "SHARED_DEV",
    runId: "run-shared-dev",
    familyId: "CONFIRMED_DEV",
    assignedPartition: undefined,
    candidateKey: "shared-source:dev.ts#devCandidate",
    sourceOrigin: {
      repoCanonicalId: "github.com/example/shared-source",
      repoEvidenceRef: "shared-source:dev.ts",
      repoIndependenceConfirmed: true,
      renameRelationConfirmed: true,
      sourceConsistentAcrossRuns: true,
      provenIndependentFromUnresolvedGroups: true,
    },
  });
  const conflictForward = convertLogObservationsToDataset({
    acceptedCases: [trainCase, devCase],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: EMPTY_EXISTING_PARTITIONS,
    confirmedFamilyAssignments: confirmedAssignments,
    baselineProfile: null,
  });
  const conflictReverse = convertLogObservationsToDataset({
    acceptedCases: [devCase, trainCase],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: EMPTY_EXISTING_PARTITIONS,
    confirmedFamilyAssignments: [...confirmedAssignments].reverse(),
    baselineProfile: null,
  });
  assert.equal(conflictForward.converterReadiness, "NOT_READY");
  assert.equal(conflictForward.train.length, 0);
  assert.equal(conflictForward.dev.length, 0);
  assert.equal(conflictForward.familyAssignments[0].assignmentState, "conflicting");
  assert.equal(conflictForward.familyAssignments[0].holdReason, "CONNECTED_FAMILY_PARTITION_CONFLICT:dev_vs_train");
  assert.deepEqual(simplifyConversionResult(conflictForward), simplifyConversionResult(conflictReverse));
});

test("8 verification demotion only follows was-ever verification", async () => {
  const { convertLogObservationsToDataset } = await trainingApi();
  const trainOrigin = {
    repoCanonicalId: "github.com/example/train-repo",
    repoEvidenceRef: "train-repo:src/train.ts",
    repoIndependenceConfirmed: true,
    renameRelationConfirmed: true,
    sourceConsistentAcrossRuns: true,
    provenIndependentFromUnresolvedGroups: true,
  };
  const verificationOrigin = {
    repoCanonicalId: "github.com/example/verification-repo",
    repoEvidenceRef: "verification-repo:src/verify.ts",
    repoIndependenceConfirmed: true,
    renameRelationConfirmed: true,
    sourceConsistentAcrossRuns: true,
    provenIndependentFromUnresolvedGroups: true,
  };
  const result = convertLogObservationsToDataset({
    acceptedCases: [
      makeValidLearningCase({
        caseId: "TRAIN_LEARNING",
        runId: "run-train-learning",
        familyId: "VF_TR_1",
        assignedPartition: "train",
        sourceOrigin: trainOrigin,
        usedForFixOrDesign: true,
      }),
      {
        caseId: "TRAIN_PARSER_GAP",
        runId: "run-train-parser-gap",
        seq: 2,
        runState: "complete",
        familyId: "VF_TR_1",
        sourceOrigin: trainOrigin,
        usedForFixOrDesign: true,
        reviewState: "confirmed_parser_gap",
        confirmationSource: "ast_posterior_verified",
      },
      makeValidLearningCase({
        caseId: "VERIFICATION_DEMOTED",
        runId: "run-verification-demoted",
        familyId: "VF_VER_1",
        assignedPartition: "verification",
        sourceOrigin: verificationOrigin,
        usedForFixOrDesign: true,
      }),
    ],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    baselineProfile: null,
  });

  assert.equal(result.train.length, 1);
  assert.equal(result.train[0].id, "TRAIN_LEARNING");
  assert.equal(result.verificationRefs.length, 0);
  assert.equal(result.engineeringRegressionRefs.length, 2);
  assert.equal(result.trainerPayload.verificationContentIncluded, false);
  assert.equal(
    result.engineeringRegressionRefs.some(item => item.caseId === "VERIFICATION_DEMOTED"),
    true,
  );
});

test("9 cross-batch association and permanent conflict history are order invariant", async () => {
  const { convertLogObservationsToDataset } = await trainingApi();
  const sourceA = {
    repoCanonicalId: "github.com/example/repo-a",
    repoEvidenceRef: "repo-a:src/a.ts",
    repoIndependenceConfirmed: true,
    renameRelationConfirmed: true,
    sourceConsistentAcrossRuns: true,
    provenIndependentFromUnresolvedGroups: true,
  };
  const sourceB = {
    repoCanonicalId: "github.com/example/repo-b",
    repoEvidenceRef: "repo-b:src/b.ts",
    repoIndependenceConfirmed: true,
    renameRelationConfirmed: true,
    sourceConsistentAcrossRuns: true,
    provenIndependentFromUnresolvedGroups: true,
  };
  const caseA = makeValidLearningCase({
    caseId: "BATCH1_CASE_A",
    runId: "run-b1-a",
    seq: 1,
    familyId: "VF_TR_1",
    sourceOrigin: sourceA,
    callsiteKey: "src/a.ts:10:5",
    candidateKey: "src/a-target.ts#target@param0",
  });
  const caseB = makeValidLearningCase({
    caseId: "BATCH1_CASE_B",
    runId: "run-b1-b",
    seq: 2,
    familyId: "VF_TR_2",
    sourceOrigin: sourceB,
    callsiteKey: "src/b.ts:11:5",
    candidateKey: "src/b-target.ts#target@param0",
  });
  const batch1 = convertLogObservationsToDataset({
    batchId: "batch-1",
    acceptedCases: [caseA, caseB],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    baselineProfile: null,
  });
  assert.equal(batch1.train.length, 2);

  const sameCaseRerun = makeValidLearningCase({
    caseId: "BATCH2_SAME_CASE_A",
    runId: "run-b2-a-rerun",
    seq: 9,
    familyId: "VF_TR_1",
    sourceOrigin: sourceA,
    callsiteKey: caseA.callsiteKey,
    candidateKey: caseA.candidateKey,
  });
  const batch2Same = convertLogObservationsToDataset({
    batchId: "batch-2a",
    acceptedCases: [caseA, sameCaseRerun],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    existingCaseAssociations: batch1.caseAssociations,
    baselineProfile: null,
  });
  assert.equal(batch2Same.auditSummary.crossBatchIdempotentSkippedCount, 1);
  assert.equal(batch2Same.auditSummary.crossBatchMergedObservationCount, 1);
  assert.equal(batch2Same.train.length, 0);
  assert.equal(batch2Same.updatedExistingCaseAssociations[0].caseId, "BATCH1_CASE_A");
  assert.equal(batch2Same.updatedExistingCaseAssociations[0].occurrenceCount, 2);

  const oppositeB = makeValidLearningCase({
    caseId: "BATCH2_OPPOSITE_LABEL_B",
    runId: "run-b2-b-opposite",
    seq: 4,
    familyId: "VF_TR_2",
    sourceOrigin: sourceB,
    callsiteKey: caseB.callsiteKey,
    candidateKey: caseB.candidateKey,
    posteriorFact: {
      expectedLabel: "refuted",
      supervisionMasked: false,
      oracleKind: "ast_reaching_definition_oracle",
      verifiedSpanOrEdgeRef: "opposite-ref",
    },
  });
  const batch2Opposite = convertLogObservationsToDataset({
    batchId: "batch-2b",
    acceptedCases: [oppositeB],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    existingCaseAssociations: batch1.caseAssociations,
    baselineProfile: null,
  });
  assert.equal(batch2Opposite.converterReadiness, "NOT_READY");
  assert.equal(batch2Opposite.train.length, 0);
  assert.deepEqual(batch2Opposite.conflictedHistoricalCaseIds, ["BATCH1_CASE_B"]);
  assert.equal(batch2Opposite.caseAssociations.length, 2);
  assert.equal(batch2Opposite.caseAssociations.every(item => item.associationState === "conflict"), true);

  const missingSnapshotResult = convertLogObservationsToDataset({
    batchId: "batch-2c",
    acceptedCases: [sameCaseRerun],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    existingCaseAssociations: [
      {
        caseId: "HISTORICAL_WITHOUT_SNAPSHOT",
        callsiteKey: caseA.callsiteKey,
        observationRefs: ["default_log_root#run-old#1"],
        associationState: "same_case",
        sourceFamilyRef: "VF_TR_1",
      },
    ],
    baselineProfile: null,
  });
  assert.equal(missingSnapshotResult.train.length, 0);
  assert.equal(missingSnapshotResult.caseAssociations[0].associationState, "unresolved");
  assert.equal(missingSnapshotResult.excludedWithReasons[0].reasonCode, "MISSING_HISTORICAL_CASE_COMPARISON_SNAPSHOT");

  const batch3Holds = makeValidLearningCase({
    caseId: "BATCH3_REPEAT_HOLDS_B",
    runId: "run-b3-b-holds",
    seq: 7,
    familyId: "VF_TR_2",
    sourceOrigin: sourceB,
    callsiteKey: caseB.callsiteKey,
    candidateKey: caseB.candidateKey,
  });
  const batch3Refuted = makeValidLearningCase({
    caseId: "BATCH3_REPEAT_REFUTED_B",
    runId: "run-b3-b-refuted",
    seq: 8,
    familyId: "VF_TR_2",
    sourceOrigin: sourceB,
    callsiteKey: caseB.callsiteKey,
    candidateKey: caseB.candidateKey,
    posteriorFact: {
      expectedLabel: "refuted",
      supervisionMasked: false,
      oracleKind: "ast_reaching_definition_oracle",
      verifiedSpanOrEdgeRef: "repeat-refuted",
    },
  });
  const historyForward = batch2Opposite.caseAssociations;
  const historyReverse = [...historyForward].reverse();
  const variants = [
    convertLogObservationsToDataset({
      batchId: "batch-3-holds-fwd",
      acceptedCases: [batch3Holds],
      targetUnitContract: TARGET_UNIT_CONTRACT,
      existingPartitions: DEFAULT_EXISTING_PARTITIONS,
      existingCaseAssociations: historyForward,
      baselineProfile: null,
    }),
    convertLogObservationsToDataset({
      batchId: "batch-3-holds-rev",
      acceptedCases: [batch3Holds],
      targetUnitContract: TARGET_UNIT_CONTRACT,
      existingPartitions: DEFAULT_EXISTING_PARTITIONS,
      existingCaseAssociations: historyReverse,
      baselineProfile: null,
    }),
    convertLogObservationsToDataset({
      batchId: "batch-3-refuted-fwd",
      acceptedCases: [batch3Refuted],
      targetUnitContract: TARGET_UNIT_CONTRACT,
      existingPartitions: DEFAULT_EXISTING_PARTITIONS,
      existingCaseAssociations: historyForward,
      baselineProfile: null,
    }),
    convertLogObservationsToDataset({
      batchId: "batch-3-refuted-rev",
      acceptedCases: [batch3Refuted],
      targetUnitContract: TARGET_UNIT_CONTRACT,
      existingPartitions: DEFAULT_EXISTING_PARTITIONS,
      existingCaseAssociations: historyReverse,
      baselineProfile: null,
    }),
  ];
  for (const variant of variants) {
    assert.equal(variant.converterReadiness, "NOT_READY");
    assert.equal(variant.train.length, 0);
    assert.equal(variant.dev.length, 0);
    assert.deepEqual(variant.conflictedHistoricalCaseIds, ["BATCH1_CASE_B", "BATCH2_OPPOSITE_LABEL_B"]);
    assert.equal(variant.caseAssociations.length, 3);
    assert.equal(variant.caseAssociations.every(item => item.associationState === "conflict"), true);
  }
  assert.deepEqual(variants[0].caseAssociations, variants[1].caseAssociations);
  assert.deepEqual(variants[2].caseAssociations, variants[3].caseAssociations);
});

test("10 decision preparation preserves explicit mask and no-log stays disabled", async t => {
  const { disabledUsageLog, projectValueFlowDecisionUsageEvent } = await cliApi();
  const baseInput = {
    requestId: "request-1",
    callsiteKey: "src/decision.ts:5:3",
    candidateKey: "src/target.ts#target@param0",
    syntaxPatternKey: "decision_pattern",
    requestScopeKey: "scope-1",
    profileRef: "cli-value-flow-test-profile",
    modelRef: "cli-value-flow-test-model",
    preDecisionFeatures: [...BASE_FEATURES],
    inputMissingMask: [true, false, false, false, true, false, false, false, false, false, false, false, false, false, false],
    legalCandidates: [...VALUE_FLOW_LABELS],
    originalChoice: "insufficient",
    scoresByLabel: {
      holds: 0.2,
      insufficient: 0.6,
      refuted: 0.2,
    },
  };

  await assert.rejects(
    async () => projectValueFlowDecisionUsageEvent({
      ...baseInput,
      legalCandidates: undefined,
    }),
    TypeError,
  );
  await assert.rejects(
    async () => projectValueFlowDecisionUsageEvent({
      ...baseInput,
      inputMissingMask: undefined,
    }),
    TypeError,
  );
  await assert.rejects(
    async () => projectValueFlowDecisionUsageEvent({
      ...baseInput,
      legalCandidates: ["holds", "refuted"],
    }),
    TypeError,
  );
  await assert.rejects(
    async () => projectValueFlowDecisionUsageEvent({
      ...baseInput,
      legalCandidates: ["holds", "holds", "insufficient", "refuted"],
    }),
    TypeError,
  );

  const event = projectValueFlowDecisionUsageEvent({
    ...baseInput,
    legalCandidates: ["refuted", "holds", "insufficient"],
  });
  assert.equal(event.kind, "decision");
  assert.deepEqual(event.body.inputMissingMask, baseInput.inputMissingMask);
  assert.equal(event.body.inputMissingMask[14], false);
  assert.equal(event.body.decisionRuntimeCollectionIntegrated, false);
  assert.deepEqual(event.body.legalCandidates, ["refuted", "holds", "insufficient"]);
  assert.equal(event.body.originalChoice, "insufficient");

  const noLogDir = join(await makeTempDir(t, "nn-code-no-log-parent-"), "disabled-log-root");
  const disabled = disabledUsageLog();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.runLogPath, null);
  await assert.rejects(() => lstat(noLogDir), /ENOENT/);
});

test("11 unknown event kind is rejected consistently by pass 1 and pass 2", async t => {
  const { iterateVerifiedUsageLogRuns, iterateVerifiedUsageLogCandidates } = await cliApi();
  const logRoot = await makeTempDir(t, "nn-code-unknown-kind-");
  const runId = "run-unknown-kind";
  const path = join(logRoot, `${runId}.jsonl`);
  await writeFile(path, [
    JSON.stringify(eventBase(runId, 0, "start")),
    JSON.stringify(eventBase(runId, 1, "unknown")),
    JSON.stringify(eventBase(runId, 2, "finish")),
  ].join("\n") + "\n");

  const pass1 = await drainUsageLogGenerator(iterateVerifiedUsageLogRuns({ logRoot }));
  assert.equal(pass1.items.length, 1);
  assert.equal(pass1.items[0].status, "corrupted_v2");
  assert.equal(pass1.items.some(item => item.status === "verified_complete"), false);
  assert.equal(pass1.summary.v2CompleteRuns, 0);
  assert.equal(pass1.summary.corruptedFileCount, 1);

  const pass2 = await drainUsageLogGenerator(iterateVerifiedUsageLogCandidates({ logRoot }));
  assert.equal(pass2.items.length, 1);
  assert.equal(pass2.items[0].status, "corrupted_v2");
  assert.equal(pass2.items.some(item => item.type === "candidate"), false);
  assert.equal(pass2.summary.v2CompleteRuns, 0);
  assert.equal(pass2.summary.corruptedFileCount, 1);
});

test("12 confirmed legal candidates must be the exact three-label set", async () => {
  const { convertLogObservationsToDataset } = await trainingApi();
  for (const legalCandidates of [["holds"], ["holds", "refuted"]]) {
    const result = convertLogObservationsToDataset({
      acceptedCases: [
        makeValidLearningCase({
          caseId: `SUBSET_${legalCandidates.join("_")}`,
          runId: `run-subset-${legalCandidates.join("-")}`,
          decisionEvent: {
            ...makeValidLearningCase().decisionEvent,
            legalCandidates,
            originalChoice: "holds",
          },
        }),
      ],
      targetUnitContract: TARGET_UNIT_CONTRACT,
      existingPartitions: DEFAULT_EXISTING_PARTITIONS,
      baselineProfile: null,
    });
    assert.equal(result.train.length, 0);
    assert.equal(result.dev.length, 0);
    assert.equal(result.excludedWithReasons.length, 1);
    assert.equal(result.excludedWithReasons[0].reasonCode, "INVALID_LEGAL_CANDIDATES");
  }

  const full = convertLogObservationsToDataset({
    acceptedCases: [
      makeValidLearningCase({
        caseId: "FULL_THREE_LABEL_SET",
        runId: "run-full-three-labels",
        decisionEvent: {
          ...makeValidLearningCase().decisionEvent,
          legalCandidates: ["refuted", "holds", "insufficient"],
          originalChoice: "insufficient",
        },
      }),
    ],
    targetUnitContract: TARGET_UNIT_CONTRACT,
    existingPartitions: DEFAULT_EXISTING_PARTITIONS,
    baselineProfile: null,
  });
  assert.equal(full.train.length, 1);
  assert.equal(full.dev.length, 0);
});

test("13 staging inside a protected root is rejected before directory creation", async t => {
  const { spoolVerifiedUsageLogCandidates } = await cliApi();
  const logRoot = await makeTempDir(t, "nn-code-protected-log-");
  await writeUsageRun(logRoot, "run-protected", 1);
  const protectedRoot = await makeTempDir(t, "nn-code-protected-tree-");

  const inside = join(protectedRoot, "staging");
  await assert.rejects(
    () => spoolVerifiedUsageLogCandidates({
      logRoot,
      batchStagingDir: inside,
      protectedRoots: [protectedRoot],
    }),
    error => {
      assert.equal(error.code, "STAGING_DIR_INSIDE_PROTECTED_TREE");
      return true;
    },
  );
  await assert.rejects(() => lstat(inside), /ENOENT/);

  const nested = join(protectedRoot, "nested", "staging");
  await assert.rejects(
    () => spoolVerifiedUsageLogCandidates({
      logRoot,
      batchStagingDir: nested,
      protectedRoots: [protectedRoot],
    }),
    error => {
      assert.equal(error.code, "STAGING_DIR_INSIDE_PROTECTED_TREE");
      return true;
    },
  );
  await assert.rejects(() => lstat(join(protectedRoot, "nested")), /ENOENT/);
  await assert.rejects(() => lstat(nested), /ENOENT/);

  await assert.rejects(
    () => spoolVerifiedUsageLogCandidates({
      logRoot,
      batchStagingDir: protectedRoot,
      protectedRoots: [protectedRoot],
    }),
    error => {
      assert.equal(error.code, "STAGING_DIR_INSIDE_PROTECTED_TREE");
      return true;
    },
  );
  assert.deepEqual(await readdir(protectedRoot), []);

  const siblingRoot = `${protectedRoot}-other`;
  await mkdir(siblingRoot);
  t.after(async () => {
    await rm(siblingRoot, { recursive: true, force: true });
  });
  const siblingBatch = join(siblingRoot, "batch");
  const receipt = await spoolVerifiedUsageLogCandidates({
    logRoot,
    batchStagingDir: siblingBatch,
    protectedRoots: [protectedRoot],
  });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.committedRunCount, 1);
  await assert.rejects(() => lstat(inside), /ENOENT/);
});

test("14 dotdot-prefixed sibling name inside a protected root is rejected before directory creation", async t => {
  const { spoolVerifiedUsageLogCandidates } = await cliApi();
  const logRoot = await makeTempDir(t, "nn-code-protected-log-");
  await writeUsageRun(logRoot, "run-protected", 1);
  const protectedRoot = await makeTempDir(t, "nn-code-protected-tree-");
  const dotDotChild = join(protectedRoot, "..cache");
  const batchStagingDir = join(dotDotChild, "batch");

  await assert.rejects(
    () => spoolVerifiedUsageLogCandidates({
      logRoot,
      batchStagingDir,
      protectedRoots: [protectedRoot],
    }),
    error => {
      assert.equal(error.code, "STAGING_DIR_INSIDE_PROTECTED_TREE");
      return true;
    },
  );
  await assert.rejects(() => lstat(dotDotChild), /ENOENT/);
  await assert.rejects(() => lstat(batchStagingDir), /ENOENT/);
});
