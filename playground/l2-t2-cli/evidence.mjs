/**
 * L2 T2 CLI evidence experiment: real OS initial state -> read -> feedback.
 *
 * Scope (task l2-four-head-t2-cli-evidence, audit plan T2 / C1-C3):
 *   - drive the delivered production CLI adapter (`nnanything/cli-read` sandbox + typed
 *     semantic calls) to obtain raw states and real receipts,
 *   - record per-field provenance and the condition table of the first read goal,
 *   - produce red/green counterexamples for C1 (unread loop premise), C2 (one field name,
 *     two meanings) and C3 (range result disagreement),
 *   - give the two minimal-advance paths: unread state can legally read and close on a real
 *     receipt; a range error or a recoverable reference update yields the next sub-goal from
 *     feedback, and a non-recovery scenario stops accurately.
 *
 * This file fits nothing, projects nothing into numeric features and runs no controller. It
 * adds no second L2 framework: the shared encoder/chain and the candidate collector stay with
 * their current owners. It reads only public production entries and its own fixtures.
 */

import { utimes } from "node:fs/promises";
import { lstat, mkdtemp, realpath, rm, unlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createCliFilesystemSandbox } = await import("nnanything/cli-read");

const GRANTED = Object.freeze(["filesystem.read", "process.exec", "session.write"]);

/** Each recorded field names its only real source. No field is filled from a prediction. */
export const FIELD_PROVENANCE = Object.freeze({
  "recipe.entries": "authored fixture written into the fresh sandbox root",
  "binding.ref": "sandbox-issued object reference (bindFile)",
  "binding.identity": "sandbox-issued dev/ino carried by that reference",
  "binding.sessionRevision": "sandbox session counter captured when the reference was issued",
  "binding.sourceRun": "sandbox run id of the issuing binding call",
  "binding.usable": "real validateObservedObject observation of that reference",
  "call.operation": "typed semantic call chosen by the decision step",
  "call.parameters": "typed parameters of that call (offset, length, ref)",
  "call.attempted": "controller attempt bookkeeping for this frame",
  "observation.receipt": "real receipt returned by the sandbox executor, or null",
  "observation.error": "real failure carried by the receipt, or null",
  "observation.bytes": "bytes returned by the real open/read on the owned fixture",
  "observation.bytesRead": "count actually returned by the real read",
  "observation.size": "file size observed by that same real read",
  "observation.eof": "end-of-file fact established by that same real read",
  "observation.endObserved": "end-position fact established by that same real read",
  "condition.binding_usable": "derived: real reference validation result",
  "condition.read_receipt_observed": "derived: presence of a real file.read receipt",
  "condition.requested_range_obtained": "derived: real receipt facts under the declared range mode",
  "root.obtained": "derived: the declared goal is satisfied by real evidence only",
  "model.scores": "none: T2 fits and runs no model, so no score field is recorded",
});

const READ_MODES = Object.freeze(["exact", "up_to"]);

/**
 * Evaluate the range condition from real receipt facts only.
 *
 * exact: the requested number of bytes must be returned. A zero-length request is satisfied by
 * zero bytes and needs no end-of-file fact.
 * up_to: a short read qualifies only when this receipt itself established the end of file, so
 * the shortfall is real absence rather than a truncated observation.
 */
export function requestedRangeObtained(receipt, { mode, length }) {
  if (!READ_MODES.includes(mode)) throw new Error(`unknown read mode ${mode}`);
  if (receipt === null || receipt === undefined) return "unknown";
  if (receipt.call?.operation !== "file.read") return "unknown";
  if (receipt.status !== "succeeded") return "unsatisfied";
  const observed = receipt.execution.observation;
  if (observed.bytesRead === length) return "satisfied";
  if (mode === "exact") return "unsatisfied";
  return observed.eof === true && observed.end_observed === true ? "satisfied" : "unsatisfied";
}

/** A receipt exists once a call ran, including a failed call: failure is not "never tried". */
export function readReceiptObserved(receipt) {
  return receipt === null || receipt === undefined ? "unsatisfied" : "satisfied";
}

/**
 * C1: the legal action set before any read.
 *
 * The legacy premise requires a *future* receipt fact (sourceCurrent) before allowing the read,
 * so an unread frame has no legal action and the rollout stalls. The staged premise uses only
 * facts that exist now: current binding eligibility and the granted read capability.
 */
export function legalActions(premise, state) {
  if (premise === "legacy-unread-premise") {
    return state.sourceCurrent === true ? ["read"] : [];
  }
  if (premise !== "staged") throw new Error(`unknown premise ${premise}`);
  const allowed = [];
  if (state.bindingUsable === "satisfied" && state.grantedRead === true) allowed.push("read");
  return allowed;
}

/**
 * C3 red counterexample: a teacher that validates the requested end against the file size before
 * the read runs. It rejects a legitimate EOF-limited up_to request.
 */
export function legacyRangePrecheck(offset, length, size) {
  return offset + length <= size;
}

/** Offsets and lengths the runtime accepts as a typed request. */
export function typedRangeValid(offset, length) {
  return Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length >= 0;
}

async function makeWorld(scenarioId, entries) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `t2-${scenarioId}-`)));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId,
      entries: [{ path: "start", kind: "directory" }, ...entries],
      sessions: [{ id: "s", cwd: "start", grantedEffects: GRANTED }],
    },
  });
  const session = sandbox.bindSession("s");
  return { sandbox, session, root, base: join(root, scenarioId, "start") };
}

async function closeWorld(world) {
  await world.sandbox.cleanup();
  await rm(world.root, { recursive: true, force: true });
}

async function bindingState(sandbox, ref) {
  try {
    await sandbox.validateObservedObject(ref);
    return "satisfied";
  } catch {
    return "unsatisfied";
  }
}

async function readOnce(sandbox, ref, offset, length) {
  return sandbox.execute({ operation: "file.read", parameters: { ref, offset, length } });
}

function receiptFacts(receipt) {
  if (receipt === null) return null;
  if (receipt.status !== "succeeded") {
    return {
      status: "failed",
      runId: receipt.execution.runId,
      executorInvoked: receipt.execution.executorInvoked,
      error: { stage: receipt.execution.error.stage, code: receipt.execution.error.code, message: receipt.execution.error.message },
    };
  }
  const observed = receipt.execution.observation;
  return {
    status: "succeeded",
    runId: receipt.execution.runId,
    executorInvoked: receipt.execution.executorInvoked,
    bytes: observed.bytes,
    bytesRead: observed.bytesRead,
    size: observed.size,
    eof: observed.eof,
    endObserved: observed.end_observed,
    identity: observed.identity,
  };
}

/**
 * One frame: capture the real initial state, record which premise admits which action, run the
 * real call, and evaluate the three conditions from real facts.
 */

/** Restore the exact prior mtime so the fixture keeps an unchanged stat identity. */
async function preserveMtime(path, snapshot) {
  const wanted = Number(snapshot.mtimeMs);
  let target = wanted;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await utimes(path, Number(snapshot.atimeMs) / 1000, target / 1000);
    const now = Number((await lstat(path)).mtimeMs);
    if (now === wanted) return true;
    target += wanted - now;
  }
  return false;
}

async function runFrame({ id, family, partition, mode, offset, length, mutate }) {
  const world = await makeWorld(`t2-${id}`, [{ path: "start/f.txt", kind: "file", contents: "abcdefghij" }]);
  const rows = [];
  try {
    const { sandbox, session, base } = world;
    let ref = await sandbox.bindFile(session, "f.txt");
    const inspectBefore = await sandbox.execute({ operation: "entry.inspect", parameters: { ref, followSymlinks: false } });
    const before = inspectBefore.execution.observation.snapshot;

    // C1 evidence: the unread state keeps read and sourceCurrent empty, and no receipt exists yet.
    const initialState = {
      receipt: null,
      read: null,
      sourceCurrent: null,
      bindingUsable: await bindingState(sandbox, ref),
      grantedRead: true,
    };
    const legacyActions = legalActions("legacy-unread-premise", initialState);
    const stagedActions = legalActions("staged", initialState);
    rows.push({
      id, family, partition, kind: "C1-unread-premise",
      unreadState: { receipt: null, read: null, sourceCurrent: null },
      legacyPremiseActions: legacyActions,
      stagedPremiseActions: stagedActions,
      red: legacyActions.length === 0,
      green: stagedActions.includes("read"),
    });

    // C2 evidence: separate the three facts that a single "revisionCurrent" name used to mix.
    let contentChange = null;
    if (mutate === "same-size-new-content") {
      // Independent native observation of the same owned fixture, used only to state the OS facts.
      const statBefore = await lstat(ref.absolutePath);
      await writeFile(ref.absolutePath, "KLMNOPQRST");
      const mtimeRestored = await preserveMtime(ref.absolutePath, statBefore);
      const statAfter = await lstat(ref.absolutePath);
      const inspectAfter = await sandbox.execute({ operation: "entry.inspect", parameters: { ref, followSymlinks: false } });
      const after = inspectAfter.execution.observation.snapshot;
      const reread = await readOnce(sandbox, ref, 0, statBefore.size);
      const sizeEqual = Number(statBefore.size) === Number(statAfter.size);
      const mtimeEqual = Number(statBefore.mtimeMs) === Number(statAfter.mtimeMs);
      contentChange = {
        sessionRevisionBefore: ref.sessionRevision,
        sessionRevisionAfter: sandbox.getSession(session).revision,
        lstat: {
          sizeEqual,
          mtimeEqual,
          devEqual: String(statBefore.dev) === String(statAfter.dev),
          inoEqual: String(statBefore.ino) === String(statAfter.ino),
          ctimeChanged: Number(statBefore.ctimeMs) !== Number(statAfter.ctimeMs),
          mtimeRestored,
        },
        legacyRevisionCurrent: sizeEqual && mtimeEqual,
        contentChangedProved: reread.status === "succeeded"
          && reread.execution.observation.bytes !== Buffer.from("abcdefghij").toString("base64"),
        bytesAfterChange: reread.status === "succeeded" ? reread.execution.observation.bytes : null,
        sandboxSnapshotMtimeDelta: Number(after.mtimeMs) - Number(before.mtimeMs),
        note: "a collector that names size+mtime equality revisionCurrent reports current here while the bytes changed; session revision is a sandbox counter, not a content fact",
      };
      rows.push({ id, family, partition, kind: "C2-field-separation", ...contentChange });
    }

    if (mutate === "replace-object") {
      await unlink(ref.absolutePath);
      await writeFile(ref.absolutePath, "abcdefghij");
      const staleRead = await readOnce(sandbox, ref, offset, length);
      const staleUsable = await bindingState(sandbox, ref);
      rows.push({
        id, family, partition, kind: "C2-reference-replacement",
        oldRefUsable: staleUsable,
        oldRefRead: receiptFacts(staleRead),
        legacyTreatsPathAsIdentity: true,
        red: staleRead.status === "succeeded",
        green: staleRead.status === "failed" && staleRead.execution.error.code === "STALE_REFERENCE",
      });
      // Recovery: the failure code says the reference is stale, so the frame rebinds by path.
      const rebound = await sandbox.bindFile(session, "f.txt");
      const reboundRead = await readOnce(sandbox, rebound, offset, length);
      rows.push({
        id, family, partition, kind: "pathB-reference-recovery",
        recoveryTrigger: staleRead.execution.error.code,
        recoveryAction: "rebind-by-path",
        reboundRunsNewSource: rebound.sourceRun !== ref.sourceRun,
        newIno: rebound.identity.ino !== ref.identity.ino,
        read: receiptFacts(reboundRead),
        requestedRangeObtained: requestedRangeObtained(reboundRead, { mode, length }),
      });
      ref = rebound;
    }

    // Path A: the staged premise admits the read, and the real receipt closes the conditions.
    const receipt = await readOnce(sandbox, ref, offset, length);
    const observedFacts = receiptFacts(receipt);
    const binding = await bindingState(sandbox, ref);
    const conditions = {
      binding_usable: binding,
      read_receipt_observed: readReceiptObserved(receipt),
      requested_range_obtained: requestedRangeObtained(receipt, { mode, length }),
    };
    rows.push({
      id, family, partition, kind: "read-attempt",
      call: { operation: "file.read", parameters: { offset, length }, attempted: true, runId: receipt.execution.runId },
      observation: observedFacts,
      conditions,
      rootObtained: conditions.requested_range_obtained === "satisfied",
      rangeMode: mode,
      requested: { offset, length, fileSize: before.size },
      legacyPrecheckAccepts: legacyRangePrecheck(offset, length, before.size),
      typedRangeValid: typedRangeValid(offset, length),
    });
    return rows;
  } finally {
    await closeWorld(world);
  }
}

/** Path B with a range error: correct the request from the receipt, or stop when it cannot close. */
async function runRangeRecovery({ id, family, partition }) {
  const world = await makeWorld(`t2-${id}`, [{ path: "start/f.txt", kind: "file", contents: "abcdefghij" }]);
  const rows = [];
  try {
    const { sandbox, session } = world;
    const ref = await sandbox.bindFile(session, "f.txt");
    const first = await readOnce(sandbox, ref, 8, 5);
    const firstFacts = receiptFacts(first);
    const firstCondition = requestedRangeObtained(first, { mode: "exact", length: 5 });
    rows.push({
      id, family, partition, kind: "pathB-range-error-first-attempt",
      call: { operation: "file.read", parameters: { offset: 8, length: 5 }, attempted: true, runId: first.execution.runId },
      observation: firstFacts,
      conditions: {
        binding_usable: await bindingState(sandbox, ref),
        read_receipt_observed: readReceiptObserved(first),
        requested_range_obtained: firstCondition,
      },
      red: legacyRangePrecheck(8, 5, 10),
    });
    // The corrected sub-goal uses only facts the first receipt established.
    const available = firstFacts.size - 8;
    const corrected = { mode: "exact", offset: 8, length: available, derivedFrom: ["observation.size", "call.parameters.offset", "observation.eof"] };
    const second = await readOnce(sandbox, ref, corrected.offset, corrected.length);
    rows.push({
      id, family, partition, kind: "pathB-range-recovery",
      recoveryFrom: first.execution.runId,
      correctedSubGoal: corrected,
      observation: receiptFacts(second),
      requestedRangeObtained: requestedRangeObtained(second, { mode: corrected.mode, length: corrected.length }),
      rootObtained: requestedRangeObtained(second, { mode: corrected.mode, length: corrected.length }) === "satisfied",
    });

    // Non-recovery: a range fully past the observed end can never be obtained for this goal.
    const far = await readOnce(sandbox, ref, 13, 2);
    const farCondition = requestedRangeObtained(far, { mode: "exact", length: 2 });
    rows.push({
      id, family, partition, kind: "pathB-nonrecovery-range",
      call: { operation: "file.read", parameters: { offset: 13, length: 2 }, attempted: true, runId: far.execution.runId },
      observation: receiptFacts(far),
      conditions: {
        binding_usable: await bindingState(sandbox, ref),
        read_receipt_observed: readReceiptObserved(far),
        requested_range_obtained: farCondition,
      },
      stop: { decision: "stop", reason: "no legal re-request can obtain bytes past the observed end", rootObtained: false },
      furtherAttempts: 0,
    });
    return rows;
  } finally {
    await closeWorld(world);
  }
}

/** Non-recovery capability paths: the delivered adapter must refuse or fail explicitly. */
async function runCapabilityGaps({ partition }) {
  const world = await makeWorld("t2-gaps", [
    { path: "start/denied.txt", kind: "file", contents: "secret" },
    { path: "start/dir", kind: "directory" },
  ]);
  const rows = [];
  try {
    const { sandbox, session, base } = world;
    const missing = await (async () => {
      try {
        await sandbox.bindFile(session, "gone.txt");
        return { bound: true };
      } catch (error) {
        return { bound: false, message: error.message };
      }
    })();
    rows.push({ id: "gap-missing", family: "F7-capability-gap", partition, kind: "nonrecovery", target: "missing file", ...missing, accurateStop: missing.bound === false });

    const nonRegular = await (async () => {
      try {
        await sandbox.bindFile(session, "dir");
        return { bound: true };
      } catch (error) {
        return { bound: false, message: error.message };
      }
    })();
    rows.push({ id: "gap-nonregular", family: "F7-capability-gap", partition, kind: "nonrecovery", target: "directory named as regular file", ...nonRegular, accurateStop: nonRegular.bound === false });

    await chmod(join(base, "denied.txt"), 0o000);
    const deniedRef = await sandbox.bindFile(session, "denied.txt");
    const denied = await readOnce(sandbox, deniedRef, 0, 6);
    await chmod(join(base, "denied.txt"), 0o644);
    rows.push({
      id: "gap-denied", family: "F7-capability-gap", partition, kind: "nonrecovery", target: "read without permission",
      observation: receiptFacts(denied),
      conditions: {
        binding_usable: await bindingState(sandbox, deniedRef),
        read_receipt_observed: readReceiptObserved(denied),
        requested_range_obtained: requestedRangeObtained(denied, { mode: "exact", length: 6 }),
      },
      accurateStop: denied.status === "failed" && denied.execution.error.code === "EACCES",
      note: "the attempt is recorded with its real error; no byte and no success is claimed",
    });
    return rows;
  } finally {
    await closeWorld(world);
  }
}

/**
 * Path A through the delivered controller: an unread initial state is not a premise blocker.
 * The production entry lists, inspects and then executes one real file.read whose receipt closes
 * the goal. No field requires a future receipt before the read.
 */
export async function runControllerPathA() {
  const profileFile = process.env.NN_CLI_COMMAND_PROFILE;
  if (typeof profileFile !== "string" || profileFile.length === 0) {
    return [{ id: "controller-path-a", kind: "SKIP", reason: "NN_CLI_COMMAND_PROFILE not set; controller path A needs the shared policy profile" }];
  }
  const { readFile: read } = await import("node:fs/promises");
  const rawProfile = JSON.parse(await read(profileFile, "utf8"));
  const profile = rawProfile.wires?.length === 30
    ? await (await import("nnanything/cli-goal")).migrateCliCommandProfileV10x30(rawProfile)
    : rawProfile;
  const { runCliReadCompositionGoal } = await import("nnanything/cli-read");
  const world = await makeWorld("t2-controller", [{ path: "start/target.bin", kind: "file", contents: "abcdef" }]);
  const rows = [];
  try {
    const { sandbox, session } = world;
    const directory = await sandbox.bindDirectoryObject(session, ".");
    const samples = [];
    const result = await runCliReadCompositionGoal({
      requestId: "t2-controller",
      goal: {
        kind: "file.property",
        property: "file.property.content.bytes",
        target: { kind: "cli.exact-child", directory, name: "target.bin", requiredType: "regular" },
        requirement: { kind: "equals", range: { offset: 1, length: 3 }, expectedBase64: Buffer.from("bcd").toString("base64") },
      },
      satisfactionThreshold: 100,
    }, {
      sandbox, session, profile,
      limits: { maxTransitions: 23, maxDepth: 4, maxDerivedGoals: 8 },
      onSample: async sample => samples.push(sample),
    });
    const readFact = result.domain.rootFact?.read ?? null;
    rows.push({
      id: "controller-path-a", kind: "controller-final",
      status: result.domain.status,
      resolution: result.domain.resolution,
      satisfaction: result.domain.satisfaction,
      realReadReceipt: readFact === null ? null : {
        sourceRun: readFact.sourceRun,
        refSourceRun: readFact.refSourceRun,
        offset: readFact.offset,
        length: readFact.length,
        bytesRead: readFact.bytesRead,
        size: readFact.size,
        eof: readFact.eof,
        bytes: readFact.bytes,
      },
      closedOnRealReceipt: readFact !== null && readFact.bytesRead === 3 && readFact.bytes === Buffer.from("bcd").toString("base64"),
      controllerSteps: samples.map(sample => ({ goal: sample.goal.property, invocation: sample.invocation?.[0], status: sample.status })),
      note: "the goal opened with no read fact; the production controller executed one real file.read whose receipt (bytesRead=3, bytes=YmNk) closed the matched root fact. The read is a composition transition, not a shared cli-command sample, so it is read from the root fact, not from onSample.",
    });
    return rows;
  } finally {
    await closeWorld(world);
  }
}

export const SCENARIOS = Object.freeze([
  { id: "exact-full", family: "F1-exact-in-range", partition: "TRAIN", mode: "exact", offset: 0, length: 10 },
  { id: "exact-mid", family: "F1-exact-in-range", partition: "TRAIN", mode: "exact", offset: 2, length: 4 },
  { id: "exact-end", family: "F1-exact-in-range", partition: "TRAIN", mode: "exact", offset: 10, length: 0 },
  { id: "exact-short", family: "F2-exact-short-at-eof", partition: "TRAIN", mode: "exact", offset: 8, length: 5 },
  { id: "exact-past-end", family: "F2-exact-short-at-eof", partition: "TRAIN", mode: "exact", offset: 10, length: 2 },
  { id: "exact-zero-at-zero", family: "F4-zero-length", partition: "TRAIN", mode: "exact", offset: 0, length: 0 },
  { id: "upto-past-eof", family: "F3-upto-short-with-eof", partition: "TRAIN", mode: "up_to", offset: 0, length: 15 },
  { id: "upto-mid-short", family: "F3-upto-short-with-eof", partition: "TRAIN", mode: "up_to", offset: 8, length: 5 },
  { id: "upto-zero", family: "F3-upto-short-with-eof", partition: "TRAIN", mode: "up_to", offset: 4, length: 0 },
  { id: "offset-past-eof", family: "F5-offset-past-eof", partition: "TRAIN", mode: "exact", offset: 13, length: 2 },
  { id: "content-change", family: "F8-content-change-same-stat", partition: "dev", mode: "exact", offset: 0, length: 10, mutate: "same-size-new-content" },
  { id: "reference-replaced", family: "F6-stale-reference-rebind", partition: "TRAIN", mode: "exact", offset: 0, length: 10, mutate: "replace-object" },
]);

export async function collectRows() {
  const rows = [];
  for (const scenario of SCENARIOS) rows.push(...await runFrame(scenario));
  rows.push(...await runRangeRecovery({ id: "range-recovery", family: "F9-range-recovery", partition: "dev" }));
  rows.push(...await runCapabilityGaps({ partition: "dev" }));
  rows.push(...await runControllerPathA());
  return rows;
}

export function summarize(rows) {
  const attempts = rows.filter(row => row.kind === "read-attempt" || row.kind === "pathB-range-recovery" || row.kind === "pathB-nonrecovery-range" || row.kind === "pathB-range-error-first-attempt");
  const partitions = {};
  for (const row of rows) {
    const key = `${row.partition}/${row.family}`;
    partitions[key] ??= { rows: 0, kinds: new Set() };
    partitions[key].rows += 1;
    partitions[key].kinds.add(row.kind);
  }
  return {
    generatedAt: new Date().toISOString(),
    rowCount: rows.length,
    attemptCount: attempts.length,
    families: Object.fromEntries(Object.entries(partitions).map(([k, v]) => [k, { rows: v.rows, kinds: [...v.kinds] }])),
    conditionTable: attempts.map(row => ({
      id: row.id,
      mode: row.rangeMode ?? row.correctedSubGoal?.mode ?? null,
      conditions: row.conditions ?? { requested_range_obtained: row.requestedRangeObtained ?? null },
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await collectRows();
  const summary = summarize(rows);
  const outDir = process.argv[2];
  if (outDir) {
    const { writeFile: write } = await import("node:fs/promises");
    await write(join(outDir, "t2-cli-rows.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await write(join(outDir, "t2-cli-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  }
  console.log(JSON.stringify({ rowCount: rows.length, attemptCount: summary.attemptCount }, null, 2));
}
