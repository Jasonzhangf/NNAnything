import assert from "node:assert/strict";
import test from "node:test";

import { runFiniteSearchScenario } from "../playground/recursive-goal/finite-search.mjs";

function reportFrom(result) {
  assert.equal(result.response.kind, "run_result");
  return result.response.report;
}

function operations(report) {
  return report.atomicResults.map(result => {
    if (result.sourceResult?.tag !== "finite.compute") return null;
    return result.sourceResult.value;
  }).filter(Boolean);
}

function framesForGoal(report, kind, predicate = () => true) {
  return report.frames.filter(frame => frame.goal.kind === kind && predicate(frame));
}

function findCondition(report, conditionId) {
  for (const frame of report.frames) {
    const found = frame.conditionResults.find(condition => condition.conditionId === conditionId);
    if (found) return found;
  }
  return null;
}

function assertFrameReferences(result, report) {
  assert.deepEqual(report.root.rootGoal, result.request.rootGoal);
  assert.equal(report.root.rootThreshold, result.request.satisfactionThreshold);
  assert.deepEqual(report.root.rootBindings, result.request.rootBindings);
  const frameById = new Map(report.frames.map(frame => [frame.frameId, frame]));
  for (const frame of report.frames) {
    assert.equal(frame.rootRef, report.root.rootFrameId);
    if (frame.parentFrameId === null) {
      assert.equal(frame.frameId, report.root.rootFrameId);
      assert.equal(frame.fulfillsConditionId, null);
      continue;
    }
    const parent = frameById.get(frame.parentFrameId);
    assert.ok(parent, `missing parent frame for ${frame.frameId}`);
    assert.ok(frame.fulfillsConditionId, `missing fulfills condition for ${frame.frameId}`);
    assert.ok(
      parent.conditionResults.some(
        condition => condition.conditionId === frame.fulfillsConditionId,
      ),
      `fulfills condition ${frame.fulfillsConditionId} is not owned by ${parent.frameId}`,
    );
  }
}

test("finite search derives depth-three checked coverage and preserves match as a required goal", async () => {
  const sixty = await runFiniteSearchScenario("search", {
    threshold: 60,
    matchAt: 4,
  });
  const sixtyReport = reportFrom(sixty);
  assert.equal(sixtyReport.control.outcome, "completed");
  assert.equal(sixtyReport.rootEvaluation.state, "evaluated");
  assert.equal(sixtyReport.rootEvaluation.result, "satisfied");
  assert.equal(sixtyReport.rootEvaluation.satisfaction, 60);

  const checks60 = operations(sixtyReport).filter(operation => operation.operation === "check-item");
  assert.deepEqual(checks60.map(operation => operation.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(new Set(checks60.map(operation => operation.index)).size, 6);
  assert.ok(sixtyReport.frames.some(frame => frame.depth >= 3));
  assert.equal(
    framesForGoal(sixtyReport, "coverage")[0]?.fulfillsConditionId,
    "condition:search:coverage",
  );
  assert.equal(
    framesForGoal(sixtyReport, "coverage_item", frame => frame.goal.index === 0)[0]
      ?.fulfillsConditionId,
    "condition:coverage:item-0",
  );
  assertFrameReferences(sixty, sixtyReport);

  const match60 = operations(sixtyReport).find(operation => operation.operation === "find-match");
  assert.deepEqual(match60, {
    operation: "find-match",
    matchFound: true,
    checkedIndices: [0, 1, 2, 3, 4, 5],
  });
  assert.equal(findCondition(sixtyReport, "condition:search:match")?.fact, "satisfied");

  const hundred = await runFiniteSearchScenario("search", {
    threshold: 100,
    matchAt: 4,
  });
  const hundredReport = reportFrom(hundred);
  assert.equal(hundredReport.control.outcome, "completed");
  assert.equal(hundredReport.rootEvaluation.state, "evaluated");
  assert.equal(hundredReport.rootEvaluation.result, "satisfied");
  assert.equal(hundredReport.rootEvaluation.satisfaction, 100);

  const checks100 = operations(hundredReport).filter(operation => operation.operation === "check-item");
  assert.deepEqual(
    checks100.map(operation => operation.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  const coverageSliceFrames = framesForGoal(hundredReport, "coverage_slice");
  assert.equal(coverageSliceFrames.length, 5);
  assertFrameReferences(hundred, hundredReport);
});

test("coverage satisfaction comes from checked items, while finding a match remains necessary", async () => {
  const result = await runFiniteSearchScenario("search", {
    threshold: 60,
    matchAt: null,
  });
  const report = reportFrom(result);
  const checks = operations(report).filter(operation => operation.operation === "check-item");
  const match = operations(report).find(operation => operation.operation === "find-match");

  assert.deepEqual(checks.map(operation => operation.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(match, {
    operation: "find-match",
    matchFound: false,
    checkedIndices: [0, 1, 2, 3, 4, 5],
  });
  assert.equal(findCondition(report, "condition:search:match")?.fact, "unsatisfied");
  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.equal(report.rootEvaluation.result, "unsatisfied");
  assert.equal(report.rootEvaluation.satisfaction, 60);
  assert.notEqual(report.control.outcome, "completed");

  const coverageCondition = report.frames
    .flatMap(frame => frame.conditionResults)
    .find(condition => condition.conditionId.includes(":coverage"));
  assert.equal(coverageCondition?.fact, "satisfied");
  assert.equal(coverageCondition?.satisfaction, 60);
});

test("a three-level document chain keeps stage history but persistent invalidation blocks the root", async () => {
  const result = await runFiniteSearchScenario("document");
  const report = reportFrom(result);
  assert.notEqual(report.control.outcome, "completed");
  assert.equal(report.rootEvaluation.state, "evaluated");
  assert.notEqual(report.rootEvaluation.result, "satisfied");
  assertFrameReferences(result, report);

  const fieldOperations = operations(report).filter(
    operation => operation.operation === "set-document-field",
  );
  assert.deepEqual(
    fieldOperations.map(operation => operation.field),
    ["title", "owner", "revise"],
  );
  const fieldFrames = framesForGoal(report, "document_field");
  assert.equal(fieldFrames.length, 3);
  for (const frame of fieldFrames) {
    assert.equal(frame.execution, "completed");
    assert.ok(frame.evidenceRefs.length > 0);
  }
  assert.ok(report.frames.some(frame => frame.depth === 3));

  const configureFrame = framesForGoal(report, "document_configure")[0];
  assert.ok(configureFrame);
  assert.equal(configureFrame.fulfillsConditionId, "condition:prepare:configure");
  assert.equal(
    framesForGoal(report, "document_prepare")[0]?.fulfillsConditionId,
    "condition:document:prepare",
  );
  const titleCondition = configureFrame.conditionResults.find(condition =>
    condition.conditionId.endsWith(":title"),
  );
  const ownerCondition = configureFrame.conditionResults.find(condition =>
    condition.conditionId.endsWith(":owner"),
  );
  assert.equal(titleCondition?.fact, "unsatisfied");
  assert.equal(ownerCondition?.fact, "satisfied");
  assert.ok(titleCondition?.evidenceRefs.length > 0);

  const titleFrame = fieldFrames.find(frame => frame.goal.field === "title");
  assert.equal(titleFrame?.execution, "completed");
  assert.equal(titleFrame?.fulfillsConditionId, "condition:configure:title");
  assert.ok(titleFrame?.evidenceRefs.length > 0);
  const ownerFrame = fieldFrames.find(frame => frame.goal.field === "owner");
  assert.equal(ownerFrame?.fact, "satisfied");
});

test("branch selection uses the observed New State and a failed selected branch stops dependents", async () => {
  const success = await runFiniteSearchScenario("branch", {
    observedBranch: "approve",
    failSelected: false,
  });
  const successReport = reportFrom(success);
  assert.equal(successReport.control.outcome, "completed");
  assert.equal(successReport.rootEvaluation.state, "evaluated");
  assert.equal(successReport.rootEvaluation.result, "satisfied");
  assertFrameReferences(success, successReport);

  const rejectedCondition = findCondition(successReport, "condition:branch:reject");
  assert.equal(rejectedCondition?.fact, "not_applicable");
  assert.equal(
    framesForGoal(successReport, "branch_probe")[0]?.fulfillsConditionId,
    "condition:branch:probe",
  );
  assert.equal(
    framesForGoal(
      successReport,
      "branch_path",
      frame => frame.goal.branch === "approve",
    )[0]?.fulfillsConditionId,
    "condition:branch:approve",
  );
  const successFinish = framesForGoal(successReport, "branch_finish")[0];
  assert.equal(successFinish?.execution, "completed");

  const rejected = await runFiniteSearchScenario("branch", {
    observedBranch: "reject",
    failSelected: false,
  });
  const rejectedReport = reportFrom(rejected);
  assert.equal(rejectedReport.control.outcome, "completed");
  assert.equal(rejectedReport.rootEvaluation.state, "evaluated");
  assert.equal(rejectedReport.rootEvaluation.result, "satisfied");
  assertFrameReferences(rejected, rejectedReport);

  assert.equal(
    findCondition(rejectedReport, "condition:branch:approve")?.fact,
    "not_applicable",
  );
  assert.equal(
    framesForGoal(
      rejectedReport,
      "branch_path",
      frame => frame.goal.branch === "reject",
    )[0]?.fulfillsConditionId,
    "condition:branch:reject",
  );
  assert.equal(
    framesForGoal(rejectedReport, "branch_finish")[0]?.execution,
    "completed",
  );

  const failure = await runFiniteSearchScenario("branch", {
    observedBranch: "approve",
    failSelected: true,
  });
  const failureReport = reportFrom(failure);
  assert.notEqual(failureReport.control.outcome, "completed");
  assert.equal(failureReport.rootEvaluation.state, "evaluated");
  assert.notEqual(failureReport.rootEvaluation.result, "satisfied");
  assertFrameReferences(failure, failureReport);

  const failedRejectedCondition = findCondition(failureReport, "condition:branch:reject");
  assert.equal(failedRejectedCondition?.fact, "not_applicable");
  const approvedFrame = framesForGoal(
    failureReport,
    "branch_path",
    frame => frame.goal.branch === "approve",
  )[0];
  assert.equal(approvedFrame?.execution, "failed");
  assert.notEqual(approvedFrame?.fact, "not_applicable");
  assert.ok(approvedFrame?.errorId);

  const finishFrame = framesForGoal(failureReport, "branch_finish")[0];
  assert.equal(finishFrame?.execution, "not_started");
  assert.equal(finishFrame?.unexecutedReason, "dependency_not_met");
  assert.ok(failureReport.primaryErrorId);
});

test("the finite consumer uses only a non-CLI typed computation domain", async () => {
  const result = await runFiniteSearchScenario("search", {
    threshold: 60,
    matchAt: 4,
  });
  const serialized = JSON.stringify(result.request);
  assert.equal(result.request.rootGoal.kind, "search_success");
  assert.equal(result.request.rootBindings.kind, "search_range");
  assert.equal(result.request.state.kind, "search_state");
  assert.doesNotMatch(serialized, /cwd|cli|file\.property|sessionCwd/iu);
});
