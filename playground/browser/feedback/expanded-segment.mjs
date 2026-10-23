import { runBrowserStrategyGoal } from 'nnanything/browser-strategy';

const io = await import(new URL('./expanded-io.mjs', import.meta.url).href);
const run = await io.createBrowserStrategyRun();

try {
  const response = await runBrowserStrategyGoal(run.request, run.resources);
  const report = response.kind === 'run_result' ? response.report : null;
  const output = {
    caseId: run.source,
    targetId: run.targetId,
    kind: response.kind,
    outcome: report?.control.outcome ?? null,
    stopReason: report?.control.stopReason ?? null,
    rootResult: report?.rootEvaluation?.result ?? null,
    rootSatisfaction: report?.rootEvaluation?.satisfaction ?? null,
    atomic: (report?.atomicResults ?? []).map(atomic => {
      const step = atomic.sourceResult && 'value' in atomic.sourceResult ? atomic.sourceResult.value : null;
      const rawAtomic = step?.atomic ?? null;
      return {
        dispatchId: atomic.dispatchId,
        outcome: atomic.outcome,
        effectKnowledge: atomic.effect.knowledge,
        feedback: step?.feedback ?? null,
        feedbackInput: step?.feedbackInput ?? null,
        effectProof: step?.effectProof ?? null,
        decision: step?.decision ?? null,
        executionErrors: atomic.executionErrorIds,
        verificationErrors: atomic.verificationErrorIds,
        raw: rawAtomic === null ? null : {
          dispatchState: rawAtomic.dispatchState,
          receipt: rawAtomic.receipt,
          effectKnowledge: rawAtomic.effectKnowledge,
          error: rawAtomic.error,
          executionErrors: rawAtomic.executionErrors ?? [],
          observationFeedback: rawAtomic.observationFeedback ?? null,
        },
      };
    }),
    errors: (report?.errors ?? []).map(error => ({
      code: error.code,
      stage: error.stage,
      source: error.source,
      diagnosticMessage: error.diagnosticMessage,
    })),
    clicks: run.clicks,
    continuation: report?.continuation ?? null,
    state: report?.states?.at(-1)?.value ?? null,
    rejection: response.kind === 'request_rejected'
      ? { code: response.error?.code ?? null, message: response.error?.message ?? null }
      : response.kind === 'fault'
        ? { code: response.fault?.code ?? null, message: response.fault?.message ?? null }
        : null,
  };
  console.log(JSON.stringify(output));
  if (response.kind === 'fault') process.exitCode = 1;
} finally {
  if (typeof run.close === 'function') {
    try { await run.close(); } catch { /* best effort */ }
  }
}
