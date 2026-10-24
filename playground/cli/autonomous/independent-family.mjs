// C-A1 independent scenario family for the autonomous CLI goal entry.
//
// Independence contract:
// - Public surface only: `nnanything/cli-goal` exports plus `node:` built-ins.
// - No fixture reuse from consumer.mjs or the repository tests.
// - Fresh mkdtemp root per case, with its own scenario id, names and contents.
// - Real command-policy weights are required explicitly through
//   NN_CLI_COMMAND_PROFILE; no embedded default is accepted.

import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_COMMAND_HEADS,
  createCliFilesystemSandbox,
  createEvidenceAuthority,
  runCliAutonomousGoal,
  validateCliCommandProfile,
} from "nnanything/cli-goal";

const SESSION_EFFECTS = Object.freeze(["filesystem.read", "process.exec", "session.write"]);
const OWNER_EFFECTS = Object.freeze(["filesystem.read", "filesystem.write"]);
const READ_ONLY_EFFECTS = Object.freeze(["filesystem.read"]);
const NO_EFFECTS = Object.freeze([]);
const POLICY_HEADS = new Set(CLI_COMMAND_HEADS);

const weightsPath = process.env.NN_CLI_COMMAND_PROFILE;
if (!weightsPath) {
  console.error("NN_CLI_COMMAND_PROFILE must point to a real cli.command-policy.v1 weights file");
  process.exit(1);
}

let profile;
try {
  profile = validateCliCommandProfile(JSON.parse(await readFile(weightsPath, "utf8")));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`failed to load command policy from ${weightsPath}: ${message}`);
  process.exit(1);
}

let scenarioCounter = 0;

function nextScenarioId(slug) {
  scenarioCounter += 1;
  return `ca1-${slug}-${scenarioCounter}`;
}

async function makeScenario({ slug, entries, cwd = "." }) {
  const root = await mkdtemp(join(tmpdir(), "ca1-independent-"));
  try {
    const sandbox = await createCliFilesystemSandbox({
      root,
      recipe: {
        scenarioId: nextScenarioId(slug),
        entries,
        sessions: [{ id: "shell", cwd, grantedEffects: SESSION_EFFECTS }],
      },
      ownerGrantedEffects: OWNER_EFFECTS,
    });
    return { root, sandbox, session: sandbox.bindSession("shell") };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function emptyState(session) {
  return { session: session.sessionId, cwdObservation: null, directoryListing: null };
}

function encode(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function observationOf(receipt) {
  const execution = receipt?.execution;
  if (receipt?.status !== "succeeded" || execution?.status !== "succeeded") {
    throw new Error(`sandbox call failed: ${JSON.stringify(execution?.error ?? receipt)}`);
  }
  return { observation: execution.observation, runId: execution.runId };
}

async function trustedCwdState(sandbox, session) {
  const receipt = await sandbox.execute({ operation: "cwd.get", parameters: { session } });
  const { observation, runId } = observationOf(receipt);
  const revision = sandbox.getSession(session).revision;
  const authority = createEvidenceAuthority();
  authority.record({ kind: "pwd", session: session.sessionId, revision, runId, observation });
  return {
    initialState: {
      session: session.sessionId,
      cwdObservation: { physicalCwd: observation.physicalCwd, evidence: observation, revision, sourceRun: runId },
      directoryListing: null,
    },
    authority,
  };
}

function observedThisRunRequirement() {
  return { kind: "observed", freshness: "this_run" };
}

function equalsCwdRequirement(expected) {
  return { kind: "equals", expected };
}

function cwdGoal(session, requirement) {
  return {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: { kind: "cli.file-query", relation: "sessionCwd", session },
    requirement,
  };
}

function contentBytesGoal({ offset, length, expectedBase64 }) {
  return {
    kind: "file.property",
    property: "file.property.content.bytes",
    target: {
      kind: "cli.file-query",
      relation: "entrySelector",
      selector: { type: "regular" },
      cardinality: "one",
    },
    requirement: { kind: "equals", range: { offset, length }, expectedBase64 },
  };
}

function mismatch(label, actualValue, expectedValue) {
  return Object.is(actualValue, expectedValue)
    ? null
    : `${label}: expected ${JSON.stringify(expectedValue)} got ${JSON.stringify(actualValue)}`;
}

function mismatchArray(label, actualValue, expectedValue) {
  return JSON.stringify(actualValue) === JSON.stringify(expectedValue)
    ? null
    : `${label}: expected ${JSON.stringify(expectedValue)} got ${JSON.stringify(actualValue)}`;
}

function truthy(label, value) {
  return value ? null : `${label}: expected truthy got ${JSON.stringify(value)}`;
}

function endsWith(label, value, suffix) {
  return typeof value === "string" && value.endsWith(suffix)
    ? null
    : `${label}: expected suffix ${JSON.stringify(suffix)} got ${JSON.stringify(value)}`;
}

function collect(...faults) {
  return faults.filter(Boolean);
}

function stepSummary(step) {
  return {
    phase: step.phase,
    decisionMechanism: step.decisionMechanism,
    selectedHead: step.selectedHead,
    operation: step.operation,
    executorInvoked: step.executorInvoked,
    status: step.status,
    reason: step.reason,
  };
}

// The trained policy may select a registered head. Only the deterministic
// `file.read` harness step may skip the head and run without one.
function mechanismFaults(steps) {
  const faults = [];
  for (const step of steps ?? []) {
    if (step.decisionMechanism === "trained_policy_v1") {
      if (step.selectedHead === null || !POLICY_HEADS.has(step.selectedHead)) {
        faults.push(
          `step ${step.stepIndex}: trained_policy_v1 requires a registered head, got ${JSON.stringify(step.selectedHead)}`,
        );
      }
      if (step.operation === "file.read") {
        faults.push(`step ${step.stepIndex}: file.read must not be labelled trained_policy_v1`);
      }
    } else if (step.decisionMechanism === "deterministic_exec") {
      if (step.selectedHead !== null) {
        faults.push(
          `step ${step.stepIndex}: deterministic_exec requires selectedHead === null, got ${JSON.stringify(step.selectedHead)}`,
        );
      }
    } else {
      faults.push(`step ${step.stepIndex}: unknown decisionMechanism ${JSON.stringify(step.decisionMechanism)}`);
    }
  }
  return faults;
}

const cases = [
  {
    name: "cwd-observed-tide",
    expected: { family: "session_cwd_observed", status: "satisfied", reason: "satisfied", executions: 1 },
    async prepare() {
      const scenario = await makeScenario({
        slug: "tide",
        cwd: "tide",
        entries: [
          { path: "tide", kind: "directory" },
          { path: "tide/harbour.txt", kind: "file", contents: "quiet water at dawn" },
        ],
      });
      const goal = cwdGoal(scenario.session, observedThisRunRequirement());
      return {
        root: scenario.root,
        base: scenario.sandbox,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: scenario.sandbox,
              session: scenario.session,
              profile,
              grantedEffects: SESSION_EFFECTS,
            },
          }),
      };
    },
    extra(result) {
      const [step] = result.domain.steps;
      return collect(
        mismatch("selectedHead", step?.selectedHead, "pwd"),
        mismatch("executorInvoked", step?.executorInvoked, true),
        endsWith("cwdObservation.physicalCwd", result.domain.cwdObservation?.physicalCwd, "/tide"),
      );
    },
  },
  {
    name: "cwd-equals-standing-lighthouse",
    expected: { family: "session_cwd_equals", status: "satisfied", reason: "satisfied", executions: 0 },
    async prepare() {
      const scenario = await makeScenario({
        slug: "lighthouse",
        cwd: "lighthouse",
        entries: [
          { path: "lighthouse", kind: "directory" },
          { path: "lighthouse/beam.txt", kind: "file", contents: "steady light" },
        ],
      });
      const expectedDir = await scenario.sandbox.bindDirectory(scenario.session, ".");
      const { initialState, authority } = await trustedCwdState(scenario.sandbox, scenario.session);
      const goal = cwdGoal(scenario.session, equalsCwdRequirement(expectedDir));
      return {
        root: scenario.root,
        base: scenario.sandbox,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: scenario.sandbox,
              session: scenario.session,
              profile,
              grantedEffects: SESSION_EFFECTS,
              initialState,
              authority,
            },
          }),
      };
    },
    extra(result) {
      const [step] = result.domain.steps;
      return collect(
        mismatch("initialStateStatus", result.domain.initialStateStatus, "trusted"),
        mismatch("noopSatisfied", result.domain.noopSatisfied, true),
        mismatch("stepCount", result.domain.steps.length, 1),
        mismatch("selectedHead", step?.selectedHead, "NOOP"),
        mismatch("executorInvoked", step?.executorInvoked, false),
      );
    },
  },
  {
    name: "cwd-equals-move-relay",
    expected: { family: "session_cwd_equals", status: "satisfied", reason: "satisfied", executions: 2 },
    async prepare() {
      const scenario = await makeScenario({
        slug: "relay",
        cwd: "signal",
        entries: [
          { path: "signal", kind: "directory" },
          { path: "signal/bell.txt", kind: "file", contents: "ring once" },
          { path: "signal/relay", kind: "directory" },
        ],
      });
      const expectedDir = await scenario.sandbox.bindDirectory(scenario.session, "relay");
      const resolved = await scenario.sandbox.resolveDirectory(expectedDir);
      const goal = cwdGoal(scenario.session, equalsCwdRequirement(expectedDir));
      return {
        root: scenario.root,
        base: scenario.sandbox,
        expectedPhysical: resolved.physicalPath,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: scenario.sandbox,
              session: scenario.session,
              profile,
              grantedEffects: SESSION_EFFECTS,
            },
          }),
      };
    },
    extra(result, prepared) {
      return collect(
        mismatchArray(
          "selectedHeads",
          result.domain.steps.map((step) => step.selectedHead),
          ["pwd", "cd"],
        ),
        mismatch("cwdObservation.physicalCwd", result.domain.cwdObservation?.physicalCwd, prepared.expectedPhysical),
      );
    },
  },
  {
    name: "entries-observed-ledger",
    expected: { family: "directory_entries_observed", status: "satisfied", reason: "satisfied", executions: 1 },
    async prepare() {
      const scenario = await makeScenario({
        slug: "ledger",
        cwd: ".",
        entries: [
          { path: "ledger", kind: "directory" },
          { path: "ledger/receipt.txt", kind: "file", contents: "paid in full" },
          { path: "ledger/archive", kind: "directory" },
        ],
      });
      const scope = await scenario.sandbox.bindDirectory(scenario.session, "ledger");
      const goal = {
        kind: "file.property",
        property: "file.property.directory.entries",
        target: scope,
        requirement: observedThisRunRequirement(),
      };
      return {
        root: scenario.root,
        base: scenario.sandbox,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: scenario.sandbox,
              session: scenario.session,
              profile,
              grantedEffects: SESSION_EFFECTS,
            },
          }),
      };
    },
    extra(result) {
      const listing = result.domain.directoryListing;
      const names = (listing?.entries ?? []).map((entry) => entry.name).sort();
      const [step] = result.domain.steps;
      return collect(
        mismatch("selectedHead", step?.selectedHead, "ls"),
        endsWith("directoryListing.path", listing?.path, "/ledger"),
        mismatchArray("directoryListing.names", names, ["archive", "receipt.txt"]),
      );
    },
  },
  {
    name: "content-hit-atlas",
    expected: { family: "content_bytes_equals", status: "satisfied", reason: "satisfied", executions: 3 },
    async prepare() {
      const scenario = await makeScenario({
        slug: "atlas",
        cwd: ".",
        entries: [
          { path: "atlas", kind: "directory" },
          { path: "atlas/orbit.dat", kind: "file", contents: "tide-rises-over-quiet-harbor" },
        ],
      });
      const scope = await scenario.sandbox.bindDirectory(scenario.session, "atlas");
      const goal = contentBytesGoal({ offset: 0, length: 5, expectedBase64: encode("tide-") });
      return {
        root: scenario.root,
        base: scenario.sandbox,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: scenario.sandbox,
              session: scenario.session,
              profile,
              scope,
              fileName: "orbit.dat",
              grantedEffects: SESSION_EFFECTS,
            },
          }),
      };
    },
    extra(result) {
      const receipt = result.domain.readReceipt;
      const readStep = result.domain.steps[2];
      return collect(
        mismatch("readReceipt.operation", receipt?.operation, "file.read"),
        mismatch("readReceipt.offset", receipt?.offset, 0),
        mismatch("readReceipt.length", receipt?.length, 5),
        mismatch("readReceipt.bytesRead", receipt?.bytesRead, 5),
        mismatch("readStep.decisionMechanism", readStep?.decisionMechanism, "deterministic_exec"),
        mismatch("readStep.selectedHead", readStep?.selectedHead, null),
        mismatch("readStep.operation", readStep?.operation, "file.read"),
      );
    },
  },
  {
    name: "content-miss-quarry",
    expected: { family: "content_bytes_equals", status: "failed", reason: "content_mismatch", executions: 3 },
    async prepare() {
      const scenario = await makeScenario({
        slug: "quarry",
        cwd: "quarry",
        entries: [
          { path: "quarry", kind: "directory" },
          { path: "quarry/vein.bin", kind: "file", contents: "granite-veins-run-deep" },
        ],
      });
      const scope = await scenario.sandbox.bindDirectory(scenario.session, ".");
      const goal = contentBytesGoal({ offset: 3, length: 6, expectedBase64: encode("xxxxxx") });
      return {
        root: scenario.root,
        base: scenario.sandbox,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: scenario.sandbox,
              session: scenario.session,
              profile,
              scope,
              fileName: "vein.bin",
              grantedEffects: SESSION_EFFECTS,
            },
          }),
      };
    },
    extra(result) {
      const receipt = result.domain.readReceipt;
      return collect(
        truthy("readReceipt", receipt),
        mismatch("readReceipt.operation", receipt?.operation, "file.read"),
        mismatch("readReceipt.offset", receipt?.offset, 3),
        mismatch("readReceipt.length", receipt?.length, 6),
        mismatch("readReceipt.bytesRead", receipt?.bytesRead, 6),
      );
    },
  },
  {
    name: "unsupported-links-harbor",
    expected: { family: "unsupported_property", status: "rejected", reason: "unsupported_property", executions: 0 },
    async prepare() {
      const scenario = await makeScenario({
        slug: "harbor",
        cwd: ".",
        entries: [{ path: "harbor", kind: "directory" }],
      });
      const goal = {
        kind: "file.property",
        property: "file.property.links",
        target: { kind: "cli.file-query", relation: "sessionCwd", session: scenario.session },
        requirement: observedThisRunRequirement(),
      };
      return {
        root: scenario.root,
        base: scenario.sandbox,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: scenario.sandbox,
              session: scenario.session,
              profile,
              grantedEffects: SESSION_EFFECTS,
            },
          }),
      };
    },
    extra(result) {
      const [step] = result.domain.steps;
      return collect(
        mismatch("selectedHead", step?.selectedHead, "unsupported"),
        mismatch("executorInvoked", step?.executorInvoked, false),
      );
    },
  },
  {
    name: "permission-cd-denied-dock",
    expected: { family: "session_cwd_equals", status: "rejected", reason: "permission_denied", executions: 0 },
    async prepare() {
      const scenario = await makeScenario({
        slug: "dock",
        cwd: "dock",
        entries: [
          { path: "dock", kind: "directory" },
          { path: "dock/berth", kind: "directory" },
          { path: "dock/open-sea", kind: "directory" },
        ],
      });
      const expectedDir = await scenario.sandbox.bindDirectory(scenario.session, "open-sea");
      const { initialState, authority } = await trustedCwdState(scenario.sandbox, scenario.session);
      const goal = cwdGoal(scenario.session, equalsCwdRequirement(expectedDir));
      return {
        root: scenario.root,
        base: scenario.sandbox,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: scenario.sandbox,
              session: scenario.session,
              profile,
              grantedEffects: READ_ONLY_EFFECTS,
              initialState,
              authority,
            },
          }),
      };
    },
    extra(result) {
      const [step] = result.domain.steps;
      return collect(
        mismatch("stepCount", result.domain.steps.length, 1),
        mismatch("selectedHead", step?.selectedHead, "cd"),
        mismatch("executorInvoked", step?.executorInvoked, false),
      );
    },
  },
  {
    name: "lexical-absolute-cartography",
    expected: { family: "atomic_file_property", status: "satisfied", reason: "satisfied", executions: 1 },
    async prepare() {
      const scenario = await makeScenario({
        slug: "cartography",
        cwd: ".",
        entries: [{ path: "cartography", kind: "directory" }],
      });
      const base = scenario.sandbox.bindPath(scenario.session, join(scenario.sandbox.scenarioRoot, "cartography"));
      const goal = {
        kind: "file.property",
        property: "file.property.path.absolute",
        target: { kind: "cli.path-query", base, input: "regions/./coast/../ridge" },
        requirement: observedThisRunRequirement(),
      };
      return {
        root: scenario.root,
        base: scenario.sandbox,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: scenario.sandbox,
              session: scenario.session,
              profile,
              grantedEffects: NO_EFFECTS,
            },
          }),
      };
    },
    extra(result) {
      const [step] = result.domain.steps;
      return collect(
        mismatch("selectedHead", step?.selectedHead, "path.resolve"),
        mismatch("executorInvoked", step?.executorInvoked, true),
        endsWith(
          "pathKnowledge.absolutePath",
          result.domain.state.pathKnowledge?.absolutePath,
          "/cartography/regions/ridge",
        ),
      );
    },
  },
  {
    name: "object-swap-cavern",
    expected: { family: "content_bytes_equals", status: "failed", reason: "object_changed", executions: 2 },
    async prepare() {
      const replacement = "REPLACED-INODE-RECORD";
      const scenario = await makeScenario({
        slug: "cavern",
        cwd: ".",
        entries: [
          { path: "cavern", kind: "directory" },
          { path: "cavern/anchor.dat", kind: "file", contents: "limestone-anchor-chain" },
        ],
      });
      const scope = await scenario.sandbox.bindDirectory(scenario.session, "cavern");
      const targetPath = join(scenario.sandbox.scenarioRoot, "cavern", "anchor.dat");
      const stagingPath = join(scenario.sandbox.scenarioRoot, "cavern", ".pending-inode");
      let swapped = false;
      // Replace the object only after entry.inspect and before bindFile, then
      // delegate to the real binding so the identity comparison can reject it.
      const wrapped = {
        ...scenario.sandbox,
        bindFile: async (sessionRef, entryPath) => {
          if (!swapped) {
            swapped = true;
            await writeFile(stagingPath, replacement);
            await rename(stagingPath, targetPath);
          }
          return scenario.sandbox.bindFile(sessionRef, entryPath);
        },
      };
      const goal = contentBytesGoal({ offset: 0, length: 5, expectedBase64: encode("limes") });
      return {
        root: scenario.root,
        base: scenario.sandbox,
        swapped: () => swapped,
        replacement,
        run: () =>
          runCliAutonomousGoal({
            goal,
            resources: {
              sandbox: wrapped,
              session: scenario.session,
              profile,
              scope,
              fileName: "anchor.dat",
              grantedEffects: SESSION_EFFECTS,
            },
          }),
      };
    },
    extra(result, prepared) {
      return collect(
        mismatch("swapped", prepared.swapped(), true),
        mismatch("readReceipt", result.domain.readReceipt, null),
        mismatch("stepCount", result.domain.steps.length, 3),
        mismatchArray(
          "selectedHeads",
          result.domain.steps.map((step) => step.selectedHead),
          ["ls", "entry.inspect", null],
        ),
        mismatch("replacement-leaked", JSON.stringify(result).includes(prepared.replacement), false),
      );
    },
  },
];

function evaluate(spec, result, prepared) {
  const domain = result.domain;
  const expected = spec.expected;
  const faults = [
    ...mechanismFaults(domain.steps),
    mismatch("family", domain.family, expected.family),
    mismatch("status", domain.status, expected.status),
    mismatch("reason", domain.reason, expected.reason),
    mismatch("executions", domain.executorInvocationCount, expected.executions),
    ...(spec.extra?.(result, prepared) ?? []),
  ].filter(Boolean);

  const line = {
    case: spec.name,
    family: expected.family,
    expected: { status: expected.status, reason: expected.reason, executions: expected.executions },
    actual: {
      family: domain.family,
      status: domain.status,
      reason: domain.reason,
      executions: domain.executorInvocationCount,
      initialStateStatus: domain.initialStateStatus,
      noopSatisfied: domain.noopSatisfied,
      policyStepCount: domain.policyStepCount,
      cwdPhysical: domain.cwdObservation?.physicalCwd ?? null,
      directoryPath: domain.directoryListing?.path ?? null,
      directoryEntries: (domain.directoryListing?.entries ?? []).map((entry) => entry.name),
      pathAbsolute: domain.state?.pathKnowledge?.absolutePath ?? null,
      readReceipt: domain.readReceipt
        ? {
            operation: domain.readReceipt.operation,
            offset: domain.readReceipt.offset,
            length: domain.readReceipt.length,
            bytesRead: domain.readReceipt.bytesRead,
            eof: domain.readReceipt.eof,
            observedObject: domain.readReceipt.observedObject,
          }
        : null,
      steps: domain.steps.map(stepSummary),
    },
    ok: faults.length === 0,
  };
  if (faults.length > 0) {
    line.faults = faults;
  }
  return line;
}

function addFault(line, fault) {
  line.ok = false;
  line.faults = Array.isArray(line.faults) ? [...line.faults, fault] : [fault];
}

async function executeCase(spec) {
  let prepared;
  let line;
  try {
    prepared = await spec.prepare();
    line = evaluate(spec, await prepared.run(), prepared);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    line = {
      case: spec.name,
      family: spec.expected.family,
      expected: {
        status: spec.expected.status,
        reason: spec.expected.reason,
        executions: spec.expected.executions,
      },
      actual: { error: message },
      ok: false,
      faults: [error instanceof Error ? (error.stack ?? message) : message],
    };
  }

  if (prepared) {
    try {
      await prepared.base.cleanup();
    } catch (error) {
      addFault(line, `cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await rm(prepared.root, { recursive: true, force: true });
    } catch (error) {
      addFault(line, `temp-removal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return line;
}

const lines = [];
for (const spec of cases) {
  const line = await executeCase(spec);
  lines.push(line);
  console.log(JSON.stringify(line));
}

const passed = lines.filter((line) => line.ok).length;
const failed = lines.length - passed;
const summary = { cases: lines.length, passed, failed, exitCode: failed === 0 ? 0 : 1 };
console.log(JSON.stringify(summary));
process.exitCode = summary.exitCode;
