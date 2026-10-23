import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CASE_ROWS, materializeConfig, materializeExpected } from './cases.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const runEntry = resolve(here, 'run.mjs');
const ioEntry = resolve(here, 'native-io.mjs');

function argAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

const familyArg = argAfter('--family', 'all');
const cdp = argAfter('--cdp', '');
const origin = argAfter('--origin', argAfter('--fixture-origin', ''));
const out = resolve(argAfter('--out', resolve(process.cwd(), 'b-search-acceptance')));
const resultReads = Number(process.env.BSEARCH_RESULT_READS ?? '8');
if (!Number.isSafeInteger(resultReads) || resultReads < 1) {
  throw new Error('BSEARCH_RESULT_READS must be a positive integer');
}
const families = familyArg === 'all' ? ['A', 'B'] : familyArg === 'A' ? ['A'] : familyArg === 'B' ? ['B'] : (() => {
  throw new Error('--family must be A, B, or all');
})();

if (!cdp || !origin) throw new Error('--cdp and --origin are required');

function member(expect, kind, candidates) {
  if (!expect[kind]) return true;
  if (typeof expect[kind] === 'boolean') return expect[kind];
  return expect[kind].some((value) => candidates.includes(value));
}

function sourceEpisode(sourceResult) {
  if (!sourceResult || typeof sourceResult !== 'object' || !('value' in sourceResult)) return null;
  const value = sourceResult.value;
  return value && typeof value === 'object' ? value : null;
}

function deriveActual(runResult, config) {
  const report = runResult?.response?.report ?? null;
  const episodes = (report?.atomicResults ?? []).map((entry) => sourceEpisode(entry.sourceResult)).filter(Boolean);
  const phases = {};
  const phaseFacts = [];
  for (const frame of report?.frames ?? []) {
    if (frame.depth === 1 && ['input', 'submitted', 'results'].includes(frame.goal.phase)) {
      // A derived condition that never started carries fact "unknown" but was not
      // evaluated at all; the phase stays not_evaluated instead of claiming a read.
      const fact = frame.execution === 'not_started' ? 'not_evaluated' : frame.fact;
      phases[frame.goal.phase] = fact;
      phaseFacts.push({ phase: frame.goal.phase, fact, execution: frame.execution ?? null });
    }
  }
  const actionCounts = { input: 0, submit: 0, read: 0 };
  for (const episode of episodes) {
    if (episode.action in actionCounts) actionCounts[episode.action] += 1;
  }
  const episodeReceipts = episodes
    .filter((episode) => episode.action === 'input' || episode.action === 'submit')
    .map((episode) => ({
      action: episode.action,
      source: episode.receipt?.source ?? null,
      dispatched: episode.receipt?.dispatched ?? null,
      ok: episode.receipt?.ok ?? null,
      effectKnowledge: episode.receipt?.effectKnowledge ?? null,
      dispatchState: episode.dispatchState,
    }));
  const nativeReceipts = (runResult.sideEffects?.mutationReceipts ?? episodeReceipts)
    .map((receipt) => ({
      action: receipt.action,
      source: receipt.source ?? null,
      dispatched: receipt.dispatched ?? null,
      ok: receipt.ok ?? null,
      effectKnowledge: receipt.effectKnowledge ?? null,
      dispatchState: receipt.dispatchState ?? 'unknown',
    }));
  const episodeExecutionErrors = episodes.flatMap((episode) =>
    (episode.executionErrors ?? []).map((error) => ({ action: episode.action, code: error.code, message: error.message })));
  const episodeObservationErrors = episodes.flatMap((episode) =>
    (episode.observationFeedback?.errors ?? []).map((error) => ({ action: episode.action, code: error.code, message: error.message })));
  const lastEpisodeState = episodes.findLast((episode) => episode.state?.observation)?.state ?? null;
  const finalObservation = runResult.sideEffects?.finalObservation ?? lastEpisodeState?.observation ?? null;
  const collectionItems = finalObservation?.collection?.items ?? [];
  const collectionMembers = collectionItems.map((item) => ({
    ref: item.ref,
    collectionRef: item.collectionRef,
    role: item.role,
    text: item.text?.status === 'observed' ? item.text.value : null,
    textStatus: item.text?.status ?? 'unknown',
  }));
  const mainMatches = collectionMembers.filter((item) =>
    item.collectionRef === config.goal.collectionRef &&
    item.role === 'main' &&
    item.textStatus === 'observed' &&
    item.text.includes(config.goal.containsText)).length;
  const observedValue = (fact) => fact?.status === 'observed' ? fact.value : null;
  const association = {
    baseline: episodes.find((episode) => episode.submissionBaseline)?.submissionBaseline ?? null,
    submittedQuery: observedValue(finalObservation?.submittedQuery),
    submittedRequestRef: observedValue(finalObservation?.submittedRequestRef),
    resultsQuery: observedValue(finalObservation?.resultsFor),
    resultsRequestRef: observedValue(finalObservation?.resultsRequestRef),
    collectionRequestRef: observedValue(finalObservation?.collection?.requestRef),
    batch: observedValue(finalObservation?.collection?.batch),
  };
  return {
    root: report?.rootEvaluation?.result ?? 'not_evaluated',
    rootFacts: report?.rootEvaluation
      ? {
          result: report.rootEvaluation.result,
          satisfaction: report.rootEvaluation.satisfaction,
          reason: report.rootEvaluation.reason,
        }
      : null,
    control: report?.control?.outcome ?? 'not_run',
    phases,
    phaseFacts,
    actionCounts,
    nativeReceipts,
    // Execution/observation errors come from the atomic episodes only. Report-level
    // diagnostics also carry control-level settlement ("derived requirements are
    // unresolved", postcondition propagation); those describe a normal unknown
    // result, not an execution or observation failure.
    executionErrors: episodeExecutionErrors,
    observationErrors: episodeObservationErrors,
    effects: {
      report: report?.effects ?? [],
      episodes: episodes.map((episode) => ({
        action: episode.action,
        dispatchState: episode.dispatchState,
        effectKnowledge: episode.effectKnowledge,
      })),
    },
    request: finalObservation?.request ?? 'unknown',
    display: finalObservation?.display ?? 'unknown',
    access: finalObservation?.access ?? 'unknown',
    collectionMembers,
    mainMatches,
    association,
    closeErrors: runResult.closeErrors ?? [],
    sideEffects: runResult.sideEffects ?? null,
  };
}

function checkRow(runResult, expect, config, actual) {
  const checks = {
    exit: runResult.code !== null && (expect.exit ?? [0]).includes(runResult.code),
    root: member(expect, 'root', [actual.root]),
    control: member(expect, 'control', [actual.control]),
    input: member(expect, 'input', [actual.phases.input ?? 'not_evaluated']),
    submitted: member(expect, 'submitted', [actual.phases.submitted ?? 'not_evaluated']),
    results: member(expect, 'results', [actual.phases.results ?? 'not_evaluated']),
    inputCount: expect.inputCount === undefined || expect.inputCount === actual.actionCounts.input,
    submitCount: expect.submitCount === undefined || expect.submitCount === actual.actionCounts.submit,
    executionErrors: expect.executionErrors === undefined ||
      expect.executionErrors === (actual.executionErrors.length > 0),
    observationErrors: expect.observationErrors === undefined ||
      expect.observationErrors === (actual.observationErrors.length > 0),
    closeErrors: actual.closeErrors.length === 0,
    neighborUnchanged: expect.neighborUnchanged === undefined ||
      runResult.sideEffects?.neighborValue === config.neighborExpected,
    requestStatus: member(expect, 'requestStatus', [actual.request]),
    display: member(expect, 'display', [actual.display]),
    access: member(expect, 'access', [actual.access]),
  };
  const mutationCount = actual.actionCounts.input + actual.actionCounts.submit;
  checks.nativeReceipts = mutationCount === actual.nativeReceipts.length &&
    actual.nativeReceipts.every((receipt) =>
      receipt.dispatched === true && receipt.source === 'cdp.Input');
  if (expect.requireAssociation) {
    const association = actual.association;
    checks.association = Boolean(
      association.baseline &&
      association.baseline.observedSubmission !== null &&
      association.submittedRequestRef &&
      association.resultsRequestRef === association.submittedRequestRef &&
      association.collectionRequestRef === association.submittedRequestRef &&
      association.batch,
    );
  }
  if (expect.mainMatches) {
    checks.mainMatches = actual.mainMatches >= expect.mainMatches.min &&
      actual.mainMatches <= (expect.mainMatches.max ?? Number.POSITIVE_INFINITY);
  }
  if (expect.latePreserved) {
    const lateRef = runResult.sideEffects?.lateValue ?? '';
    checks.latePreserved = Boolean(lateRef && lateRef !== actual.association.resultsRequestRef);
  }
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { checks, passed: failedChecks.length === 0, failedChecks };
}

function conciseReason(error, stderr) {
  const lines = (stderr || '').split('\n').filter(Boolean);
  const marker = lines.find((line) => /EPERM|ECONNREFUSED|ENOTFOUND/.test(line))
    ?? lines.find((line) => /Error:|Build failed|connect/.test(line));
  if (marker) return marker.trim();
  const fromMessage = String(error?.message || '').split('\n').find((line) => /Error/.test(line));
  return (fromMessage || `exit ${error?.code ?? 'unknown'}`).trim();
}

function summarize(rows) {
  const counts = { total: rows.length, pass: 0, fail: 0, unverified: 0 };
  const distribution = { S: 0, N: 0, U: 0, controlError: 0, nativeActions: 0 };
  for (const row of rows) {
    if (row.status === 'PASS') counts.pass += 1;
    else if (row.status === 'FAIL') counts.fail += 1;
    else counts.unverified += 1;
    if (row.status !== 'PASS') continue;
    if (row.actual?.root === 'satisfied') distribution.S += 1;
    else if (row.actual?.root === 'unsatisfied') distribution.N += 1;
    else if (row.actual?.root === 'unknown') distribution.U += 1;
    if (row.actual?.control === 'error') distribution.controlError += 1;
    distribution.nativeActions += row.actual?.nativeReceipts?.length ?? 0;
  }
  return { counts, distribution };
}

function compactExpected(expect) {
  const facts = ['input', 'submitted', 'results'].map((phase) => `${phase}=${(expect[phase] ?? []).join('/')}`);
  return [
    `exit=${(expect.exit ?? [0]).join('/')}`,
    ...facts,
    `root=${(expect.root ?? []).join('/')}`,
    `control=${(expect.control ?? []).join('/')}`,
    `actions=${expect.inputCount ?? '?'}i/${expect.submitCount ?? '?'}s`,
  ].join('; ');
}

function compactActual(actual) {
  return [
    `exit=${actual.exitCode ?? 'null'}`,
    ...actual.phaseFacts.map((item) => `${item.phase}=${item.fact}`),
    `root=${actual.root}`,
    `control=${actual.control}`,
    `actions=${actual.actionCounts.input}i/${actual.actionCounts.submit}s/${actual.actionCounts.read}r`,
  ].join('; ');
}

function nativeText(actual) {
  if (!actual.nativeReceipts.length) return 'none';
  return actual.nativeReceipts.map((receipt) =>
    `${receipt.action}:${receipt.source}/${receipt.dispatchState}`).join('; ');
}

function phaseText(actual) {
  const phases = actual.phaseFacts.map((item) => `${item.phase}=${item.fact}`).join('; ') || 'none';
  return `${phases}; root=${actual.root}; satisfaction=${actual.rootFacts?.satisfaction ?? 'null'}`;
}

function collectionText(actual) {
  if (!actual.collectionMembers.length) return `none; mainMatches=${actual.mainMatches}`;
  const members = actual.collectionMembers.map((item) =>
    `${item.ref}[${item.collectionRef}/${item.role}]`).join(', ');
  return `${members}; mainMatches=${actual.mainMatches}`;
}

function errorsEffectsText(actual) {
  const execution = actual.executionErrors.map((error) => error.code).join('/') || 'none';
  const observation = actual.observationErrors.map((error) => error.code).join('/') || 'none';
  const effects = actual.effects.episodes.map((effect) =>
    `${effect.action}:${effect.effectKnowledge}/${effect.dispatchState}`).join('; ') || 'none';
  return `exec=${execution}; observe=${observation}; effects=${effects}`;
}

function tableCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function tableMarkdown(rows) {
  const summary = summarize(rows);
  const lines = [
    '# B-Search 逐例验收表',
    '',
    '| 家族 | 用例 | 子变体 | 期望 | 实际 | 判定 | 原因 | 动作数 | native 回执 | 阶段/根事实 | 集合成员 | 错误与 effects |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
  ];
  for (const row of rows) {
    const actual = row.actual ?? {};
    const actionCounts = actual.actionCounts
      ? `${actual.actionCounts.input}i/${actual.actionCounts.submit}s/${actual.actionCounts.read}r`
      : '未运行';
    lines.push(`| ${[
      row.family,
      row.caseId,
      row.variant,
      compactExpected(row.expected),
      actual.exitCode === undefined ? '未运行' : compactActual(actual),
      row.status,
      row.reason,
      actionCounts,
      actual.nativeReceipts ? nativeText(actual) : '未运行',
      actual.phaseFacts ? phaseText(actual) : '未运行',
      actual.collectionMembers ? collectionText(actual) : '未运行',
      actual.effects ? errorsEffectsText(actual) : '未运行',
    ].map(tableCell).join(' | ')} |`);
  }
  lines.push('', '## 汇总', '');
  lines.push(`- 总实例：${summary.counts.total}`);
  lines.push(`- PASS：${summary.counts.pass}`);
  lines.push(`- FAIL：${summary.counts.fail}`);
  lines.push(`- UNVERIFIED：${summary.counts.unverified}`);
  lines.push(`- 已通过行的根分布：S=${summary.distribution.S} N=${summary.distribution.N} U=${summary.distribution.U}`);
  lines.push(`- 已通过行的 control error：${summary.distribution.controlError}`);
  lines.push(`- 已通过行的 native 回执：${summary.distribution.nativeActions}`);
  lines.push('');
  return lines.join('\n');
}

await mkdir(out, { recursive: true });
const rows = [];
for (const family of families) {
  for (const specification of CASE_ROWS) {
    const config = materializeConfig(family, specification);
    const expect = materializeExpected(family, specification);
    const caseDir = resolve(out, family, specification.caseId, specification.variant || 'main');
    await mkdir(caseDir, { recursive: true });
    const requestPath = resolve(caseDir, 'request.json');
    const casePath = resolve(caseDir, 'case.json');
    const request = {
      requestId: `b-search-${family}-${specification.caseId}-${specification.variant || 'main'}`,
      goal: config.goal,
      satisfactionThreshold: 100,
      bindings: config.bindings,
      maxResultReads: resultReads,
    };
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    await writeFile(casePath, `${JSON.stringify(config, null, 2)}\n`);

    let runResult;
    try {
      const started = Date.now();
      const result = await execFileAsync(process.execPath, [runEntry, '--request', requestPath, '--io', ioEntry], {
        cwd: repo,
        env: {
          ...process.env,
          BSEARCH_CDP_URL: cdp,
          BSEARCH_FIXTURE_ORIGIN: origin,
          BSEARCH_CASE_DIR: caseDir,
          BSEARCH_RESULT_READS: process.env.BSEARCH_RESULT_READS ?? '8',
          BSEARCH_READ_TIMEOUT_MS: process.env.BSEARCH_READ_TIMEOUT_MS ?? '1000',
        },
        maxBuffer: 24 * 1024 * 1024,
        timeout: 45000,
      });
      runResult = { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '', elapsedMs: Date.now() - started };
    } catch (error) {
      runResult = {
        code: error.code === 'ETIMEDOUT' ? null : (error.code ?? 1),
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        killed: error.killed === true,
        signal: error.signal ?? null,
        message: error.message,
        elapsedMs: error.elapsedMs ?? null,
      };
    }
    await writeFile(resolve(caseDir, 'stdout.json'), runResult.stdout);
    await writeFile(resolve(caseDir, 'stderr.log'), runResult.stderr);
    await writeFile(resolve(caseDir, 'exec-error.json'), `${JSON.stringify({
      code: runResult.code,
      killed: runResult.killed === true,
      signal: runResult.signal ?? null,
      message: runResult.message ?? null,
    }, null, 2)}\n`);

    let parsed = null;
    try {
      parsed = JSON.parse(runResult.stdout);
    } catch {
      parsed = null;
    }
    if (parsed) await writeFile(resolve(caseDir, 'episode.json'), `${JSON.stringify(parsed, null, 2)}\n`);
    if (parsed) runResult.sideEffects = parsed.sideEffects ?? null;

    let actual = null;
    let checks = null;
    let failedChecks = [];
    let status;
    let reason;
    if (parsed?.response?.kind === 'run_result') {
      actual = { ...deriveActual(parsed, config), exitCode: runResult.code };
      const checked = checkRow(runResult, expect, config, actual);
      checks = checked.checks;
      failedChecks = checked.failedChecks;
      status = checked.passed ? 'PASS' : 'FAIL';
      reason = checked.passed ? '' : `failed: ${failedChecks.join(', ')}`;
    } else {
      status = 'UNVERIFIED';
      reason = `execution did not produce a run report: ${conciseReason(runResult, runResult.stderr)}`;
    }
    rows.push({
      family,
      caseId: specification.caseId,
      variant: specification.variant || 'main',
      label: specification.label,
      expected: expect,
      actual,
      checks,
      failedChecks,
      status,
      reason,
      exitCode: runResult.code,
      elapsedMs: runResult.elapsedMs ?? null,
      artifacts: {
        request: requestPath,
        case: casePath,
        stdout: resolve(caseDir, 'stdout.json'),
        stderr: resolve(caseDir, 'stderr.log'),
        episode: resolve(caseDir, 'episode.json'),
        execError: resolve(caseDir, 'exec-error.json'),
      },
    });
  }
}

await writeFile(resolve(out, 'rows.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
await writeFile(resolve(out, 'table.md'), `${tableMarkdown(rows)}\n`);
const summary = summarize(rows);
console.log(JSON.stringify(summary, null, 2));
if (summary.counts.unverified > 0 || summary.counts.fail > 0) process.exitCode = 2;
