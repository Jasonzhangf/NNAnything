import { basename } from "node:path";

const EXECUTION_HEADS = new Set(["entry.inspect", "ls", "read"]);

export function atomicStepViews(response) {
  const report = response?.report;
  const states = Array.isArray(report?.states) ? report.states.map(step => step?.value ?? null) : [];
  const atomics = Array.isArray(report?.atomicResults) ? report.atomicResults : [];
  return atomics.map((item, index) => {
    const source = item.sourceResult?.value ?? null;
    const invocation = Array.isArray(source?.invocation) ? source.invocation : null;
    const tag = item.sourceResult?.tag ?? null;
    const head = invocation?.[0] ?? (tag === "cli.file.read.receipt.v1" ? "read" : null);
    const path = invocation?.[1]?.path ?? source?.ref?.absolutePath ?? null;
    const execution = source?.receipt?.execution ?? null;
    const domainOutcome = execution?.status === "failed"
      ? "failed"
      : execution?.status === "succeeded"
        ? "succeeded"
        : item.outcome;
    return {
      index,
      dispatchId: item.dispatchId,
      head,
      candidateName: typeof path === "string" ? basename(path) : null,
      outcome: domainOutcome,
      workflowOutcome: item.outcome,
      errorCode: execution?.status === "failed" ? (execution?.error?.code ?? null) : null,
      stateBeforeRef: states[index]?.stateId ?? null,
      stateAfterRef: typeof item.observedStateRef === "string" ? item.observedStateRef : (states[index + 1]?.stateId ?? null),
    };
  });
}

export function decisionExecutions(decisions, steps) {
  let cursor = 0;
  return decisions.map(decision => {
    const selectedName = decision.selectedName ?? decision.selected?.name ?? null;
    const candidateNames = Array.isArray(decision.candidateNames)
      ? [...decision.candidateNames]
      : (decision.candidates ?? []).map(candidate => candidate.name);
    const selectedFeatures = Array.isArray(decision.selectedFeatures)
      ? [...decision.selectedFeatures]
      : (Array.isArray(decision.selected?.features) ? [...decision.selected.features] : null);
    const normalized = {
      ...decision,
      selectedName,
      candidateNames,
      ...(selectedFeatures === null ? {} : { selectedFeatures }),
    };
    let start = cursor;
    while (start < steps.length) {
      const step = steps[start];
      if (step !== undefined && EXECUTION_HEADS.has(step.head) && step.candidateName === selectedName) break;
      start += 1;
    }
    if (start >= steps.length) {
      cursor = start;
      return { ...normalized, executions: [] };
    }
    let end = start;
    while (end < steps.length && steps[end] !== undefined && steps[end].candidateName === selectedName) end += 1;
    cursor = end;
    return { ...normalized, executions: steps.slice(start, end) };
  });
}

export function normalizedTrace(decisions) {
  return (decisions ?? []).map(decision => ({
    ordinal: decision.ordinal,
    forced: decision.forced,
    candidateNames: [...(decision.candidateNames ?? [])],
    selectedName: decision.selectedName,
    selectedNameColumn: decision.selectedFeatures?.[29],
  }));
}

export function t1t2Mismatches(left, right, label) {
  const leftNorm = normalizedTrace(left?.decisionTrace);
  const rightNorm = normalizedTrace(right?.decisionTrace);
  const checks = [
    ["status", left?.status, right?.status],
    ["resolution", left?.resolution, right?.resolution],
    ["satisfaction", left?.satisfaction, right?.satisfaction],
    ["root.state", left?.root?.state, right?.root?.state],
    ["root.result", left?.root?.result, right?.root?.result],
    ["root.satisfaction", left?.root?.satisfaction, right?.root?.satisfaction],
    ["control.outcome", left?.control?.outcome, right?.control?.outcome],
    ["invocationCount", left?.invocationCount, right?.invocationCount],
    ["observationCount", left?.observationCount, right?.observationCount],
    ["bytesReadTotal", left?.bytesReadTotal, right?.bytesReadTotal],
    ["duplicateReads", left?.duplicateReads, right?.duplicateReads],
    ["trace", JSON.stringify(leftNorm), JSON.stringify(rightNorm)],
  ];
  const mismatches = [];
  for (const [name, a, b] of checks) {
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(`${label}: ${name} differs`);
  }
  return mismatches;
}

export function measuredFeedback(cell) {
  const kind = cell?.feedbackKind;
  const slot0 = cell?.slot0;
  if (slot0 === null || slot0 === undefined) {
    return { covered: false, measured: "not_triggered", reasons: ["slot 0 has no candidate fact"] };
  }
  const negativeNames = Array.isArray(cell.negativeNames) ? cell.negativeNames : [];
  const inNegatives = negativeNames.includes(slot0.name);
  const reasons = [];
  let measured = "unknown";
  if (kind === "N") {
    measured = "complete_negative";
    if (slot0.outcome !== "negative" || slot0.scan?.complete !== true) reasons.push(`N slot 0 must be a complete negative, got ${slot0.outcome}/${slot0.scan?.complete}`);
  } else if (kind === "S") {
    measured = "short_read_unknown";
    if (slot0.scan?.shortRead !== true) reasons.push("S slot 0 must carry a real short read");
    if (slot0.outcome !== "unknown") reasons.push(`S slot 0 must stay unknown, got ${slot0.outcome}`);
    if (slot0.contains !== null) reasons.push("S slot 0 must keep contains=null");
    if (inNegatives) reasons.push("S slot 0 must not become a proven negative");
  } else if (kind === "E") {
    measured = "read_error_eio";
    if (slot0.outcome !== "read_error" || slot0.failureCode !== "EIO") reasons.push(`E slot 0 must be read_error/EIO, got ${slot0.outcome}/${slot0.failureCode}`);
    if (slot0.contains !== null) reasons.push("E slot 0 must keep contains=null");
    if (slot0.hasRead) reasons.push("E slot 0 must not carry a successful read");
    if (inNegatives) reasons.push("E slot 0 must not become a proven negative");
  } else if (kind === "P") {
    measured = "partial_listing_complete_negative";
    if (slot0.outcome !== "negative" || slot0.scan?.complete !== true) reasons.push(`P slot 0 must be a complete negative, got ${slot0.outcome}/${slot0.scan?.complete}`);
    if (cell.denominators?.directoriesComplete !== 0 || cell.denominators?.directoriesUncovered !== 1) reasons.push("P listing denominators must be partial");
  } else {
    return { covered: false, measured: "not_triggered", reasons: [`unknown feedback kind ${kind}`] };
  }
  return { covered: reasons.length === 0, measured, reasons };
}

export function recoveryOutcome(cell) {
  if (cell?.arm !== "forced") {
    return { applicable: false, covered: false, recovered: false, measured: null, reasons: ["not a forced cell"] };
  }
  const feedback = measuredFeedback(cell);
  if (!feedback.covered) {
    return { applicable: false, covered: false, recovered: false, measured: feedback.measured, reasons: feedback.reasons };
  }
  const slotName = cell.slot0.name;
  const trace = Array.isArray(cell.decisionTrace) ? cell.decisionTrace : [];
  const steps = Array.isArray(cell.atomicSteps) ? cell.atomicSteps : [];
  const feedbackIndex = trace.findIndex(decision =>
    decision.selectedName === slotName &&
    decision.candidateNames.includes(slotName) &&
    Array.isArray(decision.executions) &&
    decision.executions.length > 0,
  );
  if (feedbackIndex < 0) {
    return { applicable: false, covered: false, recovered: false, measured: feedback.measured, reasons: ["slot 0 selection has no real execution record"] };
  }
  const feedbackStep = Math.max(...trace[feedbackIndex].executions.map(step => step.index));
  const laterIndex = trace.slice(feedbackIndex + 1).findIndex(decision =>
    decision.selectedName !== slotName &&
    decision.candidateNames.includes(decision.selectedName) &&
    Array.isArray(decision.executions) && decision.executions.length > 0,
  );
  if (laterIndex < 0) {
    return { applicable: true, covered: true, recovered: false, measured: feedback.measured, reasons: ["no later legal candidate was actually executed"] };
  }
  const laterStep = Math.min(...trace[feedbackIndex + 1 + laterIndex].executions.map(step => step.index));
  if (laterStep <= feedbackStep) {
    return { applicable: true, covered: true, recovered: false, measured: feedback.measured, reasons: ["later candidate executed before the feedback"] };
  }
  const hitRead = steps.find(step =>
    step.candidateName === cell.hitName &&
    step.head === "read" &&
    step.index > feedbackStep &&
    step.outcome === "succeeded",
  );
  const reasons = [];
  if (hitRead === undefined) reasons.push("the hit was not read after the feedback");
  if (cell.status !== "achieved") reasons.push(`expected achieved, got ${cell.status}`);
  if (cell.root?.state !== "evaluated" || cell.root?.result !== "satisfied" || cell.root?.satisfaction !== 100) reasons.push("root evidence is not evaluated/satisfied/100");
  if (cell.control?.outcome !== "completed") reasons.push("control did not complete");
  if (cell.transitionsUsed !== null && cell.limits?.maxTransitions !== undefined && cell.transitionsUsed > cell.limits.maxTransitions) reasons.push("transitions budget exceeded");
  if (cell.derivedGoalsUsed !== null && cell.limits?.maxDerivedGoals !== undefined && cell.derivedGoalsUsed > cell.limits.maxDerivedGoals) reasons.push("derived goals budget exceeded");
  const recovered = reasons.length === 0;
  return { applicable: true, covered: true, recovered, measured: feedback.measured, reasons };
}
