import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { NodeDefinition } from "../core/contracts.js";
import { expectFiniteNumber, expectNonEmptyString, expectRecord } from "../core/schema.js";
import { evaluateSemanticRules, onlyKeys, readMatchConfig } from "../filters/sample-match.js";
import { assembleSamples, LABEL_STATES, readAssembleConfig, readMatchedRecords, readRawRecords, readTaskDataset } from "../training/samples.js";
import type { LabelState, MatchedSlot } from "../training/samples.js";

const rawPort = { name: "raw_records", schemaId: "sample/raw-dom-records/v1", eventType: "sample.raw-records.v1", validate: readRawRecords };
const matchedPort = { name: "matched_records", schemaId: "sample/matched-records/v1", eventType: "sample.matched-records.v1", validate: readMatchedRecords };
const datasetPort = { name: "task_samples", schemaId: "sample/task-dataset/v1", eventType: "sample.task-dataset.v1", validate: readTaskDataset };

export const sampleMatchNode: NodeDefinition = {
  operator: "sample.match", version: "0.1.0", inputPorts: [rawPort], outputPort: matchedPort,
  config: { required: true, validate: readMatchConfig }, effects: [],
  execute(context) {
    const input = readRawRecords(context.inputs[0]!.payload), config = readMatchConfig(context.config);
    const results = evaluateSemanticRules(input.records, config);
    const slots: MatchedSlot[] = input.records.map((record, index) => ({
      index, nodeRef: record.nodeRef, inputRef: { snapshotRef: input.snapshotRef, nodeRef: record.nodeRef, index },
      provenanceRef: record.provenanceRef, sourceGroup: input.sourceGroup, ...results[index]!,
      ...(record.candidateStatus !== undefined ? { candidateStatus: record.candidateStatus } : {}),
      ...(record.studentObservation !== undefined ? { studentObservation: record.studentObservation } : {}),
    }));
    return context.emit({ snapshotRef: input.snapshotRef, sourceGroup: input.sourceGroup, ruleId: config.ruleId, slots,
      matchedRefs: slots.filter(s => s.matchStatus === "matched").map(s => ({ index: s.index, nodeRef: s.nodeRef })) });
  },
};
export const sampleAssembleNode: NodeDefinition = {
  operator: "sample.assemble", version: "0.1.0", inputPorts: [matchedPort], outputPort: datasetPort,
  config: { required: true, validate: readAssembleConfig }, effects: [],
  execute: context => context.emit(assembleSamples(context.inputs[0]!.payload, context.config)),
};

function within(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError("save path is outside allowedRoot");
}
function saveConfig(value: unknown, root: string): { fileName: string; writeMode: "create_new" } {
  const r = expectRecord(value, "save config"); onlyKeys(r, ["fileName", "writeMode"], "save config");
  const fileName = expectNonEmptyString(r.fileName, "fileName");
  if (r.writeMode !== "create_new") throw new TypeError("writeMode must be create_new");
  if (isAbsolute(fileName) || /^[a-z][a-z0-9+.-]*:/i.test(fileName) || fileName.includes("\0")) throw new TypeError("fileName must be a relative local path");
  within(root, resolve(root, fileName));
  return { fileName, writeMode: "create_new" };
}
function receipt(value: unknown) {
  const r = expectRecord(value, "receipt"), rawCounts = expectRecord(r.counts, "counts");
  onlyKeys(r, ["savedPath", "taskId", "ruleId", "totalSlots", "counts"], "receipt"); onlyKeys(rawCounts, LABEL_STATES, "counts");
  const count = (v: unknown) => { const n = expectFiniteNumber(v, "count"); if (!Number.isInteger(n) || n < 0) throw new TypeError("count must be a nonnegative integer"); return n; };
  const counts = Object.fromEntries(LABEL_STATES.map(key => [key, count(rawCounts[key])])) as Record<LabelState, number>;
  const totalSlots = count(r.totalSlots);
  if (Object.values(counts).reduce((a, b) => a + b, 0) !== totalSlots) throw new TypeError("receipt counts disagree");
  return { savedPath: expectNonEmptyString(r.savedPath, "savedPath"), taskId: expectNonEmptyString(r.taskId, "taskId"), ruleId: expectNonEmptyString(r.ruleId, "ruleId"), totalSlots, counts };
}

/** Caller owns the existing directory and must not replace its parents during a write. */
export function createSampleSaveNode({ allowedRoot }: { allowedRoot: string }): NodeDefinition {
  expectNonEmptyString(allowedRoot, "allowedRoot");
  if (!isAbsolute(allowedRoot)) throw new TypeError("allowedRoot must be absolute");
  const lexicalRoot = resolve(allowedRoot);
  return {
    operator: "sample.save", version: "0.1.0", inputPorts: [datasetPort],
    outputPort: { name: "save_receipt", schemaId: "sample/save-receipt/v1", eventType: "sample.save-receipt.v1", validate: receipt },
    config: { required: true, validate: value => saveConfig(value, lexicalRoot) }, effects: ["filesystem.write"],
    async execute(context) {
      const data = readTaskDataset(context.inputs[0]!.payload), config = saveConfig(context.config, lexicalRoot);
      const content = data.items.map(item => JSON.stringify(item)).join("\n") + (data.items.length ? "\n" : "");
      const root = await realpath(lexicalRoot);
      if (!(await stat(root)).isDirectory()) throw new TypeError("allowedRoot must be an existing directory");
      const destination = resolve(root, config.fileName); within(root, destination);
      const parent = dirname(destination);
      let current = root;
      for (const component of relative(root, parent).split(sep).filter(Boolean)) {
        current = resolve(current, component);
        if ((await lstat(current)).isSymbolicLink()) throw new TypeError("save parent cannot be a symbolic link");
      }
      within(root, await realpath(parent));
      // wx rejects an existing final file or symlink, including a dangling symlink.
      const handle = await open(destination, "wx");
      try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
      const counts = { positive: 0, negative: 0, unlabeled: 0, conflict: 0, excluded: 0 };
      for (const item of data.items) counts[item.labelState]++;
      return context.emit({ savedPath: destination, taskId: data.taskId, ruleId: data.ruleId, totalSlots: data.items.length, counts });
    },
  };
}
