import {readFile} from 'node:fs/promises';
import {createPathResolver,preparePathDataset,evaluatePathSamples,validatePathProfile} from 'nnanything/cli-training';

if(process.argv.length!==4)throw new Error('Usage: reload.mjs PROFILE_FILE SAMPLES_FILE');
const profile=validatePathProfile(JSON.parse(await readFile(process.argv[2],'utf8')));
const prepared=preparePathDataset(JSON.parse(await readFile(process.argv[3],'utf8')));
const evaluation=await evaluatePathSamples(prepared.dataset.samples,profile,createPathResolver({profile}).resolve);
process.stdout.write(JSON.stringify(evaluation));
