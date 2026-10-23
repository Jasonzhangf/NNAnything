// P5 projection audit. It derives every row with the public 81-wire extractor,
// keeps exact 0/1/continuous/null values (no rounding or hashing), and reports
// three distinct comparisons:
// - same projection with different gold inside old train + new train;
// - repeated projections between old train and old eval (historical note);
// - repeated projections between old data and new train/dev.
// Verification rows are rejected until the independent verifier evaluates them.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractBasicKindWires, BASIC_KIND_WIRE_NAMES } from "nnanything/browser";

const NEW_TRAIN = "new-train";
const NEW_DEV = "new-dev";
const VERIFICATION_PREFIX = "sample-repair-verification:";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--request", "--dev-request", "--usage", "--out", "--report"].includes(flag) || value === undefined || value.startsWith("--")) {
      throw new Error("expected --request <prepared.json> [--dev-request <dev.json>] --usage <usage.json> --out <projection.json> [--report <report.md>]");
    }
    if (values.has(flag)) throw new Error(`duplicate argument ${flag}`);
    values.set(flag, value);
  }
  for (const flag of ["--request", "--usage", "--out"]) {
    if (!values.has(flag)) throw new Error(`missing required ${flag}`);
  }
  return {
    requests: [
      resolve(values.get("--request")),
      ...(values.has("--dev-request") ? [resolve(values.get("--dev-request"))] : []),
    ],
    usage: resolve(values.get("--usage")),
    out: resolve(values.get("--out")),
    report: values.has("--report") ? resolve(values.get("--report")) : null,
  };
}

function readJson(file, label) {
  const raw = readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usageEntries(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.explicitUsage)) return raw.explicitUsage;
  const merged = [];
  for (const key of ["control", "treatment", "dev", "verification"]) {
    if (Array.isArray(raw?.[key])) merged.push(...raw[key]);
  }
  if (merged.length > 0) return merged;
  throw new Error("usage must be an array, carry explicitUsage, or contain control/treatment/dev/verification arrays");
}

function groupOf(row) {
  const id = row.sampleId;
  if (id.startsWith("sample-repair-train:")) return NEW_TRAIN;
  if (id.startsWith("sample-repair-dev:")) return NEW_DEV;
  if (id.startsWith(VERIFICATION_PREFIX)) return "new-verification";
  if (id.startsWith("fixture-a:")) return "old-fixture-a";
  if (id.startsWith("fixture-b:")) return "old-fixture-b";
  return "old";
}

function isOldGroup(group) {
  return group === "old" || group === "old-fixture-a" || group === "old-fixture-b";
}

function familyOf(row) {
  const group = groupOf(row);
  if (group === NEW_TRAIN || group === NEW_DEV) return group.replace("new-", "sample-repair-");
  return row.sourceAssociations?.assetRefs?.[0] ?? row.inputRef?.documentRef ?? null;
}

function sourceRefsOf(row) {
  const values = row.sourceAssociations?.snapshotRefs;
  if (Array.isArray(values) && values.length > 0) return [...values];
  return row.inputRef?.snapshotRef ? [row.inputRef.snapshotRef] : [];
}

function exactProjection(properties) {
  const wires = extractBasicKindWires(properties);
  const projection = {};
  for (const name of BASIC_KIND_WIRE_NAMES) {
    if (!Object.hasOwn(wires, name)) throw new Error(`missing wire ${name}`);
    const value = wires[name];
    if (value === undefined) throw new Error(`undefined wire ${name}`);
    if (value !== null && typeof value !== "number") throw new Error(`wire ${name} is not numeric/null`);
    projection[name] = value;
  }
  return projection;
}

function projectionKey(projection) {
  return JSON.stringify(BASIC_KIND_WIRE_NAMES.map(name => projection[name]));
}

function metadata(row) {
  return {
    projectionGroupId: row.projectionGroupId,
    rowGroupId: row.rowGroupId,
    sampleId: row.sampleId,
    family: row.family,
    objectId: row.objectId,
    state: row.state,
    usage: row.usage,
    gold: row.gold,
    evidenceRef: row.evidenceRef,
    sourceRefs: row.sourceRefs,
  };
}

function sourceReuse(rows) {
  const usageBySource = new Map();
  for (const row of rows) {
    for (const source of row.sourceRefs) {
      const usages = usageBySource.get(source) ?? new Set();
      usages.add(String(row.usage));
      usageBySource.set(source, usages);
    }
  }
  return [...usageBySource].filter(([, usages]) => usages.size > 1).map(([source]) => source);
}

function overlapGroup(group) {
  const oldRows = group.rows.filter(row => isOldGroup(row.group));
  const newRows = group.rows.filter(row => row.group === NEW_TRAIN || row.group === NEW_DEV);
  const oldTrain = oldRows.filter(row => row.usage === "train");
  const oldEval = oldRows.filter(row => row.usage === "eval");
  const judgments = [];
  if (oldRows.length > 0 && newRows.length > 0) {
    judgments.push("different_implementation_same_projection");
    if (sourceReuse([...oldRows, ...newRows]).length > 0) judgments.push("same_source_cross_usage");
  }
  if (oldTrain.length > 0 && oldEval.length > 0) judgments.push("old_train_eval_repeat");
  return {
    projectionGroupId: group.projectionGroupId,
    projectionKey: group.projectionKey,
    projection: group.projection,
    judgments,
    rows: group.rows.map(metadata),
  };
}

export function auditProjection(requests, usageRaw) {
  const requestList = Array.isArray(requests) ? requests : [requests];
  const usage = new Map(usageEntries(usageRaw).map(entry => [entry.sampleId, entry.usage]));
  const sourceRows = [];
  for (const [requestIndex, request] of requestList.entries()) {
    if (!Array.isArray(request?.rows)) throw new Error(`request[${requestIndex}].rows must be an array`);
    for (const [rowIndex, row] of request.rows.entries()) {
      if (row.sampleId?.startsWith(VERIFICATION_PREFIX)) {
        throw new Error(`verification row ${row.sampleId} must not be audited before unsealing`);
      }
      const group = groupOf(row);
      const projection = exactProjection(row.properties);
      sourceRows.push({
        rowGroupId: `request-${requestIndex + 1}-row-${rowIndex + 1}`,
        sampleId: row.sampleId,
        group,
        family: familyOf(row),
        objectId: row.inputRef?.nodeRef ?? null,
        state: row.inputRef?.snapshotRef ?? null,
        usage: usage.get(row.sampleId) ?? null,
        gold: row.review?.expectedLabel ?? null,
        evidenceRef: row.review?.evidenceRef ?? row.provenanceRef ?? null,
        sourceRefs: sourceRefsOf(row),
        projection,
        projectionKey: projectionKey(projection),
      });
    }
  }

  const byProjection = new Map();
  for (const row of sourceRows) {
    const rows = byProjection.get(row.projectionKey) ?? [];
    rows.push(row);
    byProjection.set(row.projectionKey, rows);
  }
  const projectionGroups = [];
  let projectionIndex = 0;
  for (const [key, rows] of byProjection) {
    projectionIndex += 1;
    const projectionGroupId = `projection-${String(projectionIndex).padStart(3, "0")}`;
    for (const row of rows) row.projectionGroupId = projectionGroupId;
    projectionGroups.push({
      projectionGroupId,
      projectionKey: key,
      projection: rows[0].projection,
      rows,
    });
  }

  const sameInputDifferentGold = [];
  const oldTrainEvalOverlaps = [];
  const crossUsageOverlaps = [];
  for (const group of projectionGroups) {
    const oldTrain = group.rows.filter(row => isOldGroup(row.group) && row.usage === "train");
    const newTrain = group.rows.filter(row => row.group === NEW_TRAIN);
    const trainRows = [...oldTrain, ...newTrain];
    // Check the complete train set: a same-projection different-gold conflict that
    // exists only inside the new train family is still a real conflict.
    if (trainRows.length > 1 && new Set(trainRows.map(row => String(row.gold))).size > 1) {
      sameInputDifferentGold.push({
        ...overlapGroup({ ...group, rows: trainRows }),
        judgment: "same_input_different_gold",
      });
    }
    const overlap = overlapGroup(group);
    if (overlap.judgments.includes("old_train_eval_repeat")) oldTrainEvalOverlaps.push(overlap);
    if (overlap.judgments.includes("different_implementation_same_projection")) crossUsageOverlaps.push(overlap);
  }

  const usageCounts = {};
  const projectionCountByUsage = {};
  for (const row of sourceRows) {
    usageCounts[row.group] = (usageCounts[row.group] ?? 0) + 1;
  }
  for (const group of projectionGroups) {
    const groups = new Set(group.rows.map(row => row.group));
    for (const name of groups) {
      projectionCountByUsage[name] = (projectionCountByUsage[name] ?? 0) + 1;
    }
  }
  return {
    wireNames: [...BASIC_KIND_WIRE_NAMES],
    dimension: BASIC_KIND_WIRE_NAMES.length,
    rows: sourceRows.length,
    usageCounts,
    uniqueProjections: byProjection.size,
    projectionCountByUsage,
    sameInputDifferentGold,
    oldTrainEvalOverlaps,
    crossUsageOverlaps,
    rowsByProjection: projectionGroups.map(group => ({
      projectionGroupId: group.projectionGroupId,
      projectionKey: group.projectionKey,
      projection: group.projection,
      rows: group.rows.map(metadata),
    })),
  };
}

function readableGroup(group) {
  return [
    `### ${group.projectionGroupId}`,
    `- judgments: ${group.judgments.join(", ")}`,
    `- projection: \`${JSON.stringify(group.projection)}\``,
    ...group.rows.map(row =>
      `- ${row.rowGroupId} ${row.sampleId} family=${row.family} object=${row.objectId} state=${row.state} usage=${row.usage} gold=${row.gold} evidence=${row.evidenceRef}`,
    ),
  ];
}

function writeReport(result, out) {
  const lines = [
    "# P5 projection audit",
    "",
    `- wire dimension: ${result.dimension} (ordered BASIC_KIND_WIRE_NAMES, exact values)`,
    `- rows: ${result.rows}`,
    `- usage counts: ${JSON.stringify(result.usageCounts)}`,
    `- unique projections: ${result.uniqueProjections}`,
    `- projection count by usage: ${JSON.stringify(result.projectionCountByUsage)}`,
    `- same-input-different-gold conflicts: ${result.sameInputDifferentGold.length}`,
    `- old train/eval repeats: ${result.oldTrainEvalOverlaps.length}`,
    `- old vs new train/dev overlaps: ${result.crossUsageOverlaps.length}`,
    "",
    "## Same-input-different-gold conflicts",
    ...(result.sameInputDifferentGold.length === 0
      ? ["None."]
      : result.sameInputDifferentGold.flatMap(readableGroup)),
    "",
    "## Old train/eval repeats",
    ...(result.oldTrainEvalOverlaps.length === 0
      ? ["None."]
      : result.oldTrainEvalOverlaps.flatMap(readableGroup)),
    "",
    "## Old vs new train/dev overlaps",
    ...(result.crossUsageOverlaps.length === 0
      ? ["None."]
      : result.crossUsageOverlaps.flatMap(readableGroup)),
    "",
    "Full ordered projections for every one of the 81 wires are in the JSON rowsByProjection.",
    "Verification family overlap is reported separately after unsealing by the independent verifier.",
    "",
  ];
  writeFileSync(out, `${lines.join("\n")}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const requests = args.requests.map(file => readJson(file, "prepared request"));
  const result = auditProjection(requests, readJson(args.usage, "usage"));
  writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  if (args.report !== null) writeReport(result, args.report);
  console.log(JSON.stringify({
    rows: result.rows,
    uniqueProjections: result.uniqueProjections,
    sameInputDifferentGold: result.sameInputDifferentGold.length,
    oldTrainEvalOverlaps: result.oldTrainEvalOverlaps.length,
    crossUsageOverlaps: result.crossUsageOverlaps.length,
  }));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) main();
