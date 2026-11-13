import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";

import { runRecursiveGoal } from "nnanything/recursive-goal";
import {
  counterGoal,
  createFixtureAdapter,
  evaluator,
  failedAtomicReceipt,
  initialObservation,
  makeRequest,
  responseReport,
  selector,
  singleChildDerivation,
  skill,
  successfulAtomicReceipt,
} from "./recursive-goal-fixtures.mjs";
import {
  createBoundedFiniteResources,
  runBoundedFiniteStep,
} from "../playground/recursive-goal/bounded-finite.mjs";
import {
  parseTraceJsonl,
  runTraceJsonExample,
  validateTraceEvents,
} from "../playground/recursive-goal/trace-json.mjs";

const traceKinds = new Set([
  "segment_started",
  "segment_ended",
  "final_summary",
  "step_started",
  "step_ended",
  "frame_defined",
  "evidence_view_defined",
  "condition_view_defined",
  "conditions_derived",
  "evaluation_started",
  "evaluation_returned",
  "evaluation_failed",
  "evaluation_applied",
  "evaluation_discarded",
  "selection_returned",
  "selection_accepted",
  "selection_disposed",
  "selection_rejected",
  "selection_failed",
  "dispatch_started",
  "atomic_returned",
  "observation_accepted",
  "branch_changed",
  "planning_changed",
  "control_projection",
  "diagnostic",
  "resource_defined",
]);

function comparators() {
  return {
    sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  };
}

function dependencies(adapter, trace, overrides = {}) {
  return {
    adapter,
    enabledSkills: [skill("read", "atomic")],
    enabledEvaluators: [evaluator()],
    selectors: [selector("root-selector", ["read"])],
    grantedEffects: new Set(),
    comparators: comparators(),
    ...(trace === undefined ? {} : { trace }),
    ...overrides,
  };
}

function eventsOf(events, kind) {
  return events.filter(event => event.payload.kind === kind);
}

function assertBackwardReferences(events) {
  const seen = new Set();
  for (const event of events) {
    assert.equal(
      traceKinds.has(event.payload.kind),
      true,
      `unknown trace kind ${event.payload.kind}`,
    );
    if (event.payload.previousEventRef !== null) {
      assert.ok(
        seen.has(event.payload.previousEventRef),
        `previous reference must point backward: ${event.eventId}`,
      );
    }
    for (const cause of event.payload.causes) {
      assert.ok(
        seen.has(cause.eventRef),
        `cause must point backward: ${event.eventId} -> ${cause.eventRef}`,
      );
    }
    seen.add(event.eventId);
  }
}

function assertEvaluationDispositions(events) {
  const starts = eventsOf(events, "evaluation_started");
  const returns = eventsOf(events, "evaluation_returned");
  const failures = eventsOf(events, "evaluation_failed");
  const dispositions = events.filter(event =>
    event.payload.kind === "evaluation_applied" ||
    event.payload.kind === "evaluation_discarded",
  );
  assert.equal(
    starts.length,
    returns.length + failures.length,
    "each evaluation invocation must end in returned or failed",
  );
  for (const returned of returns) {
    const matching = dispositions.filter(event =>
      event.payload.details.evaluationEventRef === returned.eventId,
    );
    assert.equal(
      matching.length,
      1,
      `returned evaluation ${returned.eventId} must have one disposition`,
    );
    assert.ok(
      events.indexOf(matching[0]) > events.indexOf(returned),
      "evaluation disposition must follow its returned event",
    );
  }
  for (const disposition of dispositions) {
    assert.ok(
      returns.some(event => event.eventId === disposition.payload.details.evaluationEventRef),
      "evaluation disposition must reference a returned event",
    );
  }
}

async function runTrace(request, adapter, trace, overrides = {}) {
  return runRecursiveGoal(request, dependencies(adapter, trace, overrides));
}

test("trace events survive JSON round-trip and all references point backward", async () => {
  const records = [];
  const fixture = createFixtureAdapter({
    select: () => ({
      kind: "selected",
      skillId: "read",
      decision: { target: "B", parameters: { path: "b.ts" } },
    }),
  });
  const response = await runTrace(makeRequest(), fixture.adapter, {
    segmentId: "json-round-trip",
    emit: event => records.push(event),
  });
  assert.equal(response.trace.capture, "complete");
  const roundTripped = parseTraceJsonl(
    [...records, { kind: "capture_summary", trace: response.trace }]
      .map(event => JSON.stringify(event)).join("\n"),
  ).events;
  assert.deepEqual(roundTripped, records);
  assertBackwardReferences(roundTripped);
  assertEvaluationDispositions(roundTripped);
  const dispatch = eventsOf(roundTripped, "dispatch_started")[0];
  const accepted = eventsOf(roundTripped, "selection_accepted")[0];
  assert.equal(dispatch.payload.details.selectionEventRef, accepted.eventId);
  assert.deepEqual(dispatch.payload.details.decision, {
    target: "B",
    parameters: { path: "b.ts" },
  });
});

test("JSON consumer rejects incomplete claimed captures and broken graph references", async () => {
  const records = [];
  const fixture = createFixtureAdapter();
  const response = await runTrace(makeRequest(), fixture.adapter, {
    segmentId: "consumer-corruption",
    emit: event => records.push(event),
  });
  const encode = (events, summaries = [{ kind: "capture_summary", trace: response.trace }]) =>
    [...events, ...summaries].map(value => JSON.stringify(value)).join("\n");
  assert.doesNotThrow(() => parseTraceJsonl(encode(records)));
  assert.throws(() => parseTraceJsonl(encode(records, [])), /capture summary/);
  assert.throws(() => parseTraceJsonl(encode(records.slice(0, -1))), /terminal/);
  const forward = structuredClone(records);
  forward[1].payload.previousEventRef = forward.at(-1).eventId;
  assert.throws(() => parseTraceJsonl(encode(forward)), /prior event/);
  const dangling = structuredClone(records);
  eventsOf(dangling, "evaluation_applied")[0].payload.details.evaluationEventRef = "missing-evaluation";
  assert.throws(() => parseTraceJsonl(encode(dangling)), /evaluationEventRef/);
  const missingState = structuredClone(records);
  eventsOf(missingState, "evaluation_started")[0].payload.details.inputRefs.stateRef = "missing-state";
  assert.throws(() => parseTraceJsonl(encode(missingState)), /stateRef/);
  const missingAtomic = structuredClone(records);
  eventsOf(missingAtomic, "atomic_returned")[0].payload.details.atomicResultRef = "missing-atomic";
  assert.throws(() => parseTraceJsonl(encode(missingAtomic)), /atomicResultRef/);
  const missingReceiptState = structuredClone(records);
  eventsOf(missingReceiptState, "resource_defined")
    .find(event => event.payload.details.resourceType === "atomic")
    .payload.details.resource.observedStateRef = "missing-receipt-state";
  assert.throws(() => parseTraceJsonl(encode(missingReceiptState)), /atomic.observedStateRef/);
  const missingEvidence = structuredClone(records);
  eventsOf(missingEvidence, "evidence_view_defined").at(-1)
    .payload.details.memberIds.push("missing-evidence");
  assert.throws(() => parseTraceJsonl(encode(missingEvidence)), /evidence member/);
});

test("public JSONL consumer demonstrates split, blocked, independent, resumed, and closure", async () => {
  const chunks = [];
  const output = new PassThrough();
  output.on("data", chunk => chunks.push(String(chunk)));
  const run = await runTraceJsonExample({
    output,
    segmentId: "closure-json-demo",
  });
  const parsed = parseTraceJsonl(chunks.join(""));
  assert.equal(parsed.summary.length, 1);
  assert.equal(parsed.summary[0].trace.capture, "complete");
  assert.equal(parsed.summary[0].trace.history, "from_admission");
  validateTraceEvents(parsed.events);
  assert.equal(parsed.events.at(-1).payload.kind, "segment_ended");
  assert.equal(
    eventsOf(parsed.events, "step_started").every(event =>
      Object.hasOwn(event.payload.details, "control")),
    true,
  );
  const blocked = eventsOf(parsed.events, "branch_changed").filter(
    event => event.payload.details.state === "blocked",
  );
  const resumed = eventsOf(parsed.events, "branch_changed").filter(
    event => event.payload.details.state === "resumed",
  );
  assert.ok(blocked.length > 0);
  assert.ok(resumed.length > 0);
  for (const event of resumed) {
    assert.ok(
      event.payload.causes.some(cause => cause.relation === "blocked_event"),
    );
    assert.ok(
      event.payload.causes.some(
        cause => cause.relation === "changed_observation",
      ),
    );
  }
  const executions = eventsOf(parsed.events, "atomic_returned").map(
    event => event.payload.details.runId,
  );
  assert.deepEqual(executions, ["trace-demo-run-B", "trace-demo-run-A"]);
  const final = eventsOf(parsed.events, "final_summary")[0];
  assert.deepEqual(final.payload.details.remainingRequirements, []);
  assert.equal(final.payload.details.errorRefs.length, 1);
  assert.equal(final.payload.details.primaryErrorId, null);
  assert.equal(run.response.trace.capture, "complete");
});

function branchHarness({ remainDeferred = true } = {}) {
  const executions = [];
  const fixture = createFixtureAdapter({
    derive(input) {
      return {
        conditions: ["A", "B"].map(id =>
          singleChildDerivation({
            id,
            goal: counterGoal(id === "A" ? 2 : 1, { role: id }),
            bindings: input.bindings,
            selectorId: `${id}-selector`,
          }).conditions[0],
        ),
        nextCursor: "closed",
        expansion: "closed",
      };
    },
    select(input) {
      if (input.goal.role === "A" && (input.state.count === 0 || remainDeferred)) {
        return { kind: "defer", reason: "evidence not ready" };
      }
      return { kind: "selected", skillId: input.candidates[0].id };
    },
    executeAtomic(input) {
      executions.push(input.goal.role);
      return successfulAtomicReceipt({
        count: input.state.count + 1,
        stateId: `branch-state-${input.goal.role}`,
        evidenceId: `branch-evidence-${input.goal.role}`,
        runId: `branch-run-${input.goal.role}`,
      });
    },
  });
  const request = makeRequest({
    rootGoal: counterGoal(2, { role: "root" }),
    limits: { maxTransitions: 64, maxDepth: 4, maxDerivedGoals: 4 },
  });
  const deps = {
    adapter: fixture.adapter,
    enabledSkills: [
      skill("compose", "composite"),
      skill("read-A", "atomic"),
      skill("read-B", "atomic"),
    ],
    enabledEvaluators: [evaluator()],
    selectors: [
      selector("root-selector", ["compose"]),
      selector("A-selector", ["read-A"]),
      selector("B-selector", ["read-B"]),
    ],
    grantedEffects: new Set(),
    comparators: comparators(),
  };
  return { request, deps, fixture, executions };
}

test("continuation with and without an external prefix never replays atomic work", async () => {
  const { request, deps, fixture, executions } = branchHarness();
  const firstEvents = [];
  deps.trace = {
    segmentId: "closure-prefix-first",
    emit: event => firstEvents.push(event),
  };
  const first = await runRecursiveGoal(request, deps);
  const firstReport = responseReport(first);
  assert.ok(firstReport.continuation);
  assert.deepEqual(executions, ["B"]);
  const continuation = firstReport.continuation;

  const withoutPrefix = [];
  deps.trace = {
    segmentId: "closure-prefix-missing",
    emit: event => withoutPrefix.push(event),
  };
  const missing = await runRecursiveGoal(
    { ...request, continuation },
    deps,
  );
  assert.equal(missing.trace.history, "prefix_unavailable");
  assert.equal(fixture.calls.executeAtomic, 1);

  const withPrefix = [];
  deps.trace = {
    segmentId: "closure-prefix-linked",
    prefix: {
      segmentId: "closure-prefix-first",
      terminalEventId: first.trace.terminalEventId,
    },
    emit: event => withPrefix.push(event),
  };
  const linked = await runRecursiveGoal(
    { ...request, continuation },
    deps,
  );
  assert.equal(linked.trace.history, "linked_prefix");
  assert.equal(fixture.calls.executeAtomic, 1);
  assert.deepEqual(executions, ["B"]);
  assert.ok(
    withPrefix.some(
      event =>
        event.payload.kind === "frame_defined" &&
        event.payload.details.imported === true,
    ),
  );
  assert.ok(
    withPrefix.some(
      event =>
        event.payload.kind === "evidence_view_defined" &&
        event.payload.details.imported === true,
    ),
  );
  assert.equal(linked.trace.capture, "complete");
});

test("invalid and throwing selectors retain the raw failure boundary", async () => {
  const invalidRecords = [];
  const invalid = createFixtureAdapter({
    select: () => ({ kind: "selected", skillId: "outside" }),
  });
  const invalidResponse = await runTrace(
    makeRequest(),
    invalid.adapter,
    { segmentId: "invalid-selection", emit: event => invalidRecords.push(event) },
  );
  const invalidReport = responseReport(invalidResponse);
  assert.equal(invalidReport.control.outcome, "error");
  assert.equal(
    invalidRecords.some(event => event.payload.kind === "selection_returned"),
    true,
  );
  assert.equal(
    invalidRecords.some(event => event.payload.kind === "selection_rejected"),
    true,
  );
  assert.equal(
    invalidRecords.some(event => event.payload.kind === "selection_accepted"),
    false,
  );
  assert.equal(invalidRecords.some(event => event.payload.kind === "dispatch_started"), false);
  assert.equal(invalid.calls.executeAtomic, 0);

  const throwingRecords = [];
  const throwing = createFixtureAdapter({
    select: () => {
      throw new Error("selector callback exploded");
    },
  });
  const throwingResponse = await runTrace(
    makeRequest(),
    throwing.adapter,
    { segmentId: "throwing-selection", emit: event => throwingRecords.push(event) },
  );
  assert.equal(responseReport(throwingResponse).control.outcome, "error");
  assert.equal(
    throwingRecords.some(event => event.payload.kind === "selection_failed"),
    true,
  );
  const failed = throwingRecords.find(
    event => event.payload.kind === "selection_failed",
  );
  assert.match(failed.payload.details.inputRefs.stateRef, /:state:/);
  assert.match(
    failed.payload.details.inputRefs.evidenceViewRef,
    /:event:\d+$/,
  );
  assert.match(
    failed.payload.details.inputRefs.conditionViewRef,
    /:event:\d+$/,
  );
  assert.equal(
    throwingRecords.some(event => event.payload.kind === "selection_returned"),
    false,
  );
  assert.equal(throwing.calls.executeAtomic, 0);
});

test("throwing and invalid atomic callbacks are real results, never accepted observations", async () => {
  for (const [label, implementation, expectedMessage] of [
    ["throw", () => {
      throw new Error("atomic callback exploded");
    }, "atomic callback exploded"],
    ["invalid", () => ({ not: "a receipt" }), "unsupported field not"],
  ]) {
    const records = [];
    const fixture = createFixtureAdapter({ executeAtomic: implementation });
    const response = await runTrace(makeRequest(), fixture.adapter, {
      segmentId: `atomic-${label}`,
      emit: event => records.push(event),
    });
    const report = responseReport(response);
    const result = eventsOf(records, "atomic_returned")[0];
    assert.ok(result, `${label} must emit an atomic result`);
    assert.equal(result.payload.details.outcome, "unknown");
    assert.equal(result.payload.details.executorInvoked, "unknown");
    assert.equal(result.payload.details.sourceResult, null);
    assert.equal(result.payload.details.observationAccepted, false);
    assert.equal(eventsOf(records, "observation_accepted").length, 0);
    assert.ok(
      report.errors.some(error =>
        String(error.diagnosticMessage ?? "").includes(expectedMessage),
      ),
      `${label} must preserve the original failure`,
    );
    assert.equal(fixture.calls.executeAtomic, 1);
    assert.equal(response.trace.capture, "complete");
  }
});

test("evaluation return and disposition remain paired for accepted, rejected, and thrown evaluations", async () => {
  const validRecords = [];
  const valid = await runTrace(
    makeRequest(),
    createFixtureAdapter().adapter,
    { segmentId: "evaluation-valid", emit: event => validRecords.push(event) },
  );
  assert.equal(valid.trace.capture, "complete");
  assertEvaluationDispositions(validRecords);
  assert.ok(eventsOf(validRecords, "evaluation_applied").length > 0);

  const invalidRecords = [];
  const invalid = createFixtureAdapter({
    evaluate: () => ({
      evaluatorId: "wrong-evaluator",
      result: "unsatisfied",
      satisfaction: 0,
      necessaryConditionsMet: false,
      evidenceRefs: [],
    }),
  });
  const invalidResponse = await runTrace(
    makeRequest(),
    invalid.adapter,
    { segmentId: "evaluation-invalid", emit: event => invalidRecords.push(event) },
  );
  assert.equal(responseReport(invalidResponse).control.outcome, "error");
  assertEvaluationDispositions(invalidRecords);
  assert.ok(eventsOf(invalidRecords, "evaluation_discarded").length > 0);

  const thrownRecords = [];
  const thrown = createFixtureAdapter({
    evaluate: () => {
      throw new Error("evaluator callback exploded");
    },
  });
  const thrownResponse = await runTrace(
    makeRequest(),
    thrown.adapter,
    { segmentId: "evaluation-thrown", emit: event => thrownRecords.push(event) },
  );
  assert.equal(responseReport(thrownResponse).control.outcome, "error");
  assertEvaluationDispositions(thrownRecords);
  assert.equal(eventsOf(thrownRecords, "evaluation_failed").length, 1);
  assert.equal(eventsOf(thrownRecords, "evaluation_returned").length, 0);
  assert.equal(thrown.calls.executeAtomic, 0);
});

test("sink failures at independent boundaries preserve execution and report incomplete capture", async () => {
  const baseline = createFixtureAdapter();
  const expected = responseReport(
    await runRecursiveGoal(makeRequest(), dependencies(baseline.adapter)),
  );
  for (const boundary of [
    "resource_defined",
    "selection_returned",
    "evaluation_returned",
    "final_summary",
  ]) {
    const fixture = createFixtureAdapter();
    let attempts = 0;
    const response = await runTrace(makeRequest(), fixture.adapter, {
      segmentId: `sink-${boundary}`,
      emit(event) {
        attempts += 1;
        if (event.payload.kind === boundary) {
          throw new Error(`sink failed at ${boundary}`);
        }
      },
    });
    assert.deepEqual(responseReport(response), expected);
    assert.deepEqual(fixture.calls, baseline.calls);
    assert.ok(attempts >= 1);
    assert.equal(response.trace.capture, "incomplete");
    assert.equal(response.trace.failure.category, "sink");
    assert.equal(response.trace.failure.message, `sink failed at ${boundary}`);
    if (boundary === "final_summary") {
      assert.ok(response.trace.missingCoverage.includes("terminal_summary"));
    }
  }
});

test("trace absent and present use the same callback contract and counts", async () => {
  const baseline = createFixtureAdapter();
  const baselineResponse = await runRecursiveGoal(
    makeRequest(),
    dependencies(baseline.adapter),
  );
  const instrumented = createFixtureAdapter();
  const instrumentedResponse = await runTrace(
    makeRequest(),
    instrumented.adapter,
    { segmentId: "count-parity", emit() {} },
  );
  assert.deepEqual(responseReport(instrumentedResponse), responseReport(baselineResponse));
  assert.deepEqual(instrumented.calls, baseline.calls);
  assert.equal(instrumentedResponse.trace.capture, "complete");
});

test("zero-action completion has no invented dispatch or atomic receipt", async () => {
  const records = [];
  const fixture = createFixtureAdapter();
  const response = await runTrace(
    makeRequest({
      state: { count: 1 },
      initialObservation: initialObservation(),
    }),
    fixture.adapter,
    { segmentId: "zero-action", emit: event => records.push(event) },
  );
  assert.equal(responseReport(response).rootEvaluation.result, "satisfied");
  assert.equal(eventsOf(records, "dispatch_started").length, 0);
  assert.equal(eventsOf(records, "atomic_returned").length, 0);
  assertEvaluationDispositions(records);
  assert.equal(fixture.calls.executeAtomic, 0);
});

test("admission rejection records a real terminal without invented root or steps", async () => {
  const records = [];
  const fixture = createFixtureAdapter();
  const response = await runTrace(
    { schema: "invalid-request" },
    fixture.adapter,
    { segmentId: "admission-rejected", emit: event => records.push(event) },
  );
  assert.equal(response.kind, "request_rejected");
  assert.equal(response.trace.capture, "complete");
  const terminal = eventsOf(records, "final_summary")[0];
  assert.ok(terminal);
  assert.equal(terminal.payload.details.responseKind, "request_rejected");
  assert.equal(terminal.payload.details.control, null);
  assert.equal(terminal.payload.details.rootEvaluation, null);
  assert.deepEqual(terminal.payload.details.frames, []);
  assert.equal(terminal.payload.details.primaryErrorId, response.error.errorId);
  assert.equal(eventsOf(records, "step_started").length, 0);
  assert.equal(records.at(-1).payload.kind, "segment_ended");
});

test("checkpoint evaluation records its actual goal and bindings instead of the frame definition", async () => {
  const resources = createBoundedFiniteResources({
    scenario: "checkpoint",
    checkpoint: true,
    actualBranch: "reject",
    expectedBranch: "reject",
  });
  const records = [];
  resources.dependencies.trace = {
    segmentId: "checkpoint-input",
    emit: event => records.push(event),
  };
  let continuation = null;
  for (let step = 0; step < 8; step += 1) {
    const run = await runBoundedFiniteStep(resources, continuation);
    assert.equal(run.response.kind, "run_result");
    continuation = run.response.report.continuation;
    if (continuation === null) break;
  }
  const checkpoint = eventsOf(records, "evaluation_started").find(
    event => event.payload.details.purpose === "checkpoint",
  );
  assert.ok(checkpoint);
  assert.equal(checkpoint.payload.details.inputDefinition.kind, "inline");
  assert.equal(
    checkpoint.payload.details.inputDefinition.goal.kind,
    "finite.bounded-checkpoint",
  );
  assert.deepEqual(
    checkpoint.payload.details.inputDefinition.bindings,
    resources.request.rootBindings,
  );
});

test("failed atomic receipt preserves sourceResult and diagnostic references in the trace", async () => {
  const records = [];
  const fixture = createFixtureAdapter({
    executeAtomic: () =>
      failedAtomicReceipt({
        sourceResult: {
          tag: "fixture.original-failure",
          value: { token: "original-token" },
        },
      }),
  });
  const response = await runTrace(
    makeRequest(),
    fixture.adapter,
    { segmentId: "failed-receipt", emit: event => records.push(event) },
  );
  const report = responseReport(response);
  const atomic = eventsOf(records, "atomic_returned")[0];
  assert.deepEqual(atomic.payload.details.sourceResult, {
    tag: "fixture.original-failure",
    value: { token: "original-token" },
  });
  assert.ok(atomic.payload.details.diagnosticRefs.length > 0);
  assert.ok(
    atomic.payload.details.diagnosticRefs.every(id =>
      report.errors.some(error => error.errorId === id),
    ),
  );
  assert.equal(atomic.payload.details.observationAccepted, false);
});
