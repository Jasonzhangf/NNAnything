import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('C05 runner public entry preserves caller grantedEffects without auto-appending nativeExpandRange', async () => {
  // Exercise the real run.mjs public entry with a model decision directory and
  // an IO module that exports createResources. The caller's grantedEffects does
  // NOT contain browser.nativeExpandRange; run.mjs must not auto-append it.
  const {mkdtemp, writeFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {spawn} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');

  const dir = await mkdtemp(join(tmpdir(), 'bsearch-runner-'));
  const profileDir = join(dir, 'profiles');
  await import('node:fs/promises').then(({mkdir}) => mkdir(profileDir, {recursive: true}));
  await writeFile(join(profileDir, 'input-policy.json'), JSON.stringify({
    contract: 'browser.input-text-policy.v1',
    heads: ['INPUT', 'NOOP', 'DEFER'],
    wires: ['bias','textType.known','textType.value','enabled.known','enabled.value','editable.known','editable.value',
      'readOnly.known','readOnly.value','valueEqual.known','valueEqual.value','executableHit.known','executableHit.value'],
    weights: [[-9,0,2,0,2,0,2,2,-4,2,-6,0,2],[-3,0,0,0,0,0,0,0,0,0,6,0,0],[2,0,0,0,0,0,0,0,0,0,0,0,0]],
    calibration: 'uncalibrated', adoption: 'not_applied',
  }));
  await writeFile(join(profileDir, 'query-relation.json'), JSON.stringify({
    contract: 'browser.search-query-relation.v1',
    heads: ['input_only_unsubmitted','submitted_pending_or_stale','results_associated_active','insufficient_or_conflict'],
    wires: ['bias','inputQueryEqual.known','inputQueryEqual.value','newSubmissionInstance.known','newSubmissionInstance.value',
      'responseMatchesSubmission.known','responseMatchesSubmission.value','requestState.known','requestSettled.value',
      'requestLoading.value','accessAvailable.known','accessAvailable.value','displayCurrentOrEmpty.value',
      'associatedAndSettledInteraction'],
    weights: [[0,0,2,0,0,0,0,0,0,0,0,2,0,0],[0,0,0,0,0,0,0,0,0,1,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,10],[0,0,0,0,0,0,0,0,0,0,0,0,0,0]],
    calibration: 'uncalibrated', adoption: 'not_applied',
  }));
  await writeFile(join(profileDir, 'step-policy.json'), JSON.stringify({
    contract: 'browser.search-step-policy.v1',
    heads: ['input','submit','read_or_reobserve','expand_range','NOOP','DEFER'],
    wires: ['bias','phase.input','phase.submitted','phase.results','predInputPolicy.INPUT','predInputPolicy.NOOP',
      'predInputPolicy.DEFER','predQueryRelation.input_only_unsubmitted','predQueryRelation.submitted_pending_or_stale',
      'predQueryRelation.results_associated_active','predQueryRelation.insufficient_or_conflict','batchCheckedCurrent',
      'contentConditionSatisfied.known','contentConditionSatisfied.value','canExpandRange.known','canExpandRange.value',
      'collectionTerminalConfirmed','unreadCurrentBatch'],
    weights: [[-5,4,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0],[-5,0,4,0,0,0,0,4,0,0,0,0,0,0,0,0,0,0],
      [-5,0,0,4,0,0,0,0,4,0,0,0,0,0,0,0,0,4],[-5,0,0,4,0,0,0,0,0,0,0,0,0,-4,0,4,-4,0],
      [-5,4,4,-2,0,4,0,0,4,4,0,0,0,6,0,0,6,0],[1,0,0,0,0,0,3,0,0,0,3,0,0,0,0,0,0,0]],
    calibration: 'uncalibrated', adoption: 'not_applied',
  }));

  const requestPath = join(dir, 'request.json');
  await writeFile(requestPath, JSON.stringify({
    requestId: 'runner-test', satisfactionThreshold: 100,
    bindings: { documentRef: 'd', scopeRef: 's', inputRef: 'query', submitRef: 'submit',
      resultScopeRef: 'results', collectionRef: 'main' },
    goal: { kind: 'BrowserSearch', query: '露营', collectionRef: 'main', containsText: '装备',
      minimumMatches: 1, coverage: 'visible_batch' },
    maxResultReads: 3,
  }));
  const ioPath = join(dir, 'io.mjs');
  await writeFile(ioPath, `
export async function createResources(request) {
  let revision = 0;
  const fact = (value, id) => value === null ? { status: 'unknown', reason: 'not_observed' }
    : { status: 'observed', value, evidenceRefs: [id] };
  let input = '', submitted = null, forQuery = null, submittedRequest = null, resultsRequest = null,
    batchRef = null, requestStatus = 'unknown', display = 'none', current = null;
  const observe = async () => {
    const observationId = 'runner-obs-' + (++revision), id = observationId + ':evidence';
    const observedFact = (value) => ({ status: 'observed', value, evidenceRefs: [id] });
    const rangeRequestState = ['loading','settled','error'].includes(requestStatus)
      ? observedFact(requestStatus) : { status: 'unknown', reason: 'no_positive_request_state_source' };
    const target = { ref: 'query', connected: observedFact(true), currentRef: observedFact('query'),
      host: observedFact('input'), contentEditable: observedFact(null), type: observedFact('text'),
      value: fact(input, id), placeholder: observedFact(null), nativeDisabled: observedFact(false),
      ariaDisabled: observedFact(null), nativeReadonly: observedFact(false), ariaReadonly: observedFact(null),
      readonlyState: observedFact('editable'), editable: observedFact(true),
      activeElementRef: observedFact('query'), activeElementFocus: observedFact(true),
      executableHit: observedFact(true), point: observedFact({ x: 1, y: 1 }) };
    current = { documentRef: 'd', scopeRef: 's', observationId, revision, target,
      input: { ref: 'query', tag: 'input', type: 'text', value: fact(input, id), editable: observedFact(true) },
      submitRef: 'submit', submittedQuery: fact(submitted, id), resultsFor: fact(forQuery, id),
      submittedRequestRef: fact(submittedRequest, id), resultsRequestRef: fact(resultsRequest, id),
      request: requestStatus, display, access: 'available',
      collection: { ref: 'main', scopeRef: 'results', requestRef: fact(resultsRequest, id),
        batch: fact(batchRef, id), items: [] },
      rangeExpansion: { actionMechanicalEffect: 'not_attempted',
        atGeometryBoundary: { status: 'unknown', reason: 'scroll_container_absent' },
        requestState: rangeRequestState, hasMore: { status: 'unknown', reason: 'no_positive_terminal_control_source' },
        collectionTerminal: false },
      evidence: [{ id, source: 'runner.fixture', fact: {} }] };
    return current;
  };
  return {
    grantedEffects: new Set(['browser.read', 'browser.nativeInputText', 'browser.nativeSubmit', 'filesystem.write']),
    observe, readResults: observe, currentControl: () => ({ documentRef: current.documentRef,
      observationId: current.observationId, revision: current.revision }),
    nativeInputText: async (inv) => { input = inv.value; return { dispatched: true, ok: true,
      effectKnowledge: 'known', source: 'synthetic', error: null }; },
    nativeSubmit: async () => { submitted = input; submittedRequest = 'r1'; resultsRequest = 'r1';
      batchRef = 'b1'; forQuery = input; requestStatus = 'settled'; display = 'empty';
      return { dispatched: true, ok: true, effectKnowledge: 'known', source: 'synthetic', error: null }; },
    nativeExpandRange: async () => { return { dispatched: true, ok: true, effectKnowledge: 'known',
      source: 'synthetic', error: null }; },
    collect: async () => {},
  };
}
`);

  const runEntry = fileURLToPath(new URL('../playground/browser/search/run.mjs', import.meta.url));
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runEntry, '--request', requestPath, '--io', ioPath,
      '--decision-profile', profileDir], { cwd: new URL('..', import.meta.url).pathname });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
  await rm(dir, { recursive: true, force: true });
  assert.ok(output.stderr === '' || !/TypeError|Error:/.test(output.stderr), output.stderr);
  const parsed = JSON.parse(output.stdout);
  // The IO's grantedEffects has no browser.nativeExpandRange; the runner must
  // not have appended it (the old auto-append bug did).
  assert.equal(parsed.response.kind, 'run_result');
  assert.equal(parsed.response.report.rootEvaluation.result, 'unsatisfied');
  assert.equal(parsed.response.report.control.outcome, 'error');
});
