import assert from 'node:assert/strict';
import {test} from 'node:test';
import {emptyPlanControl, expandGoalGraph} from '../dist/workflow/recursive-goal/planning.js';

const ref = id => ({id, version: '1'});
const skills = ['first', 'second'].map(id => ({id, version:'1', mode:'atomic', effectClass:'none', allowedEffects:[]}));
const modelRef = ref('finite-transition');
function transition(id, state, next, score, cost, order = 1) {
  return {
    resultRef:id, preferenceOrder:order,
    predictedState:{kind:'predicted', projection:{state,evidence:[]}, assumptions:[],unknown:[],source:{modelRef,predictionCallRef:id}},
    predictedEffects:[], applicability:{kind:'applicable',reason:'fixture premise',evidenceRefs:[]},
    coverage:'covered', semanticProgress:'progressed',
    continuation:next ? {kind:'continued',nextSkillRefs:[ref(next)]} : {kind:'terminal',terminalKind:'root_satisfied',checkpointRef:null},
    projection:{terminalSatisfaction:score,riskLevels:[{scaleRef:ref('risk'),level:'low',ordinal:0}],cost:{amount:cost,unit:'step'}},
    unknown:[],preconditions:[],
  };
}
function input(predict, options = {}) {
  return {
    planId:'plan',rootRef:'root',frameRef:'root',goal:{kind:'goal'},bindings:{},state:{stage:0},stateRef:'actual:0',evidence:[],
    skills,rootSatisfied:false,control:emptyPlanControl(),consumePrediction:()=>true,
    options:{kind:'bounded_goal_planning.v1',capabilityRef:ref('cap'),horizonN:3,resultModelRefs:[modelRef],preference:{kind:'order_first',projectionScaleRef:ref('score')},checkpointSpecs:[],limits:{maxPlanNodes:20,maxPredictionCalls:20,maxReplans:3,maxRollbacks:2},...options},
    capability:{contract:ref('cap'),resultModels:[{ref:modelRef,skillRefs:skills.map(s=>ref(s.id)),predict}],assessPrior:()=>({kind:'inapplicable',reason:'no prior',evidenceRefs:[]})},
  };
}

test('a predicted terminal ends its own path while other alternatives are still expanded', async () => {
  const calls=[];
  const result=await expandGoalGraph(input(({skillRef})=>{
    calls.push(skillRef.id);
    return {kind:'ready',transitions:[transition(skillRef.id,{done:true},null,100,1,skillRef.id==='first'?1:2)]};
  }));
  assert.deepEqual(calls,['first','second']);
  assert.equal(result.plan.paths.length,2);
  assert.equal(result.prediction.kind,'ready');
  assert.deepEqual(result.ranking.pathRefs,['plan-path:0','plan-path:1']);
});

test('path score uses its terminal result, cost accumulates, and known risk is not unknown', async () => {
  const data=input(({skillRef,stateProjection})=>({kind:'ready',transitions:[
    skillRef.id==='first' && stateProjection.stage===0
      ? transition('advance',{stage:1},'second',null,2,1)
      : transition('finish',{stage:2},null,95,3,skillRef.id==='first'?1:2),
  ]}));
  data.skills=[skills[0]];
  // Second is enabled for successors; the first root result model describes a
  // single entry by marking the other root result inapplicable.
  data.skills=skills;
  const original=data.capability.resultModels[0].predict;
  data.capability.resultModels[0].predict=arg=>{
    const output=original(arg);
    if(arg.skillRef.id==='second' && arg.stateProjection.stage===0) {
      output.transitions[0].applicability={kind:'inapplicable',reason:'requires stage 1',evidenceRefs:[]};
    }
    return output;
  };
  const result=await expandGoalGraph(data);
  assert.equal(result.prediction.kind,'ready');
  const path=result.plan.paths[0];
  assert.equal(path.projection.terminalSatisfaction,95);
  assert.equal(path.projection.maximumCost,5);
  assert.deepEqual(path.projection.unknownRefs,[]);
});

test('non-progressing transitions consume model budget without satisfying horizon N', async () => {
  const data=input(()=>({kind:'ready',transitions:[{
    ...transition('repeat',{stage:0},'first',null,1),semanticProgress:'no_progress',
  }]}),{horizonN:2,limits:{maxPlanNodes:3,maxPredictionCalls:3,maxReplans:1,maxRollbacks:1}});
  data.skills=[skills[0]];
  const result=await expandGoalGraph(data);
  assert.notEqual(result.prediction.kind,'ready');
  assert.equal(result.plan.paths.length,0);
  assert.ok(result.plan.nodes.every(node=>node.semanticDepth===0));
  assert.ok(result.usage.predictionCallsUsed<=3);
});

test('a viable horizon prefix can run before the root is reachable, with an explicit truncated frontier', async()=>{
  const data=input(({stateProjection})=>({kind:'ready',transitions:[transition('advance',{stage:stateProjection.stage+1},'first',null,1)]}),{horizonN:2});
  data.skills=[skills[0]];
  const result=await expandGoalGraph(data);
  assert.equal(result.prediction.kind,'ready');
  assert.equal(result.plan.paths[0].nodeRefs.length,2);
  assert.equal(result.plan.paths[0].termination.terminalKind,'horizon');
  assert.equal(result.plan.frontier[0].coverage,'truncated');
  assert.equal(result.plan.paths[0].projection.terminalSatisfaction,null);
});
