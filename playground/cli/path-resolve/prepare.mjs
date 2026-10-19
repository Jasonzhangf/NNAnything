import { writeFile } from 'node:fs/promises';
import { makePathFixture, preparePathDataset } from 'nnanything/cli-training';

const args=process.argv.slice(2);
if(args.length!==0 && !(args.length===2&&args[0]==='--output')) throw new Error('Usage: prepare.mjs [--output NEW_FILE]');
const fixture=makePathFixture();
const prepared=preparePathDataset(fixture);
const text=JSON.stringify(fixture,null,2)+'\n';
if(args.length){
  await writeFile(args[1],text,{flag:'wx'});
  console.log(JSON.stringify({samplesFile:args[1],train:prepared.train.length,development:prepared.development.length,holdout:prepared.holdout.length,trainSteps:prepared.rows.length}));
}else process.stdout.write(text);
