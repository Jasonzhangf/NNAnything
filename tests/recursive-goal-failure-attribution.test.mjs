import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRecursiveGoal} from 'nnanything/recursive-goal';
import {createBoundedFiniteResources} from '../playground/recursive-goal/bounded-finite.mjs';

async function run(resources) {
  const results=[];
  let continuation;
  do {
    const response=await runRecursiveGoal({...resources.request,...(continuation?{continuation}: {})},resources.dependencies);
    results.push(response);
    continuation=response.kind==='run_result' && response.report.control.outcome==='yielded'
      ? JSON.parse(JSON.stringify(response.report.continuation)) : null;
  } while(continuation);
  return results;
}

function scene() {
  return createBoundedFiniteResources({scenario:'attribution',actualBranch:'approve',expectedBranch:'approve',failSelected:true,maxPredictionCalls:96});
}

test('failure without domain attribution or with unknown cause does not exclude predicted transitions',async()=>{
  for(const mode of ['missing','unknown']) {
    const resources=scene();
    delete resources.dependencies.planning.attributeFailure;
    if(mode==='unknown') resources.dependencies.planning.attributeFailure=()=>({kind:'unknown',reason:'only this resource-busy attempt is known to fail',evidenceRefs:[]});
    const results=await run(resources);
    const last=results.at(-1);
    assert.equal(last.kind,'run_result');
    assert.ok(last.report.errors.some(e=>e.code==='execution_failed'));
    assert.equal(last.report.control.outcome,'error');
    assert.ok(results.every(r=>!r.report?.continuation?.planControl.failurePriors.length),'one failure does not prove every prediction impossible');
    assert.ok(last.report.errors.some(e=>e.source.category===`failure_attribution_${mode==='missing'?'not_configured':'unknown'}`));
    const failed=last.report.atomicResults.findIndex(r=>r.outcome==='failed');
    assert.equal(last.report.atomicResults.length,failed+1,'no implicit retry after unproven failure');
  }
});

test('domain restriction affects only the supported generated transition and survives JSON continuation',async()=>{
  const resources=scene();
  resources.dependencies.planning.decision={ref:{id:'test.attribution-order',version:'1'},
    infer:async input=>({kind:'ranked',pathRefs:input.candidates.map(c=>c.pathId)})};
  const model=resources.dependencies.planning.resultModels[0];
  const predict=model.predict;
  model.predict=input=>{
    const output=predict(input);
    if(output.kind==='ready' && input.skillRef.id==='bounded.approve') {
      const first=output.transitions[0];
      return {...output,transitions:[first,{...first,resultRef:'result:approve:alternative',preferenceOrder:99}]};
    }
    return output;
  };
  const calls=new Map();
  const domainAttribution=resources.dependencies.planning.attributeFailure;
  resources.dependencies.planning.attributeFailure=input=>{
    const ref=input.atomicResult.dispatchId;
    calls.set(ref,(calls.get(ref)??0)+1);
    return domainAttribution(input);
  };
  const results=await run(resources);
  const prior=results.flatMap(r=>r.report?.continuation?.planControl.failurePriors??[])[0];
  assert.ok(prior,JSON.stringify(results.map(r=>({kind:r.kind,control:r.report?.control,errors:r.report?.errors}))));
  assert.equal(prior.conclusion.transitionRefs.length,1,'must not silently broaden the domain restriction');
  assert.equal(prior.source.attribution.generatedTransitionRefs.length,2);
  assert.ok(prior.source.attribution.evidenceRefs.length);
  assert.ok([...calls.values()].every(count=>count===1),'resuming cannot repeat attribution for the same dispatch');
  const saved=results.find(r=>r.report?.continuation?.planControl.failurePriors.length).report.continuation;
  for(const mode of ['missingProof','transition','evidence']) {
    const continuation=structuredClone(saved),prior=continuation.planControl.failurePriors[0];
    if(mode==='missingProof') delete prior.source.attribution;
    if(mode==='transition') prior.conclusion.transitionRefs=[prior.conclusion.transitionRefs[0]+':invented'];
    if(mode==='evidence') prior.source.attribution.evidenceRefs=['not-observed'];
    const before=resources.memory.atomicExecutions.length;
    const rejected=await runRecursiveGoal({...resources.request,continuation},resources.dependencies);
    assert.equal(rejected.kind,'request_rejected',mode);
    assert.equal(resources.memory.atomicExecutions.length,before);
  }
});

test('invalid attribution stops without losing the original execution error',async()=>{
  for(const mode of ['throws','promise','outside','badEvidence']) {
    const resources=scene();
    resources.dependencies.planning.attributeFailure=input=>{
      if(mode==='throws') throw new Error('attribution failed');
      if(mode==='promise') return Promise.resolve({kind:'unknown',reason:'async not permitted',evidenceRefs:[]});
      return {kind:'restricted',reason:'bounded evidence claim',
        evidenceRefs:mode==='badEvidence'?['not-observed']:input.evidence.filter(e=>e.validity==='valid' && e.stateRef===input.state.id).map(e=>e.id),
        transitionRefs:[mode==='outside'?input.node.predictedResults[0].transitionRef+':invented':input.node.predictedResults[0].transitionRef],preconditions:[],invalidation:[]};
    };
    const results=await run(resources),last=results.at(-1);
    assert.equal(last.kind,'run_result');
    assert.equal(last.report.control.outcome,'error');
    assert.ok(last.report.errors.some(e=>e.source.category==='failure_attribution_contract'));
    assert.equal(last.report.errors.find(e=>e.errorId===last.report.primaryErrorId).code,'execution_failed');
    assert.ok(results.every(r=>!r.report?.continuation?.planControl.failurePriors.length));
  }
});

test('unattributed planning failure refreshes root facts only from the actual postcondition',async()=>{
  for(const mode of ['missing','unknown','throws','badOutput','evaluateThrows','noEvidence','cancel','cancelDuringReject']) {
    const resources=scene();
    const abort=new AbortController();
    resources.dependencies.signal=abort.signal;
    delete resources.dependencies.planning.attributeFailure;
    if(mode==='unknown') resources.dependencies.planning.attributeFailure=()=>({kind:'unknown',reason:'cause is not known',evidenceRefs:[]});
    if(mode==='throws') resources.dependencies.planning.attributeFailure=()=>{throw new Error('explanation unavailable');};
    if(mode==='badOutput') resources.dependencies.planning.attributeFailure=()=>({kind:'invalid'});
    const execute=resources.dependencies.adapter.executeAtomic;
    resources.dependencies.adapter.executeAtomic=async input=>{
      const receipt=await execute(input);
      if(receipt.outcome==='failed') {
        receipt.newState.value.finished=true; // observed external completion, despite this action failing
        if(mode==='noEvidence') receipt.evidence=[];
        if(mode==='cancel') abort.abort();
      }
      return receipt;
    };
    resources.dependencies.adapter.evaluate=async input=>{
      if(input.state.finished && mode==='cancelDuringReject') {
        await Promise.resolve();
        abort.abort();
        throw new Error('post evaluation cancelled while awaiting');
      }
      if(input.state.finished && mode==='evaluateThrows') throw new Error('post evaluation unavailable');
      const satisfied=input.state.finished;
      return {evaluatorId:resources.request.rootEvaluatorId,result:satisfied?'satisfied':'unsatisfied',
        satisfaction:satisfied?100:0,necessaryConditionsMet:satisfied,
        evidenceRefs:input.evidence.filter(e=>e.validity==='valid' && e.payload.revision===input.state.revision).map(e=>e.id)};
    };
    const results=await run(resources),last=results.at(-1);
    assert.equal(last.kind,'run_result');
    assert.equal(last.report.rootEvaluation.result,['evaluateThrows','noEvidence','cancel','cancelDuringReject'].includes(mode)?'unknown':'satisfied',mode);
    assert.equal(last.report.control.outcome,mode.startsWith('cancel')?'cancelled':'error');
    assert.ok(last.report.errors.some(e=>e.code==='execution_failed'));
    const failed=last.report.atomicResults.findIndex(r=>r.outcome==='failed');
    assert.equal(last.report.atomicResults.length,failed+1,'fact refresh must not dispatch any recovery action');
    assert.equal(last.report.atomicResults[failed].effect.knowledge,'none');
  }
});
