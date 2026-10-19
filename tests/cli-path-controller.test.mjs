import test from 'node:test';
import assert from 'node:assert/strict';

test('public path policy is learned, zero/tampered policy cannot receive teacher corrections', async () => {
  const {zeroPathProfile,rolloutPath,PATH_ACTIONS,PATH_WIRES} = await import('../dist/cli-training.js');
  const zero = zeroPathProfile();
  const baseline = rolloutPath({cwd:'/a/b',input:'../c'},zero);
  assert.equal(baseline.ok,false);
  assert.equal(baseline.trace[0].action,'START_FROM_ROOT');
  const bad = structuredClone(zero);
  bad.weights[PATH_ACTIONS.indexOf('POP_PARENT')][PATH_WIRES.indexOf('bias')] = 10;
  const wrong = rolloutPath({cwd:'/a',input:'b'},bad);
  assert.equal(wrong.ok,false);
  assert.equal(wrong.trace[0].action,'POP_PARENT');
});

test('profile shape, request grammar and source group leakage are explicit contracts', async () => {
  const {zeroPathProfile,rolloutPath,validatePathProfile,preparePathDataset} = await import('../dist/cli-training.js');
  const profile = zeroPathProfile();
  const wrong=structuredClone(profile); wrong.wires.reverse();
  assert.throws(()=>validatePathProfile(wrong));
  for (const request of [{cwd:'relative',input:'a'},{cwd:'/a/..',input:'x'},{cwd:'/a',input:''},{cwd:'/a',input:'x\0y'}]) assert.throws(()=>rolloutPath(request,profile));
  const row={id:'a',sourceGroup:'same',partition:'train',cwd:'/a',input:'b',expected:'/a/b'};
  assert.throws(()=>preparePathDataset({version:1,samples:[row,{...row,id:'b',partition:'holdout'}]}));
});
