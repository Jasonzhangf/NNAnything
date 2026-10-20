import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHandwired } from '../dist/training/handwired.js';
import { buildBrowserFeedbackCircuit } from '../dist/nodes/trainable/browser-feedback.js';
import { fitFeedbackProfile, createZeroFeedbackProfile, makeFeedbackSamples } from 'nnanything/browser-feedback';
test('duplicate coverage of one projection does not change feedback loss or source gradient', { skip: !process.env.NN_HANDWIRED_ROOT }, async () => {
  const samples = makeFeedbackSamples();
  const rows = [samples[0], samples[4], samples[8]];
  const initial = createZeroFeedbackProfile();
  initial.weights = initial.weights.map((row, head) => row.map((_, wire) => .01 * (head + wire % 3)));
  const run = episodes => fitFeedbackProfile({ initial, episodes, handwiredRoot: process.env.NN_HANDWIRED_ROOT, epochs: 1, learningRate: .1 });
  const plain = await run(rows);
  const duplicate = await run([...rows, { ...rows[0], id: 'duplicate-source-record' }]);
  assert.ok(Math.abs(plain.trajectory[0].loss - duplicate.trajectory[0].loss) < 1e-7);
  plain.trajectory[0].gradient.forEach((value, index) => assert.ok(Math.abs(value - duplicate.trajectory[0].gradient[index]) < 1e-7));
});
test('feedback fitting rejects contradictory supervision for the same observable projection', async () => {
  const row = makeFeedbackSamples()[0];
  const conflict = { ...structuredClone(row), id: 'conflicting-observable-row', teacher: { ...row.teacher, head: 'indeterminate' } };
  await assert.rejects(fitFeedbackProfile({ initial: createZeroFeedbackProfile(), episodes: [row, conflict], handwiredRoot: '/unused-backend', epochs: 200, learningRate: .1 }), /Conflicting feedback labels/);
});
test('feedback source gradients match finite differences for all 36 parameters', { skip: !process.env.NN_HANDWIRED_ROOT }, async () => {
  const circuit = buildBrowserFeedbackCircuit(await loadHandwired(process.env.NN_HANDWIRED_ROOT));
  const source = new Float32Array(circuit.circuit.sourceSize);
  circuit.parameters.forEach((wire, i) => { source[wire] = .02 * (i % 4); });
  circuit.features.forEach((wire, i) => { source[wire] = Number(i !== 5 && i !== 8 && i !== 10); });
  const loss = source => {
    const values = circuit.circuit.evaluateReference(source);
    const logits = circuit.logits.map(wire => values[wire]);
    const max = Math.max(...logits);
    return Math.log(logits.reduce((sum, value) => sum + Math.exp(value - max), 0)) + max - logits[0];
  };
  const values = circuit.circuit.evaluateReference(source);
  const logits = circuit.logits.map(wire => values[wire]);
  const exp = logits.map(value => Math.exp(value - Math.max(...logits)));
  const total = exp.reduce((a, b) => a + b);
  const seeds = new Float32Array(values.length);
  circuit.logits.forEach((wire, i) => { seeds[wire] = exp[i] / total - Number(i === 0); });
  const gradient = circuit.circuit.backpropagateReference(values, seeds);
  assert.ok(circuit.parameters.some(wire => Math.abs(gradient[wire]) > .01));
  for (const wire of circuit.parameters) {
    const plus = source.slice(), minus = source.slice();
    plus[wire] += .001; minus[wire] -= .001;
    assert.ok(Math.abs((loss(plus) - loss(minus)) / .002 - gradient[wire]) < .002);
  }
});
