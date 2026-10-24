// Online stage 1 only: paired baseline vs the initially trained candidate, both
// driven by the SAME public entry `runCliReadExpectationGoal` on the same
// execution interface (the same sandbox, the same I/O cap, the same controller).
// The baseline uses policy "baseline": the harness reads the whole remaining
// range in one bounded call each round, no learned unit. The candidate uses the
// trained units for the model decision. No post-use candidate exists yet.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReadFeedbackUnit, runCliReadExpectationGoal } from "nnanything/cli-read-feedback";
import { createCliFilesystemSandbox } from "nnanything/cli-read";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
if (typeof handwiredRoot !== "string" || handwiredRoot.length === 0) throw new Error("NN_HANDWIRED_ROOT is required");
const outDir = process.env.NN_OUT_DIR ?? "playground/cli/read-feedback/out";
const unit = await readReadFeedbackUnit({
  handwiredRoot,
  baseProfilePath: join(outDir, "base-profile.json"),
  reasoningProfilePath: join(outDir, "reasoning-profile.json"),
});

const context = Object.freeze({
  target: "current",
  bindingReissuable: true,
  retryEligible: false,
  retryBudgetLeft: 0,
  retryExhausted: false,
  skills: Object.freeze(["read", "inspect", "observe"]),
});

async function world(name, contents) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-online-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.read", "filesystem.write"],
    recipe: {
      scenarioId: name,
      entries: [{ path: "file.txt", kind: "file", contents }],
      sessions: [{ id: "session", cwd: ".", grantedEffects: ["filesystem.read"] }],
    },
  });
  const session = sandbox.bindSession("session");
  const fileRef = await sandbox.bindFile(session, "file.txt");
  return { sandbox, session, fileRef, close: async () => { await sandbox.cleanup(); await rm(root, { recursive: true, force: true }); } };
}

// Same I/O cap for both sides: the execution interface must be identical.
const MAX_READ_BYTES = 3;

const TASKS = [
  { id: "t1", size: 20, request: { shape: "head", mode: "exact", quantity: 8, offset: 0, length: 8 } },
  { id: "t2", size: 6, request: { shape: "head", mode: "up_to", quantity: 8, offset: 0, length: 8 } },
  { id: "t3", size: 12, request: { shape: "range", mode: "exact", quantity: 6, offset: 2, length: 6 } },
];

const results = [];
for (const task of TASKS) {
  for (const policy of ["baseline", "candidate"]) {
    const w = await world(`online-${task.id}-${policy}`, "x".repeat(task.size));
    const outcome = await runCliReadExpectationGoal(
      { requestId: `online-${task.id}-${policy}`, requirement: task.request, path: "file.txt" },
      {
        sandbox: w.sandbox, session: w.session, fileRef: w.fileRef, unit, context,
        maxReadBytes: MAX_READ_BYTES, retryBudget: 0, policy,
      },
    );
    await w.close();
    const response = outcome.response;
    const reads = outcome.finalState?.reads ?? 0;
    const root = response.kind === "run_result" ? response.report.rootEvaluation ?? null : null;
    const control = response.kind === "run_result" ? response.report.control ?? null : null;
    const satisfied = root !== null && root.state === "evaluated" && root.result === "satisfied";
    const end = task.request.mode === "up_to" ? Math.min(task.request.quantity, task.size) : task.request.quantity;
    const covered = outcome.finalState?.coverage ?? [];
    const targetCovered = covered.some(([start, stop]) => start <= task.request.offset && stop >= task.request.offset + end);
    results.push({
      task: task.id,
      policy,
      reads,
      bytesReturned: (outcome.finalState?.attempts ?? []).reduce((n, a) => n + (a.observation?.bytesRead ?? 0), 0),
      rootSuccess: satisfied,
      rootResult: root === null ? null : root.result,
      stopReason: control === null ? null : control.stopReason,
      outcome: control === null ? null : control.outcome,
      targetCovered,
      // Every candidate decision recorded against the independent oracle.
      legal: outcome.decisions.every(decision => decision.allowed.includes(decision.prediction)),
      predictions: outcome.decisions.map(decision => decision.prediction),
    });
  }
}

const summaryOf = (policy) => {
  const rows = results.filter(row => row.policy === policy);
  return {
    policy,
    tasks: rows.length,
    rootSuccess: rows.filter(row => row.rootSuccess).length,
    reads: rows.reduce((n, row) => n + row.reads, 0),
    bytesReturned: rows.reduce((n, row) => n + row.bytesReturned, 0),
    legal: rows.every(row => row.legal),
    stopKinds: rows.map(row => `${row.stopReason ?? row.outcome}`),
  };
};
const summary = {
  baseline: summaryOf("baseline"),
  candidate: summaryOf("candidate"),
  // Same execution interface and same optional actions: both policies get the
  // same I/O cap and the same controller, so a read-count difference is a real
  // efficiency signal, not an artifact of different chunk sizes.
  note: "both policies run on the same public entry with maxReadBytes=3 and no retry budget",
};
console.log(JSON.stringify({ results, summary }, null, 2));
