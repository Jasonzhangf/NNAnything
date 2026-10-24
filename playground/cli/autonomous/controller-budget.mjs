// Public consumer for the C-A1 P1 budget contract.
// Runs the content-bytes root goal through the public entry under several
// RecursiveGoalLimits and reports the generic control result. It never assumes
// a default profile: the real trained candidate must be supplied explicitly.
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profilePath = process.env.NN_CLI_COMMAND_PROFILE;
if (profilePath === undefined || profilePath.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required; no candidate default is allowed");
}
const module = await import("nnanything/cli-goal");
const profile = JSON.parse(await readFile(profilePath, "utf8"));

const root = await realpath(await mkdtemp(join(tmpdir(), "nn-cli-controller-budget-")));
const sessionEffects = Object.freeze(["filesystem.read", "process.exec", "session.write"]);

const sandbox = await module.createCliFilesystemSandbox({
  root,
  ownerGrantedEffects: ["filesystem.write"],
  recipe: {
    scenarioId: "cli-autonomous-controller-budget",
    entries: [
      { path: "work", kind: "directory" },
      { path: "work/a.txt", kind: "file", contents: "alpha" },
    ],
    sessions: [{
      id: "s",
      cwd: "work",
      grantedEffects: sessionEffects,
    }],
  },
});
const session = sandbox.bindSession("s");

function contentBytesGoal(expectedBase64, range = { offset: 0, length: 5 }) {
  return {
    kind: "file.property",
    property: "file.property.content.bytes",
    target: {
      kind: "cli.file-query",
      relation: "entrySelector",
      selector: { type: "regular" },
      cardinality: "one",
    },
    requirement: { kind: "equals", range, expectedBase64 },
  };
}

const cases = [
  { id: "B1", name: "invalid-budget-nan", limits: { maxTransitions: NaN, maxDepth: 4, maxDerivedGoals: 4 } },
  { id: "B2", name: "zero-transition-boundary", limits: { maxTransitions: 0, maxDepth: 4, maxDerivedGoals: 4 } },
  { id: "B3", name: "transition-exhausted", limits: { maxTransitions: 1, maxDepth: 4, maxDerivedGoals: 4 } },
  { id: "B4", name: "depth-constrained", limits: { maxTransitions: 17, maxDepth: 0, maxDerivedGoals: 4 } },
  { id: "B5", name: "derived-goal-constrained", limits: { maxTransitions: 17, maxDepth: 4, maxDerivedGoals: 0 } },
  // Three independent atomic dispatches (ls, entry.inspect, deterministic file.read) plus the
  // root frame need 17 transitions in the shared controller. The positive budget is defined by
  // that real requirement, not by a fixed number chosen to fit the test.
  { id: "B6", name: "baseline-satisfied", limits: { maxTransitions: 17, maxDepth: 4, maxDerivedGoals: 4 } },
  { id: "B7", name: "one-below-real-budget-fails", limits: { maxTransitions: 16, maxDepth: 4, maxDerivedGoals: 4 } },
];

const results = [];
const failures = [];

function isRunResult(response) {
  return typeof response === "object" && response !== null && response.kind === "run_result";
}

function readStepOf(result) {
  return result.domain.steps.find(step => step.operation === "file.read") ?? null;
}

function report(result, limits) {
  const response = result.response;
  const readStep = readStepOf(result);
  return {
    id: result.id,
    name: result.name,
    status: result.domain.status,
    reason: result.domain.reason,
    executions: result.domain.executorInvocationCount,
    policyStepCount: result.domain.policyStepCount,
    heads: result.domain.steps.map(step => step.selectedHead),
    readStep: readStep === null
      ? null
      : {
          decisionMechanism: readStep.decisionMechanism,
          selectedHead: readStep.selectedHead,
          operation: readStep.operation,
        },
    responseKind: response === null ? null : response.kind,
    control: isRunResult(response) ? response.report.control : null,
    budgetUsed: isRunResult(response) ? response.report.budgetUsed : null,
    rootEvaluation: isRunResult(response) ? response.report.rootEvaluation : null,
  };
}

try {
  const scope = await sandbox.bindDirectory(session, ".");
  for (const item of cases) {
    const result = await module.runCliAutonomousGoal({
      goal: contentBytesGoal("YWxwaGE="),
      resources: {
        sandbox,
        session,
        profile,
        grantedEffects: sessionEffects,
        scope,
        budget: item.limits,
      },
    });
    results.push(Object.freeze({ id: item.id, name: item.name, result, limits: item.limits }));
  }

  for (const { id, name, result, limits } of results) {
    const receipt = report(result, limits);
    const readStep = readStepOf(result);
    if (readStep !== null) {
      const mechanismOk = readStep.decisionMechanism === "deterministic_exec" && readStep.selectedHead === null;
      if (!mechanismOk) {
        failures.push(`${id}: file.read step is not deterministic_exec/selectedHead null`);
      }
    }

    const satisfied = result.domain.status === "satisfied";
    const budgetish = /budget|transition|derived|depth/i.test(result.domain.reason);
    if (id === "B1") {
      if (satisfied) failures.push("B1: NaN budget must not be satisfied");
      if (result.response === null || result.response.kind !== "request_rejected") {
        failures.push("B1: NaN budget must be rejected at admission, not run");
      }
    } else if (id === "B2") {
      if (satisfied) failures.push("B2: zero-transition budget must not be satisfied");
      if (result.domain.executorInvocationCount !== 0) failures.push("B2: zero executions expected");
      if (!budgetish) failures.push("B2: budget-exhausted reason expected");
    } else if (id === "B3") {
      if (satisfied) failures.push("B3: exhausted budget must not be satisfied");
      if (result.domain.executorInvocationCount > 1) failures.push("B3: at most one execution expected");
      if (!budgetish) failures.push("B3: budget-exhausted reason expected");
    } else if (id === "B4") {
      if (satisfied) failures.push("B4: zero depth must not be satisfied");
    } else if (id === "B5") {
      if (satisfied) failures.push("B5: zero derived-goal budget must not be satisfied");
    } else if (id === "B6") {
      if (!satisfied) failures.push("B6: baseline must be satisfied");
      if (result.domain.executorInvocationCount < 3) failures.push("B6: at least three executions expected");
      if (!isRunResult(result.response)) failures.push("B6: generic run_result response expected");
      if (isRunResult(result.response) && result.response.report.budgetUsed.transitionsUsed <= result.domain.steps.length) {
        failures.push("B6: budget usage must come from the generic controller, not steps.length");
      }
      const heads = result.domain.steps.map(step => step.selectedHead);
      if (JSON.stringify(heads) !== JSON.stringify(["ls", "entry.inspect", null])) {
        failures.push(`B6: expected independent ls / entry.inspect / deterministic read dispatch, got ${JSON.stringify(heads)}`);
      }
    } else if (id === "B7") {
      if (satisfied) failures.push("B7: one transition below the real requirement must not be satisfied");
      if (result.domain.executorInvocationCount !== 3) {
        failures.push(`B7: the three real executions happen and the failure lands on the root transition, got ${result.domain.executorInvocationCount}`);
      }
      if (!budgetish) failures.push("B7: budget-exhausted reason expected");
    }

    process.stdout.write(`${JSON.stringify({ case: receipt, limits })} \n`);
  }

  const summary = {
    consumer: "controller-budget",
    profile: profilePath,
    passed: results.length - failures.length,
    failed: failures.length,
    failures,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await sandbox.cleanup();
  await rm(root, { recursive: true, force: true });
}

if (failures.length !== 0) {
  process.exitCode = 1;
}
