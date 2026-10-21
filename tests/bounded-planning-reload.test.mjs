import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  createPlanningDecisionReloadResource, comparePlanningDecisionCandidates,
  PLANNING_DECISION_WIRES, runRecursiveGoal, createDefaultPlanningDecisionBinding,
} from 'nnanything/recursive-goal';
import {createBoundedFiniteResources} from '../playground/recursive-goal/bounded-finite.mjs';

const handwiredRoot=process.env.NN_HANDWIRED_ROOT;
function candidate(version, weight=1) {
  return {ref:{id:'experiment.weights',version},profile:{
    contract:'planning.decision-policy.v1',providerRef:{id:'handwired',version:'1'},
    unitRef:{id:'planning.decision',version:'1'},wireSchemaVersion:'planning.decision-wire.v1',
    wires:[...PLANNING_DECISION_WIRES],featureRange:{min:0,max:1},
    weights:PLANNING_DECISION_WIRES.map(name=>name==='rankOrder.value'?weight:0),
    normalization:{satisfaction:{min:0,max:100},risk:{scaleRef:{id:'risk',version:'1'},maxOrdinal:4},cost:{unit:'action',min:0,max:10},rankOrder:{min:0,max:100}},
    calibration:'uncalibrated',adoption:'not_applied',
  }};
}
const input={preference:{kind:'order_first',projectionScaleRef:{id:'satisfaction',version:'1'}},
  candidates:['a','b'].map((pathId,index)=>({pathId,rankOrder:index+1,attemptOrder:[],projection:{terminalSatisfaction:100,riskLevels:[],maximumCost:1,costUnit:'action',coverage:'covered',unknownRefs:[]}})),priorInfluences:[],unknown:[]};

test('hot reload publishes new requests while captured versions remain immutable',async()=>{
  const resource=createPlanningDecisionReloadResource(handwiredRoot);
  assert.throws(()=>resource.capture(),/not loaded/);
  const a=candidate('A',-1);
  const loading=resource.reload(a);
  assert.throws(()=>resource.capture(),/reload_in_progress/);
  await assert.rejects(resource.reload(candidate('overlap')),/reload_in_progress/);
  await loading;
  const capturedA=resource.capture();
  a.profile.weights.fill(0);
  a.profile.normalization.rankOrder.max=1;
  assert.deepEqual(await capturedA.infer(input),{kind:'ranked',pathRefs:['a','b']});
  await resource.reload(candidate('B',1));
  assert.deepEqual(await resource.capture().infer(input),{kind:'ranked',pathRefs:['b','a']});
  assert.deepEqual(await capturedA.infer(input),{kind:'ranked',pathRefs:['a','b']});
  const invalid=candidate('bad'); invalid.profile.weights=[];
  await assert.rejects(resource.reload(invalid),/18 finite/);
  assert.throws(()=>resource.capture(),/not loaded/);
  assert.deepEqual(await capturedA.infer(input),{kind:'ranked',pathRefs:['a','b']});
  await resource.reload(candidate('C'));
  await assert.rejects(resource.reload(candidate('A')),/already been published/);
});

test('the same recorded decision compares candidates with isolated errors and no action execution',async()=>{
  const bad=candidate('bad');bad.profile.weights=[];
  const missing=candidate('missing');missing.profile.weights=PLANNING_DECISION_WIRES.map(name=>name==='risk.value'?1:0);
  const candidates=[candidate('A',-1),bad,candidate('B',1),missing,candidate('tie',0)];
  const before=structuredClone(input);
  const first=await comparePlanningDecisionCandidates(input,candidates,handwiredRoot);
  assert.deepEqual(first,await comparePlanningDecisionCandidates(input,candidates,handwiredRoot));
  assert.deepEqual(input,before);
  assert.deepEqual(first[0].ranking,{kind:'ranked',pathRefs:['a','b']});
  assert.equal(first[1].kind,'error');
  assert.deepEqual(first[2].ranking,{kind:'ranked',pathRefs:['b','a']});
  assert.ok(Math.abs(first[0].rows[0].utility-(-0.01))<1e-7);
  assert.ok(Math.abs(first[2].rows[1].utility-0.02)<1e-7);
  assert.equal(first[3].ranking.kind,'defer');
  assert.ok(first[3].rows.every(row=>row.utility===null && row.missing.includes('risk.value')));
  assert.equal(first[4].ranking.kind,'defer');
  await assert.rejects(comparePlanningDecisionCandidates(input,[candidate('A'),candidate('A')],handwiredRoot),/unique/);
});

test('public continuation rejects a different weight version and resumes the captured version',async()=>{
  const resource=createPlanningDecisionReloadResource(handwiredRoot);
  await resource.reload(candidate('A',-1));
  const bindingA=resource.capture();
  const resources=createBoundedFiniteResources({scenario:'reload-continuation',actualBranch:'approve',expectedBranch:'approve'});
  resources.dependencies.planning.decision=bindingA;
  const first=await runRecursiveGoal(resources.request,resources.dependencies);
  assert.equal(first.kind,'run_result');
  assert.equal(first.report.control.outcome,'yielded',JSON.stringify(first));
  const continuation=first.report.continuation;
  const atomicCount=first.report.atomicResults.length;
  await resource.reload(candidate('B',1));
  resources.dependencies.planning.decision=resource.capture();
  const rejected=await runRecursiveGoal({...resources.request,continuation},resources.dependencies);
  assert.notEqual(rejected.kind==='run_result' && rejected.report.control.outcome,'completed');
  assert.match(JSON.stringify(rejected),/decision|contract/);
  resources.dependencies.planning.decision=bindingA;
  const resumed=await runRecursiveGoal({...resources.request,continuation},resources.dependencies);
  assert.equal(resumed.kind,'run_result');
  assert.ok(resumed.report.atomicResults.length>=atomicCount);
  assert.notEqual(resumed.report.control.outcome,'error',JSON.stringify(resumed));
});

test('a recorded failed execution supplies decision input for repeated numeric experiments',async()=>{
  const resources=createBoundedFiniteResources({scenario:'failure-weight-experiment',actualBranch:'approve',expectedBranch:'approve',failSelected:true});
  const rule=createDefaultPlanningDecisionBinding();
  const captured=[];
  resources.dependencies.planning.decision={ref:rule.ref,infer:async decision=>{
    captured.push(structuredClone(decision));
    return rule.infer(decision);
  }};
  let continuation;
  let final;
  do {
    final=await runRecursiveGoal({...resources.request,...(continuation?{continuation}:{})},resources.dependencies);
    continuation=final.kind==='run_result' && final.report.control.outcome==='yielded'?final.report.continuation:null;
  } while(continuation);
  assert.ok(final.report.errors.some(error=>error.code==='execution_failed'));
  assert.ok(captured.length>0);
  const before=structuredClone(resources.memory);
  const recorded=captured[0];
  const variants=[candidate('failure-A',-1),candidate('failure-B',1)];
  const first=await comparePlanningDecisionCandidates(recorded,variants,handwiredRoot);
  assert.deepEqual(await comparePlanningDecisionCandidates(recorded,variants,handwiredRoot),first);
  assert.deepEqual(resources.memory,before,'numeric comparison cannot dispatch or alter the actual fixture');
  assert.ok(first.every(result=>result.kind==='evaluated'));
});
