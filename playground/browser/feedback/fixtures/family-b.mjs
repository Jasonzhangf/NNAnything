/**
 * Expanded-domain family B. A toolbar over a stacked sheet. This renderer is
 * intentionally separate from family A: different markup, styles, ids, and
 * event wiring so a passing pair cannot come from one shared renderer.
 */
export function renderFamilyB({ caseId, mode }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Expanded family B · ${caseId}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #eef2f4; color: #1b2a31; font: 16px/1.4 "Avenir Next", system-ui, sans-serif; }
  #shell { max-width: 980px; margin: 0 auto; padding: 34px 24px 90px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 2px solid #8ba6b2; padding-bottom: 12px; }
  header h1 { font-size: 21px; margin: 0; letter-spacing: 0; }
  nav { display: flex; align-items: center; gap: 10px; }
  #run-primary { font: inherit; padding: 10px 15px; border: 0; border-radius: 3px; background: #1f5266; color: #fff; cursor: pointer; }
  #run-secondary { font: inherit; padding: 10px 15px; border: 1px solid #6f8e99; border-radius: 3px; background: #dce8ec; cursor: pointer; }
  .sheet { margin-top: 22px; border: 1px solid #9db4bd; background: #ffffff; padding: 20px; }
  #panel-region { margin-top: 16px; border-top: 4px solid #2f6f57; background: #f2faf5; padding: 20px; }
  #changed-region { margin-top: 16px; background: #fff7e8; padding: 16px; }
  [hidden] { display: none !important; }
  #audit-log { display: block; margin-top: 26px; font: 12px ui-monospace, monospace; color: #4d5e66; }
</style></head>
<body data-case="${caseId}" data-mode="${mode}">
<div id="shell" data-ref="scope">
  <header>
    <h1>Sheet controls</h1>
    <nav>
      <button type="button" id="run-primary" aria-controls="panel-region" aria-expanded="false">Reveal sheet</button>
      <span id="run-secondary" role="button" tabindex="0" aria-disabled="false" aria-controls="panel-region" aria-expanded="false">Reveal sheet, alternative</span>
    </nav>
  </header>
  <section class="sheet">
    <p>The toolbar controls below share one explicit sheet-expansion effect.</p>
    <section id="panel-region" role="region" aria-label="Revealable sheet" hidden>Revealable sheet content.</section>
    <section id="changed-region" aria-label="Other sheet state" hidden>Other sheet state changed.</section>
  </section>
  <output id="audit-log"></output>
</div>
<script>
(() => {
  const MODE = ${JSON.stringify(mode)};
  const CASE = ${JSON.stringify(caseId)};
  const primary = document.getElementById('run-primary');
  const secondary = document.getElementById('run-secondary');
  const panel = document.getElementById('panel-region');
  const changed = document.getElementById('changed-region');
  const log = document.getElementById('audit-log');
  let primaryCount = 0;
  let secondaryCount = 0;
  let events = 0;
  if (MODE === 'target-invalid') primary.disabled = true;
  const read = () => ({ expanded: panel.hidden === false, other: changed.hidden === false, href: String(location.href) });
  const publish = (which, trusted, before, after) => {
    const record = {
      caseId: CASE,
      mode: MODE,
      control: which,
      sequence: events,
      trusted,
      before: { goal: before.expanded, neighbor: before.other, url: before.href },
      after: { goal: after.expanded, neighbor: after.other, url: after.href },
      noBusinessEffects: before.expanded === after.expanded && before.other === after.other && before.href === after.href,
      goalChanged: before.expanded !== after.expanded,
      otherEffect: before.other !== after.other || before.href !== after.href,
      downloads: 0,
      navigation: false,
    };
    window.__bFeedbackAudit = record;
    if (log) log.textContent = JSON.stringify(record);
  };
  const toggleLabel = () => {
    for (const control of [primary, secondary]) {
      control.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    }
  };
  const handle = (which, trusted) => {
    const before = read();
    events += 1;
    if (which === 'primary') {
      primaryCount += 1;
      if (MODE === 'receipt-success-no-change' && primaryCount > 1) panel.hidden = false;
      if (MODE === 'other-effect') changed.hidden = false;
      if (MODE === 'achieved-then-throw' || MODE === 'post-missing' || MODE === 'post-stale') panel.hidden = false;
    } else {
      secondaryCount += 1;
      if (MODE === 'primary-twice-then-secondary') panel.hidden = false;
    }
    toggleLabel();
    publish(which, trusted, before, read());
  };
  primary.addEventListener('click', event => { if (event.isTrusted) handle('primary', event.isTrusted); });
  secondary.addEventListener('click', event => { if (event.isTrusted) handle('secondary', event.isTrusted); });
  window.__bFeedbackState = () => ({
    caseId: CASE,
    mode: MODE,
    counts: { primary: primaryCount, secondary: secondaryCount },
    goalExpanded: panel.hidden === false,
    neighborVisible: changed.hidden === false,
    audit: window.__bFeedbackAudit ?? null,
  });
  toggleLabel();
})();
</script>
</body></html>`;
}
