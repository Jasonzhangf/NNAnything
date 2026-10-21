import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as api from '../dist/browser-single-action.js';

function fixture({readFails=false,stale=false,receipt=null}={}) {
  const request=structuredClone(api.makeBrowserSingleActionSamples().find(x=>x.id==='train-native-caption-00').request);
  const profile=structuredClone(api.createZeroBrowserSingleActionProfile());
  profile.relationWeights[0][api.SINGLE_ACTION_RELATION_WIRES.indexOf('controls.target*enabled.value*hit.value')]=10;
  profile.relationWeights[1][0]=1;
  profile.capabilityWeights[0][api.SINGLE_ACTION_CAPABILITY_WIRES.indexOf('providers.one')]=10;
  const post=structuredClone(request.state);post.observationId+=':post';post.revision++;
  for(const e of post.evidence)e.observationId=post.observationId;
  for(const r of post.regions){r.expanded={status:'observed',value:true,evidenceRefs:[post.evidence[0].id]};r.rendered={status:'observed',value:true,evidenceRefs:[post.evidence[0].id]};}
  let reads=0,clicks=0,current=request.state;
  const resources={profile,grantedEffects:new Set(['browser.nativeClick','filesystem.write']),
    observe:async()=>{reads++;if(reads>1&&readFails)throw new Error('sensor unavailable');current=reads===1||stale?request.state:post;return current;},
    currentControl:()=>current,
    nativeClick:async()=>{clicks++;if(receipt)return receipt;throw new Error('transport failed after dispatch');},
    collect:async()=>{},
  };
  return {request,resources,counts:()=>({reads,clicks})};
}

test('possibly dispatched exception preserves real achieved state and unknown effects',async()=>{
  const f=fixture();const r=await api.runBrowserSingleActionEpisode(f.request,f.resources);
  assert.deepEqual(f.counts(),{reads:2,clicks:1});
  assert.equal(r.error.code,'native_click_failed');assert.equal(r.executionErrors[0].code,'native_click_failed');
  assert.equal(r.observationFeedback.status,'satisfied');assert.equal(r.achieved,true);assert.equal(r.satisfaction,100);
  assert.equal(r.dispatchState,'unknown');assert.equal(r.effectKnowledge,'unknown');
});
test('executor and observer errors both survive without invented state',async()=>{
  const f=fixture({readFails:true});const r=await api.runBrowserSingleActionEpisode(f.request,f.resources);
  assert.equal(r.error.code,'native_click_failed');assert.equal(r.executionErrors[0].code,'native_click_failed');
  assert.equal(r.observationFeedback.status,'failed');assert.equal(r.observationFeedback.errors[0].code,'post_observation_failed');
  assert.equal(r.newState,null);assert.equal(r.satisfaction,null);assert.deepEqual(f.counts(),{reads:2,clicks:1});
});
test('stale evidence after execution exception is retained but cannot prove completion',async()=>{
  const f=fixture({stale:true});const r=await api.runBrowserSingleActionEpisode(f.request,f.resources);
  assert.equal(r.error.code,'native_click_failed');assert.equal(r.observationFeedback.status,'failed');
  assert.equal(r.observationFeedback.errors[0].code,'stale_reference');assert.equal(r.satisfaction,null);assert.equal(r.achieved,false);
});
test('explicit failed receipt is distinct from true goal evidence',async()=>{
  const f=fixture({receipt:{dispatched:true,ok:false,effectKnowledge:'unknown',source:'test',error:{code:'executor_rejected',message:'failed'}}});
  const r=await api.runBrowserSingleActionEpisode(f.request,f.resources);
  assert.equal(r.receipt.ok,false);assert.equal(r.executionErrors[0].code,'executor_rejected');
  assert.equal(r.observationFeedback.status,'satisfied');assert.equal(r.achieved,true);assert.equal(r.effectKnowledge,'unknown');
});
test('malformed receipt keeps uncertain dispatch and still attempts the post-observation',async()=>{
  const f=fixture({receipt:{ok:true}});const r=await api.runBrowserSingleActionEpisode(f.request,f.resources);
  assert.equal(r.error.code,'adapter_contract_invalid');assert.equal(r.executionErrors[0].code,'adapter_contract_invalid');
  assert.equal(r.receipt,null);assert.equal(r.dispatchState,'unknown');assert.equal(r.effectKnowledge,'unknown');
  assert.equal(r.observationFeedback.status,'satisfied');assert.deepEqual(f.counts(),{reads:2,clicks:1});
});
