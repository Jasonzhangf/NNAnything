import {observeLiveDom,createStableNodeRefRegistry,stableNodeRefFor,validateExplorationInput} from 'nnanything/browser-classify';
const result=document.querySelector('#result');
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>未采集的shadow内部</button>';
try{
 const registry=createStableNodeRefRegistry('fixture');
 const snapshot=observeLiveDom({document,window,registry,excludeRoot:result,snapshotRef:'browser-fixture',documentRef:'synthetic',maxRelationHops:2});
 const ref=id=>stableNodeRefFor(registry,document.querySelector(id));
 const leaf=snapshot.explorationInputs.get(ref('#leaf'));
 const outer=snapshot.explorationInputs.get(ref('#outer'));
 const input=Array.from(snapshot.properties.values()).find(p=>p.tag==='input');
 const checks={
  secondAncestor:leaf.containment.ancestorEdges[1]?.targetRef===ref('#middle')&&leaf.containment.ancestorEdges[1]?.relativeHops===2,
  hopLimit:leaf.containment.ancestorBoundary==='hop_limit_reached',
  descendantsRetained:snapshot.explorationInputs.has(ref('#inner'))&&snapshot.explorationInputs.has(ref('#leaf')),
  textNotInherited:outer.childComposition.children[0].directTextPresent===false,
  inputIsOneControl:input?.inputType==='text'&&input?.role==='combobox'&&document.querySelector('input').childNodes.length===0,
  iframeUnassessed:[...snapshot.explorationInputs.values()].some(x=>x.measurementCoverage.unassessedInterior.includes('iframe')),
  shadowUnassessed:snapshot.explorationInputs.get(ref('#shadow')).measurementCoverage.unassessedInterior.includes('shadow_root'),
  allRowsReload:[...snapshot.explorationInputs.values()].every(x=>validateExplorationInput(JSON.parse(JSON.stringify(x))).nodeRef===x.nodeRef),
 };
 if(Object.values(checks).some(v=>!v))throw new Error(JSON.stringify(checks));
 result.textContent=JSON.stringify({status:'PASS',checks,nodeCount:snapshot.explorationInputs.size,maxRelationHops:leaf.containment.maxRelationHops,classificationPerformed:false,trainingPerformed:false},null,2);
}catch(error){result.textContent=`FAIL: ${error.stack??error}`;throw error;}
