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
 * The old candidate teacher's real range rule, read from its source
 * (`playground/l2/cli.mjs`, E head, request.mode branches) rather than re-invented.
 *
 * It performs no size precheck at all: `exact` is satisfied iff bytesRead === length; `up_to` is
 * satisfied iff bytesRead === length, or bytesRead < length with eof === true. This claim is
 * scoped to the E branch only (see LEGACY_TEACHER_SOURCE.scope); the old R qualification or any
 * pre-read range gate is UNVERIFIED here. An earlier revision
 * of this file compared offset+length against size and called that the legacy precheck; that was a
 * substitute, not the old teacher, so it is withdrawn here (C3 correction, Alice review r1).
 *
 * The one real endpoint divergence found on the source: the old candidate computes its own
 * `eof` for a zero-length read as `offset >= size`, while the delivered production adapter reports
 * `eof: false, end_observed: true` for a zero-length read exactly at the end. Both agree the
 * zero-length exact request is satisfied because bytesRead === length; only the eof field differs.
 */
export const LEGACY_TEACHER_SOURCE = Object.freeze({
  file: "playground/l2/cli.mjs",
  scope: "E branch only: the receipt-level range judgment reproduced below. This is the only part verified against source.",
  branches: Object.freeze({
    exact: "bytesRead === length -> satisfied; short with eof -> unsatisfied; short -> unsatisfied",
    up_to: "bytesRead === length -> satisfied; bytesRead > length -> unsatisfied; short with eof -> satisfied; short without eof -> unsatisfied",
  }),
  eBranchSizePrecheck: "none inside the E branch: the E branch evaluates receipt facts only",
  fullChainSizePrecheck: "UNVERIFIED: the old R qualification or any pre-read range gate is not verified here; the current shared source no longer contains the historical version, so no claim is made about it",
  zeroLengthEof: "old candidate computes eof = offset >= size for length 0; production adapter reports eof=false, end_observed=true at the end",
});

/** The old teacher's rule as a label, so no substitute predicate is mistaken for the source. */
export function legacyTeacherVerdict(mode, { bytesRead, length, eof }) {
  if (mode === "exact") {
    if (bytesRead === length) return "satisfied";
    return "unsatisfied";
  }
  if (mode !== "up_to") throw new Error(`unknown read mode ${mode}`);
  if (bytesRead === length) return "satisfied";
  if (bytesRead > length) return "unsatisfied";
  return eof === true ? "satisfied" : "unsatisfied";
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
        note: "field-definition conflict: a collector that names size+mtime equality revisionCurrent reports current here while the bytes changed, and the runtime's sessionRevision is a sandbox counter that stayed 0. Content change is proved only by the direct reread bytes; ctime is metadata-only evidence (chmod also moves it), so it is not used as byte proof. A session revision that stays unchanged is not by itself an error.",
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
      // Boundary (Alice review r1, P1-2): rebinding by path gets a *different* object (new inode).
      // For a root whose target is this fixed ObservedObjectRef, that changes the target and can
      // never be called a recovery of the original root. It is only a candidate for a root that
      // explicitly names the path object and re-validates binding eligibility.
      // (Alice review r2, P1): the original binding is kept; the rebound object's read is recorded
      // as its own result and never as the original case's root success.
      const rebound = await sandbox.bindFile(session, "f.txt");
      const reboundRead = await readOnce(sandbox, rebound, offset, length);
      rows.push({
        id, family, partition, kind: "pathB-reference-fixed-root-boundary",
        recoveryTrigger: staleRead.execution.error.code,
        candidateAction: "rebind-by-path",
        identityEndpoints: {
          original: { dev: ref.identity.dev, ino: ref.identity.ino, sourceRun: ref.sourceRun },
          rebound: { dev: rebound.identity.dev, ino: rebound.identity.ino, sourceRun: rebound.sourceRun },
        },
        reboundRunsNewSource: rebound.sourceRun !== ref.sourceRun,
        newIno: rebound.identity.ino !== ref.identity.ino,
        newObjectRead: receiptFacts(reboundRead),
        newObjectRangeObtained: requestedRangeObtained(reboundRead, { mode, length }),
        newObjectRootObtained: requestedRangeObtained(reboundRead, { mode, length }) === "satisfied",
        originalRootRecovered: false,
        originalRootState: "unknown",
        boundary: "the fixed-reference root is not restored by a path rebind; the rebound read proves only that a new object was obtained. A path-located root may accept the rebound only after it explicitly allows the current path object and re-validates binding eligibility.",
        note: "the original root keeps its unsatisfied/unknown state; the new-object read is reported as newObjectRootObtained, not as original-root success",
      });
      // Keep ref as the original binding: the read below then runs on the stale original ref and
      // reports the original root as unsatisfied, preserving traceability.
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
      rootBinding: { dev: ref.identity.dev, ino: ref.identity.ino, sourceRun: ref.sourceRun },
      rangeMode: mode,
      requested: { offset, length, fileSize: before.size },
      legacyTeacherVerdict: observedFacts === null ? "unobserved" : legacyTeacherVerdict(mode, {
        bytesRead: observedFacts.bytesRead ?? null,
        length,
        eof: observedFacts.eof ?? null,
      }),
      typedRangeValid: typedRangeValid(offset, length),
    });
    return rows;
  } finally {
    await closeWorld(world);
  }
}

/**
 * Path B with a range error.
 *
 * The root goal and its threshold stay fixed for every row here (Alice review r1, P1-1): a new
 * sub-request that succeeds never counts as the original root succeeding. Lowering length from 5 to
 * 2 is a different goal, so the original root is re-evaluated on the original goal after each
 * attempt and stays unsatisfied.
 */
async function runRangeRecovery({ id, family, partition }) {
  const world = await makeWorld(`t2-${id}`, [{ path: "start/f.txt", kind: "file", contents: "abcdefghij" }]);
  const rows = [];
  const rootGoal = Object.freeze({ mode: "exact", offset: 8, length: 5 });
  try {
    const { sandbox, session } = world;
    const ref = await sandbox.bindFile(session, "f.txt");
    const first = await readOnce(sandbox, ref, rootGoal.offset, rootGoal.length);
    const firstFacts = receiptFacts(first);
    const firstCondition = requestedRangeObtained(first, { mode: rootGoal.mode, length: rootGoal.length });
    rows.push({
      id, family, partition, kind: "pathB-range-error-first-attempt",
      rootGoal,
      call: { operation: "file.read", parameters: { offset: rootGoal.offset, length: rootGoal.length }, attempted: true, runId: first.execution.runId },
      observation: firstFacts,
      conditions: {
        binding_usable: await bindingState(sandbox, ref),
        read_receipt_observed: readReceiptObserved(first),
        requested_range_obtained: firstCondition,
      },
      originalRootObtained: firstCondition === "satisfied",
    });

    // A corrected sub-request derived only from the first receipt's own facts. It closes the
    // sub-request, not the original root: the original root is re-evaluated unchanged below.
    const available = Number(firstFacts.size) - rootGoal.offset;
    const subRequest = { mode: "exact", offset: rootGoal.offset, length: available, derivedFrom: ["observation.size", "call.parameters.offset", "observation.eof"] };
    const second = await readOnce(sandbox, ref, subRequest.offset, subRequest.length);
    const subCondition = requestedRangeObtained(second, { mode: subRequest.mode, length: subRequest.length });
    const rootAfterSub = legacyTeacherVerdict(rootGoal.mode, {
      bytesRead: receiptFacts(second).bytesRead,
      length: rootGoal.length,
      eof: receiptFacts(second).eof,
    });
    rows.push({
      id, family, partition, kind: "pathB-range-boundary",
      recoveryFrom: first.execution.runId,
      rootGoal,
      subRequest,
      observation: receiptFacts(second),
      subRequestObtained: subCondition,
      originalRootObtained: false,
      originalRootVerdictOnOriginalGoal: rootAfterSub,
      boundary: "the corrected sub-request obtains the remaining bytes; the original root exact(8,5) stays unsatisfied because only 2 bytes exist past offset 8. A lower length is a different goal and is not reported as root success.",
      note: "real recovery of an achievable root is covered by the T1 controlled example (tests/l2-cli-conditions.test.mjs); T2 does not duplicate it and only states this boundary",
    });

    // Retry with the original goal unchanged: the requirement is not lowered, so it stays unmet.
    const retry = await readOnce(sandbox, ref, rootGoal.offset, rootGoal.length);
    const retryFacts = receiptFacts(retry);
    rows.push({
      id, family, partition, kind: "pathB-range-retry-original-goal",
      rootGoal,
      call: { operation: "file.read", parameters: { offset: rootGoal.offset, length: rootGoal.length }, attempted: true, runId: retry.execution.runId },
      observation: retryFacts,
      originalRootObtained: requestedRangeObtained(retry, { mode: rootGoal.mode, length: rootGoal.length }) === "satisfied",
      stop: {
        decision: "stop",
        reason: "the original exact(8,5) range cannot be obtained on a 10-byte file; retrying with the unchanged root goal confirms the requirement was not lowered",
        rootObtained: false,
      },
      furtherAttempts: 0,
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

    // C3 confirmed counterexamples (Alice review r1, P2-2): requests whose end lies past the file
    // size. These use real receipts; no size precheck is invented.
    const upToPastEnd = await readOnce(sandbox, ref, 13, 2);
    rows.push({
      id: "range-eof-outside-up-to", family: family, partition, kind: "range-eof-outside",
      call: { operation: "file.read", parameters: { offset: 13, length: 2 }, attempted: true, runId: upToPastEnd.execution.runId },
      observation: receiptFacts(upToPastEnd),
      rangeMode: "up_to",
      requested: { offset: 13, length: 2, fileSize: 10 },
      requestedRangeObtained: requestedRangeObtained(upToPastEnd, { mode: "up_to", length: 2 }),
      legacyTeacherVerdict: legacyTeacherVerdict("up_to", { bytesRead: receiptFacts(upToPastEnd).bytesRead, length: 2, eof: receiptFacts(upToPastEnd).eof }),
      boundary: "the real receipts below are the counterexample, not any invented size precheck: an up_to(13,2) on a 10-byte file returns 0 bytes with eof established, and the up_to rule (bytesRead===length or short-with-eof) judges it satisfied. No claim is made about an offset<=size acceptance, because 13<=10 is false and no historical precheck is verified here.",
    });
    const zeroPastEnd = await readOnce(sandbox, ref, 13, 0);
    const zeroAtEnd = await readOnce(sandbox, ref, 10, 0);
    rows.push({
      id: "range-eof-outside-zero-length", family: family, partition, kind: "range-eof-outside",
      call: { operation: "file.read", parameters: { offset: 13, length: 0 }, attempted: true, runId: zeroPastEnd.execution.runId },
      observation: receiptFacts(zeroPastEnd),
      rangeMode: "exact",
      requested: { offset: 13, length: 0, fileSize: 10 },
      requestedRangeObtained: requestedRangeObtained(zeroPastEnd, { mode: "exact", length: 0 }),
      endpointComparison: {
        beyondEnd: receiptFacts(zeroPastEnd),
        atEnd: receiptFacts(zeroAtEnd),
      },
      boundary: "zero-length exact is satisfied by bytesRead === length at any offset; the delivered adapter reports eof=false and end_observed=true for a zero-length read exactly at the end, while the old candidate computes eof = offset >= size. Only the eof field differs; both agree the request is satisfied.",
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
  const profile = await (await import("nnanything/cli-goal")).migrateCliCommandProfileToCurrent(rawProfile);
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

/**
 * Assertion on the real replacement trajectory (Alice review r2, P1).
 *
 * For the case whose root is the fixed ObservedObjectRef that was replaced, no row may report the
 * original root as obtained: the rebound object belongs to a different identity and its read is
 * recorded as newObjectRootObtained only.
 */
export function assertReplacementCaseHasNoOriginalRootSuccess(rows, caseId) {
  const caseRows = rows.filter(row => row.id === caseId);
  if (caseRows.length === 0) throw new Error(`no rows recorded for case ${caseId}`);
  const offending = caseRows.filter(row => row.rootObtained === true || row.originalRootObtained === true);
  if (offending.length > 0) {
    throw new Error(`case ${caseId} reports original-root success on ${offending.map(row => row.kind).join(", ")}`);
  }
  const boundary = caseRows.find(row => row.kind === "pathB-reference-fixed-root-boundary");
  if (boundary === undefined) throw new Error(`case ${caseId} has no replacement boundary row`);
  if (boundary.originalRootRecovered !== false) throw new Error(`case ${caseId} claims the original root recovered`);
  return true;
}

export async function collectRows() {
  const rows = [];
  for (const scenario of SCENARIOS) rows.push(...await runFrame(scenario));
  rows.push(...await runRangeRecovery({ id: "range-recovery", family: "F9-range-recovery", partition: "dev" }));
  rows.push(...await runCapabilityGaps({ partition: "dev" }));
  rows.push(...await runControllerPathA());
  assertReplacementCaseHasNoOriginalRootSuccess(rows, "reference-replaced");
  return rows;
}

export function summarize(rows) {
  const attemptKinds = new Set([
    "read-attempt",
    "pathB-range-error-first-attempt",
    "pathB-range-boundary",
    "pathB-range-retry-original-goal",
    "pathB-nonrecovery-range",
    "range-eof-outside",
  ]);
  const attempts = rows.filter(row => attemptKinds.has(row.kind));
  const partitions = {};
  for (const row of rows) {
    const key = `${row.partition ?? "unpartitioned"}/${row.family ?? "unfiled"}`;
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
      kind: row.kind,
      mode: row.rangeMode ?? row.subRequest?.mode ?? row.rootGoal?.mode ?? null,
      conditions: row.conditions ?? { requested_range_obtained: row.requestedRangeObtained ?? null },
      originalRootObtained: row.originalRootObtained ?? null,
      subRequestObtained: row.subRequestObtained ?? null,
    })),
    boundaries: {
      rangeRecovery: "a corrected sub-request never counts as the original root succeeding; the original goal is re-evaluated unchanged and stays unsatisfied when the range is impossible",
      reference: "a fixed-Reference root is not restored by a path rebind that yields a new inode; that is a different target, allowed only for a path root that explicitly names the object and re-validates eligibility",
      contentChange: "content change is proved by direct reread bytes only; ctime is metadata evidence; sessionRevision unchanged is not an error",
      legacyTeacher: "the legacy comparison is scoped to the E branch: its up_to rule is bytesRead===length or (short && eof). No size precheck is claimed for the old full chain (R qualification / pre-read gate), which is UNVERIFIED because the historical source is no longer available; a fabricated offset+length<=size precheck is withdrawn",
    },
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
