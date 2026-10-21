import assert from 'node:assert/strict';
import {test} from 'node:test';
import {profiles,scenarios} from '../playground/browser/search-fixture/cases.mjs';
import {renderPage} from '../playground/browser/search-fixture/page.mjs';
import {createFixtureServer} from '../playground/browser/search-fixture/server.mjs';

test('one renderer accepts every representation and a new configuration without a new parser',()=>{
  for(const profile of profiles) {
    const html=renderPage(profile,'normal');
    assert.match(html,/搜索结果/);
    assert.match(html,/<form\b/);
    assert.match(html,/保持原值/);
    assert.ok(html.includes(profile.input.tag==='textarea'?'<textarea':'<input'));
  }
  const unseen={...structuredClone(profiles[0]),id:'configuration-added-after-core',label:'独立紧凑表示',layout:{columns:1,maxWidth:760,cardBorder:false,fieldOrder:['author','source','title','body','metric','image','video','time','citation'],wrapperDepth:3}};
  assert.match(renderPage(unseen,'normal'),/搜索结果/);
});

test('fixture server publishes only page resources and accepts explicit known configurations',async()=>{
  const server=createFixtureServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const profile of profiles) {
      const response=await fetch(`${root}/?profile=${profile.id}&scenario=normal`);
      assert.equal(response.status,200);
      assert.match(await response.text(),/搜索结果/);
    }
    for(const scenario of scenarios) {
      assert.equal((await fetch(`${root}/?profile=mixed&scenario=${scenario}`)).status,200);
    }
    assert.equal((await fetch(`${root}/?profile=not-registered`)).status,400);
    assert.equal((await fetch(`${root}/?scenario=not-registered`)).status,400);
    for(const path of ['/cases.mjs','/teacher','/oracle','/api/profile','/..%2Fcases.mjs']) {
      assert.equal((await fetch(root+path)).status,404,path);
    }
    assert.ok(['normal','delayed','empty','error','blocked','ineffective'].every(value=>scenarios.includes(value)));
  } finally {
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
