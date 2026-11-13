import assert from "node:assert/strict";
import { test } from "node:test";
import { runRecursiveGoal } from "nnanything/recursive-goal";
import { createFixtureAdapter, evaluator, initialObservation, makeRequest, responseReport, selector, skill, successfulAtomicReceipt } from "./recursive-goal-fixtures.mjs";

function dependencies(adapter, trace) {
  return {
    adapter, trace,
    enabledSkills: [skill("read", "atomic")],
    enabledEvaluators: [evaluator()],
    selectors: [selector("root-selector", ["read"])],
    grantedEffects: new Set(),
    comparators: {
      sameGoal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      sameBindings: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      sameFacts: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    },
  };
}

test("trace records selected target, actual dispatch and distinct evaluation history", async () => {
  const records = [];
  const decision = { target: "B", parameters: { path: "b.ts" } };
  const fixture = createFixtureAdapter({
    select: () => ({ kind: "selected", skillId: "read", decision }),
    executeAtomic(input) {
      assert.deepEqual(input.decision, decision);
      return successfulAtomicReceipt();
    },
  });
  const response = await runRecursiveGoal(makeRequest(), dependencies(fixture.adapter, {
    segmentId: "selection", emit: event => records.push(event),
  }));
  assert.equal(responseReport(response).rootEvaluation.result, "satisfied");
  assert.ok(response.trace, "public response must expose trace completeness");
  const definition = records.find(event => event.payload.kind === "frame_defined");
  assert.equal(definition.payload.details.parentFrameRef, null);
  assert.deepEqual(definition.payload.details.goal, makeRequest().rootGoal);
  assert.equal(definition.payload.details.imported, false);
  const selected = records.find(event => event.payload.kind === "selection_returned");
  const accepted = records.find(event => event.payload.kind === "selection_accepted");
  const dispatched = records.find(event => event.payload.kind === "dispatch_started");
  assert.deepEqual(selected.payload.details.selection.decision, decision);
  assert.deepEqual(dispatched.payload.details.decision, decision);
  assert.equal(dispatched.payload.details.selectionEventRef, accepted.eventId);
  assert.equal(fixture.calls.select, 1);
  const evaluations = records.filter(event => event.payload.kind === "evaluation_returned");
  assert.equal(evaluations.length, fixture.calls.evaluate);
  assert.deepEqual(evaluations.map(event => event.payload.details.evaluation.result), ["unsatisfied", "satisfied"]);
  assert.equal(response.trace.capture, "complete", "instrumented invocation must report complete delivery");
  assert.deepEqual(response.trace.missingCoverage, []);
  const reparsed = JSON.parse(JSON.stringify(records));
  assert.equal(reparsed.at(-1).payload.kind, "segment_ended");
  const states = records.filter(event => event.payload.kind === "resource_defined" && event.payload.details.resourceType === "state");
  assert.ok(states.some(event => event.payload.details.resource.id === dispatched.payload.details.inputRefs.stateRef));
  assert.equal(new Set(states.map(event => event.payload.details.resource.id)).size, states.length);
  assert.deepEqual(records.at(-1).payload.details.control, responseReport(response).control);
});

test("actual execution error is traceable to its original frame and diagnostic", async () => {
  const records = [];
  const fixture = createFixtureAdapter({ executeAtomic() { throw new Error("source read failed"); } });
  const report = responseReport(await runRecursiveGoal(makeRequest(), dependencies(fixture.adapter, {
    segmentId: "error", emit: event => records.push(event),
  })));
  const recorded = records.filter(event => event.payload.kind === "diagnostic");
  assert.ok(recorded.length > 0);
  for (const record of recorded) {
    assert.ok(report.errors.some(error => error.errorId === record.payload.details.diagnostic.errorId));
    assert.equal(record.payload.frameRef, record.payload.details.diagnostic.origin.frameId);
  }
});

test("initially satisfied goal has no invented selection or dispatch", async () => {
  const records = [];
  const fixture = createFixtureAdapter();
  const response = await runRecursiveGoal(makeRequest({ state: { count: 1 }, initialObservation: initialObservation() }), dependencies(fixture.adapter, {
    segmentId: "satisfied", emit: event => records.push(event),
  }));
  assert.ok(response.trace);
  assert.equal(responseReport(response).rootEvaluation.result, "satisfied");
  assert.ok(records.some(event => event.payload.kind === "evaluation_returned"));
  assert.equal(records.some(event => ["selection_returned", "dispatch_started"].includes(event.payload.kind)), false);
  assert.equal(fixture.calls.executeAtomic, 0);
});

test("throwing sink preserves execution and explicitly reports failed capture", async () => {
  const baseline = createFixtureAdapter();
  const expected = responseReport(await runRecursiveGoal(makeRequest(), dependencies(baseline.adapter)));
  const fixture = createFixtureAdapter();
  let attempts = 0;
  const response = await runRecursiveGoal(makeRequest(), dependencies(fixture.adapter, {
    segmentId: "sink-failure", emit() { attempts++; throw new Error("storage unavailable"); },
  }));
  assert.deepEqual(responseReport(response), expected);
  assert.deepEqual(fixture.calls, baseline.calls);
  assert.equal(attempts, 1);
  assert.equal(response.trace.capture, "incomplete");
  assert.equal(response.trace.failure.message, "storage unavailable");
});

for (const boundary of ["dispatch_started", "atomic_returned", "segment_ended"]) {
  test(`sink failure at ${boundary} does not replace execution facts`, async () => {
    const baseline = createFixtureAdapter();
    const expected = responseReport(await runRecursiveGoal(makeRequest(), dependencies(baseline.adapter)));
    const fixture = createFixtureAdapter();
    let failed = false;
    const response = await runRecursiveGoal(makeRequest(), dependencies(fixture.adapter, {
      segmentId: boundary,
      emit(event) {
        assert.equal(failed, false, "no callback after capture failure");
        if (event.payload.kind === boundary) {
          failed = true;
          throw new Error(boundary);
        }
      },
    }));
    assert.equal(failed, true);
    assert.deepEqual(responseReport(response), expected);
    assert.deepEqual(fixture.calls, baseline.calls);
    assert.equal(response.trace.capture, "incomplete");
    assert.equal(response.trace.failure.message, boundary);
  });
}

test("sink-owned event mutation cannot change selected target or evaluation", async () => {
  const fixture = createFixtureAdapter({
    select: () => ({ kind: "selected", skillId: "read", decision: { target: "B" } }),
    executeAtomic(input) {
      assert.equal(input.decision.target, "B");
      return successfulAtomicReceipt();
    },
  });
  const response = await runRecursiveGoal(makeRequest(), dependencies(fixture.adapter, {
    segmentId: "isolated",
    emit(event) {
      if (event.payload.kind === "selection_returned") event.payload.details.selection.decision.target = "A";
      if (event.payload.kind === "evaluation_returned") event.payload.details.evaluation.result = "unknown";
    },
  }));
  assert.equal(responseReport(response).rootEvaluation.result, "satisfied");
  assert.equal(response.trace.failure, null);
});

test("returned but invalid evaluation is discarded rather than presented as applied", async () => {
  const records = [];
  const fixture = createFixtureAdapter({ evaluate: () => ({
    evaluatorId: "wrong-evaluator", result: "unsatisfied", satisfaction: 0,
    necessaryConditionsMet: false, evidenceRefs: [],
  }) });
  const response = await runRecursiveGoal(makeRequest(), dependencies(fixture.adapter, {
    segmentId: "invalid-evaluation", emit: event => records.push(event),
  }));
  assert.equal(responseReport(response).control.outcome, "error");
  const returned = records.find(event => event.payload.kind === "evaluation_returned");
  const discarded = records.find(event => event.payload.kind === "evaluation_discarded");
  assert.ok(returned);
  assert.ok(discarded);
  assert.equal(discarded.payload.details.evaluationEventRef, returned.eventId);
  assert.equal(records.some(event => event.payload.kind === "evaluation_applied"), false);
});
