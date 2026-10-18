import {createStableNodeRefRegistry,stableNodeRefFor,validateExplorationInput,extractBasicKindWires,compileWorkflow,createBrowserOverlayNodeDefinitions,createWorkflowInputEvent,runWorkflow,BROWSER_OVERLAY_REQUEST_EVENT_TYPE,DEFAULT_BASIC_KIND_CONFIG,BrowserCaptureSession,readBasicKindTrainingRequest,prepareBasicKindSamples} from 'nnanything/browser-classify';
import graph from '../../workflows/browser-visual-overlay.graph.json';
const result=document.querySelector('#result');
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>未采集的shadow内部</button>';
try{
 const registry=createStableNodeRefRegistry('fixture');
 const resources={document,window,registry,excludeHost:result,excludeRoots:[document.querySelector('#configured-exclusion')],maxRelationHops:2,present:()=>undefined};
 const compiled=compileWorkflow({graph,bindings:{'筛选当前视口与关注候选':{config:{viewportOnly:true,scopeMode:'subtree'}},'判断DOM基础种类':{config:DEFAULT_BASIC_KIND_CONFIG}}},{nodeDefinitions:createBrowserOverlayNodeDefinitions(resources),grantedEffects:['browser.dom.read','browser.overlay.present']});
 const executed=await runWorkflow(compiled,createWorkflowInputEvent({runId:'appearance-fixture',eventId:'appearance-fixture:input',port:'overlay_request',type:BROWSER_OVERLAY_REQUEST_EVENT_TYPE,correlation:{},payload:{snapshotRef:'browser-fixture',documentRef:'synthetic'}}));
 if(executed.status!=='completed'||executed.outputEvent.status!=='ok')throw new Error('workflow failed');
 const frame=executed.outputEvent.payload,snapshot=frame.snapshot;
 const ref=id=>stableNodeRefFor(registry,document.querySelector(id));
 const leaf=snapshot.explorationInputs.get(ref('#leaf'));
 const outer=snapshot.explorationInputs.get(ref('#outer'));
 const input=Array.from(snapshot.properties.values()).find(p=>p.tag==='input');
 const properties=id=>snapshot.properties.get(ref(id));
 const session=new BrowserCaptureSession({sessionId:'fixture',createdAt:'2026-10-17T00:00:00Z'});
 session.captureSelected(frame,ref('#real-text'),{kind:'unsure'});
 let bundle;await session.export(value=>{bundle=value;});
 const restored=readBasicKindTrainingRequest(JSON.parse(JSON.stringify(bundle.trainingRequest)));
 const prepared=prepareBasicKindSamples(restored,{taskId:'dom.basic-kinds.v1',inputScope:'candidate_qualified'});
 const checks={
  secondAncestor:leaf.containment.ancestorEdges[1]?.targetRef===ref('#middle')&&leaf.containment.ancestorEdges[1]?.relativeHops===2,
  hopLimit:leaf.containment.ancestorBoundary==='hop_limit_reached',
  descendantsRetained:snapshot.explorationInputs.has(ref('#inner'))&&snapshot.explorationInputs.has(ref('#leaf')),
  textNotInherited:outer.childComposition.children[0].directTextPresent===false,
  inputIsOneControl:input?.inputType==='text'&&input?.role==='combobox'&&document.querySelector('input').childNodes.length===0,
  iframeUnassessed:[...snapshot.explorationInputs.values()].some(x=>x.measurementCoverage.unassessedInterior.includes('iframe')),
  shadowUnassessed:snapshot.explorationInputs.get(ref('#shadow')).measurementCoverage.unassessedInterior.includes('shadow_root'),
  allRowsReload:[...snapshot.explorationInputs.values()].every(x=>validateExplorationInput(JSON.parse(JSON.stringify(x))).nodeRef===x.nodeRef),
  toolSubtreesExcluded:![...snapshot.evidence.values()].some(e=>['codex-browser-sidebar-comments-root','configured-exclusion'].includes(e.id))&&snapshot.coverage.excludedElementCount>=4,
  normalFixedRetained:!!properties('#regular-fixed'),
  literalAndNonFormatDistinct:properties('#format').directTextPresent===true&&properties('#format').nonFormatDirectTextPresent===false,
  meaningfulTextRetained:properties('#real-text').nonFormatDirectTextPresent===true&&document.querySelector('#real-text').textContent.includes('👩‍💻'),
  cssPseudoMeasured:properties('#pseudo').beforeContentPresent===true&&properties('#pseudo').afterContentPresent===false,
  cssBackgroundMeasured:properties('#background').backgroundImagePresent===true,
  cssMaskMeasured:properties('#mask').maskImagePresent===true,
  encodingDistinct:extractBasicKindWires(properties('#real-text')).direct_non_format_text===1&&extractBasicKindWires(properties('#primitive')).nat_svg_child===1,
  captureRoundtrip:restored.rows[0].properties.nonFormatDirectTextPresent===true&&restored.rows[0].review.status==='ambiguous'&&prepared.includedIndices.length===0,
  missingStaysExplicit:[...snapshot.properties.values()].every(p=>['nonFormatDirectTextPresent','beforeContentPresent','afterContentPresent','backgroundImagePresent','maskImagePresent'].every(k=>typeof p[k]==='boolean')),
 };
 if(Object.values(checks).some(v=>!v))throw new Error(JSON.stringify(checks));
 result.textContent=JSON.stringify({status:'PASS',checks,nodeCount:snapshot.explorationInputs.size,maxRelationHops:leaf.containment.maxRelationHops,classificationPerformed:true,trainingPerformed:false},null,2);
}catch(error){result.textContent=`FAIL: ${error.stack??error}`;throw error;}
