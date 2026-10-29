// Public consumer for the optional-budget contract. It only uses package
// exports, a real trained CLI profile and real filesystem sandboxes.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const { runRecursiveGoal } = await import("nnanything/recursive-goal");
const { createCliFilesystemSandbox, runCliEntrySearchGoal } = await import(
  "nnanything/cli-search"
);
const { runCliReadCompositionGoal } = await import("nnanything/cli-read");
const { runCliContentSearchGoal } = await import("nnanything/cli-content-search");
const { migrateCliCommandProfileToCurrent } = await import("nnanything/cli-goal");

const profilePath = process.env.NN_CLI_COMMAND_PROFILE;
if (profilePath === undefined || profilePath.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE is required");
}
const rawProfile = JSON.parse(await readFile(profilePath, "utf8"));
const profile = migrateCliCommandProfileToCurrent(rawProfile);

function goal(target, threshold = 100) {
  return { kind: "counter", target, threshold };
}

function skill(id, mode) {
  return {
    id,
    version: "1.0.0",
    mode,
    capability: "counter.increment",
    evaluatorId: "counter-evaluator",
    requiredEffects: [],
    allowedEffects: [],
    retry: "never",
    effectClass: "none",
  };
}

function evaluation(input) {
  const count = input.state?.count ?? 0;
  const target = input.goal?.target ?? 0;
  const satisfied = count >= target;
  return {
    evaluatorId: "counter-evaluator",
    result: satisfied ? "satisfied" : "unsatisfied",
    satisfaction: satisfied ? 100 : 0,
    necessaryConditionsMet: satisfied,
    evidenceRefs: input.evidence
      .filter((item) => item.validity === "valid")
      .map((item) => item.id),
  };
}

function atomicReceipt(count, sequence) {
  return {
    runId: `optional-budget-run-${sequence}`,
    executorInvoked: true,
    outcome: "succeeded",
    sourceResult: { tag: "optional-budget.counter", value: { count } },
    newState: { id: `optional-budget-state-${sequence}`, value: { count } },
    evidence: [
      {
        id: `optional-budget-evidence-${sequence}`,
        stateRef: `optional-budget-state-${sequence}`,
        payload: { count },
        validity: "valid",
      },
    ],
    executionErrors: [],
    verificationErrors: [],
    effect: { knowledge: "none", confirmedEffects: [], receiptRef: null },
  };
}

function incrementalHarness({ rounds, rootTarget, limits }) {
  const calls = { derive: 0, executeAtomic: 0 };
  const adapter = {
    async validateRequest(request) {
      return {
        requestId: request.requestId,
        rootGoal: request.rootGoal,
        satisfactionThreshold: request.satisfactionThreshold,
        rootBindings: request.rootBindings,
        state: request.state,
        rootEvaluatorId: request.rootEvaluatorId,
        rootSelectorId: request.rootSelectorId,
        ...(request.limits === undefined ? {} : { limits: request.limits }),
        continuation: request.continuation ?? null,
      };
    },
    supports: (input) => input.goal?.kind === "counter",
    async evaluate(input) {
      calls.evaluate = (calls.evaluate ?? 0) + 1;
      return evaluation(input);
    },
    async select(input) {
      return input.candidates[0]
        ? { kind: "selected", skillId: input.candidates[0].id }
        : { kind: "defer", reason: "no candidate" };
    },
    async derive(input) {
      calls.derive += 1;
      if (calls.derive > rounds) throw new TypeError("derive rounds exhausted");
      const current = input.state?.count ?? 0;
      return {
        conditions: [
          {
            id: `optional-budget-step-${calls.derive}`,
            goal: goal(current + 1),
            bindings: input.bindings,
            satisfactionThreshold: 100,
            evaluatorId: "counter-evaluator",
            selectorId: "leaf-selector",
            mode: "atomic",
            dependsOn: [],
            lifetime: "stage",
            activation: "required",
            allowedEffects: [],
          },
        ],
        nextCursor: "open",
        expansion: "more",
      };
    },
    async executeAtomic(input) {
      calls.executeAtomic += 1;
      return atomicReceipt((input.state?.count ?? 0) + 1, calls.executeAtomic);
    },
    validateAtomicReceipt: (raw) => raw,
    measureProgress(input) {
      return {
        improved: (input.after?.count ?? 0) > (input.before?.count ?? 0),
        reason: "facts_improved",
        comparable: true,
      };
    },
  };
  const request = {
    schema: "nnanything.recursive-goal.request.v1",
    requestId: `optional-budget-${rounds}-${rootTarget}`,
    rootGoal: goal(rootTarget),
    satisfactionThreshold: 100,
    rootBindings: { scope: "optional-budget-consumer" },
    state: { count: 0 },
    rootEvaluatorId: "counter-evaluator",
    rootSelectorId: "root-selector",
    ...(limits === undefined ? {} : { limits }),
  };
  const dependencies = {
    adapter,
    enabledSkills: [
      skill("compose-counter", "composite"),
      skill("increment-counter", "atomic"),
    ],
    enabledEvaluators: [
      {
        id: "counter-evaluator",
        goalType: "counter",
        thresholdContract: "0..100",
        allowsPartialSatisfaction: false,
      },
    ],
    selectors: [
      { id: "root-selector", skillIds: ["compose-counter"] },
      { id: "leaf-selector", skillIds: ["increment-counter"] },
    ],
    comparators: {
      sameGoal: isDeepStrictEqual,
      sameBindings: isDeepStrictEqual,
      sameFacts: isDeepStrictEqual,
    },
    grantedEffects: new Set(),
  };
  return { request, dependencies, calls };
}

function summarize(response) {
  const report = response?.report ?? null;
  return {
    kind: response?.kind ?? null,
    error: response?.error?.code ?? null,
    control: report?.control ?? null,
    rootEvaluation: report?.rootEvaluation ?? null,
    budgetUsed: report?.budgetUsed ?? null,
    primaryErrorId: report?.primaryErrorId ?? null,
    errors: report?.errors?.map((error) => error.code) ?? [],
  };
}

const results = [];

async function runRecursiveCase(id, options) {
  const harness = incrementalHarness(options);
  const response = await runRecursiveGoal(harness.request, harness.dependencies);
  const summary = summarize(response);
  results.push({
    id,
    omittedLimits: options.limits === undefined,
    limits: options.limits ?? null,
    executions: harness.calls.executeAtomic,
    ...summary,
  });
  return { response, summary, calls: harness.calls };
}

function tempWorld(module, entries, sessions) {
  return mkdtemp(join(tmpdir(), "nn-optional-budget-consumer-")).then(async (root) => {
    const real = await realpath(root);
    const sandbox = await module.createCliFilesystemSandbox({
      root: real,
      ownerGrantedEffects: ["filesystem.write"],
      recipe: {
        scenarioId: "optional-budget-consumer",
        entries,
        sessions,
      },
    });
    const session = sandbox.bindSession("s");
    return { root: real, sandbox, session };
  });
}

async function runEntryCase(id, limits) {
  const world = await tempWorld(
    { createCliFilesystemSandbox },
    [
      { path: "start", kind: "directory" },
      { path: "start/target.txt", kind: "file", contents: "target contents" },
    ],
    [
      {
        id: "s",
        cwd: "start",
        grantedEffects: ["filesystem.read", "process.exec"],
      },
    ],
  );
  try {
    const directory = await world.sandbox.bindDirectoryObject(world.session, ".");
    const response = await runCliEntrySearchGoal(
      {
        requestId: `entry-${id}`,
        goal: {
          kind: "file.property",
          property: "file.property.directory.entries",
          target: directory,
          requirement: {
            kind: "matches",
            predicate: {
              kind: "entrySelector",
              name: "target.txt",
              type: "regular",
              cardinality: "one",
            },
          },
        },
        satisfactionThreshold: 100,
      },
      {
        sandbox: world.sandbox,
        session: world.session,
        profile,
        ...(limits === undefined ? {} : { limits }),
      },
    );
    results.push({
      id,
      omittedLimits: limits === undefined,
      limits: limits ?? null,
      domain: {
        status: response.domain.status,
        resolution: response.domain.resolution,
        satisfaction: response.domain.satisfaction,
        match: response.domain.match?.absolutePath ?? null,
        rootFact: response.domain.rootFact?.kind ?? null,
      },
      preserveControl: response.domain.preserve.control,
      ...summarize(response.response),
    });
  } finally {
    await world.sandbox.cleanup();
    await rm(world.root, { recursive: true, force: true });
  }
}

async function runReadCase(id, limits) {
  const world = await tempWorld(
    { createCliFilesystemSandbox },
    [
      { path: "start", kind: "directory" },
      { path: "start/target.bin", kind: "file", contents: "abcdef" },
    ],
    [
      {
        id: "s",
        cwd: "start",
        grantedEffects: ["filesystem.read", "process.exec"],
      },
    ],
  );
  try {
    const directory = await world.sandbox.bindDirectoryObject(world.session, ".");
    const response = await runCliReadCompositionGoal(
      {
        requestId: `read-${id}`,
        goal: {
          kind: "file.property",
          property: "file.property.content.bytes",
          target: {
            kind: "cli.exact-child",
            directory,
            name: "target.bin",
            requiredType: "regular",
          },
          requirement: {
            kind: "equals",
            range: { offset: 0, length: 6 },
            expectedBase64: Buffer.from("abcdef").toString("base64"),
          },
        },
        satisfactionThreshold: 100,
      },
      {
        sandbox: world.sandbox,
        session: world.session,
        profile,
        ...(limits === undefined ? {} : { limits }),
      },
    );
    results.push({
      id,
      omittedLimits: limits === undefined,
      limits: limits ?? null,
      domain: {
        status: response.domain.status,
        resolution: response.domain.resolution,
        satisfaction: response.domain.satisfaction,
        rootFact: response.domain.rootFact?.kind ?? null,
      },
      preserveControl: response.domain.preserve.control,
      ...summarize(response.response),
    });
  } finally {
    await world.sandbox.cleanup();
    await rm(world.root, { recursive: true, force: true });
  }
}

async function runContentCase(id, limits) {
  const needle = "hunt1234";
  const world = await tempWorld(
    { createCliFilesystemSandbox },
    [
      { path: "scan", kind: "directory" },
      {
        path: "scan/large.ts",
        kind: "file",
        contents: `${"x".repeat(160)}${needle}`,
      },
    ],
    [
      {
        id: "s",
        cwd: "scan",
        grantedEffects: ["filesystem.read", "process.exec"],
      },
    ],
  );
  try {
    const directory = await world.sandbox.bindDirectoryObject(world.session, ".");
    const response = await runCliContentSearchGoal(
      {
        requestId: `content-${id}`,
        goal: {
          kind: "file.property",
          property: "file.property.content.bytes",
          target: {
            kind: "cli.content-search-scope",
            directory,
            fileCondition: { type: "regular", suffix: ".ts" },
            cardinality: "all",
            recursion: "flat",
          },
          requirement: {
            kind: "contains",
            predicate: { kind: "contains", needle, encoding: "utf8" },
          },
        },
        satisfactionThreshold: 100,
      },
      {
        sandbox: world.sandbox,
        session: world.session,
        profile,
        scan: {
          maxBytesPerFile: 65536,
          maxTotalBytes: 262144,
          chunkSize: 8,
          maxDirectoryDepth: 0,
          maxStaleRetries: 1,
        },
        ...(limits === undefined ? {} : { limits }),
      },
    );
    results.push({
      id,
      omittedLimits: limits === undefined,
      limits: limits ?? null,
      domain: {
        status: response.domain.status,
        resolution: response.domain.resolution,
        satisfaction: response.domain.satisfaction,
        bytesReadTotal: response.domain.bytesReadTotal,
        matches: response.domain.matches.length,
        rootFact: response.domain.rootFact?.kind ?? null,
      },
      preserveControl: response.domain.preserve.control,
      ...summarize(response.response),
    });
  } finally {
    await world.sandbox.cleanup();
    await rm(world.root, { recursive: true, force: true });
  }
}

try {
  const omitted = await runRecursiveCase("recursive-omitted-limits", {
    rounds: 120,
    rootTarget: 120,
  });
  assert.equal(omitted.summary.control.outcome, "completed");
  assert.equal(omitted.summary.rootEvaluation.result, "satisfied");
  assert.ok(omitted.summary.budgetUsed.transitionsUsed > 100);
  assert.ok(omitted.summary.budgetUsed.derivedGoalsUsed > 12);

  const zero = await runRecursiveCase("recursive-zero-transitions", {
    rounds: 10,
    rootTarget: 10,
    limits: { maxTransitions: 0, maxDepth: 8, maxDerivedGoals: 8 },
  });
  assert.equal(zero.summary.control.outcome, "exceeded");
  assert.deepEqual(zero.summary.control.budget, {
    dimension: "maxTransitions",
    limit: 0,
    used: 0,
    attempted: 1,
  });
  assert.equal(zero.calls.executeAtomic, 0);

  const partial = await runRecursiveCase("recursive-partial-maxDepth", {
    rounds: 120,
    rootTarget: 120,
    limits: { maxDepth: 8 },
  });
  assert.equal(partial.summary.control.outcome, "completed");
  assert.ok(partial.summary.budgetUsed.transitionsUsed > 100);

  const finite = await runRecursiveCase("recursive-finite-transitions", {
    rounds: 50,
    rootTarget: 50,
    limits: { maxTransitions: 6, maxDepth: 8, maxDerivedGoals: 16 },
  });
  assert.equal(finite.summary.control.outcome, "exceeded");
  assert.deepEqual(finite.summary.control.budget, {
    dimension: "maxTransitions",
    limit: 6,
    used: 6,
    attempted: 7,
  });
  assert.equal(finite.summary.budgetUsed.transitionsUsed, 6);

  await runEntryCase("entry-omitted-limits", undefined);
  await runEntryCase("entry-finite-transitions", {
    maxTransitions: 1,
    maxDepth: 4,
    maxDerivedGoals: 8,
  });
  await runReadCase("read-omitted-limits", undefined);
  await runReadCase("read-finite-transitions", {
    maxTransitions: 2,
    maxDepth: 4,
    maxDerivedGoals: 8,
  });
  await runContentCase("content-omitted-limits", undefined);
  await runContentCase("content-finite-transitions", {
    maxTransitions: 12,
    maxDepth: 8,
    maxDerivedGoals: 4,
  });

  const budgetCases = [
    { id: "entry-finite-transitions", resolution: "budget_exhausted" },
    { id: "read-finite-transitions", resolution: "budget_exhausted" },
    { id: "content-finite-transitions", resolution: "budget_exhausted" },
  ];
  for (const { id, resolution } of budgetCases) {
    const result = results.find(item => item.id === id);
    assert.ok(result, `${id} must run`);
    assert.equal(result.domain.resolution, resolution, `${id} resolution`);
    assert.ok(result.preserveControl?.budget !== undefined, `${id} must expose a typed budget`);
    assert.deepEqual(
      result.preserveControl?.budget,
      result.control?.budget,
      `${id} must preserve the complete typed budget report`,
    );
  }

  for (const result of results) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({ consumer: "optional-budget", cases: results.length, passed: results.length })}\n`,
  );
} catch (error) {
  process.stdout.write(`${JSON.stringify({ consumer: "optional-budget", failure: String(error) })}\n`);
  process.exitCode = 1;
}
