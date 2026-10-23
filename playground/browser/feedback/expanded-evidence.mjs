export function verificationErrors(output) {
  return (output?.errors ?? []).filter(error => error.stage === 'observation');
}

export function evidenceFor({ segments }) {
  const dispatches = segments.reduce((sum, segment) => sum + (segment.output?.clicks?.length ?? 0), 0);
  // A retry means a new native dispatch after a segment that already stopped
  // for a stop condition. Legal same-goal recovery across yields keeps its own
  // expected dispatch count and is not a retry.
  const retryAttempted = segments.some((segment, index) => {
    const previous = segments[index - 1]?.output ?? null;
    if (index === 0 || previous === null) return false;
    if (previous.outcome === 'yielded') return false;
    return (segment.output?.clicks?.length ?? 0) > 0;
  });
  const f1Heads = [];
  const effectKnowledge = [];
  const executionErrors = [];
  const observationErrors = [];
  const seenAtomic = new Set();
  const seenObservationErrors = new Set();
  for (const segment of segments) {
    for (const error of verificationErrors(segment.output)) {
      const key = JSON.stringify([
        error.code,
        error.source ?? null,
        error.diagnosticMessage ?? null,
        error.nativeCode ?? null,
      ]);
      if (seenObservationErrors.has(key)) continue;
      seenObservationErrors.add(key);
      observationErrors.push(error.code);
    }
    for (const atomic of segment.output?.atomic ?? []) {
      if (atomic.dispatchId !== undefined) {
        if (seenAtomic.has(atomic.dispatchId)) continue;
        seenAtomic.add(atomic.dispatchId);
      }
      if (atomic.feedback?.status === 'goal_achieved') f1Heads.push('goal_achieved');
      else if (atomic.feedback?.head) f1Heads.push(atomic.feedback.head);
      if (atomic.effectKnowledge) effectKnowledge.push(atomic.effectKnowledge);
      executionErrors.push(...(atomic.executionErrors ?? []));
    }
  }
  const last = segments.at(-1)?.output ?? null;
  const lastRunResult = [...segments].reverse().find(segment => segment.output?.kind === 'run_result')?.output ?? null;
  const outcome = last?.kind === 'request_rejected' ? 'request_rejected' : last?.outcome ?? 'error';
  const rejected = last?.rejection?.code ?? null;
  const deferred = (last?.errors ?? []).find(error =>
    error.code === 'policy_deferred' || error.source?.category === 'policy_deferred');
  const deferReason = deferred
    ? (deferred.diagnosticMessage ?? deferred.source?.category ?? 'policy_deferred')
    : (/defer/i.test(last?.stopReason ?? '') ? last.stopReason : null);
  return {
    outcome,
    root: lastRunResult?.rootResult ?? 'unknown',
    dispatches,
    f1Heads,
    effectKnowledge,
    executionErrors,
    observationErrors,
    retryAttempted,
    deferReason,
    rejected,
    segments: segments.length,
    continuationCount: segments.filter(segment => segment.output?.continuation).length,
    continuationDispatches: dispatches - (segments[0]?.output?.clicks?.length ?? 0),
    stops: segments.map(segment => segment.output?.stopReason ?? null).filter(Boolean),
  };
}
