#!/usr/bin/env node
// Offline self-check for the dev-family fixture and capture script.
//
// No browser and no network. It reads the fixture markup, checks the
// construction matrix, checks that the capture entry source keeps the
// production observer, and rebuilds the page-side bundle through esbuild so a
// broken import fails before the host runs real capture.
//
//   node playground/browser/focus-ignore/selfcheck-sample-repair-dev.mjs

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const fixturePath = resolve(scriptDir, "fixture-sample-repair-dev.html");
const capturePath = resolve(scriptDir, "capture-sample-repair-dev.mjs");

const failures = [];
const checks = [];
function check(label, condition, detail) {
  checks.push(label);
  if (condition !== true) failures.push(`${label}: ${detail ?? "expected true"}`);
}

const fixtureText = readFileSync(fixturePath, "utf8");
const captureText = readFileSync(capturePath, "utf8");

check("capture supports an explicit --port", /arg\("--port", "9444"\)/.test(captureText), "missing --port argument");
check("capture defaults the CDP endpoint to port 9444", /http:\/\/127\.0\.0\.1:\$\{portValue\}/.test(captureText), "missing endpoint construction");

function slotsOf(kind) {
  const out = [];
  const pattern = new RegExp(
    '<section class="slot" data-dev-case="([^"]+)" data-dev-construction="([^"]+)" data-dev-kind="' + kind + '" data-dev-states="([^"]+)"',
    "g",
  );
  let match;
  while ((match = pattern.exec(fixtureText)) !== null) out.push(match);
  return out.map(m => ({ caseId: m[1], construction: m[2], states: m[3] }));
}

function slotBlock(caseId) {
  const start = fixtureText.indexOf(`data-dev-case="${caseId}"`);
  if (start < 0) return "";
  const end = fixtureText.indexOf("</section>", start);
  return fixtureText.slice(start, end);
}

function containerAttributes(caseId) {
  const block = slotBlock(caseId);
  const match = block.match(/<div class="probe([^"]*)"([^>]*)>/);
  return {
    probeClass: match ? match[1].trim() : null,
    attributes: match ? match[2] : null,
  };
}

const positive = slotsOf("positive");
const ignore = slotsOf("ignore");

check("fixture has six positive slots", positive.length === 6, `got ${positive.length}`);
check("fixture has three ignore slots", ignore.length === 3, `got ${ignore.length}`);
check("positive slots declare four states", positive.every(s => s.states === "initial,focused,blurred,refocused"), JSON.stringify(positive));
check("ignore slots declare two states", ignore.every(s => s.states === "descendant-initial,descendant-focused"), JSON.stringify(ignore));

const expectedPositive = [
  ["positive-w1-neg1", "W1", "-1"],
  ["positive-w1-zero", "W1", "0"],
  ["positive-w2-neg1", "W2", "-1"],
  ["positive-w2-zero", "W2", "0"],
  ["positive-w3-neg1", "W3", "-1"],
  ["positive-w3-zero", "W3", "0"],
];
for (const [caseId, construction, tabindex] of expectedPositive) {
  const found = positive.find(s => s.caseId === caseId);
  check(`positive slot ${caseId} exists with construction`, found !== undefined && found.construction === construction, JSON.stringify(found));
  const attrs = containerAttributes(caseId);
  const hasTabindex = attrs.attributes !== null && new RegExp(`tabindex="${tabindex}"`).test(attrs.attributes);
  check(`positive slot ${caseId} declares tabindex ${tabindex}`, hasTabindex, JSON.stringify(attrs));
  check(`positive slot ${caseId} marks its container an own control`, attrs.attributes !== null && /data-dev-own-control="true"/.test(attrs.attributes), JSON.stringify(attrs));
}
const expectedIgnore = [["ignore-w1", "W1"], ["ignore-w2", "W2"], ["ignore-w3", "W3"]];
for (const [caseId, construction] of expectedIgnore) {
  const found = ignore.find(s => s.caseId === caseId);
  check(`ignore slot ${caseId} exists with construction`, found !== undefined && found.construction === construction, JSON.stringify(found));
  const attrs = containerAttributes(caseId);
  check(`ignore slot ${caseId} container carries no tabindex`, attrs.attributes !== null && !/tabindex=/.test(attrs.attributes), JSON.stringify(attrs));
  check(`ignore slot ${caseId} container is not marked an own control`, attrs.attributes !== null && !/data-dev-own-control/.test(attrs.attributes), JSON.stringify(attrs));
  check(`ignore slot ${caseId} marks one focus descendant`, /data-dev-focus-descendant="true"/.test(slotBlock(caseId)), caseId);
}

check("fixture has one parking control", (fixtureText.match(/data-dev-target="parking"/g) ?? []).length === 1, fixtureText);
check("fixture has no script block", !/<script/i.test(fixtureText), "unexpected script element");
check("fixture has no autofocus", !/autofocus/i.test(fixtureText), "unexpected autofocus");
check("fixture has no onload", !/onload/i.test(fixtureText), "unexpected onload handler");

// The ignore wrappers must be independent objects: their action targets are
// native buttons, never a positive container with a removed tabindex.
for (const [caseId] of expectedIgnore) {
  const block = slotBlock(caseId);
  check(`ignore slot ${caseId} uses a native button descendant`, /<button type="button"[^>]*data-dev-target="descendant"/.test(block), caseId);
  check(`ignore slot ${caseId} has no data-dev-own-control anywhere`, !/data-dev-own-control/.test(block), caseId);
}

check("capture references the production observer", /observeLiveDom/.test(captureText), "missing observeLiveDom");
check("capture references the production extractor", /extractBasicKindWires/.test(captureText), "missing extractBasicKindWires");
check("capture references the stable registry", /createStableNodeRefRegistry/.test(captureText), "missing createStableNodeRefRegistry");
check("capture uses CDP mouse input only", /Input\.dispatchMouseEvent/.test(captureText), "missing Input.dispatchMouseEvent");
check("capture sends no keyboard events", !/dispatchKeyEvent/.test(captureText), "unexpected dispatchKeyEvent");
check("capture declares the dev CDP default", /9444/.test(captureText), "missing 9444 default endpoint");
{
  const caseIds = [...new Set(captureText.match(/"(?:positive|ignore)-w\d[-\w]*"/g) ?? [])];
  check("capture lists nine distinct cases", caseIds.length === 9, `${caseIds.length} distinct ids`);
  check("capture lists all nine expected cases", [
    '"positive-w1-neg1"', '"positive-w1-zero"',
    '"positive-w2-neg1"', '"positive-w2-zero"',
    '"positive-w3-neg1"', '"positive-w3-zero"',
    '"ignore-w1"', '"ignore-w2"', '"ignore-w3"',
  ].every(id => caseIds.includes(id)), JSON.stringify(caseIds));
}

// The page-side entry source is a string literal; rebuild it so a broken
// import or type error fails here instead of at capture time.
const entryMatch = captureText.match(/const entrySource = String\.raw`\n([\s\S]*?)\n`;\n/);
check("capture exposes its page entry source", entryMatch !== null, "entry source block not found");
let bundleSize = 0;
if (entryMatch !== null) {
  check("page entry never dispatches DOM events", !/\.dispatchEvent\s*\(/.test(entryMatch[1]), "unexpected DOM event dispatch");
  check("page entry never calls focus", !/\.focus\s*\(/.test(entryMatch[1]), "unexpected focus call");
  check("page entry never calls click", !/\.click\s*\(/.test(entryMatch[1]), "unexpected click call");
  check("page entry never writes values", !/\.value\s*=/.test(entryMatch[1]), "unexpected value write");
  const bundled = await build({
    stdin: {
      contents: entryMatch[1],
      resolveDir: repo,
      sourcefile: "selfcheck-sample-repair-dev-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    logLevel: "silent",
  });
  bundleSize = bundled.outputFiles[0].contents.byteLength;
  check("page entry bundles", bundleSize > 0, String(bundleSize));
  check("page entry exposes the capture api", /__sampleRepairDev/.test(bundled.outputFiles[0].text), "missing window hook");
}

const expectedStates = 30;
check("capture plans thirty states", /stateSequence/.test(captureText) && /IGNORE_STATES = \["descendant-initial", "descendant-focused"\]/.test(captureText), "state plan not found");

if (failures.length > 0) {
  console.error(`selfcheck-sample-repair-dev FAILED (${failures.length})`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    checks: checks.length,
    expectedStates,
    bundleBytes: bundleSize,
    fixture: isAbsolute(fixturePath) ? fixturePath : resolve(fixturePath),
  }));
}
