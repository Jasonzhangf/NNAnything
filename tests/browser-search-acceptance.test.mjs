import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {readBrowserSearchObservation} from 'nnanything/browser-search';
import {CASE_ROWS, materializeConfig} from '../playground/browser/search/cases.mjs';
import {familyBSearch} from '../playground/browser/search-fixture/family-b/data.mjs';
import {renderFamilyBPage} from '../playground/browser/search-fixture/family-b/page.mjs';

// native-io reads BSEARCH_CASE_DIR at import time. Give it a neutral case
// config so buildObservation can be exercised without CDP or a live fixture.
const nativeCaseDir = await mkdtemp(join(tmpdir(), 'bsearch-native-target-'));
await writeFile(join(nativeCaseDir, 'case.json'), JSON.stringify({selectors: {}, bindings: {}}));
const previousCaseDir = process.env.BSEARCH_CASE_DIR;
process.env.BSEARCH_CASE_DIR = nativeCaseDir;
process.env.BSEARCH_READ_TIMEOUT_MS = '1000';
const {buildObservation} = await import('../playground/browser/search/native-io.mjs');
after(async () => {
  if (previousCaseDir === undefined) delete process.env.BSEARCH_CASE_DIR;
  else process.env.BSEARCH_CASE_DIR = previousCaseDir;
  await rm(nativeCaseDir, {recursive: true, force: true});
});

test('the two-family matrix keeps 22 independent runs per family', () => {
  assert.equal(CASE_ROWS.length, 22);
  assert.equal(new Set(CASE_ROWS.map(row => `${row.caseId}:${row.variant}`)).size, 22);
  assert.ok(CASE_ROWS.some(row => row.caseId === 'C18' && row.variant === 'stale'));
  assert.ok(CASE_ROWS.some(row => row.caseId === 'C18' && row.variant === 'observe-error'));
  assert.ok(CASE_ROWS.some(row => row.caseId === 'C19' && row.variant === 'matched_items'));
  assert.ok(CASE_ROWS.some(row => row.caseId === 'C19' && row.variant === 'visible_batch'));
});

test('family B C14 uses two independently matching main items', () => {
  const row = CASE_ROWS.find(candidate => candidate.caseId === 'C14');
  assert.ok(row);
  const config = materializeConfig('B', row);
  assert.equal(config.scenario, 'two-matches');
  assert.equal(config.params.scenario, 'two-matches');
  assert.equal(config.goal.minimumMatches, 2);
  const result = familyBSearch({query: config.goal.query, requestRef: 'request-c14', scenario: config.scenario});
  const matches = result.items.filter(text => text.includes(config.goal.containsText));
  assert.equal(matches.length, 2);
  assert.ok(result.aside.some(text => text.includes(config.goal.containsText)));
});

test('family B C13 keeps the main list non-matching while the aside matches', () => {
  const row = CASE_ROWS.find(candidate => candidate.caseId === 'C13');
  assert.ok(row);
  const config = materializeConfig('B', row);
  assert.equal(config.scenario, 'aside-match');
  assert.equal(config.params.scenario, 'aside-match');
  const result = familyBSearch({query: config.goal.query, requestRef: 'request-c13', scenario: config.scenario});
  assert.equal(result.items.filter(text => text.includes(config.goal.containsText)).length, 0);
  assert.ok(result.aside.some(text => text.includes(config.goal.containsText)));
});

test('family B keeps a distinct DOM, client and search implementation', async () => {
  const html = renderFamilyBPage();
  assert.match(html, /<ol id="main-results"><\/ol>/);
  assert.match(html, /<aside aria-label="资料旁栏">/);
  assert.match(html, /src="\/family-b\/client\.js"/);
  assert.match(html, /placeholder="旧推荐词：城市散步路线"/);
  assert.doesNotMatch(html, /data-gold|expected-id|case-answer/);

  const pageSource = await readFile(new URL('../playground/browser/search-fixture/family-b/page.mjs', import.meta.url), 'utf8');
  const clientSource = await readFile(new URL('../playground/browser/search-fixture/family-b/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pageSource, /from ['"]\.\.\/page\.mjs['"]/);
  assert.doesNotMatch(pageSource, /renderPage/);
  assert.doesNotMatch(clientSource, /const pages=|mainPages=|asidePages=/);
  assert.match(clientSource, /form\.addEventListener\('submit'/);
  assert.match(clientSource, /fetch\(`\/family-b\/api\/search/);
});

test('native IO reads only the per-case binding and keeps read-only observation separate', async () => {
  const source = await readFile(new URL('../playground/browser/search/native-io.mjs', import.meta.url), 'utf8');
  assert.match(source, /BSEARCH_CASE_DIR/);
  assert.match(source, /Input\.dispatchMouseEvent/);
  assert.match(source, /Input\.dispatchKeyEvent/);
  assert.match(source, /Input\.insertText/);
  assert.doesNotMatch(source, /materializeExpected|CASE_ROWS|rows\.jsonl/);
  assert.doesNotMatch(source, /\.focus\s*\(|\.click\s*\(|requestSubmit\s*\(|dispatchEvent\s*\(/);
});

test('native search observation carries a typed, resolvable input target with real hit facts', () => {
  const raw = {
    documentRef: 'search-doc',
    scopeRef: 'search-scope',
    inputRef: 'query',
    submitRef: 'submit',
    collectionRef: 'main',
    resultScopeRef: 'results',
    inputTag: 'input',
    inputType: 'text',
    inputValue: '露营',
    editable: true,
    submittedQuery: null,
    resultsQuery: null,
    submittedRequestRef: null,
    resultsRequestRef: null,
    collectionRequestRef: null,
    batch: null,
    request: 'unknown',
    display: 'none',
    access: 'available',
    atGeometryBoundary: null,
    hasMore: null,
    items: [],
    target: {
      present: true,
      ref: 'query',
      connected: true,
      currentRef: 'query',
      host: 'input',
      contentEditable: false,
      type: 'text',
      value: '露营',
      placeholder: null,
      nativeDisabled: false,
      ariaDisabled: null,
      nativeReadonly: false,
      ariaReadonly: null,
      readonlyState: 'editable',
      editable: true,
      activeElementRef: null,
      activeElementFocus: false,
      hit: {status: 'observed', value: true},
      point: {status: 'observed', value: {x: 42, y: 73}},
    },
  };
  const built = buildObservation(raw, 3);
  assert.ok(built.target, 'native observation must include the input target');
  const parsed = readBrowserSearchObservation(built);
  assert.equal(parsed.target.ref, 'query');
  assert.equal(parsed.target.value.value, '露营');
  assert.equal(parsed.target.executableHit.status, 'observed');
  assert.equal(parsed.target.executableHit.value, true);
  assert.equal(parsed.target.point.value.x, 42);
  const refs = [...parsed.target.executableHit.evidenceRefs, ...parsed.target.point.evidenceRefs];
  assert.ok(refs.length > 0, 'hit and point facts must carry local evidence');
  for (const ref of refs) {
    assert.ok(parsed.evidence.some(item => item.id === ref), `evidence ${ref} must resolve`);
  }
  assert.equal(parsed.target.value.evidenceRefs.length, 1);
});

test('native search target stays unknown when hit cannot be measured, never fabricates false', () => {
  const raw = {
    documentRef: 'search-doc',
    scopeRef: 'search-scope',
    inputRef: 'query',
    submitRef: 'submit',
    collectionRef: 'main',
    resultScopeRef: 'results',
    inputTag: 'input',
    inputType: 'text',
    inputValue: '露营',
    editable: true,
    submittedQuery: null,
    resultsQuery: null,
    submittedRequestRef: null,
    resultsRequestRef: null,
    collectionRequestRef: null,
    batch: null,
    request: 'unknown',
    display: 'none',
    access: 'available',
    atGeometryBoundary: null,
    hasMore: null,
    items: [],
    target: {
      present: true,
      ref: 'query',
      connected: true,
      currentRef: 'query',
      host: 'input',
      contentEditable: false,
      type: 'text',
      value: '露营',
      placeholder: null,
      nativeDisabled: false,
      ariaDisabled: null,
      nativeReadonly: false,
      ariaReadonly: null,
      readonlyState: 'editable',
      editable: true,
      activeElementRef: null,
      activeElementFocus: false,
      hit: {status: 'unknown', reason: 'elementsFromPoint_failed'},
      point: {status: 'unknown', reason: 'native_hit_point_unavailable'},
    },
  };
  const parsed = readBrowserSearchObservation(buildObservation(raw, 4));
  assert.equal(parsed.target.executableHit.status, 'unknown');
  assert.equal(parsed.target.point.status, 'unknown');
});
