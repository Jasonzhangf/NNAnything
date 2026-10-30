const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));
const scriptValue = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const attr = (name, value) => value === null || value === undefined || value === ''
  ? '' : ` ${name}="${escape(value)}"`;

const terminalBannerHtml = (fixture) => fixture.render?.terminalBanner
  ? `<div id="collection-terminal-banner" data-has-more="false" data-request-status="${escape(fixture.request.status)}">已加载全部条目</div>`
  : '';
const loadMoreHtml = (request) => request.render?.loadMore
  ? `<button id="load-more" type="button" data-has-more="true">加载更多</button>`
  : '';
const longFooterHtml = (request) => request.render?.longFooter
  ? `<div id="long-footer-spacer">Footer / Recommendations</div>`
  : '';

/** F7: independent table catalog renderer. No shared renderer or fixture code. */
export function renderPage(fixture) {
  const input = fixture.input;
  const submitted = fixture.submitted;
  const request = fixture.request;
  const disabledAttr = input.disabled ? ' disabled' : '';
  const readonlyAttr = input.readonly ? ' readonly' : '';
  const valueAttr = input.valueUnknown ? '' : ` value="${escape(input.value)}"`;
  const placeholderAttr = input.placeholder ? ` placeholder="${escape(input.placeholder)}"` : '';
  const occludeStyle = input.occluded ? '<div id="occluder" style="position:fixed;inset:0;background:white;z-index:20"></div>' : '';
  const mainTable = `<table id="catalog-table" data-collection-ref="catalog-table"><caption>海洋资料目录</caption><thead><tr><th>目录条目</th></tr></thead><tbody>${fixture.items.main.map((text) => `<tr><td>${escape(text)}</td></tr>`).join('')}</tbody></table>${fixture.items.main.length ? '' : '<p id="catalog-empty" class="empty-state">没有主集合目录条目</p>'}`;
  const aside = `<aside aria-label="资料旁注"><h2>资料旁注</h2>${fixture.items.auxiliary.length ? `<ul>${fixture.items.auxiliary.map((text) => `<li>${escape(text)}</li>`).join('')}</ul>` : '<p class="empty-state">没有旁注条目</p>'}</aside>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>海洋资料目录</title><style>
:root{font:15px/1.55 system-ui,sans-serif;color:#1c2420;background:#f4f2ed}*{box-sizing:border-box}body{margin:0}header,main{max-width:980px;margin:auto;padding:20px}header{border-bottom:1px solid #d5d2c8}h1{font-size:22px;margin:0 0 10px}label{display:inline-flex;gap:8px;align-items:center}input,button{font:inherit;padding:8px 10px;border:1px solid #9aa39b;border-radius:4px;background:white}button{cursor:pointer}#notes{width:180px}#catalog{padding:18px 0}table{border-collapse:collapse;width:100%;background:white}caption{font-size:15px;font-weight:600;text-align:left;padding:6px 0}th,td{border:1px solid #cfd3cb;padding:12px 10px;text-align:left;vertical-align:top}thead th{background:#e7e3d8}tbody tr{height:56px}tbody tr:nth-child(even){background:#f7f5ef}#result-scroll-box{height:180px;overflow-y:auto;display:block;border:1px solid #cfd3cb;background:white}#collection-terminal-banner{background:#e7f0e8;color:#31553a;padding:10px;font-size:14px}#load-more{display:block;margin:8px auto}#long-footer-spacer{height:600px;background:#f3f0e8;padding:12px;font-size:14px}aside{background:#e9ede8;padding:12px;border-radius:5px;margin-top:14px;font-size:14px}ul{margin:8px 0;padding-left:20px}.empty-state{color:#5b625c}.metadata{color:#5c645d;font-size:13px;margin:6px 0}
</style><header><h1>海洋资料目录</h1><form id="search-form" method="get"><label for="query">查询<input id="query" name="q" type="text"${valueAttr}${placeholderAttr}${disabledAttr}${readonlyAttr}></label><button id="submit" type="submit">搜索</button></form><p><label for="notes">备注<input id="notes" value="保持原值"></label></p></header><main id="catalog-panel">${occludeStyle}<p id="submission-state" class="metadata"${submitted.requestRef ? ` data-submitted-request-ref="${escape(submitted.requestRef)}" data-submitted-query="${escape(submitted.query)}"` : ''}>${submitted.requestRef ? `已提交请求 ${escape(submitted.requestRef)}：${escape(submitted.query)}` : '尚未提交查询'}</p><p id="request-state" class="metadata"${attr('data-request-status', request.status)}${attr('data-display', request.display)}${attr('data-access', request.access)}${attr('data-results-query', request.resultsFor)}${attr('data-results-request-ref', request.resultsRef)}${attr('data-batch-ref', request.batchRef)}${attr('data-mechanical-effect', request.range.actionMechanicalEffect)}>观测状态</p><section id="catalog" aria-label="海洋资料目录"><div id="result-scroll-box"><div id="catalog-table-host">${mainTable}</div>${terminalBannerHtml(fixture)}${longFooterHtml(fixture)}</div>${loadMoreHtml(fixture)}</section>${aside}<p class="metadata">验证样本 F7 · 表格目录渲染器</p></main><script>window.__F7_FIXTURE__=${scriptValue(fixture)}</script><script type="module" src="/verify-f7-table/client.js"></script>`;
}
