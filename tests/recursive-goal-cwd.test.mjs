import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  runCwdScenarios,
} from "../playground/recursive-goal/cwd.mjs";

function profilePath() {
  const value = process.env.NN_CLI_COMMAND_PROFILE;
  assert.equal(
    typeof value,
    "string",
    "NN_CLI_COMMAND_PROFILE must name an explicit saved CLI command profile",
  );
  assert.notEqual(value.length, 0, "NN_CLI_COMMAND_PROFILE must not be empty");
  return value;
}

function scenarioByName(run, name) {
  const scenario = run.scenarios.find(item => item.name === name);
  assert.ok(scenario, `scenario ${name} must run`);
  return scenario;
}

function reportOf(scenario) {
  assert.equal(scenario.response.kind, "run_result", JSON.stringify(scenario.error));
  return scenario.response.report;
}

function heads(scenario) {
  return scenario.trace
    .filter(entry => entry.kind === "atomic")
    .map(entry => entry.selectedHead);
}

function assertCommonInvariants(run, scenario) {
  assert.equal(scenario.fixture.agentCwdUnchanged, true);
  assert.equal(scenario.fixture.foreignSessionUnchanged, true);
  assert.equal(scenario.fixture.cleaned, true);
  assert.equal(scenario.fixture.rootAbsent, true);
  assert.equal(run.fixtureRootAbsent, true);
  assert.equal(run.profile.fitted, false);
  assert.equal(run.profile.textUnchanged, true);
  assert.equal(scenario.rawTrace.length, scenario.trace.length);
  assert.deepEqual(
    scenario.rawTrace.map(entry => entry.kind),
    scenario.trace.map(entry => entry.kind),
  );
  assert.equal(scenario.trace.some(entry => entry.kind === "selection"), true);
  assert.equal(scenario.trace.some(entry => entry.kind === "atomic"), true);
  assert.equal(
    scenario.trace.filter(entry => entry.kind === "atomic").length,
    scenario.transitions.length,
  );
  assert.equal(
    scenario.trace.some(entry => entry.kind === "selection" && entry.selectedHead !== undefined),
    false,
  );
}

function assertSourceAndGenericEvidenceClosed(report) {
  const atomicIds = new Set(report.atomicResults.map(result => result.dispatchId));
  for (const result of report.atomicResults) {
    assert.equal(atomicIds.has(result.dispatchId), true);
    assert.equal(result.sourceResult?.tag, "cli.command.transition.v1");
    assert.equal(typeof result.sourceResult.value.status, "string");
  }
  for (const frame of report.frames) {
    for (const atomicRef of frame.atomicResultRefs) assert.equal(atomicIds.has(atomicRef), true);
  }
}

test("public recursive-goal module runs the two-layer cwd consumer", async t => {
  const fixtureParent = await mkdtemp(join(tmpdir(), "recursive-goal-cwd-test-"));
  try {
    const run = await runCwdScenarios({
      profilePath: profilePath(),
      fixtureParent,
    });

    assert.equal(run.profile.contract, "cli.command-policy.v1");
    assert.equal(run.profile.calibration, "uncalibrated");
    assert.equal(run.profile.adoption, "not_applied");
    assert.equal(run.profile.heads, 6);
    assert.equal(run.profile.wires, 14);

    await t.test("same cwd uses one pwd and no cd", () => {
      const scenario = scenarioByName(run, "same");
      const report = reportOf(scenario);
      assertCommonInvariants(run, scenario);
      assert.deepEqual(heads(scenario), ["pwd"]);
      assert.equal(report.atomicResults.length, 1);
      assert.equal(report.rootEvaluation.state, "evaluated");
      assert.equal(report.rootEvaluation.result, "satisfied");
      assert.equal(report.control.outcome, "completed");
      assert.equal(scenario.finalSession.revision, scenario.initialSession.revision);
      assert.equal(scenario.finalSession.cwd, scenario.request.targetPhysical);
      assert.equal(report.frames.some(frame => frame.depth === 0), true);
      assert.equal(report.frames.some(frame => frame.depth === 1), true);
      assertSourceAndGenericEvidenceClosed(report);
      assert.equal(scenario.status, "PASS", JSON.stringify(scenario.summary));
    });

    await t.test("different cwd runs pwd then cd with fresh postcondition evidence", () => {
      const scenario = scenarioByName(run, "different");
      const report = reportOf(scenario);
      assertCommonInvariants(run, scenario);
      assert.deepEqual(heads(scenario), ["pwd", "cd"]);
      assert.equal(report.atomicResults.length, 2);
      assert.equal(report.rootEvaluation.state, "evaluated");
      assert.equal(report.rootEvaluation.result, "satisfied");
      assert.equal(report.control.outcome, "completed");
      assert.equal(scenario.finalSession.cwd, scenario.request.targetPhysical);
      assert.equal(scenario.finalSession.revision, scenario.initialSession.revision + 1);
      assert.equal(report.effects.some(effect => effect.knowledge === "known"), true);
      assert.equal(scenario.request.targetRef.path.startsWith("/"), false);
      assert.equal(report.root.rootBindings.target.path, scenario.request.targetRef.path);
      assert.equal(scenario.transitions[1].postcondition.matchedTarget, true);
      assertSourceAndGenericEvidenceClosed(report);
      assert.equal(scenario.status, "PASS", JSON.stringify(scenario.summary));
    });

    await t.test("binding refusal is invalid_binding and never invokes the cd executor", () => {
      const scenario = scenarioByName(run, "binding-refused");
      const report = reportOf(scenario);
      assertCommonInvariants(run, scenario);
      assert.deepEqual(heads(scenario), ["pwd", "cd"]);
      assert.equal(scenario.targetRemoved, true);
      assert.equal(scenario.finalSession.revision, scenario.initialSession.revision);
      assert.equal(scenario.finalSession.cwd, scenario.initialSession.cwd);
      const cd = scenario.transitions.find(item => item.selectedHead === "cd");
      assert.ok(cd);
      assert.equal(cd.executionStatus, "rejected");
      assert.equal(cd.executorInvoked, false);
      assert.equal(cd.reason, "directory_binding_failed");
      const cdAtomic = report.atomicResults.find(result => result.skillId === "cwd.equals.atomic");
      assert.ok(cdAtomic);
      assert.equal(cdAtomic.outcome, "rejected");
      assert.equal(cdAtomic.executorInvoked, false);
      assert.equal(cdAtomic.sourceResult.value.execution_result.reason, "directory_binding_failed");
      assert.equal(report.errors.some(error => error.code === "invalid_binding"), true);
      assert.equal(report.errors.some(error => error.code === "execution_failed"), false);
      assert.notEqual(report.rootEvaluation.result, "satisfied");
      assertSourceAndGenericEvidenceClosed(report);
      assert.equal(scenario.status, "PASS", JSON.stringify(scenario.summary));
    });

    await t.test("postcommit injected observation keeps the commit and leaves root unknown without retry", () => {
      const scenario = scenarioByName(run, "postcommit-observation-injected");
      const report = reportOf(scenario);
      assertCommonInvariants(run, scenario);
      assert.deepEqual(heads(scenario), ["pwd", "cd"]);
      assert.equal(scenario.sourceKind, "real_cd_with_controlled_observation_injection");
      assert.equal(scenario.injection.count, 1);
      assert.equal(scenario.finalSession.cwd, scenario.request.targetPhysical);
      assert.equal(scenario.finalSession.revision, scenario.initialSession.revision + 1);
      assert.equal(report.control.outcome, "error");
      assert.equal(report.effects.some(effect =>
        effect.knowledge === "known" &&
        effect.confirmedEffects.some(fact =>
          fact.kind === "cli.session.cwd" &&
          fact.cwd === scenario.request.targetPhysical &&
          fact.revision === scenario.finalSession.revision,
        ),
      ), true);
      const cdAtomic = report.atomicResults.find(result => result.skillId === "cwd.equals.atomic");
      assert.ok(cdAtomic);
      assert.equal(cdAtomic.outcome, "unknown");
      assert.equal(cdAtomic.sourceResult.value.execution_result.status, "succeeded");
      assert.equal(
        cdAtomic.sourceResult.value.postcondition.receipt.execution.error.code,
        "INJECTED_OBSERVATION",
      );
      const verificationError = report.errors.find(error => error.code === "evidence_unavailable");
      assert.ok(verificationError);
      assert.equal(verificationError.source.nativeCode, "INJECTED_OBSERVATION");
      assert.equal(report.errors.some(error => error.code === "evidence_unavailable"), true);
      assertSourceAndGenericEvidenceClosed(report);
      assert.equal(report.rootEvaluation.state, "evaluated");
      assert.equal(report.rootEvaluation.result, "unknown");
      assert.equal(scenario.status, "PASS", JSON.stringify(scenario.summary));
    });

    assert.equal(run.status, "PASS", JSON.stringify({
      counts: run.counts,
      fixtureRootAbsent: run.fixtureRootAbsent,
      profile: run.profile,
      scenarios: run.scenarios.map(scenario => ({
        name: scenario.name,
        status: scenario.status,
        error: scenario.error,
        summary: scenario.summary,
      })),
    }, null, 2));
  } finally {
    await rm(fixtureParent, { recursive: true, force: true });
  }
});
