import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EXPANDED_CASES, judgeExpandedCase } from './expanded-cases.mjs';
import { evidenceFor } from './expanded-evidence.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const segmentEntry = resolve(here, 'expanded-segment.mjs');

function argAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

const familyArg = argAfter('--family', 'all');
const cdp = argAfter('--cdp', 'http://127.0.0.1:9333');
const out = resolve(argAfter('--out', resolve(process.cwd(), 'b-feedback-expanded-acceptance')));
const families = familyArg === 'all' ? ['A', 'B'] : familyArg === 'A' ? ['A'] : familyArg === 'B' ? ['B'] : (() => {
  throw new Error('--family must be A, B, or all');
})();

const runDir = argAfter('--run', process.env.BFEEDBACK_RUN);
const feedbackProfile = argAfter('--feedback-profile',
  process.env.BFEEDBACK_FEEDBACK_PROFILE ?? process.env.BFEEDBACK_F1_PROFILE
    ?? (runDir ? resolve(runDir, 'training/f1/candidate.json') : undefined));
const atomicProfile = argAfter('--atomic-profile', process.env.BFEEDBACK_ATOMIC_PROFILE);
const strategyProfile = argAfter('--strategy-profile', process.env.BFEEDBACK_STRATEGY_PROFILE ?? process.env.BFEEDBACK_F2_INITIAL);

const missing = [
  ['feedback profile', feedbackProfile],
  ['atomic profile', atomicProfile],
  ['strategy profile', strategyProfile],
].filter(([, value]) => value === undefined).map(([name]) => name);
if (missing.length > 0) {
  throw new Error(`Missing explicit assets: ${missing.join(', ')}. Set BFEEDBACK_FEEDBACK_PROFILE, BFEEDBACK_ATOMIC_PROFILE and BFEEDBACK_STRATEGY_PROFILE (or BFEEDBACK_F2_INITIAL).`);
}

for (const [name, path] of [['feedback', feedbackProfile], ['atomic', atomicProfile], ['strategy', strategyProfile]]) {
  try {
    JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`${name} profile is not readable at ${path}: ${error.message}`);
  }
}

function buildConfig({ item, family, segment, targetId, continuation, keepTarget }) {
  const invalidateTarget = item.boundary === 'target-invalid' && segment > 1;
  return {
    caseId: item.id,
    family,
    mode: item.boundary === 'target-invalid' && segment === 1 ? 'primary-ineffective' : item.pageMode,
    diagnostic: item.diagnosticProfile ? (item.id === 'C09b' ? 'non-positive-secondary' : 'tie') : null,
    documentRef: invalidateTarget
      ? `b-feedback-${item.id}-${family}-invalidated`
      : `b-feedback-${item.id}-${family}`,
    rerender: invalidateTarget,
    segment,
    targetId: segment > 1 ? targetId : null,
    continuation,
    keepTarget,
    sameFailureLimit: 2,
    maxAtomicAttempts: 4,
    tamper: item.boundary === 'policy-change' && segment > 1 ? 'policy' : null,
    revokePermission: item.boundary === 'permission-revoked' && segment > 1,
    observeFailAfterDispatch: item.pageMode === 'post-missing' || item.pageMode === 'execution-and-observation-fail',
    stalePost: item.pageMode === 'post-stale',
  };
}

async function runSegment(config) {
  const configDir = resolve(out, 'configs');
  const configPath = resolve(configDir, `${config.caseId}-${config.family}-seg${config.segment}.json`);
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
  try {
    const result = await execFileAsync(process.execPath, [segmentEntry], {
      cwd: repo,
      env: {
        ...process.env,
        B_FEEDBACK_CASE_CONFIG: configPath,
        B_FEEDBACK_CDP: cdp,
        B_FEEDBACK_F1_PROFILE: resolve(feedbackProfile),
        B_FEEDBACK_ATOMIC_PROFILE: resolve(atomicProfile),
        B_FEEDBACK_STRATEGY_PROFILE: resolve(strategyProfile),
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60000,
    });
    return { error: null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return { error, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function tableMarkdown(rows) {
  const lines = ['| family | case | status | root | dispatches | F1 heads | effects | errors | stop |',
    '| --- | --- | --- | --- | ---: | --- | --- | --- | --- |'];
  for (const row of rows) {
    lines.push(`| ${row.family} | ${row.caseId} | ${row.status} | ${row.evidence.root} | ${row.evidence.dispatches} | ${row.evidence.f1Heads.join(',')} | ${row.evidence.effectKnowledge.join(',')} | ${row.evidence.executionErrors.length + row.evidence.observationErrors.length} | ${row.evidence.stops.join(';') || '-'} |`);
  }
  return `${lines.join('\n')}\n`;
}

const rows = [];
for (const family of families) {
  for (const item of EXPANDED_CASES) {
    const caseDir = resolve(out, `${family}/${item.id}`);
    await mkdir(caseDir, { recursive: true });
    const segments = [];
    let targetId = null;
    let continuation = null;
    const segmentBudget = item.segments > 1 ? item.segments : item.expected.maxDispatches + 2;
    for (let segment = 1; segment <= segmentBudget; segment += 1) {
      const config = buildConfig({ item, family, segment, targetId, continuation, keepTarget: segment < segmentBudget });
      const result = await runSegment(config);
      let output = null;
      try {
        output = JSON.parse(result.stdout);
      } catch {
        output = null;
      }
      await writeFile(resolve(caseDir, `seg${segment}.stdout.json`), result.stdout);
      await writeFile(resolve(caseDir, `seg${segment}.stderr.log`), result.stderr);
      if (result.error !== null) {
        await writeFile(resolve(caseDir, `seg${segment}.exec-error.json`), `${JSON.stringify({ code: result.error.code, message: result.error.message }, null, 2)}\n`);
      }
      if (output !== null) {
        await writeFile(resolve(caseDir, `seg${segment}.episode.json`), `${JSON.stringify(output, null, 2)}\n`);
        targetId = output.targetId ?? targetId;
        if (output.continuation && output.state) {
          continuation = { continuation: output.continuation, state: output.state };
        } else {
          continuation = null;
        }
      }
      segments.push({ segment, output, error: result.error, exitCode: result.error?.code ?? 0 });
      if (result.error !== null || output === null || output.kind === 'fault') break;
      if (output.kind === 'request_rejected' || output.continuation === null) break;
      if (output.outcome !== 'yielded') break;
    }
    if (targetId !== null) {
      try {
        await fetch(`${cdp}/json/close/${encodeURIComponent(targetId)}`, { method: 'PUT' });
      } catch {
        // The last segment may already have closed its own target.
      }
    }
    const evidence = evidenceFor({ item, segments });
    const judgment = judgeExpandedCase(item, evidence);
    const row = {
      family,
      caseId: item.id,
      status: judgment.passed ? 'pass' : 'fail',
      reason: judgment.reason,
      evidence,
      segments: segments.map(segment => ({
        segment: segment.segment,
        exitCode: segment.exitCode,
        kind: segment.output?.kind ?? 'crash',
        outcome: segment.output?.outcome ?? segment.output?.kind ?? 'crash',
        rootResult: segment.output?.rootResult ?? null,
        dispatches: segment.output?.clicks?.length ?? 0,
      })),
    };
    rows.push(row);
  }
}

await writeFile(resolve(out, 'rows.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
await writeFile(resolve(out, 'table.md'), tableMarkdown(rows));
const summary = {
  families,
  total: rows.length,
  pass: rows.filter(row => row.status === 'pass').length,
  fail: rows.filter(row => row.status === 'fail').length,
  unverified: rows.filter(row => row.segments.some(segment => segment.kind === 'crash')).length,
};
await writeFile(resolve(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (summary.fail > 0 || summary.unverified > 0) process.exitCode = 2;
