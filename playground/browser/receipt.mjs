// F12 public consumer: verifies nnanything/browser-receipt reproduces the validated receipt-knowledge prototype.
// Read-only against the evidence run; writes its own report only.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBrowserReceiptInference } from "nnanything/browser-receipt";

const ARGS = new Map(process.argv.slice(2).map((arg, index, all) => arg.startsWith("--") && all[index + 1] && !all[index + 1].startsWith("--") ? [arg.slice(2), all[index + 1]] : [arg.slice(2), "true"]));
const candidate = ARGS.get("candidate") ?? "/Volumes/Intel/playground/nnanything-runs/atomic-refusal-20261021/candidate.json";
const evidenceRoot = ARGS.get("evidence-root") ?? "/Volumes/Intel/playground/nnanything-runs/atomic-refusal-20261021";
const out = ARGS.get("out") ?? join(process.cwd(), "receipt-acceptance.json");
const TOLERANCE = 1e-6;

const partitions = ["train", "development", "verification", "regression", "native"];
const rows = [];
for (const name of partitions) {
  const loaded = JSON.parse(await readFile(join(evidenceRoot, `${name}.json`), "utf8"));
  rows.push(...loaded.map(row => ({ ...row, partition: name })));
}
if (rows.length !== 72) throw new Error(`expected 72 evidence rows, got ${rows.length}`);

const presave = JSON.parse(await readFile(join(evidenceRoot, "presave-predictions.json"), "utf8"));
const evaluation = JSON.parse(await readFile(join(evidenceRoot, "evaluation.json"), "utf8"));

const results = [];
for (const row of rows) {
  const result = await runBrowserReceiptInference({ receipt: row.input.receipt }, { profilePath: candidate });
  const prediction = result.prediction;
  const saved = presave.rows[row.id];
  if (saved === undefined) throw new Error(`missing presave row for ${row.id}`);
  const sameStatus = saved.status === prediction.status && saved.head === prediction.head;
  const logitsClose = saved.logits.every((value, index) => Math.abs(value - prediction.logits[index]) <= TOLERANCE);
  if (!sameStatus || !logitsClose) throw new Error(`presave mismatch for ${row.id}: saved=${JSON.stringify(saved)} reloaded=${JSON.stringify(prediction)}`);
  const receiptPreserved = JSON.stringify(row.input.receipt) === JSON.stringify(result.input.receipt);
  if (!receiptPreserved) throw new Error(`receipt not preserved for ${row.id}`);
  if (result.satisfaction !== null) throw new Error(`satisfaction must be null for ${row.id}`);
  if (prediction.head !== row.expected) throw new Error(`classification mismatch for ${row.id}: expected=${row.expected} actual=${prediction.head}`);
  results.push({ id: row.id, partition: row.partition, expected: row.expected, actual: prediction.head, features: prediction.features, logits: prediction.logits, status: prediction.status });
}

const verificationRows = results.filter(result => result.partition === "verification");
const idToResult = new Map(verificationRows.map(result => [result.id, result]));
function groupPairs(groupKey, expectedPairsPerGroup) {
  const groups = new Map();
  for (const result of verificationRows) {
    const key = groupKey(result.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  const pairs = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    if (sorted.length === 3) pairs.push([sorted[0].id, sorted[1].id], [sorted[0].id, sorted[2].id]);
    else if (sorted.length === 2) pairs.push([sorted[0].id, sorted[1].id]);
    else throw new Error(`unexpected invariance group size ${sorted.length}`);
  }
  if (pairs.length !== expectedPairsPerGroup) throw new Error(`expected ${expectedPairsPerGroup} pairs, got ${pairs.length}`);
  return pairs;
}
const effectsPairs = groupPairs(id => { const p = id.split(":"); return `${p[1]}:${p[3]}:${p[4]}`; }, 36);
const goalPairs = groupPairs(id => { const p = id.split(":"); return `${p[1]}:${p[2]}:${p[4]}`; }, 36);
const errorPairs = groupPairs(id => { const p = id.split(":"); return `${p[1]}:${p[2]}:${p[3]}`; }, 27);
function checkPairs(pairs) {
  for (const [leftId, rightId] of pairs) {
    const left = idToResult.get(leftId);
    const right = idToResult.get(rightId);
    if (left === undefined || right === undefined) throw new Error(`invalid verification pair ${leftId}<->${rightId}`);
    if (left.actual !== right.actual) throw new Error(`invariance violation ${leftId}<->${rightId}`);
  }
}
checkPairs(effectsPairs);
checkPairs(goalPairs);
checkPairs(errorPairs);

const own = [];
for (const effect of ["none", "known", "unknown"]) {
  for (const goal of ["achieved", "unachieved", "unknown"]) {
    for (const hasError of [false, true]) {
      const suffix = `${effect}:${goal}:${hasError}`;
      const failure = idToResult.get(`verification:failure:${suffix}`);
      const success = idToResult.get(`verification:success:${suffix}`);
      const absent = idToResult.get(`verification:absent:${suffix}`);
      if (!failure || !success || !absent) throw new Error(`missing own-semantics rows for ${suffix}`);
      if (failure.actual !== "explicit_failure" || success.actual !== "explicit_success" || absent.actual !== "unknown") {
        throw new Error(`own-semantics violation for ${suffix}`);
      }
      own.push({ left: failure.id, right: success.id }, { left: failure.id, right: absent.id });
    }
  }
}

const report = {
  candidate: resolve(candidate),
  state: evaluation.candidate?.state ?? { calibration: "uncalibrated", application: "not_applied" },
  counts: {
    allRows: results.length,
    classificationCorrect: results.filter(r => r.actual === r.expected).length,
    byPartition: Object.fromEntries(partitions.map(name => [name, results.filter(r => r.partition === name).length])),
  },
  presaveReload: { comparedRows: results.length, mismatchedRows: 0, tolerance: TOLERANCE },
  invariance: { effects: { pairs: effectsPairs.length, passed: effectsPairs.length }, goal: { pairs: goalPairs.length, passed: goalPairs.length }, error: { pairs: errorPairs.length, passed: errorPairs.length }, total: { pairs: 99, passed: 99 } },
  ownSemantics: { pairs: own.length, passed: own.length },
  rows: results,
};
await mkdir(resolve(out).replace(/\/[^/]+$/, ""), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
