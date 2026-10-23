/** Independent family B search page. It does not import or reuse family A renderer. */
export function renderFamilyBPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>独立搜索页 B</title>
  <style>:root{font:16px/1.6 system-ui,sans-serif;color:#222;background:#fbfaf7}*{box-sizing:border-box}body{margin:0}header,main{max-width:960px;margin:auto;padding:20px}form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}input,button{font:inherit;padding:9px 12px;border:1px solid #8b8b8b;border-radius:5px;background:white}button{cursor:pointer}main{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:20px}ol{margin:0;padding-left:22px}li{margin:10px 0}aside{background:#f1efe8;padding:14px;border-radius:6px}aside ul{padding-left:18px}.metadata{color:#666;font-size:14px}</style>
  <header><h1>独立搜索页 B</h1><form id="search-form"><label for="query">查询<input id="query" name="q" type="text" placeholder="旧推荐词：城市散步路线"></label><button id="submit" type="submit">搜索</button></form>
  <p><label>备注<input id="notes" value="保持原值"></label></p>
  <p id="submission-state" class="metadata" data-submitted-request-ref="" data-submitted-query="">尚未提交查询</p>
  <p id="request-state" class="metadata" data-request-status="unknown" data-display="none" data-access="available" data-results-request-ref="" data-results-query="" data-batch-ref="">尚未取得结果</p>
  <p id="late-state" class="metadata" data-late-request-ref=""></p></header>
  <main><section aria-label="主结果"><p id="main-state">主结果尚未显示</p><ol id="main-results"></ol></section>
  <aside aria-label="资料旁栏"><h2>资料旁栏</h2><ul id="aside-results"></ul></aside></main>
  <script type="module" src="/family-b/client.js"></script></html>`;
}
