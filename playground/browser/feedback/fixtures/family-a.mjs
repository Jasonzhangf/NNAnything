/**
 * Expanded-domain family A. Cards and a side panel. Independent from family B:
 * different markup, styles, ids, and event script.
 */
export function renderFamilyA({ caseId, mode }) {
  const initiallyExpanded = false;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Expanded family A · ${caseId}</title>
<style>
  :root { color-scheme: light; }
  body { font: 17px/1.45 "Iowan Old Style", Georgia, serif; margin: 0; background: #f2efe7; color: #20251f; }
  main { max-width: 920px; margin: 0 auto; padding: 40px 28px 120px; }
  .card { background: #fffdf7; border: 1px solid #b9b29f; border-radius: 6px; padding: 24px; margin: 0 0 18px; }
  .card h2 { margin: 0 0 8px; font-size: 22px; }
  .actions { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 16px; }
  #primary-control { font: inherit; padding: 11px 18px; border-radius: 4px; border: 1px solid #3e5c4b; background: #e4efe6; cursor: pointer; }
  #secondary-control { font: inherit; padding: 11px 18px; border: 1px solid #7b5f2f; background: #f6eedc; cursor: pointer; }
  #goal-panel { background: #f7fbf2; border-left: 5px solid #557a5e; padding: 22px; margin-top: 20px; }
  #neighbor-panel { background: #fbf4e8; padding: 18px; margin-top: 20px; }
  [hidden] { display: none !important; }
  #audit { display: block; margin-top: 24px; font: 13px ui-monospace, monospace; color: #4d554b; }
</style></head>
<body data-case="${caseId}" data-mode="${mode}">
<main id="workspace" data-ref="scope">
  <h1>Panel switches</h1>
  <article class="card">
    <h2>Document tools</h2>
    <p>Two controls describe the same panel and the same expansion effect.</p>
    <div class="actions">
      <button type="button" id="primary-control" aria-controls="goal-panel" aria-expanded="${initiallyExpanded}">Open document panel</button>
      <span id="secondary-control" role="button" tabindex="0" aria-disabled="false" aria-controls="goal-panel" aria-expanded="${initiallyExpanded}">Open document panel (alternate)</span>
    </div>
  </article>
  <aside id="goal-panel" role="region" aria-label="Document panel" ${initiallyExpanded ? '' : 'hidden'}>Document panel content.</aside>
  <aside id="neighbor-panel" role="region" aria-label="Other document state" hidden>Other document state changed.</aside>
  <output id="audit"></output>
</main>
<script>
(() => {
  const mode = ${JSON.stringify(mode)};
  const primary = document.getElementById('primary-control');
  const secondary = document.getElementById('secondary-control');
  const goal = document.getElementById('goal-panel');
  const neighbor = document.getElementById('neighbor-panel');
  const counts = { primary: 0, secondary: 0 };
  let sequence = 0;
  if (mode === 'target-invalid') primary.disabled = true;
  const snapshot = () => ({
    goal: !goal.hidden,
    neighbor: !neighbor.hidden,
    url: location.href,
  });
  const sync = () => {
    for (const control of [primary, secondary]) control.setAttribute('aria-expanded', String(!goal.hidden));
  };
  const audit = (control, before, after) => {
    const record = {
      caseId: ${JSON.stringify(caseId)},
      mode,
      control,
      sequence,
      trusted: true,
      before,
      after,
      noBusinessEffects: before.goal === after.goal && before.neighbor === after.neighbor && before.url === after.url,
      goalChanged: before.goal !== after.goal,
      otherEffect: before.neighbor !== after.neighbor || before.url !== after.url,
      downloads: 0,
      navigation: false,
    };
    window.__bFeedbackAudit = record;
    const output = document.getElementById('audit');
    if (output) output.textContent = JSON.stringify(record);
  };
  const click = (which) => {
    const before = snapshot();
    counts[which] += 1;
    sequence += 1;
    if (which === 'primary') {
      if (mode === 'receipt-success-no-change' && counts.primary >= 2) goal.hidden = false;
      if (mode === 'other-effect') neighbor.hidden = false;
      if (mode === 'achieved-then-throw' || mode === 'post-missing' || mode === 'post-stale') goal.hidden = false;
    } else {
      if (mode === 'primary-twice-then-secondary') goal.hidden = false;
    }
    sync();
    audit(which, before, snapshot());
  };
  primary.addEventListener('click', event => { if (event.isTrusted) click('primary'); });
  secondary.addEventListener('click', event => { if (event.isTrusted) click('secondary'); });
  window.__bFeedbackState = () => ({
    caseId: ${JSON.stringify(caseId)},
    mode,
    counts: { ...counts },
    goalExpanded: !goal.hidden,
    neighborVisible: !neighbor.hidden,
    audit: window.__bFeedbackAudit ?? null,
  });
  sync();
})();
</script>
</body></html>`;
}
