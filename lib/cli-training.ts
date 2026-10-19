import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { createWorkflowInputEvent } from "./core/events.js";
import { compileWorkflow } from "./workflow/compiler.js";
import { loadWorkflow } from "./workflow/loader.js";
import { runWorkflow } from "./workflow/runner.js";
import type { CompiledWorkflow } from "./core/contracts.js";
import { validatePathProfile, type PathProfile, type PathRequest, type PathRollout } from "./filters/cli-path-controller.js";
import { createPathResolveNode, createPathTrainingNodes, readPathRollout,
  type PathTrainingDiagnostics, type PathTrainingReceipt, type PathTrainingRequest, type PathTrainingResources } from "./nodes/cli-path-training.js";

export * from "./filters/cli-path-controller.js";
export * from "./training/cli-path-numeric.js";
export * from "./training/cli-path-samples.js";
export {createPathResolveNode,createPathTrainingNodes} from "./nodes/cli-path-training.js";
export type {PathTrainingReceipt,PathTrainingRequest,PathTrainingResources} from "./nodes/cli-path-training.js";

const configPath=(name:string)=>fileURLToPath(new URL(`../workflows/${name}.workflow.json`,import.meta.url));
const allowedRoot=fileURLToPath(new URL("../workflows/",import.meta.url));

export function createPathResolver({profile}:{profile:PathProfile}):{resolve(request:PathRequest):Promise<PathRollout>} {
  const candidate=validatePathProfile(profile);
  let compiled:Promise<CompiledWorkflow>|undefined;
  const getCompiled=()=>compiled??=loadWorkflow({configPath:configPath("cli-path-resolve"),allowedRoot})
    .then(definition=>compileWorkflow(definition,{nodeDefinitions:[createPathResolveNode()],profiles:{"path-controller":candidate}}));
  return Object.freeze({async resolve(request:PathRequest):Promise<PathRollout>{
    const runId=randomUUID();
    const result=await runWorkflow(await getCompiled(),createWorkflowInputEvent({runId,eventId:`${runId}:input`,port:"path_request",type:"cli.path.request.v1",payload:request}));
    if(result.status==="failed")return {ok:false,code:result.error.category,message:result.error.message,trace:[]};
    return readPathRollout(result.outputEvent.payload);
  }});
}

export async function runPathTraining(request:PathTrainingRequest,resources:PathTrainingResources):Promise<PathTrainingReceipt>{
  if(!resources||typeof resources.handwiredRoot!=="string"||!resources.handwiredRoot.length||!isAbsolute(resources.outputRoot)||!Array.isArray(resources.grantedEffects))throw new TypeError("Explicit backend, absolute outputRoot and grantedEffects are required");
  const diagnostics:PathTrainingDiagnostics={partialPaths:{}};
  const definitions=createPathTrainingNodes(resources,profile=>createPathResolver({profile}).resolve,diagnostics);
  const definition=await loadWorkflow({configPath:configPath("cli-path-training"),allowedRoot});
  const compiled=compileWorkflow(definition,{nodeDefinitions:definitions,grantedEffects:[...resources.grantedEffects]});
  const runId=randomUUID();
  const result=await runWorkflow(compiled,createWorkflowInputEvent({runId,eventId:`${runId}:input`,port:"path_training_request",type:"cli.path.training-request.v1",payload:request}));
  if(result.status==="failed")throw Object.assign(new Error(result.error.message),{category:result.error.category,nodeId:result.error.nodeId,partialReceipt:diagnostics.partialPaths,timing:diagnostics.fitTiming});
  return result.outputEvent.payload as PathTrainingReceipt;
}
