import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHandwired } from '../dist/training/handwired.js';
import { buildBrowserFeedbackCircuit } from '../dist/nodes/trainable/browser-feedback.js';
import { fitFeedbackProfile, createZeroFeedbackProfile, makeFeedbackSamples, feedbackFeatures, FEEDBACK_HEADS } from 'nnanything/browser-feedback';

function weightedOracle(weights,rows,balanced){
  const groups=new Map();for(const row of rows){const key=JSON.stringify(feedbackFeatures(row.input));const g=groups.get(key)??{head:row.teacher.head,count:0};g.count++;groups.set(key,g);}
  const perClass=new Map();for(const g of groups.values())perClass.set(g.head,(perClass.get(g.head)??0)+1);
  let loss=0;const gradient=Array(36).fill(0);
  for(const row of rows){const f=feedbackFeatures(row.input),g=groups.get(JSON.stringify(f)),y=FEEDBACK_HEADS.indexOf(row.teacher.head);
    const scale=balanced?1/(perClass.size*perClass.get(g.head)*g.count):1/(groups.size*g.count);
    const logits=weights.map(w=>w.reduce((sum,v,i)=>sum+v*f[i],0)),m=Math.max(...logits),exp=logits.map(v=>Math.exp(v-m)),total=exp.reduce((a,v)=>a+v,0);
    loss+=scale*(Math.log(total)+m-logits[y]);for(let h=0;h<3;h++)for(let j=0;j<12;j++)gradient[h*12+j]+=scale*(exp[h]/total-Number(h===y))*f[j];
  }return {loss,gradient};
}
test('class-balanced projection objective uses equal class mass and correct weighted 36-parameter gradient', {skip:!process.env.NN_HANDWIRED_ROOT},async()=>{
  const s=makeFeedbackSamples(),rows=[s[0],s[4],s[5],s[8],s[9],{...s[4],id:'duplicate-rejected'}];
  const initial=createZeroFeedbackProfile();initial.weights=initial.weights.map((w,h)=>w.map((_,j)=>j===0?[-.6,.1,.8][h]:.01*(h+1)*(j%5-2)));
  const fit=episodes=>fitFeedbackProfile({initial,episodes,objective:'class_balanced_projection_coverage',epochs:1,learningRate:.1,handwiredRoot:process.env.NN_HANDWIRED_ROOT});
  const result=await fit(rows),first=result.trajectory[0],oracle=weightedOracle(initial.weights,rows,true),unbalanced=weightedOracle(initial.weights,rows,false);
  assert.equal(result.objective.kind,'class_balanced_projection_coverage');assert.equal(result.objective.classCount,3);
  assert.deepEqual(result.objective.classProjectionCounts,[1,2,2]);assert.ok(Math.abs(oracle.loss-unbalanced.loss)>.001);
  assert.ok(Math.abs(first.loss-oracle.loss)<1e-6);
  for(let p=0;p<36;p++){
    const h=Math.floor(p/12),j=p%12,plus=structuredClone(initial.weights),minus=structuredClone(initial.weights);plus[h][j]+=.001;minus[h][j]-=.001;
    const numeric=(weightedOracle(plus,rows,true).loss-weightedOracle(minus,rows,true).loss)/.002;
    assert.ok(Math.abs(first.gradient[p]-numeric)<1e-5,`weighted gradient ${p}`);
    assert.ok(Math.abs(first.weights[p]-Math.fround(initial.weights[h][j]-.1*oracle.gradient[p]))<1e-6);
  }
  const repeated=await fit([...rows,{...s[0],id:'duplicate-completed'}]);
  assert.ok(Math.abs(first.loss-repeated.trajectory[0].loss)<1e-7);
  first.gradient.forEach((g,i)=>assert.ok(Math.abs(g-repeated.trajectory[0].gradient[i])<1e-7));
  first.weights.forEach((w,i)=>assert.ok(Math.abs(w-repeated.trajectory[0].weights[i])<1e-7));
  const oldFit=objective=>fitFeedbackProfile({initial,episodes:rows,...(objective===undefined?{}:{objective}),epochs:1,learningRate:.1,handwiredRoot:process.env.NN_HANDWIRED_ROOT});
  assert.deepEqual((await oldFit()).trajectory,(await oldFit('distinct_projection_coverage')).trajectory);
});
test('unsupported feedback objective is rejected before backend load',async()=>{
  for(const objective of ['unrecognized',null,1])await assert.rejects(fitFeedbackProfile({initial:createZeroFeedbackProfile(),episodes:[makeFeedbackSamples()[0]],objective,epochs:1,learningRate:.1,handwiredRoot:'/unused'}),/Unsupported feedback objective/);
});
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
