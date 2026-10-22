import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRecursiveGoal,createHandwiredPlanningDecisionBinding,PLANNING_DECISION_WIRES} from 'nnanything/recursive-goal';
import {createBoundedFiniteResources,runBoundedFiniteStep} from '../playground/recursive-goal/bounded-finite.mjs';

async function drain(resources) {
  const results=[];
  let continuation;
  do {
    const response=await runRecursiveGoal({...resources.request,...(continuation ? {continuation}: {})},resources.dependencies);
    results.push(response);
    continuation=response.kind==='run_result' && response.report.control.outcome==='yielded' ? response.report.continuation : null;
  } while(continuation);
  return results;
}

test('a failed path rechecks a real checkpoint and replans with scoped failure evidence',async()=>{
  const resources=createBoundedFiniteResources({scenario:'real-checkpoint-rollback',actualBranch:'approve',expectedBranch:'approve',failSelected:true,changedPremise:true,maxPredictionCalls:96});
  const original=resources.dependencies.adapter.evaluate;
  resources.dependencies.adapter.evaluate=async input=>{
    if(input.goal.kind!=='finite.bounded-checkpoint') return original(input);
    const refs=input.evidence.filter(e=>e.validity==='valid' && e.payload.revision===input.state.revision).map(e=>e.id);
    const satisfied=input.state.observedBranch!==null && refs.length>0;
    return {evaluatorId:input.context ? resources.request.rootEvaluatorId : '',result:satisfied?'satisfied':'unsatisfied',satisfaction:satisfied?100:0,necessaryConditionsMet:satisfied,evidenceRefs:refs};
  };
  resources.request.planning.checkpointSpecs=[{id:'observed-branch',goal:{kind:'finite.bounded-checkpoint',goalId:'bounded-finite-1'},bindings:resources.request.rootBindings,satisfactionThreshold:100,evaluatorId:resources.request.rootEvaluatorId,evidenceRequirementRefs:[],obligations:[],rollingRule:'next_segment'}];
  const results=await drain(resources);
  const last=results.at(-1);
  assert.equal(last.kind,'run_result');
  assert.equal(last.report.control.outcome,'completed',JSON.stringify(last));
  assert.ok(results.some(r=>r.report?.planning?.decision?.kind==='rollback'));
  assert.ok(results.some(r=>r.report?.continuation?.planControl.usage.rollbacksUsed===1));
  assert.ok(last.report.errors.some(e=>e.code==='execution_failed'));
  assert.ok(last.report.primaryErrorId,'the original failure is retained');
  assert.ok(last.report.planning.recoveredFailureRefs.includes(last.report.primaryErrorId));
  const final=last.report.states.at(-1).value;
  assert.equal(final.premise,'changed','rollback never copies the old checkpoint state');
  assert.equal(final.finished,true);
});

function twoLegalChoices() {
  const resources=createBoundedFiniteResources({scenario:'two-valid-choices',actualBranch:'approve',expectedBranch:'approve'});
  const skills=resources.dependencies.enabledSkills.filter(s=>['bounded.approve','bounded.reject'].includes(s.id));
  resources.dependencies.enabledSkills=skills;
  resources.dependencies.selectors=[{id:resources.request.rootSelectorId,skillIds:skills.map(s=>s.id)}];
  resources.dependencies.adapter.executeAtomic=async input=>{
    // This fixture defines two genuinely successful actions. Calling the branch
    // executor from its unobserved initial state would fail, even if finished
    // were later forced true; that tests failure recovery rather than ranking.
    const stateId=`${input.context.requestId}:two-choice-result:${input.state.revision+1}`;
    return {runId:input.context.requestId,executorInvoked:true,outcome:'succeeded',
      sourceResult:{tag:'finite.two-choices',value:{skillId:input.skill.id}},
      newState:{id:stateId,value:{...input.state,finished:true,revision:input.state.revision+1}},
      evidence:[{id:`${stateId}:evidence`,stateRef:stateId,validity:'valid',payload:{kind:'finite.bounded-evidence',revision:input.state.revision+1}}],
      executionErrors:[],verificationErrors:[],effect:{knowledge:'none',confirmedEffects:[],receiptRef:null}};
  };
  resources.dependencies.adapter.evaluate=async input=>({evaluatorId:resources.request.rootEvaluatorId,result:input.state.finished?'satisfied':'unsatisfied',satisfaction:input.state.finished?100:0,necessaryConditionsMet:input.state.finished,evidenceRefs:input.state.finished ? input.evidence.filter(e=>e.validity==='valid').map(e=>e.id) : []});
  resources.dependencies.adapter.select=async input=>({kind:'selected',skillId:input.planning.expectedSkillRef.id});
  const model=resources.dependencies.planning.resultModels[0];
  model.skillRefs=skills.map(s=>({id:s.id,version:s.version}));
  model.predict=input=>({kind:'ready',transitions:[{
    resultRef:input.skillRef.id,preferenceOrder:input.skillRef.id==='bounded.approve'?1:2,
    predictedState:{kind:'predicted',projection:{state:{...input.stateProjection,finished:true},evidence:[]},assumptions:[],unknown:[],source:{modelRef:model.ref,predictionCallRef:input.skillRef.id}},
    predictedEffects:[],applicability:{kind:'applicable',reason:'two safe fixture transitions',evidenceRefs:[]},coverage:'covered',semanticProgress:'progressed',continuation:{kind:'terminal',terminalKind:'root_satisfied',checkpointRef:null},projection:{terminalSatisfaction:100,riskLevels:[],cost:{amount:1,unit:'action'}},unknown:[],preconditions:[],
  }]});
  return resources;
}

test('the same public request selects a different legal action with a real Handwired profile',async()=>{
  const rule=twoLegalChoices();
  const weighted=twoLegalChoices();
  assert.deepEqual(rule.request,weighted.request);
  const weights=PLANNING_DECISION_WIRES.map(name=>name==='rankOrder.value'?1:0);
  weighted.dependencies.planning.decision=await createHandwiredPlanningDecisionBinding({kind:'planning_decision.handwired.v1',handwiredRoot:process.env.NN_HANDWIRED_ROOT,profile:{contract:'planning.decision-policy.v1',providerRef:{id:'test.weighted-order',version:'1'},unitRef:{id:'planning.decision',version:'1'},wireSchemaVersion:'planning.decision-wire.v1',wires:[...PLANNING_DECISION_WIRES],featureRange:{min:0,max:1},weights,normalization:{satisfaction:{min:0,max:100},risk:{scaleRef:{id:'risk',version:'1'},maxOrdinal:4},cost:{unit:'action',min:0,max:10},rankOrder:{min:0,max:2}},calibration:'uncalibrated',adoption:'not_applied'}});
  const first=await drain(rule),second=await drain(weighted);
  assert.equal(first.at(-1).report.control.outcome,'completed');
  assert.equal(second.at(-1).report.control.outcome,'completed');
  assert.equal(first.at(-1).report.atomicResults[0].skillId,'bounded.approve');
  assert.equal(second.at(-1).report.atomicResults[0].skillId,'bounded.reject');
});

test('invalid or rejected async decisions do not dispatch or fall back',async()=>{
  for(const mode of ['invalid','reject','cancel']) {
    const resources=twoLegalChoices();
    const abort=new AbortController();
    resources.dependencies.signal=abort.signal;
    resources.dependencies.planning.decision={ref:{id:'test.async-decision',version:'1'},infer:async input=>{
      await Promise.resolve();
      if(mode==='reject') throw new Error('explicit decision failure');
      if(mode==='cancel') abort.abort();
      return {kind:'ranked',pathRefs:mode==='invalid'?['outside']:input.candidates.map(c=>c.pathId)};
    }};
    const response=await runRecursiveGoal(resources.request,resources.dependencies);
    assert.equal(response.kind,'run_result');
    assert.equal(response.report.atomicResults.length,0);
    assert.notEqual(response.report.control.outcome,'completed');
  }
});

test('a failed action without fresh observation cannot replan mutations from old state',async()=>{
  const resources=createBoundedFiniteResources({scenario:'no-fresh-failure',actualBranch:'approve',expectedBranch:'approve',failSelected:true,changedPremise:true,maxPredictionCalls:96});
  const execute=resources.dependencies.adapter.executeAtomic;
  let failed=false;
  let callsAfterFailure=0;
  resources.dependencies.adapter.executeAtomic=async input=>{
    if(failed) callsAfterFailure+=1;
    const receipt=await execute(input);
    if(receipt.outcome==='failed') {
      failed=true;
      return {...receipt,newState:null,evidence:[]};
    }
    return receipt;
  };
  const results=await drain(resources);
  assert.equal(failed,true);
  assert.equal(callsAfterFailure,0);
  const final=results.at(-1);
  assert.equal(final.report.control.outcome,'error');
  assert.ok(final.report.errors.some(error=>error.code==='execution_failed'));
  assert.ok(!results.some(result=>result.report.planning?.decision?.kind==='replan'),
    'without a fresh observation the original execution failure is terminal');
});

test('prediction candidates exclude skills outside the current effect scope',async()=>{
  const resources=twoLegalChoices();
  resources.dependencies.enabledSkills=resources.dependencies.enabledSkills.map(skill=>
    skill.id==='bounded.approve'?{...skill,effectClass:'mutating',allowedEffects:['forbidden.write'],requiredEffects:['forbidden.write']}:skill);
  const results=await drain(resources);
  const final=results.at(-1);
  assert.equal(final.report.control.outcome,'completed',JSON.stringify(final));
  assert.equal(final.report.atomicResults[0].skillId,'bounded.reject');
});

test('continuation cannot change a checkpoint specification under the same ID',async()=>{
  const resources=createBoundedFiniteResources({scenario:'checkpoint-contract'});
  resources.request.planning.checkpointSpecs=[{id:'fixed-checkpoint',goal:resources.request.rootGoal,bindings:resources.request.rootBindings,satisfactionThreshold:100,evaluatorId:resources.request.rootEvaluatorId,evidenceRequirementRefs:[],obligations:[],rollingRule:'next_segment'}];
  const first=await runRecursiveGoal(resources.request,resources.dependencies);
  assert.equal(first.report.control.outcome,'yielded');
  for(const field of ['satisfactionThreshold','bindings','obligations']) {
    const request=structuredClone(resources.request);
    {
      const spec=request.planning.checkpointSpecs[0];
      if(field==='satisfactionThreshold') spec.satisfactionThreshold=0;
      if(field==='bindings') spec.bindings={...spec.bindings,scenario:'changed'};
      if(field==='obligations') spec.obligations=[{rootRef:first.report.continuation.acceptedRoot.rootFrameId,frameRef:first.report.continuation.acceptedRoot.rootFrameId,conditionRef:null}];
    }
    const response=await runRecursiveGoal({...request,continuation:first.report.continuation},resources.dependencies);
    assert.notEqual(response.kind,'run_result');
  }
});

test('planning honors the safe retry same-failure gate and explicit stop',async()=>{
  for(const stop of [false,true]) {
    const resources=twoLegalChoices();
    resources.dependencies.enabledSkills=resources.dependencies.enabledSkills.map(skill=>({...skill,retry:'completed_no_effect'}));
    resources.request.retryPolicy={kind:'bounded_strategy_retry.v1',selectorId:resources.request.rootSelectorId,strategySkillIds:resources.dependencies.enabledSkills.map(skill=>skill.id),sameFailureLimit:1,maxAtomicAttempts:6};
    const validate=resources.dependencies.adapter.validateRequest;
    resources.dependencies.adapter.validateRequest=async request=>({...await validate(request),retryPolicy:request.retryPolicy});
    const execute=resources.dependencies.adapter.executeAtomic;
    resources.dependencies.adapter.executeAtomic=async input=>{
      const receipt=await execute(input);
      // Synthetic safe no-effect attempt, with a real fixture revision and evidence.
      return {...receipt,outcome:'succeeded',executionErrors:[],verificationErrors:[]};
    };
    let assessments=0;
    resources.dependencies.adapter.assessRetry=async input=>{
      assessments+=1;
      return stop?{kind:'stop',reason:'not_same_failure'}:{kind:'safe_same_failure',failureKey:'still-unmet',evidenceRefs:input.evaluation.evidenceRefs};
    };
    resources.dependencies.adapter.evaluate=async input=>({evaluatorId:resources.request.rootEvaluatorId,result:'unsatisfied',satisfaction:0,necessaryConditionsMet:false,evidenceRefs:input.evidence.filter(item=>item.validity==='valid' && item.payload.revision===input.state.revision).map(item=>item.id)});
    const results=await drain(resources);
    const final=results.at(-1);
    assert.equal(final.kind,'run_result',JSON.stringify(final));
    assert.equal(final.report.atomicResults.length,stop?1:2,JSON.stringify(final));
    assert.equal(assessments,stop?1:2,JSON.stringify(final));
    assert.notEqual(final.report.control.outcome,'completed');
  }
});

test('a matching predicted result cannot bypass a stale next-entry condition',async()=>{
  for(const withAssessor of [true,false]) {
    const resources=createBoundedFiniteResources({scenario:'stale-entry',actualBranch:'approve',expectedBranch:'approve',includeInitialAlternatives:true});
    const first=await runRecursiveGoal(resources.request,resources.dependencies);
    assert.equal(first.report.control.outcome,'yielded');
    const continuation=structuredClone(first.report.continuation);
    const plan=continuation.planControl.plan;
    const next=plan.nodes.find(node=>node.skillRef.id==='bounded.approve' && plan.edges.some(edge=>edge.target.kind==='node' && edge.target.targetRef===node.id));
    assert.ok(next);
    const condition={kind:'typed_condition.v1',conditionRef:{id:'test.entry-premise',version:'1'},goal:resources.request.rootGoal,bindings:resources.request.rootBindings,stateProjection:continuation.states[0].value,evidenceProjection:[]};
    next.preconditions=[condition];
    const incoming=plan.edges.find(edge=>edge.target.kind==='node' && edge.target.targetRef===next.id);
    incoming.conditions=[condition];
    const affected=plan.paths.find(path=>path.nodeRefs.includes(next.id));
    affected.invalidation=[condition];
    let typedChecks=0;
    if(withAssessor) resources.dependencies.planning.assessEntry=input=>{
      if(input.node.preconditions.length || input.edge?.conditions.length || input.path.invalidation.length) typedChecks+=1;
      return {kind:input.node.skillRef.id==='bounded.approve'?'inapplicable':'applicable',reason:'current premise rejects approve',evidenceRefs:[]};
    };
    const response=await runRecursiveGoal({...resources.request,continuation},resources.dependencies);
    assert.equal(response.kind,'run_result');
    assert.ok(response.report.atomicResults.every(result=>result.skillId!=='bounded.approve'));
    if(withAssessor) assert.ok(typedChecks>0);
    else assert.ok(response.report.errors.some(error=>error.code==='adapter_contract_invalid'));
  }
});

test('multi-step cursor stays consistent with retry locks and exhausted strategies',async()=>{
  for(const exhausted of [false,true]) {
    const resources=twoLegalChoices();
    resources.dependencies.planning.decision={ref:{id:'test.multistep-order',version:'1'},infer:async input=>({kind:'ranked',pathRefs:[...input.candidates].sort((left,right)=>Number(right.attemptOrder[0].skillRef.id==='bounded.approve')-Number(left.attemptOrder[0].skillRef.id==='bounded.approve')).map(path=>path.pathId)})};
    resources.dependencies.planning.matchesActual=()=>({kind:'applicable',reason:'fixture observation matches this declared branch',evidenceRefs:[]});
    const validate=resources.dependencies.adapter.validateRequest;
    resources.request.retryPolicy={kind:'bounded_strategy_retry.v1',selectorId:resources.request.rootSelectorId,strategySkillIds:resources.dependencies.enabledSkills.map(skill=>skill.id),sameFailureLimit:exhausted?1:2,maxAtomicAttempts:5};
    resources.dependencies.adapter.validateRequest=async request=>({...await validate(request),retryPolicy:request.retryPolicy});
    resources.dependencies.enabledSkills=resources.dependencies.enabledSkills.map(skill=>({...skill,retry:'completed_no_effect'}));
    const execute=resources.dependencies.adapter.executeAtomic;
    resources.dependencies.adapter.executeAtomic=async input=>{
      const receipt=await execute(input);
      return {...receipt,outcome:'succeeded',executionErrors:[],verificationErrors:[],newState:{...receipt.newState,value:{...receipt.newState.value,selectedBranch:input.skill.id}}};
    };
    resources.dependencies.adapter.assessRetry=async input=>({kind:'safe_same_failure',failureKey:'unmet',evidenceRefs:input.evaluation.evidenceRefs});
    resources.dependencies.adapter.evaluate=async input=>({evaluatorId:resources.request.rootEvaluatorId,result:input.state.selectedBranch==='bounded.reject'?'satisfied':'unsatisfied',satisfaction:input.state.selectedBranch==='bounded.reject'?100:0,necessaryConditionsMet:input.state.selectedBranch==='bounded.reject',evidenceRefs:input.evidence.filter(item=>item.validity==='valid' && item.payload.revision===input.state.revision).map(item=>item.id)});
    const model=resources.dependencies.planning.resultModels[0];
    const predict=model.predict;
    model.predict=input=>{
      const output=predict(input);
      if(input.skillRef.id==='bounded.approve' && input.stateProjection.revision===0) {
        const transition=output.transitions[0];
        transition.continuation={kind:'continued',nextSkillRefs:[{id:exhausted?'bounded.approve':'bounded.reject',version:'1.0.0'}]};
        transition.predictedState.projection.state={...transition.predictedState.projection.state,revision:1,finished:false};
      }
      return output;
    };
    const results=await drain(resources);
    const final=results.at(-1);
    assert.equal(final.report.control.outcome,'completed',JSON.stringify(final));
    assert.deepEqual(final.report.atomicResults.map(result=>result.skillId),exhausted?['bounded.approve','bounded.reject']:['bounded.approve','bounded.approve','bounded.reject']);
    assert.ok(!final.report.errors.some(error=>error.code==='policy_error'));
  }
});
