import { mkdir, lstat, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { NodeDefinition } from "../core/contracts.js";
import { expectNonEmptyString, expectRecord } from "../core/schema.js";
import { PATH_ACTIONS, rolloutPath, validatePathProfile, validatePathRequest, zeroPathProfile,
  type PathProfile, type PathRequest, type PathRollout } from "../filters/cli-path-controller.js";
import { fitPathController } from "../training/cli-path-numeric.js";
import { evaluatePathSamples, preparePathDataset, type PathDataset, type PathEvaluation, type PreparedPathDataset } from "../training/cli-path-samples.js";

export interface PathTrainingRequest { readonly dataset: PathDataset; readonly epochs: number; readonly learningRate: number }
export interface PathTrainingResources { readonly handwiredRoot: string; readonly outputRoot: string; readonly grantedEffects: readonly string[] }
type FitResult = Awaited<ReturnType<typeof fitPathController>>;
interface Prepared { prepared: PreparedPathDataset; initial: PathProfile; epochs: number; learningRate: number }
interface Candidate extends Prepared { fit: FitResult }
export interface PartitionComparison { baseline: PathEvaluation; trained: PathEvaluation; fixed: number; regressed: number; retained: number; unresolved: number }
interface Evaluated extends Candidate { comparison: Record<"train" | "development" | "holdout", PartitionComparison>; frozen: FitResult }
export interface PathTrainingReceipt {
  readonly runId: string;
  readonly paths: { samples: string; profile: string; report: string };
  readonly accepted: boolean;
  readonly comparison: Evaluated["comparison"];
  readonly timing: FitResult["timing"];
  readonly workflowMs: number;
}
export interface PathTrainingDiagnostics { partialPaths: Partial<PathTrainingReceipt["paths"]>; fitTiming?: unknown }

const port = (name: string, eventType: string, validate: (value: unknown) => unknown) => ({ name, schemaId: eventType, eventType, validate });
export function readPathRollout(value: unknown): PathRollout {
  const result = expectRecord(value, "path rollout");
  if (typeof result.ok !== "boolean" || !Array.isArray(result.trace)) throw new TypeError("Invalid path rollout");
  if (result.ok) {
    if (!expectNonEmptyString(result.absolute, "absolute").startsWith("/")) throw new TypeError("Expected absolute output");
  } else {
    expectNonEmptyString(result.code, "code"); expectNonEmptyString(result.message, "message");
  }
  for (const raw of result.trace) {
    const step = expectRecord(raw, "path step");
    if (!PATH_ACTIONS.includes(step.action as never) || !Array.isArray(step.features) || !Array.isArray(step.scores) || !Array.isArray(step.before) || !Array.isArray(step.after)) throw new TypeError("Invalid path trace");
  }
  return value as PathRollout;
}

export function createPathResolveNode(): NodeDefinition {
  return {
    operator: "cli.path.resolve", version: "0.1.0",
    inputPorts: [port("path_request", "cli.path.request.v1", validatePathRequest)],
    outputPort: port("path_result", "cli.path.result.v1", readPathRollout),
    config: { required: true, validate(value) { const config=expectRecord(value,"path config"); if(Object.keys(config).length)throw new TypeError("Path config must be empty"); return {}; } },
    profileValidator: validatePathProfile, effects: [],
    execute: context => context.emit(rolloutPath(validatePathRequest(context.inputs[0]!.payload), validatePathProfile(context.profile))),
  };
}

export function readPathTrainingRequest(value: unknown): PathTrainingRequest {
  const request = expectRecord(value, "path training request");
  if (Object.keys(request).some(key=>!["dataset","epochs","learningRate"].includes(key))) throw new TypeError("Unknown path training request field");
  if (!Number.isInteger(request.epochs) || (request.epochs as number)<0) throw new TypeError("epochs must be a nonnegative integer");
  if (typeof request.learningRate!=="number" || !Number.isFinite(request.learningRate) || request.learningRate<=0) throw new TypeError("learningRate must be positive finite");
  return {dataset:preparePathDataset(request.dataset).dataset,epochs:request.epochs as number,learningRate:request.learningRate};
}

function readPrepared(value: unknown): Prepared {
  const stage=expectRecord(value,"prepared stage"), prepared=expectRecord(stage.prepared,"prepared");
  if (!Array.isArray(prepared.rows) || !Array.isArray(prepared.train) || !Array.isArray(prepared.development) || !Array.isArray(prepared.holdout)) throw new TypeError("Invalid prepared partitions");
  validatePathProfile(stage.initial);
  return value as Prepared;
}
function readCandidate(value: unknown): Candidate {
  readPrepared(value); const stage=expectRecord(value,"candidate"), fit=expectRecord(stage.fit,"fit");
  validatePathProfile(fit.profile); expectRecord(fit.timing,"fit timing");
  return value as Candidate;
}
function readEvaluated(value: unknown): Evaluated {
  readCandidate(value); const comparison=expectRecord(expectRecord(value,"evaluation").comparison,"comparison");
  for (const partition of ["train","development","holdout"]) expectRecord(comparison[partition],partition);
  return value as Evaluated;
}

async function ownedDirectory(root: string, segments: readonly string[]): Promise<string> {
  let current=root;
  for(const segment of segments){
    if(!segment||segment!==basename(segment)||segment==="."||segment===".."||segment.includes("\0"))throw new TypeError("Invalid artifact path segment");
    current=join(current,segment);
    try { await mkdir(current); } catch(error){if(!(error instanceof Error&&"code"in error&&error.code==="EEXIST"))throw error;}
    const attributes=await lstat(current);
    if(attributes.isSymbolicLink()||!attributes.isDirectory())throw new TypeError("Artifact parent must be an owned directory, not a link");
  }
  return current;
}

export function createPathTrainingNodes(
  resources: PathTrainingResources,
  resolveWithProfile: (profile: PathProfile) => (request: PathRequest) => Promise<PathRollout>,
  diagnostics: PathTrainingDiagnostics,
): readonly NodeDefinition[] {
  const preparedPort=port("path_prepared","cli.path.prepared.v1",readPrepared);
  const candidatePort=port("path_candidate","cli.path.candidate.v1",readCandidate);
  const evaluatedPort=port("path_evaluation","cli.path.evaluation.v1",readEvaluated);
  const started=performance.now();
  return [
    {operator:"cli.path.prepare",version:"0.1.0",inputPorts:[port("path_training_request","cli.path.training-request.v1",readPathTrainingRequest)],outputPort:preparedPort,effects:[],
      execute(context){const request=readPathTrainingRequest(context.inputs[0]!.payload);return context.emit({prepared:preparePathDataset(request.dataset),initial:zeroPathProfile(),epochs:request.epochs,learningRate:request.learningRate});}},
    {operator:"cli.path.fit",version:"0.1.0",inputPorts:[preparedPort],outputPort:candidatePort,effects:["filesystem.read"],
      async execute(context){const value=readPrepared(context.inputs[0]!.payload);try{
        const fit=await fitPathController({rows:value.prepared.rows,initial:value.initial,handwiredRoot:resources.handwiredRoot,epochs:value.epochs,learningRate:value.learningRate});
        diagnostics.fitTiming=fit.timing;return context.emit({...value,fit});
      }catch(error){if(error instanceof Error&&"timing"in error)diagnostics.fitTiming=error.timing;throw error;}}},
    {operator:"cli.path.evaluate",version:"0.1.0",inputPorts:[candidatePort],outputPort:evaluatedPort,effects:[],
      async execute(context){const value=readCandidate(context.inputs[0]!.payload);
        const frozen=await fitPathController({rows:value.prepared.rows,initial:value.initial,handwiredRoot:resources.handwiredRoot,epochs:0,learningRate:value.learningRate});
        if(JSON.stringify(frozen.profile.weights)!==JSON.stringify(value.initial.weights))throw new Error("Frozen control changed weights");
        const baselineResolver=resolveWithProfile(value.initial),trainedResolver=resolveWithProfile(value.fit.profile);
        const comparison={} as Evaluated["comparison"];
        for(const partition of ["train","development","holdout"] as const){
          const samples=value.prepared[partition];
          const baseline=await evaluatePathSamples(samples,value.initial,baselineResolver);
          const trained=await evaluatePathSamples(samples,value.fit.profile,trainedResolver);
          let fixed=0,regressed=0,retained=0,unresolved=0;
          for(let i=0;i<samples.length;i++){
            const b=baseline.rows[i]!,t=trained.rows[i]!;
            const oldOk=b.rollout.ok&&b.rollout.absolute===b.expected,newOk=t.rollout.ok&&t.rollout.absolute===t.expected;
            if(!oldOk&&newOk)fixed++;else if(oldOk&&!newOk)regressed++;else if(oldOk&&newOk)retained++;else unresolved++;
          }
          comparison[partition]={baseline,trained,fixed,regressed,retained,unresolved};
        }
        return context.emit({...value,comparison,frozen});}},
    {operator:"cli.path.save",version:"0.1.0",inputPorts:[evaluatedPort],outputPort:port("path_training_receipt","cli.path.training-receipt.v1",value=>{
      const receipt=expectRecord(value,"training receipt");expectNonEmptyString(receipt.runId,"runId");expectRecord(receipt.paths,"paths");if(typeof receipt.accepted!=="boolean")throw new TypeError("Invalid receipt");return value;
    }),effects:["filesystem.write"],
      async execute(context){const value=readEvaluated(context.inputs[0]!.payload);
        if(!isAbsolute(resources.outputRoot))throw new TypeError("outputRoot must be absolute");
        const root=await realpath(resources.outputRoot);
        const samplesDir=await ownedDirectory(root,["samples","path-resolve",context.runId]);
        const weightsDir=await ownedDirectory(root,["weights","path-resolve",context.runId]);
        const resultsDir=await ownedDirectory(root,["results","path-resolve",context.runId]);
        const paths={samples:join(samplesDir,"samples.json"),profile:join(weightsDir,"candidate.json"),report:join(resultsDir,"report.json")};
        const accepted=Object.values(value.comparison).every(part=>part.trained.exactPaths===part.trained.sampleCount&&part.trained.correctTeacherSteps===part.trained.teacherStepCount);
        const save=async(key:keyof typeof paths,data:unknown)=>{await writeFile(paths[key],JSON.stringify(data,null,2)+"\n",{flag:"wx"});diagnostics.partialPaths[key]=paths[key];};
        await save("samples",value.prepared.dataset);await save("profile",value.fit.profile);
        const receipt:PathTrainingReceipt={runId:context.runId,paths,accepted,comparison:value.comparison,timing:value.fit.timing,workflowMs:performance.now()-started};
        await save("report",{...receipt,initial:value.initial,candidate:value.fit.profile,trajectory:value.fit.trajectory,frozen:{timing:value.frozen.timing,parametersUnchanged:true,metricsReusedFrom:"baseline"},limits:["lexical POSIX only","synthetic finite coverage","uncalibrated","not_applied"]});
        return context.emit({...receipt,workflowMs:performance.now()-started});}},
  ];
}
