const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scriptValue = value => JSON.stringify(value).replace(/</g,'\\u003c');

function fieldHtml(field) {
  const text=escape(field.text);
  const href=typeof field.href==='string' && field.href.startsWith('#') ? escape(field.href) : '#result-detail';
  if(field.role==='title') return `<h2><a href="${href}">${text}</a></h2>`;
  if(field.role==='body') return `<p>${escape(String(field.text??'').slice(0,110))}</p>${String(field.text??'').length>110?`<details><summary>展开内容</summary><p>${text}</p></details>`:''}`;
  if(field.role==='source' || field.role==='author' || field.role==='citation') return `<p class="metadata"><a href="${href}">${text}</a></p>`;
  if(field.role==='image' || field.role==='video') {
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#e6ede6"/><path d="M0 340L180 120L320 280L440 100L640 340" fill="#819b86"/><path d="M230 350L340 180L450 350Z" fill="#b69b77"/><circle cx="120" cy="85" r="30" fill="#e6cf92"/></svg>';
    const ratio=typeof field.ratio==='number' && field.ratio>0?field.ratio:1.6;
    return `<figure><img style="aspect-ratio:${ratio}" src="data:image/svg+xml,${encodeURIComponent(svg)}" alt="${text || '户外景色示意图'}"><figcaption>${text}${field.role==='video'?' · 视频卡片预览（合成封面，无媒体播放）':''}</figcaption></figure>`;
  }
  return `<p class="metadata">${text}</p>`;
}

function itemHtml(item,layout,kind='main') {
  const order=layout.fieldOrder ?? [];
  const fields=[...item.fields].sort((a,b)=>{
    const rank=role=>order.includes(role)?order.indexOf(role):order.length;
    return rank(a.role)-rank(b.role);
  });
  let body=fields.map(fieldHtml).join('');
  if(item.children?.length) body+=`<blockquote aria-label="引用内容">${item.children.map(child=>itemHtml(child,layout,'quoted')).join('')}</blockquote>`;
  for(let i=0;i<Math.min(4,layout.wrapperDepth ?? 0);i++) body=`<div>${body}</div>`;
  const className=kind==='quoted'?'quoted-item':kind==='auxiliary'?'auxiliary-item':kind==='related'?'related-item':'result-item';
  return `<article class="${className}">${body}</article>`;
}

function groupsHtml(profile,page,placements=null) {
  return profile.groups.filter(group=>!placements||placements.includes(group.placement)).map(group=>{
    const items=group.items.filter((_,index)=>page===1?index<2:index>=2);
    const kind=group.placement==='aside'?'auxiliary':group.placement==='related'?'related':'main';
    const body=`<h2 class="group-heading">${escape(group.label)}</h2><div class="items">${items.map(item=>itemHtml(item,profile.layout,kind)).join('')}</div>`;
    return group.placement==='aside'?`<aside aria-label="${escape(group.label)}">${body}</aside>`:`<section aria-label="${escape(group.label)}">${body}</section>`;
  }).join('');
}

/** One application implementation; profile names never select behavior. */
export function renderPage(profile,scenario,choices=[profile],options={}) {
  const columns=Math.max(1,Math.min(4,profile.layout.columns));
  const width=Math.max(400,Math.min(1500,profile.layout.maxWidth));
  const placeholder=typeof profile.input?.placeholder==='string'?profile.input.placeholder:'';
  const input=profile.input.tag==='textarea'?`<textarea id="query" name="q" rows="1" placeholder="${escape(placeholder)}"></textarea>`:`<input id="query" name="q" type="${profile.input.type==='search'?'search':'text'}" placeholder="${escape(placeholder)}">`;
  // Only pre-rendered application content crosses into the page, never the source profile or teacher IDs.
  const mainPages=[groupsHtml(profile,1,['main']),groupsHtml(profile,2,['main'])];
  const relatedPages=[groupsHtml(profile,1,['related']),groupsHtml(profile,2,['related'])];
  const asidePages=[groupsHtml(profile,1,['aside']),groupsHtml(profile,2,['aside'])];
  const pages=[groupsHtml(profile,1),groupsHtml(profile,2)];
  const initialQuery=typeof options.query==='string'?options.query:'';
  const scenarioOptions=Array.isArray(options.scenarios)?options.scenarios:['normal','delayed','empty','error','blocked','ineffective','ai-first','invalid','same-word','same-word-stalled','race','blocked-empty','suggestion','title-only'];
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>搜索页面样本</title>
  <style>:root{font:16px/1.6 system-ui,sans-serif;color:#26342d;background:#f7f8f6}*{box-sizing:border-box}body{margin:0}header,main{max-width:${width}px;margin:auto;padding:24px}header{padding-bottom:8px}h1{font-size:24px;margin:0 0 12px}h2{font-size:19px;line-height:1.4;margin:0 0 8px}p{margin:8px 0}a{color:#315f86}button,input,textarea,select{font:inherit;border:1px solid #a4afa7;border-radius:5px;padding:9px 12px;background:white;color:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}:focus-visible{outline:3px solid #426fbc;outline-offset:3px}label{display:inline-flex;gap:8px;align-items:center}form{display:flex;gap:10px;align-items:center;flex-wrap:wrap}#query{width:min(480px,65vw);min-height:45px}textarea{resize:vertical}header details{font-size:14px;color:#526157}header form{padding:12px 0}#status{min-height:26px;margin:16px 0}#results{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}.items{columns:${columns};column-gap:20px}article{break-inside:avoid;margin-bottom:20px;padding:${profile.layout.cardBorder?'16px':'10px 0'};border:${profile.layout.cardBorder?'1px solid #d6dfd7':'0'};border-radius:7px;background:white}article article{border:0;padding:8px;background:#f3f5f2}.metadata{font-size:14px;color:#5e6b62}figure{margin:12px 0}img{width:100%;height:auto;object-fit:cover;border-radius:4px}figcaption{font-size:13px;color:#526157}blockquote{border-left:3px solid #c0ccc1;margin:12px 0 0;padding-left:12px}aside{background:#eef2ec;padding:16px;border-radius:6px}aside .items{columns:1}.group-heading{font-size:17px;margin:12px 0}#pager{display:flex;gap:14px;align-items:center;margin:24px 0}[hidden]{display:none!important}@media(min-width:1000px){#results:has(>aside){grid-template-columns: minmax(0,3fr) minmax(220px,1fr)}#results>section{grid-column:1}#results>aside{grid-column:2;grid-row:1/span 4}}@media(max-width:640px){header,main{padding:16px}.items{columns:1}label{flex-wrap:wrap}#query{width:100%}#search-form{display:grid;grid-template-columns:1fr 1fr}#search-form label{grid-column:1/-1}button{min-height:44px}}</style>
  <header><h1>搜索页面样本</h1><details><summary>样本场景</summary><form method="get"><label>表示<select name="profile">${choices.map(choice=>`<option value="${escape(choice.id)}"${choice.id===profile.id?' selected':''}>${escape(choice.label)}</option>`).join('')}</select></label><label>场景<select name="scenario">${scenarioOptions.map(s=>`<option${s===scenario?' selected':''}>${s}</option>`).join('')}</select></label><button>打开场景</button></form></details></header>
  <main id="search-app"><form id="search-form"><label for="query">查询${input}</label><button id="submit" type="submit">搜索</button><button id="alternative" type="button">备用搜索</button></form><p><label for="notes">备注<input id="notes" value="保持原值"></label></p>
  <p id="submission-state" class="metadata" data-submitted-request-ref="" data-submitted-query="">尚未提交查询</p>
  <p id="request-state" class="metadata" data-request-status="unknown" data-display="none" data-access="available" data-results-request-ref="" data-results-query="" data-batch-ref="">尚未取得结果</p>
  <p id="status" role="status" aria-live="polite">尚未提交查询</p><button id="retry" hidden>重试</button><section aria-label="搜索结果"><p id="ownership">没有已提交查询的结果</p><div id="results"></div></section><nav id="pager" aria-label="结果分页" hidden><button id="previous">上一页</button><span id="page-label"></span><button id="next">下一页</button></nav><p id="late-state" class="metadata" data-late-request-ref=""></p><p class="metadata">本地合成样本 · 两个批次 · 内容仅用于观察与操作实验</p></main>
  <script>
  const pages=${scriptValue(pages)};
  const mainPages=${scriptValue(mainPages)};
  const relatedPages=${scriptValue(relatedPages)};
  const asidePages=${scriptValue(asidePages)};
  const mode=${scriptValue(scenario)};
  const initialQuery=${scriptValue(initialQuery)};
  const query=document.getElementById('query'),status=document.getElementById('status'),ownership=document.getElementById('ownership'),results=document.getElementById('results'),pager=document.getElementById('pager'),retry=document.getElementById('retry');
  const submissionState=document.getElementById('submission-state'),requestState=document.getElementById('request-state'),lateState=document.getElementById('late-state');
  let generation=0,submitted='',shown='',page=1,failedOnce=false,invalidPending=true,suggestionPending=false;
  let requestCount=0,submittedRequestRef='',shownRequestRef='',shownBatch='';
  function setSubmission(){if(submittedRequestRef){submissionState.dataset.submittedRequestRef=submittedRequestRef;submissionState.dataset.submittedQuery=submitted;submissionState.textContent='已提交请求 '+submittedRequestRef+'：'+submitted;}else{delete submissionState.dataset.submittedRequestRef;delete submissionState.dataset.submittedQuery;submissionState.textContent='尚未提交查询';}}
  function setRequest(request,display,access){requestState.dataset.requestStatus=request;requestState.dataset.display=display;requestState.dataset.access=access;}
  function setOwnership(requestRef,forQuery,batch){requestState.dataset.resultsRequestRef=requestRef;requestState.dataset.resultsQuery=forQuery;requestState.dataset.batchRef=batch;}
  function display(){results.innerHTML=mainPages[page-1]+relatedPages[page-1]+(asidePages[page-1].length?asidePages[page-1]:'');ownership.textContent='结果所属查询：'+shown+' · 请求 '+shownRequestRef+' · 第 '+page+' 页';setOwnership(shownRequestRef,shown,shownBatch);setRequest('settled','current','available');document.getElementById('page-label').textContent='第 '+page+' / 2 页';document.getElementById('previous').disabled=page===1;document.getElementById('next').disabled=page===2;pager.hidden=false;status.textContent='已显示查询“'+shown+'”的结果；当前批次完成，尚未证明全量覆盖';}
  function showAsync(value,token){
    status.textContent='正在搜索“'+value+'”；AI 摘要与主结果均在加载';
    ownership.textContent='结果所属查询：“'+value+'” · 主结果尚未显示';
    setRequest('loading','partial','available');setOwnership(shownRequestRef,shown,shownBatch);
    results.innerHTML='<p id="main-loading" role="status">主结果加载中</p><p id="aside-loading" role="status" hidden>AI 摘要生成中</p>';
    const hasAside=asidePages[0].length>0;
    document.getElementById('aside-loading').hidden=!hasAside;
    setTimeout(()=>{if(token!==generation)return;const asideLoading=document.getElementById('aside-loading');if(hasAside){asideLoading?.remove();results.insertAdjacentHTML('beforeend',asidePages[0]);status.textContent='AI 摘要已显示；主结果仍在加载';}},200);
    setTimeout(()=>{if(token!==generation)return;shown=value;shownRequestRef=submittedRequestRef;shownBatch=shownRequestRef+':batch-1';page=1;display();},700);
  }
  function submit(isRetry=false){
    const value=query.value.trim();if(!value){status.textContent='请输入查询';return;}
    const token=++generation;submitted=value;requestCount+=1;submittedRequestRef='request-'+requestCount;const myRequestRef=submittedRequestRef;retry.hidden=true;setSubmission();
    setRequest('loading',shownRequestRef?'old':'partial','available');
    if(mode==='blocked'){status.textContent='需要登录，当前查询未取得结果';setRequest('settled','none','login_required');return;}
    if(mode==='blocked-empty'){status.textContent='登录后方可查看结果';setRequest('settled','empty','login_required');results.replaceChildren();ownership.textContent='查询“'+value+'”结果被登录阻断';return;}
    if(mode==='title-only'){status.textContent='已提交“'+value+'”，但结果关系不可辨';setRequest('settled','none','available');document.title='搜索页面样本 · '+value;history.replaceState({},'',location.pathname+'?title-only=1');return;}
    status.textContent='正在搜索“'+value+'”'+(shown?'；下方仍属于旧查询“'+shown+'”':'');pager.hidden=true;
    if(mode==='ai-first'){showAsync(value,token);return;}
    if(mode==='same-word-stalled'){return;}
    const delay=value.includes('slow')?600:mode==='delayed'?150:mode==='same-word'?60:0;
    setTimeout(()=>{if(token!==generation){lateState.dataset.lateRequestRef=myRequestRef;return;}
      if(mode==='error'&&!failedOnce&&!isRetry){failedOnce=true;status.textContent='搜索失败，输入已保留；可重试';setRequest('error','old','available');retry.hidden=false;return;}
      shown=value;page=1;
      shownRequestRef=submittedRequestRef;shownBatch=shownRequestRef+':batch-1';
      if(mode==='empty'){results.replaceChildren();ownership.textContent='查询“'+shown+'”明确返回空结果';setOwnership(shownRequestRef,shown,shownBatch);setRequest('settled','empty','available');status.textContent='没有匹配结果；这与尚未加载不同';pager.hidden=true;return;}
      display();
    },delay);
  }
  if(mode==='same-word'){shown=initialQuery;submitted=initialQuery;requestCount=1;submittedRequestRef='request-1';shownRequestRef='request-1';shownBatch='request-1:batch-1';page=1;setSubmission();display();}
  if(mode==='same-word-stalled'){shown=initialQuery;submitted=initialQuery;requestCount=1;submittedRequestRef='request-1';shownRequestRef='request-1';shownBatch='request-1:batch-1';page=1;setSubmission();display();}
  document.getElementById('search-form').addEventListener('submit',event=>{event.preventDefault();if(mode!=='ineffective')submit();});
  query.addEventListener('input',()=>{
    if(mode==='invalid'&&invalidPending&&query.value){invalidPending=false;query.value='';status.textContent='输入被重置；请重新输入后再提交';}
    if(mode==='suggestion'&&!suggestionPending&&query.value){suggestionPending=true;setTimeout(()=>{if(query.value){query.value='城市散步路线';status.textContent='已选择建议词；当前值与查询不同';}},60);}
  });
  query.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(mode!=='ineffective')submit();}});
  document.getElementById('alternative').addEventListener('click',()=>submit());
  retry.addEventListener('click',()=>submit(true));
  document.getElementById('next').addEventListener('click',()=>{if(page<2&&shown===submitted){page++;display();}});
  document.getElementById('previous').addEventListener('click',()=>{if(page>1&&shown===submitted){page--;display();}});
  </script></html>`;
}
