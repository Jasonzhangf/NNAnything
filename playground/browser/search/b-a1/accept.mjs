import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { B_A1_CASE_ROWS, materializeConfig, materializeExpected } from './cases.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const runEntry = resolve(repo, 'playground/browser/search/run.mjs');
const ioEntry = resolve(repo, 'playground/browser/search/native-io.mjs');

function argAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

function member(value, candidates) {
  if (!candidates || candidates.length === 0) return true;
  return candidates.includes(value);
}

function sourceEpisode(sourceResult) {
  if (!sourceResult || typeof sourceResult !== 'object' || !('value' in sourceResult)) return null;
  const value = sourceResult.value;
  return value && typeof value === 'object' ? value : null;
}

export function deriveActual(runResult, config) {
  const report = runResult?.response?.report ?? null;
  const episodes = (report?.atomicResults ?? []).map((entry) => sourceEpisode(entry.sourceResult)).filter(Boolean);
  const phases = {};
  const phaseFacts = [];
  for (const frame of report?.frames ?? []) {
    if (frame.depth === 1 && ['input', 'submitted', 'results'].includes(frame.goal.phase)) {
      const fact = frame.execution === 'not_started' ? 'not_evaluated' : frame.fact;
      phases[frame.goal.phase] = fact;
      phaseFacts.push({ phase: frame.goal.phase, fact, execution: frame.execution ?? null });
    }
  }
  const mutationReceipts = Array.isArray(runResult.sideEffects?.mutationReceipts)
    ? runResult.sideEffects.mutationReceipts
    : [];
  const actionCounts = { input: 0, submit: 0, read: 0 };
  for (const receipt of mutationReceipts) {
    if (receipt.action in actionCounts && receipt.dispatchState === 'dispatched') {
      actionCounts[receipt.action] += 1;
    }
  }
  const inputEpisodes = episodes.filter((episode) => episode.action === 'input');
  const lastInput = inputEpisodes.at(-1) ?? null;
  const failureEpisode = lastInput ? {
    state: lastInput.state ?? null,
    checkedObservationId: lastInput.checkedObservationId ?? null,
    effectKnowledge: lastInput.effectKnowledge ?? null,
    observationStatus: lastInput.observationFeedback?.status ?? null,
    unmetFacts: Array.isArray(lastInput.observationFeedback?.unmetFacts)
      ? lastInput.observationFeedback.unmetFacts
      : [],
    freshness: lastInput.observationFeedback?.obligation?.freshness ?? null,
  } : null;
  const finalObservation = runResult.sideEffects?.finalObservation ?? lastInput?.state?.observation ?? null;
  const readValue = (fact) => fact?.status === 'observed' ? fact.value : null;
  const inputValue = finalObservation ? readValue(finalObservation.input?.value) : null;
  const neighborValue = runResult.sideEffects?.neighborValue ?? null;
  const executionErrors = episodes.flatMap((episode) => episode.executionErrors ?? []);
  const observationErrors = episodes.flatMap((episode) => episode.observationFeedback?.errors ?? []);
  const inputEvents = runResult.sideEffects?.inputEvents ?? [];
  const initialObservation = runResult.sideEffects?.initialObservation ?? null;
  const initialInputValue = initialObservation
    ? readValue(initialObservation.input?.value)
    : runResult.sideEffects?.initialInputValue ?? null;
  const initialPlaceholder = initialObservation
    ? readValue(initialObservation.target?.placeholder)
    : runResult.sideEffects?.initialPlaceholder ?? null;
  return {
    root: report?.rootEvaluation?.result ?? 'not_evaluated',
    control: report?.control?.outcome ?? 'not_run',
    phases,
    phaseFacts,
    actionCounts,
    mutationReceipts,
    executionErrors,
    observationErrors,
    inputValue,
    neighborValue,
    inputEvents,
    initialInputValue,
    initialPlaceholder,
    failureEpisode,
    closeErrors: runResult.closeErrors ?? [],
  };
}

function failureEpisodeMatches(actual, expect) {
  if (!actual) return false;
  if (expect.stateNull && actual.state !== null) return false;
  if (expect.checkedObservationIdNull && actual.checkedObservationId !== null) return false;
  if (expect.effectKnowledge && actual.effectKnowledge !== expect.effectKnowledge) return false;
  if (expect.observationStatus && actual.observationStatus !== expect.observationStatus) return false;
  if (expect.freshness && actual.freshness !== expect.freshness) return false;
  if (Array.isArray(expect.unmetFacts) && !expect.unmetFacts.every((fact) => (actual.unmetFacts ?? []).includes(fact))) return false;
  return true;
}

export function checkRow(actual, expect, config) {
  const checks = {
    inputFact: member(actual.phases.input ?? 'not_evaluated', expect.inputFact),
    rootFact: member(actual.root, expect.rootFact),
    control: member(actual.control, expect.control),
    inputCount: actual.actionCounts.input === expect.inputCount,
    submitCount: actual.actionCounts.submit === expect.submitCount,
    executionErrors: expect.executionErrors === (actual.executionErrors.length > 0),
    observationErrors: expect.observationErrors === (actual.observationErrors.length > 0),
    neighborUnchanged: !expect.neighborUnchanged || actual.neighborValue === config.neighborExpected,
    inputValue: expect.inputValue === null || actual.inputValue === expect.inputValue,
    initialPlaceholderIsQuery: !expect.initialPlaceholderIsQuery || actual.initialPlaceholder === config.query,
    failureEpisode: !expect.failureEpisode || failureEpisodeMatches(actual.failureEpisode, expect.failureEpisode),
    closeErrors: actual.closeErrors.length === 0,
  };
  if (expect.initialPlaceholderIsQuery) {
    checks.initialInputValueIsEmpty = actual.initialInputValue === '';
  }
  if (expect.submitCount === 0) {
    checks.noSubmitReceipt = !actual.mutationReceipts.some((receipt) => receipt.action === 'submit');
  }
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { checks, passed: failedChecks.length === 0, failedChecks };
}

function compactReason(error, stderr) {
  const lines = (stderr || '').split('\n').filter(Boolean);
  const marker = lines.find((line) => /EPERM|ECONNREFUSED|ENOTFOUND/.test(line))
    ?? lines.find((line) => /Error:|Build failed|connect/.test(line));
  if (marker) return marker.trim();
  return String(error?.message || '').split('\n').find((line) => /Error/.test(line)) || `exit ${error?.code ?? 'unknown'}`;
}

function summarize(rows) {
  const counts = { total: rows.length, pass: 0, fail: 0, unverified: 0 };
  for (const row of rows) {
    if (row.status === 'PASS') counts.pass += 1;
    else if (row.status === 'FAIL') counts.fail += 1;
    else counts.unverified += 1;
  }
  return counts;
}

function tableMarkdown(rows) {
  const summary = summarize(rows);
  const lines = ['# B-A1 显式文本搜索绑定验收表', ''];
  lines.push('| 家族 | 用例 | 标签 | 输入 | 根 | control | i/s | exec | observe | 邻框 | 判定 | 原因 |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const row of rows) {
    const actual = row.actual ?? {};
    lines.push(`| ${row.family} | ${row.caseId} | ${row.label} | ${actual.phases?.input ?? '未运行'} | ${actual.root ?? '未运行'} | ${actual.control ?? '未运行'} | ${actual.actionCounts?.input ?? '-'}i/${actual.actionCounts?.submit ?? '-'}s | ${actual.executionErrors?.length ?? '-'} | ${actual.observationErrors?.length ?? '-'} | ${actual.neighborValue ?? '-'} | ${row.status} | ${row.reason ?? ''} |`);
  }
  lines.push('', '## 汇总', '', `- 总数：${summary.total}`, `- PASS：${summary.pass}`, `- FAIL：${summary.fail}`, `- UNVERIFIED：${summary.unverified}`, '');
  return lines.join('\n');
}
async function main() {
  const familyArg = argAfter('--family', 'all');
  const cdp = argAfter('--cdp', '');
  const origin = argAfter('--origin', '');
  const out = resolve(argAfter('--out', resolve(process.cwd(), 'b-a1-acceptance')));
  const runLabel = argAfter('--label', 'run');

  if (!cdp || !origin) throw new Error('--cdp and --origin are required');

  const families = familyArg === 'all' ? ['A', 'B'] : familyArg === 'A' ? ['A'] : familyArg === 'B' ? ['B'] : (() => {
    throw new Error('--family must be A, B, or all');
  })();

  await mkdir(out, { recursive: true });
  const rows = [];
  for (const family of families) {
    for (const specification of B_A1_CASE_ROWS) {
      const config = materializeConfig(family, specification);
      const expected = materializeExpected(family, specification);
      const caseDir = resolve(out, family, specification.id);
      await mkdir(caseDir, { recursive: true });
      const casePath = resolve(caseDir, 'case.json');
      const requestPath = resolve(caseDir, 'request.json');
      const request = {
        requestId: `b-a1-${family}-${specification.id}`,
        goal: config.goal,
        satisfactionThreshold: 100,
        bindings: config.bindings,
      };
      await writeFile(casePath, `${JSON.stringify(config, null, 2)}\n`);
      await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);

      const startedAt = Date.now();
      const runResult = await new Promise((resolveRun) => {
        execFile(process.execPath, [runEntry, '--request', requestPath, '--io', ioEntry], {
          cwd: repo,
          env: {
            ...process.env,
            BSEARCH_CDP_URL: cdp,
            BSEARCH_FIXTURE_ORIGIN: origin,
            BSEARCH_CASE_DIR: caseDir,
          },
          maxBuffer: 32 * 1024 * 1024,
          timeout: 30000,
        }, (error, stdout, stderr) => {
          resolveRun({
            error,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: error?.code ?? 0,
            signal: error?.signal ?? null,
            killed: error?.killed === true,
          });
        });
      });
      const elapsedMs = Date.now() - startedAt;
      const receipt = {
        command: `${process.execPath} ${runEntry} --request ${requestPath} --io ${ioEntry}`,
        startedAt: new Date(startedAt).toISOString(),
        elapsedMs,
        code: runResult.code,
        signal: runResult.signal,
        killed: runResult.killed,
        casePath,
        requestPath,
      };
      await writeFile(resolve(caseDir, 'stdout.json'), runResult.stdout);
      await writeFile(resolve(caseDir, 'stderr.log'), runResult.stderr);
      await writeFile(resolve(caseDir, 'run-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

      let row;
      try {
        if (runResult.killed) throw new Error('runner timed out');
        let parsed;
        try {
          parsed = JSON.parse(runResult.stdout);
        } catch {
          throw new Error('runner stdout was not JSON');
        }
        await writeFile(resolve(caseDir, 'response.json'), `${JSON.stringify(parsed, null, 2)}\n`);
        const actual = deriveActual(parsed, config);
        const checked = checkRow(actual, expected, config);
        row = {
          family,
          caseId: specification.id,
          label: specification.label,
          expected,
          actual,
          checks: checked.checks,
          status: checked.passed ? 'PASS' : 'FAIL',
          reason: checked.passed ? '' : `failed checks: ${checked.failedChecks.join(', ')}`,
          receipt,
        };
      } catch (error) {
        row = {
          family,
          caseId: specification.id,
          label: specification.label,
          expected,
          actual: null,
          checks: null,
          status: 'UNVERIFIED',
          reason: compactReason(runResult.error, runResult.stderr),
          receipt,
        };
        await writeFile(resolve(caseDir, 'exec-error.json'), `${JSON.stringify({
          message: error?.message,
          code: error?.code,
          reason: compactReason(runResult.error, runResult.stderr),
        }, null, 2)}\n`);
      }
      await writeFile(resolve(caseDir, 'row.json'), `${JSON.stringify(row, null, 2)}\n`);
      rows.push(row);
    }
  }

  const output = {
    runLabel,
    startedAt: new Date().toISOString(),
    cdp,
    origin,
    counts: summarize(rows),
    rows,
  };
  await writeFile(resolve(out, 'input-six-cases.json'), `${JSON.stringify(output, null, 2)}\n`);
  await writeFile(resolve(out, 'rows.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(resolve(out, 'table.md'), `${tableMarkdown(rows)}\n`);
  console.log(JSON.stringify(output.counts, null, 2));
  if (output.counts.unverified > 0 || output.counts.fail > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
