import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRecursiveGoal} from 'nnanything/recursive-goal';
import {createFixtureAdapter,makeRequest,skill,evaluator,selector,initialObservation,successfulAtomicReceipt,diagnostic,responseReport} from './recursive-goal-fixtures.mjs';

const evaluate=(input,satisfied)=>({evaluatorId:'counter-evaluator',result:satisfied?'satisfied':'unsatisfied',satisfaction:satisfied?100:0,
  necessaryConditionsMet:satisfied,evidenceRefs:input.evidence.map(e=>e.id)});
function deps(adapter,signal,composite=false){return {adapter,enabledSkills:[...(composite?[skill('compose','composite',{allowedEffects:['fixture.write']})]:[]),
  skill('write','atomic',{effectClass:'mutating',requiredEffects:['fixture.write'],allowedEffects:['fixture.write']})],
  enabledEvaluators:[evaluator()],selectors:[selector('root-selector',composite?['compose']:['write']),selector('child-selector',['write'])],
  comparators:{sameGoal:(a,b)=>JSON.stringify(a)===JSON.stringify(b),sameBindings:(a,b)=>JSON.stringify(a)===JSON.stringify(b),sameFacts:(a,b)=>JSON.stringify(a)===JSON.stringify(b)},
  grantedEffects:new Set(['fixture.write']),...(signal?{signal}:{})};}
function failedPost(count=1){return {...successfulAtomicReceipt({count,effect:{knowledge:'unknown',confirmedEffects:[],receiptRef:null}}),
  outcome:'failed',executionErrors:[diagnostic()]};}

for(const variant of ['current','old-evidence','throw','cancel-before','cancel-during','budget']){
  test(`error-stop fact observation: ${variant}`,async()=>{
    const abort=new AbortController();let postEvaluations=0;
    const fixture=createFixtureAdapter({
      executeAtomic:()=>{if(variant==='cancel-before')abort.abort();return failedPost();},
      evaluate:async input=>{
        if(input.state.count===1){
          postEvaluations++;
          if(variant==='throw')throw new Error('post evaluator failed');
          if(variant==='cancel-during'){await Promise.resolve();abort.abort();}
          const receipt=evaluate(input,true);
          return variant==='old-evidence'?{...receipt,evidenceRefs:['fixture-initial-evidence']}:receipt;
        }
        return evaluate(input,false);
      },
    });
    const request=makeRequest({initialObservation:initialObservation({count:0}),
      ...(variant==='budget'?{limits:{maxTransitions:3,maxDepth:8,maxDerivedGoals:16}}:{})});
    const report=responseReport(await runRecursiveGoal(request,deps(fixture.adapter,abort.signal)));
    assert.equal(fixture.calls.executeAtomic,1);
    assert.equal(fixture.calls.select,1);assert.equal(fixture.calls.derive,0);assert.equal(fixture.calls.measureProgress,0);
    assert.ok(report.errors.some(e=>e.source.nativeCode==='E_FIXTURE'));
    assert.equal(report.atomicResults[0].effect.knowledge,'unknown');
    if(variant==='current'){
      assert.equal(report.rootEvaluation.result,'satisfied');assert.equal(report.control.outcome,'error');
      assert.deepEqual(report.rootEvaluation.evidenceRefs,['evidence-after']);
    }else{
      assert.equal(report.rootEvaluation.result,'unknown');
      if(variant==='old-evidence'||variant==='throw')assert.ok(report.errors.some(e=>e.source.category==='failure_fact_evaluation'));
    }
    if(variant==='cancel-before'||variant==='budget')assert.equal(postEvaluations,0);
  });
}

for(const firstStillTrue of [false,true]){
  test(`failed child post rechecks persistent sibling: ${firstStillTrue}`,async()=>{
    const fixture=createFixtureAdapter({
      select:input=>({kind:'selected',skillId:input.goal.slot==='root'?'compose':'write'}),
      derive:input=>({conditions:['first','second'].map((id,index)=>({id,goal:{...input.goal,slot:id},bindings:input.bindings,
        satisfactionThreshold:100,evaluatorId:'counter-evaluator',selectorId:'child-selector',mode:'atomic',
        dependsOn:index?['first']:[],lifetime:index?'stage':'persistent',activation:'required',allowedEffects:['fixture.write']})),
        nextCursor:'closed',expansion:'closed'}),
      executeAtomic:()=>{
        const receipt=failedPost();receipt.newState.value.first=firstStillTrue;
        receipt.evidence[0].payload.first=firstStillTrue;return receipt;
      },
      evaluate:input=>evaluate(input,input.goal.slot==='first'?input.state.first===true:input.goal.slot==='second'?input.state.count>=1:
        input.conditions.length===2&&input.conditions.every(c=>c.fact==='satisfied')),
    });
    const initial=initialObservation({count:0});initial.evidence[0].payload.first=true;
    const request=makeRequest({rootGoal:{...makeRequest().rootGoal,slot:'root'},state:{count:0,first:true},initialObservation:initial});
    const report=responseReport(await runRecursiveGoal(request,deps(fixture.adapter,null,true)));
    assert.equal(fixture.calls.executeAtomic,1);assert.equal(report.control.outcome,'error');
    assert.equal(report.rootEvaluation.result,firstStillTrue?'satisfied':'unsatisfied');
    assert.equal(report.atomicResults[0].effect.knowledge,'unknown');
    assert.ok(report.errors.some(e=>e.source.nativeCode==='E_FIXTURE'));
  });
}
