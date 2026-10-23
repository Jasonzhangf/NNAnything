import assert from 'node:assert/strict';
import { test } from 'node:test';

const root = new URL('../playground/browser/feedback/', import.meta.url);

test('expanded acceptance declares the 17 fixed trajectory instances once', async () => {
  const { EXPANDED_CASES } = await import(new URL('expanded-cases.mjs', root).href);
  const ids = EXPANDED_CASES.map(item => item.id);
  assert.deepEqual(ids, ['C01', 'C02', 'C03', 'C04a', 'C04b', 'C05', 'C06', 'C07', 'C08', 'C09a', 'C09b', 'C10a', 'C10b', 'C11a', 'C11b', 'C11c', 'C11d']);
  for (const item of EXPANDED_CASES) {
    assert.equal(item.familyIndependent, true, `${item.id} must run in both independent families`);
    assert.ok(item.expected && typeof item.expected.root === 'string', `${item.id} must declare an expected root fact`);
    assert.ok(Number.isInteger(item.expected.maxDispatches), `${item.id} must declare a dispatch ceiling`);
    if (item.faultInjection !== null) assert.match(item.faultInjection, /^injected:/, `${item.id} injection must be labelled`);
  }
  assert.equal(EXPANDED_CASES.filter(item => item.diagnosticProfile).map(item => item.id).join(','), 'C09a,C09b');
  assert.deepEqual(EXPANDED_CASES.filter(item => item.segments > 1).map(item => item.id), ['C10a', 'C10b', 'C11c', 'C11d']);
  assert.equal(EXPANDED_CASES.find(item => item.id === 'C01').segments, 1);
  assert.equal(EXPANDED_CASES.find(item => item.id === 'C08').segments, 1);
  assert.equal(EXPANDED_CASES.find(item => item.id === 'C10a').segments, 3);
  assert.equal(EXPANDED_CASES.find(item => item.id === 'C10b').segments, 2);
  assert.equal(EXPANDED_CASES.find(item => item.id === 'C11d').segments, 2);
});

test('expanded judge keeps unknown effects and stale observation as hard stops', async () => {
  const { EXPANDED_CASES, judgeExpandedCase } = await import(new URL('expanded-cases.mjs', root).href);
  const byId = id => EXPANDED_CASES.find(item => item.id === id);
  const unknown = judgeExpandedCase(byId('C05'), {
    outcome: 'completed', root: 'unsatisfied', dispatches: 1, f1Heads: ['indeterminate'],
    effectKnowledge: ['unknown'], observationErrors: [], executionErrors: [], retryAttempted: true, deferReason: null,
  });
  assert.equal(unknown.passed, false);
  assert.match(unknown.reason, /unknown effects/);

  const stale = judgeExpandedCase(byId('C04b'), {
    outcome: 'completed', root: 'unknown', dispatches: 1, f1Heads: ['indeterminate'],
    effectKnowledge: ['known'], observationErrors: ['post_observation_stale'], executionErrors: [], retryAttempted: true, deferReason: null,
  });
  assert.equal(stale.passed, false);
  assert.match(stale.reason, /observation/);

  const rejected = judgeExpandedCase(byId('C02'), {
    outcome: 'completed', root: 'unsatisfied', dispatches: 0, f1Heads: ['execution_rejected'],
    effectKnowledge: ['unknown'], observationErrors: [], executionErrors: [], retryAttempted: true, deferReason: null,
  });
  assert.equal(rejected.passed, false);
  assert.match(rejected.reason, /reject(?:ed|ion)/);
});

test('C02 explicit rejection receipt stays typed and without an invented error body', async () => {
  const { explicitRejectionReceipt } = await import(new URL('fixtures/receipts.mjs', root).href);
  const receipt = explicitRejectionReceipt();
  assert.equal(receipt.dispatched, false);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.effectKnowledge, 'none');
  assert.equal(receipt.error, null);
  assert.equal(receipt.source, 'cdp.Input');
});

test('expanded judge keeps tied candidates as DEFER and never selects by array order', async () => {
  const { EXPANDED_CASES, judgeExpandedCase } = await import(new URL('expanded-cases.mjs', root).href);
  const c09a = EXPANDED_CASES.find(item => item.id === 'C09a');
  const selected = judgeExpandedCase(c09a, {
    outcome: 'completed', root: 'unsatisfied', dispatches: 1, f1Heads: [], effectKnowledge: [],
    observationErrors: [], executionErrors: [], retryAttempted: false, deferReason: null,
  });
  assert.equal(selected.passed, false);
  assert.match(selected.reason, /DEFER/);
});

test('evidence reads typed policy_deferred from the error category', async () => {
  const { evidenceFor } = await import(new URL('expanded-evidence.mjs', root).href);
  const evidence = evidenceFor({
    segments: [{
      output: {
        kind: 'run_result',
        outcome: 'error',
        stopReason: 'no_progress',
        rootResult: 'unsatisfied',
        clicks: [],
        atomic: [],
        errors: [{
          code: 'policy_deferred',
          stage: 'selection',
          source: { owner: 'adapter', category: 'policy_deferred' },
          diagnosticMessage: 'selector deferred: tied candidates',
        }],
      },
    }],
  });
  assert.equal(evidence.deferReason, 'selector deferred: tied candidates');
});

test('continuation cases require new-process segments and reject a policy change without new input', async () => {
  const { EXPANDED_CASES, judgeExpandedCase } = await import(new URL('expanded-cases.mjs', root).href);
  const byId = id => EXPANDED_CASES.find(item => item.id === id);
  const reset = judgeExpandedCase(byId('C10a'), {
    outcome: 'completed', root: 'satisfied', dispatches: 3, f1Heads: ['completed_without_goal', 'completed_without_goal'],
    effectKnowledge: ['none', 'none'], observationErrors: [], executionErrors: [], retryAttempted: true, deferReason: null,
    segments: 1, continuationCount: 2,
  });
  assert.equal(reset.passed, false);
  assert.match(reset.reason, /continuation|segment/);

  const tampered = judgeExpandedCase(byId('C10b'), {
    outcome: 'request_rejected', root: 'unsatisfied', dispatches: 1, f1Heads: ['completed_without_goal'],
    effectKnowledge: ['none'], observationErrors: [], executionErrors: [], retryAttempted: false,
    deferReason: null, segments: 2, continuationCount: 1, rejected: 'retry policy changed', continuationDispatches: 0,
  });
  assert.equal(tampered.passed, true);
});

test('permission and target boundary changes require a typed zero-input rejection', async () => {
  const { EXPANDED_CASES, judgeExpandedCase } = await import(new URL('expanded-cases.mjs', root).href);
  const byId = id => EXPANDED_CASES.find(item => item.id === id);
  for (const id of ['C11c', 'C11d']) {
    const evidence = {
      outcome: 'request_rejected',
      root: 'unsatisfied',
      dispatches: 1,
      f1Heads: ['completed_without_goal'],
      effectKnowledge: ['none'],
      observationErrors: [],
      executionErrors: [],
      retryAttempted: false,
      deferReason: null,
      rejected: 'invalid_binding',
      segments: 2,
      continuationCount: 1,
      continuationDispatches: 0,
    };
    const accepted = judgeExpandedCase(byId(id), evidence);
    assert.equal(accepted.passed, true, accepted.reason);
    const missingRejection = judgeExpandedCase(byId(id), { ...evidence, rejected: null });
    assert.equal(missingRejection.passed, false);
    assert.match(missingRejection.reason, /was not rejected/);
    const newInput = judgeExpandedCase(byId(id), { ...evidence, continuationDispatches: 1 });
    assert.equal(newInput.passed, false);
    assert.match(newInput.reason, /allowed new input/);
  }
});

test('continuation evidence dedupes historical atomics and observation errors', async () => {
  const { evidenceFor } = await import(new URL('expanded-evidence.mjs', root).href);
  const click = { selector: '#primary', kind: 'cdp.Input' };
  const atomic = (dispatchId, feedback) => ({
    dispatchId,
    feedback,
    effectKnowledge: 'none',
    executionErrors: [],
  });
  const observationError = {
    stage: 'observation',
    code: 'evidence_unavailable',
    source: 'browser_single_action_observation',
    diagnosticMessage: 'post-read failed',
    nativeCode: 'post_unavailable',
  };
  const first = {
    kind: 'run_result',
    outcome: 'yielded',
    rootResult: 'unsatisfied',
    stopReason: 'yielded',
    clicks: [click],
    continuation: {},
    state: {},
    atomic: [atomic('d1', { status: 'predicted', head: 'completed_without_goal' })],
    errors: [observationError],
  };
  const second = {
    kind: 'run_result',
    outcome: 'completed',
    rootResult: 'satisfied',
    stopReason: 'satisfied',
    clicks: [click],
    continuation: null,
    state: {},
    atomic: [
      atomic('d1', { status: 'predicted', head: 'completed_without_goal' }),
      atomic('d2', { status: 'goal_achieved', head: null }),
    ],
    errors: [observationError],
  };
  const evidence = evidenceFor({ segments: [{ output: first }, { output: second }] });
  assert.equal(evidence.dispatches, 2);
  assert.deepEqual(evidence.f1Heads, ['completed_without_goal', 'goal_achieved']);
  assert.deepEqual(evidence.effectKnowledge, ['none', 'none']);
  assert.deepEqual(evidence.observationErrors, ['evidence_unavailable']);
  assert.equal(evidence.continuationCount, 1);
  assert.equal(evidence.continuationDispatches, 1);
  assert.equal(evidence.root, 'satisfied');
});

test('request-rejected continuation segments add no new F1 head', async () => {
  const { evidenceFor } = await import(new URL('expanded-evidence.mjs', root).href);
  const click = { selector: '#primary', kind: 'cdp.Input' };
  const first = {
    kind: 'run_result',
    outcome: 'yielded',
    rootResult: 'unsatisfied',
    stopReason: 'yielded',
    clicks: [click],
    continuation: {},
    atomic: [{
      dispatchId: 'd1',
      feedback: { status: 'predicted', head: 'completed_without_goal' },
      effectKnowledge: 'none',
      executionErrors: [],
    }],
    errors: [],
  };
  const rejected = {
    kind: 'request_rejected',
    rejection: { code: 'invalid_binding' },
    clicks: [],
    atomic: [],
    errors: [],
  };
  const evidence = evidenceFor({ segments: [{ output: first }, { output: rejected }] });
  assert.equal(evidence.outcome, 'request_rejected');
  assert.equal(evidence.rejected, 'invalid_binding');
  assert.equal(evidence.dispatches, 1);
  assert.deepEqual(evidence.f1Heads, ['completed_without_goal']);
  assert.equal(evidence.continuationCount, 1);
  assert.equal(evidence.continuationDispatches, 0);
  assert.equal(evidence.root, 'unsatisfied');
});

test('goal-achieving continuations require the full F1 head list', async () => {
  const { EXPANDED_CASES, judgeExpandedCase } = await import(new URL('expanded-cases.mjs', root).href);
  const byId = id => EXPANDED_CASES.find(item => item.id === id);
  const base = (id, f1Heads, extra = {}) => judgeExpandedCase(byId(id), {
    outcome: 'completed',
    root: 'satisfied',
    dispatches: f1Heads.length,
    f1Heads,
    effectKnowledge: f1Heads.map(() => 'none'),
    observationErrors: [],
    executionErrors: [],
    retryAttempted: true,
    deferReason: null,
    ...extra,
  });
  const c01 = base('C01', ['completed_without_goal', 'goal_achieved']);
  assert.equal(c01.passed, true, c01.reason);
  const missingGoalHead = base('C01', ['completed_without_goal']);
  assert.equal(missingGoalHead.passed, false);
  assert.match(missingGoalHead.reason, /F1 heads/);
  const c10a = base('C10a', [
    'completed_without_goal',
    'completed_without_goal',
    'goal_achieved',
  ], { segments: 3, continuationCount: 2 });
  assert.equal(c10a.passed, true, c10a.reason);
});

test('R5 remains a known regression and never becomes a fresh holdout', async () => {
  const { buildPartitionRecord } = await import(new URL('data-usage.mjs', root).href);
  const record = buildPartitionRecord({
    total: 94, train: 81, development: 13, projections: 49,
    r5Rows: 4,
    historicalSource: '/evidence/training-episodes.json',
    r5Source: '/evidence/holdout/r5-corrected-cases.json',
  });
  assert.equal(record.r5Purpose.includes('known regression'), true);
  assert.equal(record.r5CountedAsFreshHoldout, false);
  assert.equal(record.excludedFromFit.includes('holdout/holdout.json'), true);
  assert.equal(record.excludedFromFit.includes('holdout/transformations.json'), true);
  assert.equal(record.candidateAdoption, 'not_applied');
});
