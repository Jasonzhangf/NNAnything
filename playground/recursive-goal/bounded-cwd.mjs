import {pathToFileURL} from 'node:url';
import {runCwdScenarios} from './cwd.mjs';
import {BOUNDED_CWD_SKILLS,BOUNDED_CWD_OBSERVE_SKILL,BOUNDED_CWD_EQUALS_SKILL,BOUNDED_CWD_PLANNING_GUARDS} from './cwd-adapter.mjs';

const capabilityRef={id:'cwd.bounded-results',version:'1'};
const modelRef={id:'cwd.registered-transition',version:'1'};
const scoreRef={id:'cwd.expected-satisfaction',version:'1'};
const skillRef=id=>({id,version:'1.0.0'});

export function createCwdPlanning(bindings) {
  let calls=0;
  const capability={
    contract:capabilityRef,guards:BOUNDED_CWD_PLANNING_GUARDS,
    resultModels:[{ref:modelRef,skillRefs:BOUNDED_CWD_SKILLS.map(skill=>skillRef(skill.id)),predict(input){
      calls++;
      const state=input.stateProjection;
      const observe=input.skillRef.id===BOUNDED_CWD_OBSERVE_SKILL;
      const observed=state.cli.cwdObservation!==null || state.stateId==='predicted:after-pwd';
      const permitted=observe ? !observed : observed && state.session.cwd!==bindings.targetPhysical;
      const targetReached=observe ? state.session.cwd===bindings.targetPhysical : true;
      const predicted={...state,stateId:observe?'predicted:after-pwd':'predicted:after-cd',session:observe ? state.session : {...state.session,cwd:bindings.targetPhysical,revision:state.session.revision+1}};
      return {kind:'ready',transitions:[{
        resultRef:observe ? `cwd:observed:${state.session.cwd}` : 'cwd:target',
        preferenceOrder:observe?1:2,semanticProgress:'progressed',
        predictedState:{kind:'predicted',projection:{state:predicted,evidence:[]},assumptions:['the registered command returns a fresh physical cwd observation'],unknown:[],source:{modelRef,predictionCallRef:`cwd-predict:${calls}`}},
        predictedEffects:[],applicability:{kind:permitted?'applicable':'inapplicable',reason:'explicit observation prerequisite',evidenceRefs:[]},coverage:'covered',unknown:[],preconditions:[],
        continuation:targetReached ? {kind:'terminal',terminalKind:'root_satisfied',checkpointRef:null} : {kind:'continued',nextSkillRefs:[skillRef(BOUNDED_CWD_EQUALS_SKILL)]},
        projection:{terminalSatisfaction:100,riskLevels:[],cost:{amount:1,unit:'command'}},
      }]};
    }}],
    matchesActual({predicted,actualState,actualOutcome}) {
      const cwd=actualState.cli.cwdObservation;
      const expected=predicted.resultRef==='cwd:target' ? bindings.targetPhysical : predicted.resultRef.slice('cwd:observed:'.length);
      return {kind:actualOutcome==='unknown' ? 'unknown' : cwd!==null && cwd.physicalCwd===expected && cwd.revision===actualState.session.revision ? 'applicable':'inapplicable',reason:'physical cwd in the real command receipt',evidenceRefs:[]};
    },
    assessPrior({prior,actualState}) {
      const same=prior.scope.bindings.session.sessionId===bindings.session.sessionId && prior.scope.stateProjection.session.revision===actualState.session.revision;
      return {kind:same?'applicable':'inapplicable',reason:'same bound session and observed revision',evidenceRefs:[]};
    },
  };
  return {
    capability,predictionCalls:()=>calls,
    planning:{kind:'bounded_goal_planning.v1',capabilityRef,horizonN:3,resultModelRefs:[modelRef],preference:{kind:'order_first',projectionScaleRef:scoreRef},checkpointSpecs:[],limits:{maxPlanNodes:12,maxPredictionCalls:12,maxReplans:2,maxRollbacks:1}},
  };
}

export function runBoundedCwdScenarios({profilePath,fixtureParent}) {
  return runCwdScenarios({profilePath,fixtureParent,bounded:createCwdPlanning});
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const result=await runBoundedCwdScenarios({profilePath:process.env.NN_CLI_COMMAND_PROFILE});
  console.log(JSON.stringify(result,null,2));
  if(result.status!=='PASS') process.exitCode=1;
}
