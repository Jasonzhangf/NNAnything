import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { prepareBasicKindSamples, partitionBasicKindSamples } from "nnanything/training";

const TASK_ID = "dom.basic-kinds.v1";
const INPUT_SCOPE = "candidate_qualified";
const FIXTURE_A_PREFIX = "fixture-a";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--request", "--a-capture", "--a-oracle", "--partition", "--out", "--usage-out"].includes(flag)) {
      throw new Error(`unknown argument ${flag}`);
    }
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate argument ${flag}`);
    values.set(flag, value);
  }
  for (const flag of ["--request", "--a-capture", "--a-oracle", "--partition", "--out", "--usage-out"]) {
    if (!values.has(flag)) throw new Error(`missing required ${flag}`);
  }
  return {
    request: resolve(values.get("--request")),
    aCapture: resolve(values.get("--a-capture")),
    aOracle: resolve(values.get("--a-oracle")),
    partition: resolve(values.get("--partition")),
    out: resolve(values.get("--out")),
    usageOut: resolve(values.get("--usage-out")),
  };
}

function readJson(file, label) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function oracleByKey(oracle) {
  const entries = Array.isArray(oracle) ? oracle : oracle.states;
  if (!Array.isArray(entries)) throw new Error("A oracle must be an array or carry a states array");
  const byKey = new Map();
  for (const entry of entries) {
    if (typeof entry?.construction !== "string" || typeof entry?.state !== "string") {
      throw new Error("A oracle entry is missing construction/state");
    }
    if (entry.expectedLabel !== "container" && entry.expectedLabel !== "ignore") {
      throw new Error(`A oracle has unexpected label ${entry.expectedLabel} for ${entry.construction}:${entry.state}`);
    }
    byKey.set(`${entry.construction}:${entry.state}`, entry);
  }
  return byKey;
}

function fixtureARow(state, oracleEntry, index, oraclePath) {
  if (!state.wrapperRow || typeof state.wrapperRow !== "object") {
    throw new Error(`A capture ${state.caseId} has no wrapperRow`);
  }
  const { nodeRef, ...properties } = state.wrapperRow;
  if (typeof nodeRef !== "string" || nodeRef.length === 0) {
    throw new Error(`A capture ${state.caseId} wrapperRow has no nodeRef`);
  }
  const key = `${state.construction}:${state.state}`;
  const sampleId = `${FIXTURE_A_PREFIX}:${key}`;
  return {
    sampleId,
    inputRef: {
      snapshotRef: `${FIXTURE_A_PREFIX}/${state.caseId}`,
      documentRef: FIXTURE_A_PREFIX,
      frameRef: "top",
      nodeRef,
      index,
    },
    provenanceRef: `${sampleId}:evidence`,
    sourceAssociations: {
      snapshotRefs: [`${FIXTURE_A_PREFIX}/${state.caseId}`],
      postRefs: [],
      assetRefs: [FIXTURE_A_PREFIX],
    },
    candidateQualification: { status: "ok", reasons: [] },
    captureCoverage: { frameContent: "captured", directChildren: "complete" },
    properties,
    proposal: { ruleRef: null, label: null, status: "unknown" },
    review: {
      status: "verified",
      expectedLabel: oracleEntry.expectedLabel,
      reviewerRef: "b1-a-family-oracle",
      evidenceRef: `${oraclePath}#${state.caseId}`,
      otherReason: null,
    },
  };
}

function cloneRow(row, index) {
  return { ...row, inputRef: { ...row.inputRef, index } };
}

function bSampleIds(bPath) {
  const oracle = readJson(bPath, "B oracle");
  const entries = Array.isArray(oracle) ? oracle : oracle.states;
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => `${entry.construction}:${entry.state}`).map(key => `fixture-b:${key}`);
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const request = readJson(args.request, "source request");
  if (!Array.isArray(request.rows)) throw new Error("source request.rows must be an array");
  const partition = readJson(args.partition, "partition");
  const capture = readJson(args.aCapture, "A capture");
  const oracle = readJson(args.aOracle, "A oracle");
  if (!Array.isArray(capture.states)) throw new Error("A capture.states must be an array");

  const oracleMap = oracleByKey(oracle);
  const rows = request.rows.map((row, index) => cloneRow(row, index));
  const aRows = capture.states.map((state, offset) => {
    const key = `${state.construction}:${state.state}`;
    const oracleEntry = oracleMap.get(key);
    if (!oracleEntry) throw new Error(`A oracle has no entry for ${key}`);
    return fixtureARow(state, oracleEntry, rows.length + offset, args.aOracle);
  });
  const prepared = {
    schemaVersion: 1,
    taskId: TASK_ID,
    rows: [...rows, ...aRows],
  };

  if (partition.explicitUsage.length !== rows.length) {
    throw new Error(`partition explicitUsage has ${partition.explicitUsage.length} entries, expected ${rows.length}`);
  }
  const explicitUsage = [
    ...partition.explicitUsage.map(entry => ({ sampleId: entry.sampleId, usage: entry.usage })),
    ...aRows.map(row => ({ sampleId: row.sampleId, usage: "train" })),
  ];

  const preparedResult = prepareBasicKindSamples(prepared, { taskId: TASK_ID, inputScope: INPUT_SCOPE });
  const included = preparedResult.rows.filter(row => row.included);
  if (included.length !== prepared.rows.length) {
    const excluded = preparedResult.rows.filter(row => !row.included).map(row => row.sampleId);
    throw new Error(`prepare excluded rows: ${excluded.join(", ")}`);
  }
  const aIncluded = included.filter(row => row.index >= rows.length);
  if (aIncluded.length !== aRows.length) throw new Error("A rows were not all included by prepare");

  const partitionResult = partitionBasicKindSamples(preparedResult, {
    mode: "source_group_holdout",
    seed: 20261021,
    evalFraction: 0.3,
    allowInSampleEval: false,
    explicitUsage,
  });
  if (!partitionResult.ok) {
    throw new Error(`partition rejected prepared request: ${partitionResult.reason} ${JSON.stringify(partitionResult.details)}`);
  }
  for (const cluster of partitionResult.partitions.sourceClusters) {
    const hasOld = cluster.rowIndices.some(index => index < rows.length);
    const hasA = cluster.rowIndices.some(index => index >= rows.length);
    if (hasOld && hasA) throw new Error(`A rows cross an old source closure in ${cluster.clusterId}`);
  }

  const bOraclePath = resolve(args.aOracle, "..", "..", "b", "oracle-b.json");
  const bIds = bSampleIds(bOraclePath);
  const preparedIds = new Set(prepared.rows.map(row => row.sampleId));
  const bIntersection = bIds.filter(id => preparedIds.has(id));
  if (bIntersection.length > 0) throw new Error(`B sampleIds appear in prepared request: ${bIntersection.join(", ")}`);

  const usageTrain = explicitUsage.filter(entry => entry.usage === "train").length;
  const usageEval = explicitUsage.filter(entry => entry.usage === "eval").length;
  writeJson(args.out, prepared);
  writeJson(args.usageOut, explicitUsage);
  console.log(JSON.stringify({
    rows: prepared.rows.length,
    included: included.length,
    aRows: aRows.length,
    usageTrain,
    usageEval,
    bIntersection: bIntersection.length,
  }));
}

main();
