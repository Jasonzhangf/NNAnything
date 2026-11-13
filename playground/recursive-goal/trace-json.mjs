import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

import { runRecursiveGoal } from "nnanything/recursive-goal";

const ROOT_GOAL = Object.freeze({ kind: "trace-demo-root" });
const EVALUATOR_ID = "trace-demo-evaluator";
const ROOT_SELECTOR_ID = "trace-demo-root-selector";

function evidence(id, stateRef, role) {
  return { id, stateRef, payload: { role }, validity: "valid" };
}

function validEvidence(input) {
  return input.evidence
    .filter(item => item.validity === "valid")
    .map(item => item.id);
}

function evaluate(input) {
  const state = input.state;
  const goal = input.goal;
  const role = goal.kind === "trace-demo-leaf" ? goal.role : "root";
  const satisfied =
    role === "root"
      ? state.aDone === true && state.bDone === true
      : role === "A"
        ? state.aDone === true
        : state.bDone === true;
  return {
    evaluatorId: EVALUATOR_ID,
    result: satisfied ? "satisfied" : "unsatisfied",
    satisfaction: satisfied ? 100 : 0,
    necessaryConditionsMet: satisfied,
    evidenceRefs: satisfied ? validEvidence(input) : [],
  };
}

function derive(input) {
  if (input.goal.kind !== "trace-demo-root") {
    throw new TypeError("only the root goal derives children");
  }
  return {
    conditions: [
      {
        id: "trace-demo-A",
        goal: { kind: "trace-demo-leaf", role: "A" },
        bindings: input.bindings,
        satisfactionThreshold: 100,
        evaluatorId: EVALUATOR_ID,
        selectorId: "trace-demo-A-selector",
        mode: "atomic",
        dependsOn: [],
        lifetime: "stage",
        activation: "required",
        allowedEffects: [],
      },
      {
        id: "trace-demo-B",
        goal: { kind: "trace-demo-leaf", role: "B" },
        bindings: input.bindings,
        satisfactionThreshold: 100,
        evaluatorId: EVALUATOR_ID,
        selectorId: "trace-demo-B-selector",
        mode: "atomic",
        dependsOn: [],
        lifetime: "stage",
        activation: "required",
        allowedEffects: [],
      },
    ],
    nextCursor: "closed",
    expansion: "closed",
  };
}

function select(input) {
  if (input.goal.kind === "trace-demo-root") {
    return { kind: "selected", skillId: "trace-demo-split" };
  }
  if (input.goal.role === "A" && input.state.bDone !== true) {
    return { kind: "defer", reason: "B evidence is not available" };
  }
  return {
    kind: "selected",
    skillId: input.goal.role === "A" ? "trace-demo-read-a" : "trace-demo-read-b",
  };
}

function receiptFor(input) {
  const role = input.goal.role;
  const next = { ...input.state, [`${role.toLowerCase()}Done`]: true };
  const stateId = `trace-demo-state-${role}`;
  return {
    runId: `trace-demo-run-${role}`,
    executorInvoked: true,
    outcome: "succeeded",
    sourceResult: {
      tag: "trace-demo.receipt",
      value: { role, stateRef: stateId },
    },
    newState: { id: stateId, value: next },
    evidence: [evidence(`trace-demo-evidence-${role}`, stateId, role)],
    executionErrors: [],
    verificationErrors: [],
    effect: { knowledge: "none", confirmedEffects: [], receiptRef: null },
  };
}

function validateRequest(request) {
  return {
    requestId: request.requestId,
    rootGoal: request.rootGoal,
    satisfactionThreshold: request.satisfactionThreshold,
    rootBindings: request.rootBindings,
    state: request.state,
    rootEvaluatorId: request.rootEvaluatorId,
    rootSelectorId: request.rootSelectorId,
    limits: request.limits,
    continuation: request.continuation ?? null,
  };
}

function comparators() {
  return {
    sameGoal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameBindings: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    sameFacts: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  };
}

export function createTraceJsonRequest() {
  return {
    schema: "nnanything.recursive-goal.request.v1",
    requestId: "trace-json-demo",
    rootGoal: ROOT_GOAL,
    satisfactionThreshold: 100,
    rootBindings: { scope: "trace-json-demo" },
    state: { aDone: false, bDone: false },
    rootEvaluatorId: EVALUATOR_ID,
    rootSelectorId: ROOT_SELECTOR_ID,
    limits: { maxTransitions: 64, maxDepth: 4, maxDerivedGoals: 4 },
  };
}

export function createTraceJsonAdapter() {
  const calls = {
    evaluate: 0,
    select: 0,
    derive: 0,
    executeAtomic: 0,
  };
  const adapter = {
    async validateRequest(request) {
      return validateRequest(request);
    },
    supports(input) {
      return input.skill.capability === input.goal.kind.replace("trace-demo-", "trace-demo.");
    },
    async evaluate(input) {
      calls.evaluate += 1;
      return evaluate(input);
    },
    async select(input) {
      calls.select += 1;
      return select(input);
    },
    async derive(input) {
      calls.derive += 1;
      return derive(input);
    },
    async executeAtomic(input) {
      calls.executeAtomic += 1;
      return receiptFor(input);
    },
    validateAtomicReceipt(raw) {
      return raw;
    },
    measureProgress(input) {
      return {
        improved: JSON.stringify(input.before) !== JSON.stringify(input.after),
        reason: "finite_trace_demo",
        comparable: true,
      };
    },
  };
  return { adapter, calls };
}

export function createTraceJsonDependencies(adapter, emit, segmentId = "trace-json-demo") {
  const evaluator = {
    id: EVALUATOR_ID,
    goalType: "trace-demo",
    thresholdContract: "0..100",
    allowsPartialSatisfaction: false,
  };
  const skills = [
    {
      id: "trace-demo-split",
      version: "1.0.0",
      mode: "composite",
      capability: "trace-demo.root",
      evaluatorId: EVALUATOR_ID,
      requiredEffects: [],
      allowedEffects: [],
      retry: "never",
      effectClass: "none",
    },
    {
      id: "trace-demo-read-a",
      version: "1.0.0",
      mode: "atomic",
      capability: "trace-demo.leaf",
      evaluatorId: EVALUATOR_ID,
      requiredEffects: [],
      allowedEffects: [],
      retry: "never",
      effectClass: "none",
    },
    {
      id: "trace-demo-read-b",
      version: "1.0.0",
      mode: "atomic",
      capability: "trace-demo.leaf",
      evaluatorId: EVALUATOR_ID,
      requiredEffects: [],
      allowedEffects: [],
      retry: "never",
      effectClass: "none",
    },
  ];
  return {
    adapter,
    enabledSkills: skills,
    enabledEvaluators: [evaluator],
    selectors: [
      { id: ROOT_SELECTOR_ID, skillIds: ["trace-demo-split"] },
      { id: "trace-demo-A-selector", skillIds: ["trace-demo-read-a"] },
      { id: "trace-demo-B-selector", skillIds: ["trace-demo-read-b"] },
    ],
    comparators: comparators(),
    grantedEffects: new Set(),
    trace: { segmentId, emit },
  };
}

export async function runTraceJsonExample(options = {}) {
  const output = options.output ?? process.stdout;
  const segmentId = options.segmentId ?? "trace-json-demo";
  const { adapter } = createTraceJsonAdapter();
  const write = event => {
    output.write(`${JSON.stringify(event)}\n`);
  };
  const dependencies = createTraceJsonDependencies(adapter, write, segmentId);
  const response = await runRecursiveGoal(createTraceJsonRequest(), dependencies);
  const summary = { kind: "capture_summary", trace: response.trace };
  write(summary);
  if (output !== process.stdout) {
    output.end();
    await once(output, "close");
  }
  return { response, summary };
}

export function parseTraceJsonl(text) {
  const events = [];
  const summary = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const value = JSON.parse(line);
    if (value.kind === "capture_summary") summary.push(value);
    else {
      if (summary.length > 0) throw new Error("events must precede the capture summary");
      events.push(value);
    }
  }
  if (summary.length !== 1) throw new Error("expected exactly one capture summary");
  const capture = summary[0].trace;
  if (capture.capture === "complete" &&
      (events[0]?.payload.kind !== "segment_started" ||
       events.at(-1)?.payload.kind !== "segment_ended" ||
       events.at(-1)?.eventId !== capture.terminalEventId)) {
    throw new Error("complete capture requires its terminal segment_ended record");
  }
  validateTraceEvents(events, { complete: capture.capture === "complete" });
  return { events, summary };
}

export function validateTraceEvents(events, { complete = true } = {}) {
  const seen = new Map();
  const resources = { state: new Set(), evidence: new Set(), atomic: new Set() };
  const frames = new Set();
  const diagnostics = new Set();
  const receiptLinks = [];
  const requireResource = (kind, ref, field) => {
    if (ref != null && !resources[kind].has(ref)) {
      throw new Error(`${field} references missing ${kind} definition ${ref}`);
    }
  };
  const requireEvent = (ref, field, kind) => {
    if (ref == null) return;
    const prior = seen.get(ref);
    if (prior === undefined || (kind !== undefined && prior.payload.kind !== kind)) {
      throw new Error(`${field} must reference a prior event${kind ? ` of kind ${kind}` : ""}: ${ref}`);
    }
  };
  for (const event of events) {
    const { kind, details: d, frameRef, previousEventRef, causes } = event.payload;
    if (seen.has(event.eventId)) throw new Error(`duplicate event ${event.eventId}`);
    requireEvent(previousEventRef, "previousEventRef");
    for (const cause of causes) requireEvent(cause.eventRef, "cause");
    for (const [field, expected] of [
      ["invocationEventRef", "evaluation_started"],
      ["evaluationEventRef", "evaluation_returned"],
      ["parentDerivationEventRef", "conditions_derived"],
      ["atomicReceiptEventRef", "atomic_returned"],
    ]) requireEvent(d[field], field, expected);
    if (d.selectionEventRef != null) {
      requireEvent(d.selectionEventRef, "selectionEventRef",
        kind === "dispatch_started" || kind === "conditions_derived"
          ? "selection_accepted" : "selection_returned");
    }
    for (const ref of d.activeStackEventRefs ?? []) requireEvent(ref, "activeStackEventRefs", "frame_defined");
    if (d.inputDefinition?.kind === "frame_definition") {
      requireEvent(d.inputDefinition.eventRef, "inputDefinition", "frame_defined");
    }
    if (d.inputRefs !== undefined) {
      requireResource("state", d.inputRefs.stateRef, "inputRefs.stateRef");
      requireEvent(d.inputRefs.evidenceViewRef, "evidenceViewRef", "evidence_view_defined");
      requireEvent(d.inputRefs.conditionViewRef, "conditionViewRef", "condition_view_defined");
    }
    if (kind === "frame_defined") {
      if (d.parentFrameRef !== null && !frames.has(d.parentFrameRef)) throw new Error("missing parentFrameRef");
      frames.add(frameRef);
    }
    if (kind === "resource_defined") {
      const r = d.resource;
      const ref = d.resourceType === "atomic" ? r.dispatchId : r.id;
      if (resources[d.resourceType].has(ref)) throw new Error(`duplicate resource ${ref}`);
      if (d.resourceType === "evidence") requireResource("state", r.stateRef, "resource.stateRef");
      // An atomic receipt describes its post before that post is admitted as State.
      // It is not an input/accepted observation. Check its identity link at closure.
      if (d.resourceType === "atomic") receiptLinks.push(["state", r.observedStateRef, "atomic.observedStateRef"]);
      resources[d.resourceType].add(ref);
    }
    if (kind === "evidence_view_defined") {
      for (const ref of d.memberIds) requireResource("evidence", ref, "evidence member");
    }
    if (kind === "condition_view_defined") {
      for (const condition of d.conditions) {
        for (const ref of condition.evidenceRefs) requireResource("evidence", ref, "condition.evidenceRefs");
      }
    }
    if (kind === "atomic_returned" || kind === "observation_accepted") {
      requireResource("atomic", d.atomicResultRef, "atomicResultRef");
    }
    if (kind === "observation_accepted" || kind === "branch_changed") {
      requireResource("state", d.stateRef, "stateRef");
      for (const ref of d.evidenceRefs ?? []) requireResource("evidence", ref, "evidenceRefs");
    }
    if (kind === "evaluation_applied") {
      const evaluation = seen.get(d.evaluationEventRef).payload.details.evaluation;
      for (const ref of evaluation.evidenceRefs) requireResource("evidence", ref, "applied evidenceRefs");
    }
    if (kind === "diagnostic") {
      diagnostics.add(d.diagnostic.errorId);
      for (const ref of d.diagnostic.atomicResultRefs) receiptLinks.push(["atomic", ref, "diagnostic.atomicResultRefs"]);
    }
    for (const ref of [...(d.diagnosticRefs ?? []), ...(d.errorRefs ?? []),
      ...(d.executionErrorIds ?? []), ...(d.verificationErrorIds ?? []),
      d.diagnosticRef, d.priorDiagnosticRef].filter(ref => ref != null)) {
      if (!diagnostics.has(ref)) throw new Error(`missing diagnostic ${ref}`);
    }
    if (kind === "final_summary" || kind === "segment_ended") {
      for (const ref of d.rootEvaluation?.evidenceRefs ?? []) requireResource("evidence", ref, "rootEvaluation.evidenceRefs");
      for (const frame of d.frames) {
        if (!frames.has(frame.frameRef)) throw new Error(`missing terminal frame ${frame.frameRef}`);
        requireResource("atomic", frame.pendingVerificationDispatchRef, "pendingVerificationDispatchRef");
      }
    }
    seen.set(event.eventId, event);
  }
  if (complete) for (const [kind, ref, field] of receiptLinks) requireResource(kind, ref, field);
  return { events: seen.size };
}

async function main() {
  const outputPath = process.argv[2];
  if (outputPath === undefined) {
    await runTraceJsonExample();
    return;
  }
  const output = createWriteStream(outputPath, { flags: "w" });
  await runTraceJsonExample({ output });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
