import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runBrowserSearchGoal} from 'nnanything/browser-search';
const args=new Map();
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--request','--io'].includes(key)||!value||args.has(key))throw Error('Use --request FILE --io MODULE');args.set(key,value);}
if(!args.has('--request')||!args.has('--io'))throw Error('Explicit --request FILE and --io MODULE required');
const request=JSON.parse(await readFile(resolve(args.get('--request')),'utf8'));
const io=await import(pathToFileURL(resolve(args.get('--io'))).href);
const resources=typeof io.createResources==='function'?await io.createResources(request):io.resources;
if(!resources)throw Error('IO module must export resources or createResources(request)');
const response=await runBrowserSearchGoal(request,resources);
console.log(JSON.stringify(response,null,2));
if(response.kind!=='run_result'||response.report.rootEvaluation.result!=='satisfied'||response.report.control.outcome!=='completed')process.exitCode=1;
