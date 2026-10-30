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

/** F8: independent split-panel renderer. No shared page.mjs / family-b code. */
export function renderPage(fixture) {
  const input = fixture.input;
  const submitted = fixture.submitted;
  const request = fixture.request;
  const disabledAttr = input.disabled ? ' disabled' : '';
  const readonlyAttr = input.readonly ? ' readonly' : '';
  const valueAttr = input.valueUnknown ? '' : ` value="${escape(input.value)}"`;
  const placeholderAttr = input.placeholder ? ` placeholder="${escape(input.placeholder)}"` : '';
  const occluder = input.occluded ? '<div id="occluder" style="position:fixed;inset:0;background:#faf8f0;z-index:30"></div>' : '';
  const mainList = `<ul id="split-main-list" data-collection-ref="split-main-list">${fixture.items.main.map((text) => `<li>${escape(text)}</li>`).join('')}</ul>${fixture.items.main.length ? '' : '<p id="split-empty" class="empty-state">没有主集合条目</p>'}`;
  const aside = `<aside id="split-aside" aria-label="星空资料旁注"><h2>星空资料旁注</h2>${fixture.items.aside.length ? `<ul>${fixture.items.aside.map((text) => `<li>${escape(text)}</li>`).join('')}</ul>` : '<p class="empty-state">没有旁注条目</p>'}</aside>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>星空观测面板</title><style>
:root{font:15px/1.55 system-ui,sans-serif;color:#20242f;background:#eef0f4}*{box-sizing:border-box}body{margin:0}header{padding:18px 22px;max-width:1120px;margin:auto}.app{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:18px;max-width:1120px;margin:auto;padding:0 22px 26px}label{display:inline-flex;gap:8px;align-items:center}input,button{font:inherit;padding:8px 10px;border:1px solid #7f8fa4;border-radius:4px;background:white}button{cursor:pointer}#notes{width:160px}section{background:white;border:1px solid #dfe3ea;border-radius:6px;padding:14px}h1{font-size:22px;margin:0 0 10px}ul{margin:8px 0;padding-left:22px}#split-main-list>li{min-height:48px;padding:12px;margin:0 0 6px}#result-scroll-box{height:180px;overflow-y:auto;display:block;border:1px solid #dfe3ea;background:white}#collection-terminal-banner{background:#e6eeea;color:#2f5245;padding:10px;font-size:14px}#load-more{display:block;margin:8px auto}#long-footer-spacer{height:600px;background:#eef1f6;padding:12px;font-size:14px}aside{background:#e4e8f0;border-radius:6px;padding:12px}.metadata{color:#5a6270;font-size:13px;margin:6px 0}.empty-state{color:#5a6270}
</style><header><h1>星空观测面板</h1><form id="search-form" method="get"><label for="query">查询<input id="query" name="q" type="text"${valueAttr}${placeholderAttr}${disabledAttr}${readonlyAttr}></label><button id="submit" type="submit">搜索</button></form><p><label for="notes">备注<input id="notes" value="保持原值"></label></p><p id="submission-state" class="metadata"${submitted.requestRef ? ` data-submitted-request-ref="${escape(submitted.requestRef)}" data-submitted-query="${escape(submitted.query)}"` : ''}>${submitted.requestRef ? `已提交请求 ${escape(submitted.requestRef)}：${escape(submitted.query)}` : '尚未提交查询'}</p><p id="request-state" class="metadata"${attr('data-request-status', request.status)}${attr('data-display', request.display)}${attr('data-access', request.access)}${attr('data-results-query', request.resultsFor)}${attr('data-results-request-ref', request.resultsRef)}${attr('data-batch-ref', request.batchRef)}${attr('data-mechanical-effect', request.range.actionMechanicalEffect)}>观测状态</p></header><div class="app">${occluder}<main id="split-main" aria-label="主结果"><div id="result-scroll-box"><div id="split-main-list-host">${mainList}</div>${terminalBannerHtml(fixture)}${longFooterHtml(fixture)}</div>${loadMoreHtml(fixture)}</main>${aside}<p class="metadata">验证样本 F8 · 双栏分屏渲染器</p></div><script>window.__F8_FIXTURE__=${scriptValue(fixture)}</script><script type="module" src="/verify-f8-split/client.js"></script></html>`;
}
