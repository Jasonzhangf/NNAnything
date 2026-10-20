import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('LIST training acceptance compares OS types even when names match', {
  skip: !process.env.NN_HANDWIRED_ROOT && 'provide explicit real Handwired source root',
}, async () => {
  const api = await import('nnanything/cli-goal');
  const root = await mkdtemp(join(tmpdir(), 'nn-list-type-gate-'));
  try {
    const fixture = await api.makeCliCommandFixture({ root });
    const dataset = structuredClone(fixture.dataset);
    const supported = dataset.scenarios.find(scene => scene.partition === 'train' && scene.expectedEntries.some(entry => entry.type === 'file'));
    const entry = supported.expectedEntries.find(entry => entry.type === 'file');
    entry.type = 'directory';
    await mkdir(join(root, 'results'));
    const receipt = await api.runCliCommandTraining({ dataset, commands: ['pwd', 'cd', 'ls'], initial: api.zeroCliCommandProfile([]), initialSource: null, epochs: 200, learningRate: 0.1 }, {
      handwiredRoot: process.env.NN_HANDWIRED_ROOT, outputRoot: join(root, 'results'),
      grantedEffects: ['filesystem.read', 'filesystem.write'],
    });
    assert.equal(receipt.comparison.train.correct, 16);
    assert.equal(receipt.accepted, false, 'same names with a different expected OS type must fail acceptance');
  } finally { await rm(root, { recursive: true, force: true }); }
});
