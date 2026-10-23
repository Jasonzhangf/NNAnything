// Offline static self-check for the sample-repair-verification family.
//
// This script never opens a browser and never connects to CDP. It reads the
// fixture HTML and the capture source, checks the 9-object / 30-state matrix,
// and checks that the capture contract stays native-mouse-only and free of
// scripted focus, click, and event dispatch APIs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  POSITIVE_CASES,
  IGNORE_CASES,
  POSITIVE_STATES,
  IGNORE_STATES,
  buildStatePlan,
} from "./capture-sample-repair-verification.mjs";

const fixturePath = fileURLToPath(new URL("./fixture-sample-repair-verification.html", import.meta.url));
const capturePath = fileURLToPath(new URL("./capture-sample-repair-verification.mjs", import.meta.url));
const fixture = await readFile(fixturePath, "utf8");
const capture = await readFile(capturePath, "utf8");

function attribute(tagSource, name) {
  const match = tagSource.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`));
  return match === null ? null : match[1];
}

function caseBlocks(html) {
  const blocks = [];
  const re = /<div\b[^>]*>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0];
    if (!/\bdata-v-case=/.test(tag)) continue;
    const afterTag = re.lastIndex;
    const scan = /<div\b[^>]*>|<\/div\s*>/g;
    scan.lastIndex = match.index;
    let depth = 0;
    let close = null;
    let innerMatch;
    while ((innerMatch = scan.exec(html)) !== null) {
      if (innerMatch[0].startsWith("</")) {
        depth -= 1;
        if (depth === 0) {
          close = innerMatch.index;
          break;
        }
      } else {
        depth += 1;
      }
    }
    if (close === null) throw new Error(`unclosed case div at offset ${match.index}`);
    blocks.push({
      tag,
      caseId: attribute(tag, "data-v-case"),
      inner: html.slice(afterTag, close),
    });
  }
  return blocks;
}

function directChildren(inner) {
  const children = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const re = /<([a-zA-Z][\w-]*)\b([^>]*)>|<\/([a-zA-Z][\w-]*)\s*>/g;
  let depth = 0;
  let match;
  while ((match = re.exec(inner)) !== null) {
    if (match[0].startsWith("</")) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const selfClosing = /\/\s*>$/.test(match[0]) || voidTags.has(tag);
    if (depth === 0) children.push({ tag, attrs });
    if (!selfClosing) depth += 1;
  }
  return children;
}

const plan = buildStatePlan();
assert.equal(POSITIVE_CASES.length, 6, "must have 6 positive container objects");
assert.equal(IGNORE_CASES.length, 3, "must have 3 ignore wrapper objects");
assert.equal(POSITIVE_STATES.length, 4, "must have 4 positive states per object");
assert.equal(IGNORE_STATES.length, 2, "must have 2 ignore states per object");
assert.equal(plan.length, 30, "must have 30 state rows");
for (const construction of ["W1", "W2", "W3"]) {
  const tabindexes = [...new Set(POSITIVE_CASES.filter(item => item.construction === construction).map(item => item.tabindex))].sort();
  assert.deepEqual(tabindexes, ["-1", "0"], `${construction} must have -1 and 0 objects`);
}
const allCaseIds = new Set([...POSITIVE_CASES, ...IGNORE_CASES].map(item => item.caseId));
assert.equal(allCaseIds.size, 9, "9 distinct objects");

assert.ok(!/<script\b/i.test(fixture), "fixture must not contain a script element");
assert.ok(!/\bautofocus\b/i.test(fixture), "fixture must not autofocus");
assert.ok(!/\bon(?:focus|blur)\s*=/i.test(fixture), "fixture must not declare focus or blur handlers");
assert.ok(/\bdata-v-parking\b/.test(fixture), "fixture must provide an external parking control");
assert.match(fixture, /<button\b[^>]*\bdata-v-parking\b[^>]*>/);
assert.match(fixture, /\.v-target[^{]*\{[^}]*padding:/, "targets need padding so a container hit point exists");
assert.match(fixture, /\.v-ignore[^{]*\{[^}]*padding:/, "ignore wrappers need padding so descendants are reachable");
assert.doesNotMatch(fixture, /position\s*:\s*absolute/i, "no absolute full-cover children may erase hit points");
assert.doesNotMatch(fixture, /\binset\s*:\s*0/i);
assert.match(fixture, /\.v-w2\s*\{[^}]*border:/, "W2 must have a real geometric boundary");
assert.match(fixture, /\.v-w3\s*\{[^}]*grid-template-columns:[^}]*1fr[^}]*1fr/, "W3 must be a multi-child container");

const blocks = caseBlocks(fixture);
assert.equal(blocks.length, 9, "fixture must contain exactly 9 case objects");
const byCase = new Map(blocks.map(block => [block.caseId, block]));

for (const item of POSITIVE_CASES) {
  const block = byCase.get(item.caseId);
  assert.ok(block, `missing positive case ${item.caseId}`);
  assert.equal(attribute(block.tag, "data-v-gold"), "container", `${item.caseId} gold`);
  assert.equal(attribute(block.tag, "data-v-construction"), item.construction, `${item.caseId} construction`);
  assert.equal(attribute(block.tag, "tabindex"), item.tabindex, `${item.caseId} tabindex`);
  assert.equal(attribute(block.tag, "data-v-tabindex"), item.tabindex, `${item.caseId} declared tabindex`);
  const children = directChildren(block.inner);
  if (item.construction === "W3") {
    assert.equal(children.length, 2, `${item.caseId} must have two direct children`);
    assert.ok(children.every(child => child.tag === "div" && /\bv-metric\b/.test(child.attrs)), `${item.caseId} metric children`);
  } else {
    assert.equal(children.length, 1, `${item.caseId} must have one direct child`);
    assert.equal(children[0].tag, "div", `${item.caseId} single child tag`);
    assert.ok(/\bv-readout\b/.test(children[0].attrs), `${item.caseId} readout child`);
  }
  if (item.construction === "W1") assert.ok(/\bv-w1\b/.test(block.tag), `${item.caseId} W1 class`);
  if (item.construction === "W2") assert.ok(/\bv-w2\b/.test(block.tag), `${item.caseId} W2 class`);
  if (item.construction === "W3") assert.ok(/\bv-w3\b/.test(block.tag), `${item.caseId} W3 class`);
}

for (const item of IGNORE_CASES) {
  const block = byCase.get(item.caseId);
  assert.ok(block, `missing ignore case ${item.caseId}`);
  assert.equal(attribute(block.tag, "data-v-gold"), "ignore", `${item.caseId} gold`);
  assert.equal(attribute(block.tag, "data-v-construction"), item.construction, `${item.caseId} construction`);
  assert.equal(attribute(block.tag, "tabindex"), null, `${item.caseId} wrapper must not be focusable`);
  const children = directChildren(block.inner);
  if (item.construction === "W3") {
    assert.equal(children.length, 2, `${item.caseId} must have two direct children`);
    assert.ok(children.every(child => child.tag === "button"), `${item.caseId} button children`);
  } else {
    assert.equal(children.length, 1, `${item.caseId} must have one direct child`);
    assert.equal(children[0].tag, "button", `${item.caseId} descendant button`);
  }
  assert.match(block.inner, new RegExp(`data-v-descendant="${item.descendant}"`), `${item.caseId} descendant id`);
}

assert.match(capture, /Input\.dispatchMouseEvent/, "capture must drive real CDP mouse events");
assert.ok(capture.includes('type: "mouseMoved"'), "capture must move the mouse");
assert.ok(capture.includes('type: "mousePressed"'), "capture must press the left button");
assert.ok(capture.includes('type: "mouseReleased"'), "capture must release the left button");
assert.ok(capture.includes('button: "left"'), "capture must use the left mouse button");
assert.ok(capture.includes("--out"), "capture must accept an --out path");
assert.match(capture, /DEFAULT_PORT = 9444/, "capture must default to CDP port 9444");
assert.ok(capture.includes("observeLiveDom"), "capture must load the production live adapter");
assert.ok(capture.includes("createStableNodeRefRegistry"), "capture must load the stable ref registry");
assert.ok(capture.includes("extractBasicKindWires"), "capture must load the production wire extractor");
assert.ok(!/\bInput\.dispatchKeyEvent\b/.test(capture), "capture must not use key events");

for (const [label, source] of [["fixture", fixture], ["capture", capture]]) {
  assert.ok(!/\.focus\s*\(/.test(source), `${label} must not call a scripted focus API`);
  assert.ok(!/\.click\s*\(/.test(source), `${label} must not call a scripted click API`);
  assert.ok(!/\bdispatchEvent\s*\(/.test(source), `${label} must not dispatch events`);
}

console.log(`selfcheck ok: ${POSITIVE_CASES.length * POSITIVE_STATES.length} positive rows, ${IGNORE_CASES.length * IGNORE_STATES.length} ignore rows, ${plan.length} total`);
