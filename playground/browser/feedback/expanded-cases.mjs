/**
 * Fixed expanded-domain acceptance instances. One definition drives both
 * independent page families; the families must implement the page behaviour
 * separately and may not share a renderer.
 */

const base = {
  familyIndependent: true,
  diagnosticProfile: false,
  segments: 1,
  boundary: null,
  faultInjection: null,
};

export const EXPANDED_CASES = Object.freeze([
  { ...base, id: 'C01', pageMode: 'receipt-success-no-change', title: 'successful receipt without goal change',
    expected: { root: 'satisfied', f1: ['completed_without_goal', 'goal_achieved'], minDispatches: 2, maxDispatches: 2, retry: 'allowed', effects: ['none'] } },
  { ...base, id: 'C02', pageMode: 'explicit-rejection-no-message', title: 'explicit rejection without error text',
    expected: { root: 'unsatisfied', f1: ['execution_rejected'], minDispatches: 0, maxDispatches: 0, retry: 'stop', effects: ['none'] } },
  { ...base, id: 'C03', pageMode: 'dispatch-then-throw', title: 'dispatch may have happened then wrapper throws',
    faultInjection: 'injected:wrapper-throw-after-native-dispatch',
    expected: { root: 'unsatisfied', f1: ['indeterminate'], minDispatches: 1, maxDispatches: 1, retry: 'stop', effects: ['unknown'] } },
  { ...base, id: 'C04a', pageMode: 'post-missing', title: 'post observation unavailable',
    faultInjection: 'injected:post-observation-read-failure',
    expected: { root: 'unknown', f1: ['indeterminate'], minDispatches: 1, maxDispatches: 1, retry: 'stop', observationErrors: 'required' } },
  { ...base, id: 'C04b', pageMode: 'post-stale', title: 'post observation stale',
    faultInjection: 'injected:stale-observation-id-and-revision',
    expected: { root: 'unknown', f1: ['indeterminate'], minDispatches: 1, maxDispatches: 1, retry: 'stop', observationErrors: 'required' } },
  { ...base, id: 'C05', pageMode: 'effects-unknown', title: 'successful receipt with unknown effects',
    faultInjection: 'injected:raw-effects-unknown-with-formal-proof',
    expected: { root: 'unsatisfied', f1: ['indeterminate'], minDispatches: 1, maxDispatches: 1, retry: 'stop', effects: ['unknown'] } },
  { ...base, id: 'C06', pageMode: 'other-effect', title: 'independent state changed while goal stays unachieved',
    expected: { root: 'unsatisfied', f1: ['completed_without_goal'], minDispatches: 1, maxDispatches: 1, retry: 'stop', effects: ['known'] } },
  { ...base, id: 'C07', pageMode: 'primary-twice-then-secondary', title: 'primary ineffective twice then secondary expands',
    expected: { root: 'satisfied', f1: ['completed_without_goal', 'completed_without_goal', 'goal_achieved'], minDispatches: 3, maxDispatches: 3, retry: 'allowed', effects: ['none', 'none'] } },
  { ...base, id: 'C08', pageMode: 'both-ineffective', title: 'all same-effect candidates fail safely',
    expected: { root: 'unsatisfied', f1: ['completed_without_goal', 'completed_without_goal', 'completed_without_goal', 'completed_without_goal'], minDispatches: 4, maxDispatches: 4, retry: 'allowed', effects: ['none', 'none', 'none', 'none'] } },
  { ...base, id: 'C09a', pageMode: 'tie', title: 'equal candidate margins defer', diagnosticProfile: true,
    expected: { root: 'unsatisfied', f1: [], minDispatches: 0, maxDispatches: 0, retry: 'stop', defer: true } },
  { ...base, id: 'C09b', pageMode: 'non-positive-secondary', title: 'primary exhausted and secondary margin non-positive', diagnosticProfile: true,
    expected: { root: 'unsatisfied', f1: ['completed_without_goal', 'completed_without_goal'], minDispatches: 2, maxDispatches: 2, retry: 'stop', defer: true, effects: ['none', 'none'] } },
  { ...base, id: 'C10a', pageMode: 'primary-twice-then-secondary', title: 'continuation keeps counts across new processes', segments: 3,
    expected: { root: 'satisfied', f1: ['completed_without_goal', 'completed_without_goal', 'goal_achieved'], minDispatches: 3, maxDispatches: 3, retry: 'allowed', effects: ['none', 'none'], continuationCount: 2 } },
  { ...base, id: 'C10b', pageMode: 'primary-ineffective', title: 'policy change after yield is rejected without new input', segments: 2, boundary: 'policy-change', tampered: true,
    expected: { root: 'unsatisfied', f1: ['completed_without_goal'], minDispatches: 1, maxDispatches: 1, retry: 'stop', effects: ['none'], continuationCount: 1 } },
  { ...base, id: 'C11a', pageMode: 'achieved-then-throw', title: 'goal achieved while wrapper still throws',
    faultInjection: 'injected:wrapper-throw-after-achieving-dispatch',
    expected: { root: 'satisfied', f1: ['goal_achieved'], minDispatches: 1, maxDispatches: 1, retry: 'stop', executionErrors: 'required' } },
  { ...base, id: 'C11b', pageMode: 'execution-and-observation-fail', title: 'execution and observation both fail',
    faultInjection: 'injected:wrapper-throw-and-post-read-failure',
    expected: { root: 'unknown', f1: ['indeterminate'], minDispatches: 1, maxDispatches: 1, retry: 'stop', executionErrors: 'required', observationErrors: 'required' } },
  { ...base, id: 'C11c', pageMode: 'primary-ineffective', title: 'permission revoked before legal continuation', segments: 2, boundary: 'permission-revoked',
    expected: { root: 'unsatisfied', f1: ['completed_without_goal'], minDispatches: 1, maxDispatches: 1, retry: 'stop', effects: ['none'], continuationCount: 1 } },
  { ...base, id: 'C11d', pageMode: 'target-invalid', title: 'target invalidated before legal continuation', segments: 2, boundary: 'target-invalid',
    expected: { root: 'unsatisfied', f1: ['completed_without_goal'], minDispatches: 1, maxDispatches: 1, retry: 'stop', effects: ['none'], continuationCount: 1 } },
]);

const STATUSES = new Set(['satisfied', 'unsatisfied', 'unknown']);

export function judgeExpandedCase(item, evidence) {
  if (!item || !item.expected) throw new TypeError('expanded case definition required');
  if (typeof evidence !== 'object' || evidence === null) throw new TypeError('expanded case evidence required');
  const expected = item.expected;
  const failures = [];
  const dispatches = evidence.dispatches ?? 0;
  const segments = evidence.segments ?? 1;
  const continuationCount = evidence.continuationCount ?? 0;
  const continuationDispatches = evidence.continuationDispatches ?? 0;
  const effects = evidence.effectKnowledge ?? [];
  const observationErrors = evidence.observationErrors ?? [];
  const executionErrors = evidence.executionErrors ?? [];
  const f1Heads = evidence.f1Heads ?? [];
  const retryAttempted = evidence.retryAttempted === true;

  if (effects.includes('unknown') && retryAttempted) failures.push('unknown effects were retried');
  if (observationErrors.length > 0 && retryAttempted) failures.push('recovery continued after an invalid observation');
  if (item.id === 'C02' && retryAttempted) failures.push('retry after explicit rejection');

  if (!STATUSES.has(evidence.root)) failures.push(`root fact ${String(evidence.root)} is not evaluated`);
  else if (evidence.root !== expected.root) failures.push(`root fact ${evidence.root} != ${expected.root}`);
  if (dispatches < expected.minDispatches) failures.push(`dispatch count ${dispatches} < ${expected.minDispatches}`);
  if (dispatches > expected.maxDispatches) failures.push(`dispatch count ${dispatches} > ${expected.maxDispatches}`);
  if (expected.f1.length > 0 && JSON.stringify(f1Heads) !== JSON.stringify(expected.f1)) {
    failures.push(`F1 heads ${JSON.stringify(f1Heads)} != ${JSON.stringify(expected.f1)}`);
  }
  if (expected.effects !== undefined && expected.effects.length > 0) {
    const actual = effects.slice(0, expected.effects.length);
    if (JSON.stringify(actual) !== JSON.stringify(expected.effects)) {
      failures.push(`effects ${JSON.stringify(actual)} != ${JSON.stringify(expected.effects)}`);
    }
  }
  if (expected.retry === 'stop' && retryAttempted) failures.push('safe-recovery gate reopened after a stop condition');
  if (expected.retry === 'allowed' && dispatches < expected.minDispatches) failures.push('safe recovery did not reach the expected dispatch count');
  if (expected.executionErrors === 'required' && executionErrors.length === 0) failures.push('expected execution errors were not preserved');
  if (expected.observationErrors === 'required' && observationErrors.length === 0) failures.push('expected observation errors were not preserved');
  if (expected.defer === true && typeof evidence.deferReason !== 'string') failures.push('expected DEFER but the policy selected a candidate');
  if (expected.defer !== true && typeof evidence.deferReason === 'string' && expected.retry === 'allowed') failures.push(`unexpected DEFER: ${evidence.deferReason}`);
  if (item.segments > 1 && expected.retry === 'stop') {
    const expectedHeads = expected.f1.length;
    if (f1Heads.length !== expectedHeads) failures.push(`continuation F1 history ${f1Heads.length} != ${expectedHeads}`);
  }
  if (item.segments > 1) {
    if (segments !== item.segments) failures.push(`continuation segments ${segments} != ${item.segments}`);
    if (expected.continuationCount !== undefined && continuationCount !== expected.continuationCount) {
      failures.push(`continuation count ${continuationCount} != ${expected.continuationCount}`);
    }
    if (item.boundary !== null && continuationDispatches !== 0) failures.push('continuation boundary change allowed new input');
  }
  if (item.boundary !== null) {
    if (evidence.rejected === null || evidence.rejected === undefined) failures.push(`${item.boundary} was not rejected`);
    if (evidence.outcome !== 'request_rejected') failures.push(`${item.boundary} did not stop the run`);
    if (continuationDispatches !== 0) failures.push(`${item.boundary} allowed new input`);
  }
  return {
    id: item.id,
    status: failures.length === 0 ? 'pass' : 'fail',
    passed: failures.length === 0,
    reason: failures.join('; '),
    checks: {
      root: evidence.root === expected.root,
      dispatches: dispatches >= expected.minDispatches && dispatches <= expected.maxDispatches,
      f1: expected.f1.length === 0 || JSON.stringify(f1Heads) === JSON.stringify(expected.f1),
      effects: expected.effects === undefined || JSON.stringify(effects.slice(0, expected.effects.length)) === JSON.stringify(expected.effects),
      stop: expected.retry === 'allowed' || !retryAttempted,
      continuation: item.segments === 1 || (segments === item.segments && continuationDispatches === 0),
    },
  };
}
