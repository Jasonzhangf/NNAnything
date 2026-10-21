import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  BOUNDED_CASES,
  CWD_DELEGATED_CASES,
  createBoundedCase,
  createBoundedCwdResources,
  createBoundedFiniteResources,
  createSelectorInjection,
  planningDecisions,
  planningUsages,
  reportOf,
  roundTripContinuation,
  uniqueAtomicResults,
} from "./recursive-goal-bounded-fixtures.mjs";
import {
  runBoundedFiniteScenario,
  runBoundedFiniteStep,
} from "../playground/recursive-goal/bounded-finite.mjs";
import { runFiniteSearchScenario } from "../playground/recursive-goal/finite-search.mjs";

const CONSUMER_PATH = fileURLToPath(
  new URL("../playground/recursive-goal/bounded-finite.mjs", import.meta.url),
);
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

test("planning request is executed by the public runtime instead of being rejected at admission", async () => {
  const run = await runBoundedFiniteScenario({
    scenario: "red-first",
    actualBranch: "reject",
    expectedBranch: "reject",
  });
  assert.ok(run.final);
  assert.equal(run.final.kind, "run_result");
  assert.ok(reportOf(run.final).planning);
});

for (const definition of BOUNDED_CASES) {
  test(`${definition.id}: ${definition.title}`, async () => {
    const boundedCase = createBoundedCase(definition.id);
    const run = await runBoundedFiniteScenario(definition.options);
    const final = run.final;
    assert.ok(final, "bounded finite consumer must produce a response");
    const report = reportOf(final);
    const actions = uniqueAtomicResults(run).map(result => result.skillId);
    const oracle = boundedCase.oracle;

    assert.deepEqual(actions, oracle.actions, "action sequence must match the static oracle");

    if (oracle.completed !== undefined) {
      assert.equal(
        report.control.outcome === "completed",
        oracle.completed,
        "terminal control must match the static oracle",
      );
    }
    if (oracle.rootSatisfied !== undefined) {
      assert.equal(
        report.rootEvaluation.state === "evaluated" &&
          report.rootEvaluation.result === "satisfied",
        oracle.rootSatisfied,
        "root satisfaction must match the static oracle",
      );
    }
    if (oracle.noPredictionAfterFirstAction) {
      assert.ok(run.runs.length > 1);
      assert.equal(
        run.runs[0].observation.predictionCalls,
        run.resources.memory.predictCalls,
        "normal reuse or an existing alternate must not invoke the result model again",
      );
    }
    if (oracle.decisionKinds) {
      const kinds = planningDecisions(run).map(decision => decision.kind);
      for (const kind of oracle.decisionKinds) {
        assert.ok(kinds.includes(kind), `planning decisions must include ${kind}`);
      }
    }
    if (oracle.checkpointId) {
      const checkpoint = planningDecisions(run).find(
        decision => decision.kind === "checkpoint_reached",
      );
      assert.equal(checkpoint?.checkpointRef, oracle.checkpointId);
      const index = actions.indexOf(oracle.checkpointAfter);
      assert.ok(index >= 0, "checkpoint-producing action must be present");
      assert.ok(
        report.continuation?.planControl?.verifiedCheckpoints?.some(
          item => item.specRef === oracle.checkpointId,
        ) ??
          run.responses.some(
            item =>
              item.kind === "run_result" &&
              item.report.continuation?.planControl?.verifiedCheckpoints?.some(
                checkpointRecord =>
                  checkpointRecord.specRef === oracle.checkpointId,
              ),
          ),
        "checkpoint verification must reference the observed branch action",
      );
    }
    if (oracle.forbiddenActions) {
      for (const skillId of oracle.forbiddenActions) {
        assert.equal(actions.includes(skillId), false, `${skillId} must not execute`);
      }
    }
    if (oracle.unselectedNotRequired) {
      const active = report.frames.flatMap(frame => [
        ...frame.activeRequirements,
        ...frame.unresolvedRequirements,
      ]);
      assert.equal(
        active.some(ref => ref.includes(oracle.unselectedNotRequired)),
        false,
        "the unselected OR path must not become a required obligation",
      );
      const remaining =
        report.continuation?.remainingRequirements?.map(
          requirement => requirement.conditionId,
        ) ?? [];
      assert.equal(
        remaining.some(ref => ref.includes(oracle.unselectedNotRequired)),
        false,
        "remaining requirements must not add the unselected OR path",
      );
    }
    if (oracle.noRepeatedMutation) {
      const dispatchSkills = uniqueAtomicResults(run).map(
        result => `${result.skillId}:${result.dispatchId}`,
      );
      assert.equal(
        new Set(dispatchSkills).size,
        dispatchSkills.length,
        "mutation dispatch identities must not repeat",
      );
      assert.equal(
        new Set(actions).size,
        actions.length,
        "the failure and unknown cases must not replay the same mutation",
      );
    }
    if (oracle.errorCodes) {
      for (const code of oracle.errorCodes) {
        assert.ok(
          report.errors.some(error => error.code === code),
          `errors must include ${code}`,
        );
      }
    }
    if (oracle.effectKnowledge) {
      assert.deepEqual(
        report.effects.map(effect => effect.knowledge),
        oracle.effectKnowledge,
      );
    }
    if (oracle.rawSelectionHead) {
      assert.equal(run.resources.memory.selections[0]?.skillId, oracle.rawSelectionHead);
      assert.equal(actions.length, 0);
    }
    if (oracle.priorApplicability) {
      assert.deepEqual(
        run.resources.memory.priorAssessments.map(
          assessment => assessment.applicability.kind,
        ).filter((kind,index,sequence)=>index===0 || kind!==sequence[index-1]),
        oracle.priorApplicability,
      );
    }
    if (oracle.replansAtLeast !== undefined) {
      const usage = planningUsages(run).at(-1);
      assert.ok(usage, "planning usage must be present in continuation");
      assert.ok(
        usage.replansUsed >= oracle.replansAtLeast,
        `replansUsed must be at least ${oracle.replansAtLeast}`,
      );
    }
    if (oracle.monotonicUsage) {
      const usages = planningUsages(run);
      for (let index = 1; index < usages.length; index += 1) {
        assert.ok(usages[index].predictionCallsUsed >= usages[index - 1].predictionCallsUsed);
        assert.ok(usages[index].replansUsed >= usages[index - 1].replansUsed);
        assert.ok(usages[index].rollbacksUsed >= usages[index - 1].rollbacksUsed);
      }
    }
    if (oracle.predictedToken) {
      const actual = JSON.stringify({
        states: report.states,
        evidence: report.evidence,
        effects: report.effects,
        atomicResults: report.atomicResults,
      });
      assert.equal(
        actual.includes(oracle.predictedToken),
        false,
        "predicted references must not be copied into actual runtime tables",
      );
    }
    if (oracle.finalTitleValid !== undefined) {
      const finalState = report.states.at(-1)?.value;
      assert.equal(finalState?.titleValid, oracle.finalTitleValid);
    }
    if (oracle.predictionKind) {
      assert.ok(report.planning, "planning report is required");
      assert.equal(report.planning.prediction.kind, oracle.predictionKind);
    }
    if (oracle.predictionReason) {
      assert.equal(report.planning.prediction.reason, oracle.predictionReason);
    }
    if (oracle.frontierCoverage) {
      assert.ok(report.planning.prediction.frontier.length > 0);
      assert.ok(
        report.planning.prediction.frontier.some(item =>
          oracle.frontierCoverage.includes(item.coverage),
        ),
      );
    }
    if (oracle.noAtomicExecution) {
      assert.equal(run.resources.memory.atomicExecutions.length, 0);
    }
  });
}

test("B14.v1-without-planning keeps legacy semantics", async () => {
  const run = await runFiniteSearchScenario("branch", {
    observedBranch: "approve",
    failSelected: false,
  });
  const report = reportOf(run.response);
  assert.deepEqual(
    report.atomicResults.map(result => result.sourceResult?.value?.operation),
    ["observe-branch", "execute-branch", "finish-branch"],
  );
  assert.equal(report.control.outcome, "completed");
  assert.equal(report.planning, undefined);
  assert.equal(report.continuation, null);
});

test("B08 continuation cannot replay an unknown mutation", async () => {
  const resources = createBoundedFiniteResources({
    scenario: "unknown-followup",
    actualBranch: "approve",
    expectedBranch: "approve",
    unknownProbe: true,
  });
  const first = await runBoundedFiniteStep(resources);
  const firstReport = reportOf(first.response);
  assert.equal(resources.memory.atomicExecutions.length, 1);
  assert.equal(firstReport.effects.at(-1)?.knowledge, "unknown");

  if (firstReport.continuation !== null) {
    const second = await runBoundedFiniteStep(
      resources,
      firstReport.continuation,
    );
    assert.equal(second.response.kind, "run_result");
    assert.equal(
      resources.memory.atomicExecutions.length,
      1,
      "unknown effect continuation must not replay the mutation",
    );
  }
});

test("B14.v1 continuation cannot silently attach planning", async () => {
  const legacy = await runBoundedFiniteScenario({
    scenario: "legacy-continuation",
    actualBranch: "approve",
    expectedBranch: "approve",
    failSelected: true,
    planning: false,
  });
  const legacyReport = reportOf(legacy.final);
  assert.equal(legacyReport.continuation?.schema, "nnanything.recursive-goal.continuation.v1");

  const resources = createBoundedFiniteResources({
    scenario: "legacy-continuation",
    actualBranch: "approve",
    expectedBranch: "approve",
    failSelected: true,
  });
  const step = await runBoundedFiniteStep(resources, legacyReport.continuation);
  assert.equal(step.response.kind, "request_rejected");
  assert.equal(step.response.error.code, "invalid_binding");
  assert.equal(resources.memory.atomicExecutions.length, 0);
});

test("B14.illegal-v2 continuation is rejected without replay", async () => {
  const legacy = await runBoundedFiniteScenario({
    scenario: "illegal-v2",
    actualBranch: "approve",
    expectedBranch: "approve",
    failSelected: true,
    planning: false,
  });
  const continuation = structuredClone(reportOf(legacy.final).continuation);
  continuation.schema = "nnanything.recursive-goal.continuation.v2";
  const resources = createBoundedFiniteResources({
    scenario: "illegal-v2",
    actualBranch: "approve",
    expectedBranch: "approve",
    failSelected: true,
  });
  const step = await runBoundedFiniteStep(resources, continuation);
  assert.equal(step.response.kind, "request_rejected");
  assert.equal(step.response.error.code, "invalid_binding");
  assert.equal(resources.memory.atomicExecutions.length, 0);
});

test("B14.valid-v2 JSON continuation reattaches in a new process without replay", async () => {
  const options = {
    scenario: "new-process-v2",
    actualBranch: "approve",
    expectedBranch: "approve",
  };
  const resources = createBoundedFiniteResources(options);
  const first = await runBoundedFiniteStep(resources);
  const firstReport = reportOf(first.response);
  assert.equal(firstReport.control.outcome, "yielded");
  assert.equal(firstReport.atomicResults.length, 1);
  const continuation = roundTripContinuation(firstReport.continuation);

  const child = await runConsumerProcess({
    options,
    continuation,
  });
  assert.equal(child.response.kind, "run_result", JSON.stringify(child, null, 2));
  const childReport = child.response.report;
  assert.equal(childReport.continuation?.schema, "nnanything.recursive-goal.continuation.v2");
  assert.ok(childReport.atomicResults.length >= 1);
  const firstDispatch = firstReport.atomicResults[0].dispatchId;
  const matching = childReport.atomicResults.filter(
    result => result.dispatchId === firstDispatch,
  );
  assert.equal(matching.length, 1, "the restored dispatch must appear exactly once");
  assert.ok(
    childReport.atomicResults.length <= firstReport.atomicResults.length + 1,
    "one new process invocation must add at most one atomic dispatch",
  );
});

test("B14.planning presence mismatch and missing capability are explicit contract failures", async () => {
  const resources = createBoundedFiniteResources({
    scenario: "missing-capability",
    actualBranch: "approve",
    expectedBranch: "approve",
  });
  const { planning: _planning, ...dependenciesWithoutPlanning } =
    resources.dependencies;
  const response = await runBoundedFiniteStep({
    ...resources,
    dependencies: dependenciesWithoutPlanning,
  });
  assert.equal(response.response.kind, "request_rejected");
  assert.equal(response.response.error.code, "invalid_request");
  assert.equal(resources.memory.atomicExecutions.length, 0);
});

test("B15.selector injection cannot use planning to replace a wrong head", async () => {
  const resources = createBoundedFiniteResources({
    scenario: "selector-injection",
    actualBranch: "approve",
    expectedBranch: "approve",
  });
  const injection = createSelectorInjection({
    head: "bounded.finish",
    planningAware: true,
  });
  const baseSelect = resources.dependencies.adapter.select.bind(
    resources.dependencies.adapter,
  );
  const injected=injection.wrapSelect(baseSelect);
  resources.dependencies.adapter.select = async input => {
    const selection=await injected(input);
    resources.memory.selections.push(selection);
    return selection;
  };
  const run = {
    resources,
    runs: [],
    responses: [],
    final: null,
  };
  const step = await runBoundedFiniteStep(resources);
  run.runs.push(step);
  run.responses.push(step.response);
  run.final = step.response;
  const report = reportOf(step.response);
  assert.equal(resources.memory.selections[0].skillId, "bounded.finish");
  assert.equal(uniqueAtomicResults(run).length, 0);
  assert.ok(report.errors.some(error => error.code === "policy_error"));
});

test("cwd fixture handoff is explicit and remains unverified in this worker", () => {
  const handoff = createBoundedCwdResources();
  assert.equal(handoff.kind, "bounded-cwd-delegation.v1");
  assert.equal(handoff.status, "UNVERIFIED");
  assert.deepEqual(handoff.requiredCapabilities, [
    "createSandbox",
    "createAdapter",
    "createDependencies",
    "emptyState",
    "runStep",
  ]);
  assert.ok(CWD_DELEGATED_CASES.length > 0);
  assert.equal(
    CWD_DELEGATED_CASES.every(item => item.requirement.length > 0),
    true,
  );
});

async function runConsumerProcess(input) {
  const child = spawn(process.execPath, [CONSUMER_PATH], {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  const code = await new Promise(resolve => {
    child.on("close", resolve);
  });
  assert.equal(code, 0, stderr || stdout);
  return JSON.parse(stdout);
}
