import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as browser from 'nnanything/browser-classify';
import {prepareBasicKindSamples,readBasicKindTrainingRequest,toBasicKindFitRows} from 'nnanything/training';
const box={x:0,y:0,width:100,height:30};
const nodes=['div','span','span','a'].map((tag,i)=>({nodeRef:`n${i}`,parentRef:i?`n${i-1}`:null,tag,role:null,rect:box,fragments:[box],clippedRect:box,attributes:{}}));
const observation={viewport:box,nodes,coverage:{geometry:'assessed',fragments:'assessed',clipping:'assessed'}};
const local=nodes.map((n,i)=>({nodeRef:n.nodeRef,directTextPresent:i===3,childElementCount:i===3?0:1,positiveAreaChildCount:i===3?0:1}));
const build=(overrides={})=>browser.buildExplorationInputs({observation,itemObservations:local,directChildrenStatus:'complete',maxRelationHops:4,rootNodeRef:'n0',...overrides});
test('public exploration preserves nested containment and content boundaries',()=>{
 assert.equal(typeof browser.buildExplorationInputs,'function');
 const map=build();assert.equal(map.size,4);
 assert.deepEqual(map.get('n0').containment.descendantEdges.map(e=>[e.targetRef,e.relativeHops,e.relation]),[['n1',1,'contains'],['n2',2,'contains'],['n3',3,'contains']]);
 assert.deepEqual(map.get('n3').containment.ancestorEdges.map(e=>[e.targetRef,e.relativeHops]),[['n2',1],['n1',2],['n0',3]]);
 assert.equal(map.get('n3').containment.ancestorBoundary,'complete');
 assert.equal(map.get('n0').childComposition.children[0].directTextPresent,false);
 assert.deepEqual(map.get('n1').childComposition.childTagCounts,{span:1});
 assert.deepEqual(map.get('n2').childComposition.childTagCounts,{a:1});
 assert.equal(map.get('n0').containment.descendantBoundary,'complete');
});
test('bounded and partial exploration never fabricates complete coverage',()=>{
 assert.throws(()=>build({maxRelationHops:undefined}),/maxRelationHops/);
 assert.equal(build({maxRelationHops:1}).get('n0').containment.descendantBoundary,'hop_limit_reached');
 assert.equal(build({maxRelationHops:1}).get('n3').containment.ancestorBoundary,'hop_limit_reached');
 const partial=build({directChildrenStatus:undefined,itemObservations:[]}).get('n0');
 assert.equal(partial.childComposition.childTagCounts,null);
 assert.equal(partial.containment.positiveAreaChildRefs,null);
 assert.equal(partial.measurementCoverage.directTextPresent,'unmeasured');
 assert.equal(partial.measurementCoverage.inputType,'not_applicable');
 const missing=build({observation:{...observation,nodes:nodes.slice(1)}}).get('n1');
 assert.equal(missing.containment.parentStatus,'missing_parent_observation');
 assert.equal(missing.containment.ancestorBoundary,'incomplete_observation');
 const unmeasured=build({observation:{...observation,nodes:nodes.map((n,i)=>i===1?{...n,rect:null}:n)}}).get('n0');
 assert.equal(unmeasured.containment.positiveAreaChildRefs,null);
 assert.equal(unmeasured.childComposition.positiveAreaChildTagCounts,null);
 const interior=build({unassessedInteriors:new Map([['n1',['shadow_root']]])});
 assert.equal(interior.get('n0').containment.descendantBoundary,'incomplete_observation');
 assert.deepEqual(interior.get('n1').measurementCoverage.unassessedInterior,['shadow_root']);
});
test('exploration JSON reader and prepare preserve optional data without adding training labels',()=>{
 const explorationInput=build().get('n2');
 const row={sampleId:'sample',inputRef:{snapshotRef:'s',documentRef:'d',frameRef:'top',nodeRef:'n2',index:0},provenanceRef:'ev',sourceAssociations:{snapshotRefs:['s'],postRefs:[],assetRefs:['a']},candidateQualification:{status:'ok',reasons:[]},captureCoverage:{frameContent:'not_applicable',directChildren:'complete'},properties:{tag:'span',role:null},proposal:{ruleRef:null,label:null,status:'unknown'},review:{status:'unreviewed',expectedLabel:null,reviewerRef:null,evidenceRef:null,otherReason:null},explorationInput};
 const request=()=>({schemaVersion:1,taskId:'dom.basic-kinds.v1',rows:[row]});
 const parsed=readBasicKindTrainingRequest(JSON.parse(JSON.stringify(request())));
 assert.deepEqual(parsed.rows[0].explorationInput,explorationInput);
 const prepared=prepareBasicKindSamples(parsed,{taskId:'dom.basic-kinds.v1',inputScope:'candidate_qualified'});
 assert.equal(prepared.includedIndices.length,0);assert.deepEqual(prepared.rows[0].explorationInput,explorationInput);
 const old={...row};delete old.explorationInput;
 assert.equal(readBasicKindTrainingRequest({...request(),rows:[old]}).rows[0].explorationInput,undefined);
 assert.throws(()=>browser.validateExplorationInput({...explorationInput,classList:['bad']}),/unsupported|forbidden/);
 assert.throws(()=>readBasicKindTrainingRequest({...request(),rows:[{...row,explorationInput:{...explorationInput,nodeRef:'wrong'}}]}),/nodeRef/);
 const verified={...row,review:{status:'verified',expectedLabel:'container',reviewerRef:'synthetic:fixture',evidenceRef:'ev',otherReason:null}};
 const fit=toBasicKindFitRows(prepareBasicKindSamples({...request(),rows:[verified]},{taskId:'dom.basic-kinds.v1',inputScope:'candidate_qualified'}));
 assert.equal('explorationInput' in fit[0],false);
});
test('exploration carries appearance coverage while old exports default to unmeasured nulls',()=>{
 const measuredLocal=local.map((row,index)=>index===3?{...row,nonFormatDirectTextPresent:true,beforeContentPresent:true,afterContentPresent:false,backgroundImagePresent:true,maskImagePresent:null}:row);
 const map=build({itemObservations:measuredLocal});
 const measured=map.get('n3');
 assert.equal(map.get('n2').childComposition.children[0].nonFormatDirectTextPresent,true);
 assert.equal(map.get('n2').childComposition.children[0].beforeContentPresent,true);
 assert.equal(map.get('n2').childComposition.children[0].backgroundImagePresent,true);
 assert.equal(measured.measurementCoverage.nonFormatDirectTextPresent,'measured');
 assert.equal(measured.measurementCoverage.beforeContentPresent,'measured');
 assert.equal(measured.measurementCoverage.afterContentPresent,'measured');
 assert.equal(measured.measurementCoverage.maskImagePresent,'unmeasured');
 const old=JSON.parse(JSON.stringify(map.get('n2')));
 for(const key of ['nonFormatDirectTextPresent','beforeContentPresent','afterContentPresent','backgroundImagePresent','maskImagePresent']){
  delete old.measurementCoverage[key];
  for(const child of old.childComposition.children)delete child[key];
  for(const edge of [...old.containment.ancestorEdges,...old.containment.descendantEdges])delete edge.target[key];
 }
 const restored=browser.validateExplorationInput(old);
 for(const key of ['nonFormatDirectTextPresent','beforeContentPresent','afterContentPresent','backgroundImagePresent','maskImagePresent']){
  assert.equal(restored.measurementCoverage[key],'unmeasured');
  for(const child of restored.childComposition.children)assert.equal(child[key],null);
 }
 delete old.measurementCoverage.directTextPresent;
 assert.throws(()=>browser.validateExplorationInput(old),/invalid exploration value/);
});

test('exploration carries the bounded interaction measurements while old exports stay readable',()=>{
 const measuredLocal=local.map((row,index)=>index===2?{...row,
   pointerCursor:true,parentPointerCursor:false,tabIndexFocus:true,borderPresent:null,aspectRatio:0.5,
   descendantTextPresent:true,singleChildTag:'a',singleChildSameRect:true,withinControlAncestor:true,inSvgAncestor:false}:row);
 const measured=build({itemObservations:measuredLocal}).get('n2');
 for(const key of ['pointerCursor','parentPointerCursor','tabIndexFocus','borderPresent','aspectRatio','descendantTextPresent','singleChildTag','singleChildSameRect','withinControlAncestor','inSvgAncestor']){
  assert.equal(measured.measurementCoverage[key],key==='borderPresent'?'unmeasured':'measured',key);
 }
 const old=JSON.parse(JSON.stringify(measured));
 for(const key of ['pointerCursor','parentPointerCursor','tabIndexFocus','borderPresent','aspectRatio','descendantTextPresent','singleChildTag','singleChildSameRect','withinControlAncestor','inSvgAncestor']){
  delete old.measurementCoverage[key];
 }
 const restored=browser.validateExplorationInput(old);
 for(const key of ['pointerCursor','parentPointerCursor','tabIndexFocus','borderPresent','aspectRatio','descendantTextPresent','singleChildTag','singleChildSameRect','withinControlAncestor','inSvgAncestor']){
  assert.equal(restored.measurementCoverage[key],'unmeasured',key);
 }
});

test('exploration reports direct list child coverage only when measured on complete children',()=>{
 const measuredLocal=local.map((row,index)=>index===2?{...row,directListChildPresent:true}:row);
 const measured=build({itemObservations:measuredLocal}).get('n2');
 assert.equal(measured.measurementCoverage.directListChildPresent,'measured');
 const absent=build({itemObservations:local}).get('n2');
 assert.equal(absent.measurementCoverage.directListChildPresent,'unmeasured');
 const nullMeasured=local.map((row,index)=>index===2?{...row,directListChildPresent:null}:row);
 assert.equal(build({itemObservations:nullMeasured}).get('n2').measurementCoverage.directListChildPresent,'unmeasured');
 const incomplete=build({directChildrenStatus:'incomplete',itemObservations:measuredLocal}).get('n2');
 assert.equal(incomplete.measurementCoverage.directChildren,'incomplete');
 assert.equal(incomplete.measurementCoverage.directListChildPresent,'unmeasured');
 const old=JSON.parse(JSON.stringify(measured));
 delete old.measurementCoverage.directListChildPresent;
 assert.equal(browser.validateExplorationInput(old).measurementCoverage.directListChildPresent,'unmeasured');
});
