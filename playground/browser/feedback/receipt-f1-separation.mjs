import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runBrowserReceiptInference } from 'nnanything/browser-receipt';
import { browserFeedbackUnit, validateFeedbackProfile } from 'nnanything/browser-feedback';
import { parseArgs } from '../single-action/cli.mjs';

const args = parseArgs(process.argv.slice(2), ['--cases', '--receipt-profile', '--feedback-profile', '--out']);
if (!args.get('--cases') || !args.get('--receipt-profile') || !args.get('--feedback-profile') || !args.get('--out')) {
  throw new Error('Explicit --cases, --receipt-profile, --feedback-profile and --out required');
}
const cases = JSON.parse(await readFile(resolve(args.get('--cases')), 'utf8'));
const feedbackProfile = validateFeedbackProfile(JSON.parse(await readFile(resolve(args.get('--feedback-profile')), 'utf8')));
if (!Array.isArray(cases) || cases.length !== 4) throw new Error('R5 separation must run the four corrected rows');

const rows = [];
for (const row of cases) {
  const result = row.input.result;
  const receipt = await runBrowserReceiptInference(
    { receipt: result.receipt },
    { profilePath: resolve(args.get('--receipt-profile')) },
  );
  const feedback = await browserFeedbackUnit.infer(row.input, { profile: feedbackProfile });
  const observationErrors = result.observationFeedback?.errors ?? [];
  rows.push({
    id: row.id,
    gold: row.expected,
    goldReason: row.goldReason,
    author: row.author,
    features: feedback.prediction.features,
    receiptPrediction: receipt.prediction,
    feedbackPrediction: feedback.prediction,
    facts: {
      receiptKnowledge: { present: result.receipt !== null, ok: result.receipt?.ok ?? null, error: result.receipt?.error ?? null },
      f1Explanation: { status: feedback.prediction.status, head: feedback.prediction.head },
      rootGoalFact: { satisfaction: result.satisfaction, achieved: result.achieved, kind: row.input.request.goal.kind },
      observationCurrentness: {
        observationId: result.newState?.observationId ?? null,
        revision: result.newState?.revision ?? null,
        observationErrors,
      },
      effectsAndErrors: {
        dispatchState: result.dispatchState,
        effectKnowledge: result.effectKnowledge,
        executionErrors: result.executionErrors ?? [],
        error: result.error,
      },
    },
  });
}

const receiptFailures = rows.filter(row => row.receiptPrediction.head !== 'explicit_failure' || row.receiptPrediction.status !== 'predicted');
const feedbackMatches = rows.filter(row => row.feedbackPrediction.status === 'predicted' && row.feedbackPrediction.head === row.gold.head);
const evaluation = {
  purpose: 'receipt knowledge correct while old F1 still fails the same envelope; the two units stay separate',
  matchedTenParameters: {
    count: rows.length,
    passed: rows.length - receiptFailures.length,
    failed: receiptFailures.length,
  },
  fittedF1: {
    count: rows.length,
    passed: feedbackMatches.length,
    failed: rows.length - feedbackMatches.length,
    expectedFailureReproduced: feedbackMatches.length === 0,
  },
  doesNotConstituteCombinedPass: true,
  notFreshHoldout: true,
  rows,
};

const out = resolve(args.get('--out'));
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'separation.json'), `${JSON.stringify(evaluation, null, 2)}\n`);
const lines = ['# R5 receipt / F1 separation', '',
  '| id | receipt prediction | F1 prediction | gold | features | dispatch | effects | satisfaction |',
  '| --- | --- | --- | --- | --- | --- | --- | ---: |'];
for (const row of rows) {
  lines.push(`| ${row.id} | ${row.receiptPrediction.status}:${row.receiptPrediction.head ?? 'null'} | ${row.feedbackPrediction.status}:${row.feedbackPrediction.head ?? 'null'} | ${row.gold.status}:${row.gold.head} | ${row.features.join(',')} | ${row.facts.effectsAndErrors.dispatchState} | ${row.facts.effectsAndErrors.effectKnowledge} | ${row.facts.rootGoalFact.satisfaction} |`);
}
lines.push('', `- Receipt member: ${evaluation.matchedTenParameters.passed}/${evaluation.matchedTenParameters.count} correct.`);
lines.push(`- Old F1: ${evaluation.fittedF1.passed}/${evaluation.fittedF1.count} correct; expected failure reproduced: ${evaluation.fittedF1.expectedFailureReproduced}.`);
lines.push('- Receipt correctness is not F1 correctness, and neither replaces the root goal fact.');
await writeFile(resolve(out, 'table.md'), `${lines.join('\n')}\n`);

console.log(JSON.stringify({ out, receipt: evaluation.matchedTenParameters, f1: evaluation.fittedF1, reproduced: evaluation.fittedF1.expectedFailureReproduced }, null, 2));
if (receiptFailures.length > 0 || !evaluation.fittedF1.expectedFailureReproduced) process.exitCode = 1;
