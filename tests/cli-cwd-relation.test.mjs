import test from 'node:test';
import assert from 'node:assert/strict';

test('CWD concept retains the complete four-vector truth table and real six-parameter fitting', {
  skip: !process.env.NN_HANDWIRED_ROOT && 'provide explicit real Handwired source root',
}, async () => {
  const api = await import('nnanything/cli-goal');
  const rows = [0, 1].flatMap(same => [0, 1].map(present => ({ features: [1, same, present], expected: same && present ? 'MATCH' : 'NO_MATCH' })));
  const initial = api.zeroCwdRelationProfile();
  assert.equal(api.selectCwdRelation(api.scoreCwdRelation([1, 1, 1], initial)), 'NO_MATCH');
  const frozen = await api.fitCwdRelation({ rows, initial, handwiredRoot: process.env.NN_HANDWIRED_ROOT, epochs: 0, learningRate: 0.1 });
  assert.deepEqual(frozen.profile, initial);
  const fit = await api.fitCwdRelation({ rows, initial, handwiredRoot: process.env.NN_HANDWIRED_ROOT, epochs: 200, learningRate: 0.1 });
  for (const row of rows) assert.equal(api.selectCwdRelation(api.scoreCwdRelation(row.features, fit.profile)), row.expected);
  assert.equal(fit.timing.trainableParamCount, 6);
  assert.equal(fit.timing.gradientRowEpochs, 800);
});
