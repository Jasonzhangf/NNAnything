import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  readBrowserInputPolicyProfile,
  readBrowserQueryRelationProfile,
  readBrowserStepPolicyProfile,
  runBrowserSearchGoal,
} from 'nnanything/browser-search';

async function loadDecisionFromDirectory(dirPath) {
  const resolvedDir = resolve(dirPath);
  const readJson = async (fileName) => {
    const fullPath = join(resolvedDir, fileName);
    let rawText;
    try {
      rawText = await readFile(fullPath, 'utf8');
    } catch (error) {
      throw new TypeError(`Failed to read candidate profile ${fullPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      return JSON.parse(rawText);
    } catch (error) {
      throw new TypeError(`Invalid JSON in candidate profile ${fullPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const inputPolicyProfile = readBrowserInputPolicyProfile(await readJson('input-policy.json'));
  const queryRelationProfile = readBrowserQueryRelationProfile(await readJson('query-relation.json'));
  const stepPolicyProfile = readBrowserStepPolicyProfile(await readJson('step-policy.json'));
  return {
    id: 'browser.search.model.v1',
    source: 'model',
    inputPolicyProfile,
    queryRelationProfile,
    stepPolicyProfile,
    select: () => {
      throw new Error('model decision binding must use modelProfiles and never fall back to decision.select');
    },
  };
}

const args=new Map();
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--request','--io','--decision-profile'].includes(key)||!value||args.has(key))throw Error('Use --request FILE --io MODULE [--decision-profile DIR]');args.set(key,value);}
if(!args.has('--request')||!args.has('--io'))throw Error('Explicit --request FILE and --io MODULE required');
const decisionProfileDir=args.get('--decision-profile')??process.env.BSEARCH_DECISION_PROFILE_DIR??'';
const modelDecision=decisionProfileDir?await loadDecisionFromDirectory(decisionProfileDir):null;
const request=JSON.parse(await readFile(resolve(args.get('--request')),'utf8'));
const io=await import(pathToFileURL(resolve(args.get('--io'))).href);
const baseResources=typeof io.createResources==='function'?await io.createResources(request):io.resources;
if(!baseResources)throw Error('IO module must export resources or createResources(request)');
const resources=modelDecision
  ? {
      ...baseResources,
      decision: modelDecision,
    }
  : baseResources;
let response;
let sideEffects=null;
let closeErrors=[];
try{
  response=await runBrowserSearchGoal(request,resources);
}finally{
  if(typeof io.close==='function'){
    const closed=await io.close();
    sideEffects=closed?.sideEffects??null;
    closeErrors=closed?.closeErrors??[];
  }
}
console.log(JSON.stringify({response,sideEffects,closeErrors},null,2));
const success=response?.kind==='run_result'&&response.report.rootEvaluation.result==='satisfied'&&response.report.control.outcome==='completed';
if(!success||closeErrors.length>0)process.exitCode=1;
