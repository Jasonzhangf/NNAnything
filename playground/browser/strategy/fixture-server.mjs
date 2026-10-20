import http from 'node:http';
const cases = ['primary-ineffective', 'both-ineffective', 'retry-primary-success', 'unknown-effects', 'disabled-after-first', 'initially-expanded', 'reordered'];
const families = ['cards', 'dialog'];
function html(caseId, family) {
  const open = caseId === 'initially-expanded';
  const primary = `<article><h2>Primary panel</h2><div><button type="button" id="primary-control" aria-controls="goal-region" aria-expanded="${open}"><span>Primary control</span></button></div></article>`;
  const secondary = `<article><header><h2>Alternative panel</h2></header><div role="button" tabindex="0" aria-disabled="false" id="secondary-control" aria-controls="goal-region" aria-expanded="${open}"><svg width="18" height="18" aria-hidden="true"><path d="M0 0L18 9L0 18Z"/></svg><span>Alternative control</span></div></article>`;
  return `<!doctype html><meta charset="utf-8"><title>NNAnything progressive strategy ${family} ${caseId}</title>
  <style>body{font:20px system-ui;margin:38px;background:#f7fafb;color:#19313b}main{max-width:1050px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:24px}article,section{border:1px solid #93acb5;border-radius:10px;padding:18px;background:white}button,[role=button]{display:inline-flex;align-items:center;gap:12px;padding:16px;font:inherit;cursor:pointer;border:1px solid #456879;border-radius:7px;background:#edf7fb}section{margin-top:18px}section[hidden]{display:none}.dialog article{margin:14px 0}.dialog h2{font-size:21px}#goal-region{background:#e8faed}output{display:block;margin:12px 0;font-family:monospace;font-size:16px}</style>
  <h1>Progressive strategy verification</h1><p>Case ${caseId}. Both controls declare the same expansion goal.</p>
  <output id="event-counts">Primary: 0 · Alternative: 0</output>
  <main id="scope" class="${family}">${caseId === 'reordered' ? secondary + primary : primary + secondary}
  <section id="goal-region" role="region" aria-label="Goal region" ${open ? '' : 'hidden'}>Goal content is visible.</section>
  <section id="neighbor-region" role="region" aria-label="Neighbor region" hidden>Other business state changed.</section></main>
  <output id="effect-audit" hidden style="display:none"></output>
  <script>
  const mode=${JSON.stringify(caseId)};const counts={primary:0,secondary:0};let sequence=0;
  for(const strategy of ['primary','secondary'])document.getElementById(strategy+'-control').addEventListener('click',event=>{
    const goal=document.getElementById('goal-region');const neighbor=document.getElementById('neighbor-region');
    const before={goal:!goal.hidden,neighbor:!neighbor.hidden,url:location.href};counts[strategy]++;sequence++;
    const succeeds=strategy==='primary' ? mode==='retry-primary-success'&&counts.primary>=2 : mode!=='both-ineffective';
    if(succeeds)goal.hidden=false;
    if(mode==='unknown-effects'&&strategy==='primary')neighbor.hidden=false;
    if(mode==='disabled-after-first'&&strategy==='primary'){const control=document.getElementById('primary-control');control.disabled=true;}
    for(const control of document.querySelectorAll('[aria-controls="goal-region"]'))control.setAttribute('aria-expanded',String(!goal.hidden));
    const after={goal:!goal.hidden,neighbor:!neighbor.hidden,url:location.href};
    const audit={caseId:mode,strategy,sequence,trusted:event.isTrusted,before,after,
      noBusinessEffects:mode!=='unknown-effects'&&before.goal===after.goal&&before.neighbor===after.neighbor&&before.url===after.url,
      downloads:0,navigation:false};
    document.getElementById('effect-audit').textContent=JSON.stringify(audit);
    document.getElementById('event-counts').textContent='Primary: '+counts.primary+' · Alternative: '+counts.secondary;
  });
  </script>`;
}
const portIndex = process.argv.indexOf('--port');
const port = portIndex < 0 ? 0 : Number(process.argv[portIndex + 1]);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/cases') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ cases, families })); return; }
  const caseId = url.searchParams.get('case') ?? cases[0];
  const family = url.searchParams.get('family') ?? families[0];
  if (!cases.includes(caseId) || !families.includes(family)) { res.writeHead(404); res.end('unknown fixture'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html(caseId, family));
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.address().port}`, cases, families })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
