import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {CASE_ROWS, materializeConfig} from '../playground/browser/search/cases.mjs';
import {familyBSearch} from '../playground/browser/search-fixture/family-b/data.mjs';
import {renderFamilyBPage} from '../playground/browser/search-fixture/family-b/page.mjs';

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
