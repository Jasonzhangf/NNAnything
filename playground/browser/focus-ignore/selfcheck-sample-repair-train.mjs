// Offline static self-check for the sample-repair-train family.
//
// This script never opens a browser and never makes a network request. It
// reads the fixture HTML and the host-side capture script, parses the machine
// contract from the fixture markup, and checks that the construction matrix,
// the capture driver plan, and the guard rails in the driver are complete.
// It does not classify or predict any label.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const here = process.cwd();
const fixturePath = resolve(here, "playground/browser/focus-ignore/fixture-sample-repair-train.html");
const capturePath = resolve(here, "playground/browser/focus-ignore/capture-sample-repair-train.mjs");
const fixture = await readFile(fixturePath, "utf8");
const capture = await readFile(capturePath, "utf8");

// Strip comment lines from the driver before contract-word checks so the
// explanatory comments cannot cause false positives.
const strippedCapture = capture
  .split("\n")
  .map(line => line.replace(/\/\/.*$/, ""))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const failures = [];
const expect = (condition, message) => {
  if (condition) return;
  failures.push(message);
};

// Guard rails: the capture driver must never script focus or synthetic DOM
// events. These are hard contract checks for the host-run code.
const forbiddenInPageScript = [
  [/\.focus\s*\(/, "page script must not call element.focus()"],
  [/\.click\s*\(/, "page script must not call element.click()"],
  [/dispatchEvent/, "page script must not call dispatchEvent"],
  [/autofocus/i, "fixture must not use autofocus"],
  [/onload.*focus|addEventListener\(\s*["']load["']/i, "fixture must not focus on load"],
  [/window\.addEventListener.*focus|document\.addEventListener.*focus/i, "fixture must not install focus listeners"],
];
for (const [pattern, message] of forbiddenInPageScript) {
  expect(!pattern.test(fixture) && !pattern.test(strippedCapture), message);
}

// The whole capture driver (including page source) must not use any forbidden
// DOM action words, because element.focus/click would violate the contract
// even in host-side evaluation code.
const forbiddenInDriver = [
  [/\.focus\s*\(/, "driver must not call .focus()"],
  [/\.click\s*\(/, "driver must not call .click()"],
  [/dispatchEvent/, "driver must not call dispatchEvent"],
];
for (const [pattern, message] of forbiddenInDriver) {
  expect(!pattern.test(strippedCapture), message);
}

// Target matrix: 6 positive containers with explicit -1 or 0 tabindex plus 3
// ignore wrappers, each marked with machine data attributes.
const targetTags = [...fixture.matchAll(/data-train-role="target"[\s\S]*?data-wrapper-type="([^"]+)"[^>]*tabindex="(-1|0)"/g)];
const targetKeys = [...fixture.matchAll(/data-train-key="(positive-[^"]+)"[\s\S]*?data-train-role="target"/g)];
const ignoreWrappers = [...fixture.matchAll(/data-train-role="ignore-wrapper"[\s\S]*?data-wrapper-type="([^"]+)"/g)];
const ignoreActions = [...fixture.matchAll(/data-train-role="action-child"/g)];
const allFixtureKeys = [...fixture.matchAll(/data-train-key="([^"]+)"/g)].map(match => match[1]);

expect(targetTags.length === 6, `expected 6 positive targets, got ${targetTags.length}`);
expect(new Set(targetTags.map(match => match[1])).size === 3, "positive targets must cover W1/W2/W3");
expect(targetTags.filter(match => match[2] === "-1").length === 3, "expected 3 tabindex=-1 positive targets");
expect(targetTags.filter(match => match[2] === "0").length === 3, "expected 3 tabindex=0 positive targets");
expect(targetKeys.length === 6, `expected 6 positive target keys, got ${targetKeys.length}`);
expect(new Set(targetKeys.map(match => match[1])).size === 6, "positive target keys must be unique");
expect(targetKeys.every(match => /^positive-w[123]-(neg1|zero)$/.test(match[1])), "positive target keys must follow the matrix naming");
expect(ignoreWrappers.length === 3, `expected 3 ignore wrappers, got ${ignoreWrappers.length}`);
expect(new Set(ignoreWrappers.map(match => match[1])).size === 3, "ignore wrappers must cover W1/W2/W3");
expect(ignoreWrappers.every(match => allFixtureKeys.includes(`ignore-${match[1].toLowerCase()}`)), "each ignore wrapper must have a machine key");
expect(ignoreActions.length >= 3, `expected at least 3 action children, got ${ignoreActions.length}`);

// W1 line must have one direct element child and keep its own padding.
const w1Markup = fixture.match(/class="focus-line w1"[\s\S]*?<span data-train-child="1">[\s\S]*?<\/span>/);
expect(w1Markup !== null, "W1 lines must contain a single direct span child");
expect((fixture.match(/tabindex="-1"/g) ?? []).length === 3, "fixture must contain three tabindex=-1 declarations");
expect((fixture.match(/tabindex="0"/g) ?? []).length === 3, "fixture must contain three tabindex=0 declarations");

// W2 must be a distinct layout: one direct child, clearly different geometry.
expect(fixture.includes('class="focus-line w2"'), "fixture must define W2 layouts");
expect(fixture.includes("justify-content: flex-end") && fixture.includes("min-height: 118px"), "W2 must reserve real geometry difference");

// W3 must contain multiple direct children with the parent keeping an area.
expect((fixture.match(/class="focus-line w3"[\s\S]*?<span data-train-child="1">[\s\S]*?<span data-train-child="2">/g) ?? []).length === 2, "W3 positive lines must contain two direct children each");
expect((fixture.match(/class="ignore-wrap w3"[\s\S]*?<button[\s\S]*?<button/g) ?? []).length >= 1, "W3 ignore wrapper must contain two action children");

// Every positive target and every ignore wrapper must carry a unique key that
// the driver references.
const expectedPositiveKeys = ["positive-w1-neg1", "positive-w1-zero", "positive-w2-neg1", "positive-w2-zero", "positive-w3-neg1", "positive-w3-zero"];
const expectedIgnoreKeys = ["ignore-w1", "ignore-w2", "ignore-w3"];
for (const key of [...expectedPositiveKeys, ...expectedIgnoreKeys]) {
  expect(fixture.includes(`data-train-key="${key}"`), `fixture must include target ${key}`);
}
expect(strippedCapture.includes('positive-${wrapperType.toLowerCase()}'), "driver must generate positive keys from wrapper type");
expect(strippedCapture.includes('"neg1"') && strippedCapture.includes('"zero"'), "driver must generate positive tabindex key suffixes");
expect(strippedCapture.includes('ignore-${wrapperType.toLowerCase()}'), "driver must generate ignore keys from wrapper type");

// Capture driver must implement the required episode shape: initial, focused,
// blurred, refocused for positives and before/after for ignores, including
// the real CDP mouse event sequence.
for (const word of ["Input.dispatchMouseEvent", '"mouseMoved"', '"mousePressed"', '"mouseReleased"', "clickParking", "focusTarget", "snapshotState", "pointHitsTarget"]) {
  expect(capture.includes(word), `capture must contain ${word}`);
}
expect(capture.includes('"initial"') && capture.includes('"focused"') && capture.includes('"blurred"') && capture.includes('"refocused"'), "capture must drive the four positive states");
expect(capture.includes('"before"') && capture.includes('"after"'), "capture must drive the two ignore states");
expect(capture.includes("const beforeStimulus = await clickParking(call);"), "ignore before state must park focus first");

// Driver must validate the production wires for focused positives: af and fc
// from the extraction output, not from the tabindex declaration.
expect(capture.includes("neutral_actual_focus") && capture.includes("neutral_focusable_control") && capture.includes("own_focus_target"), "capture must validate production focus wires");
expect(capture.includes("neutral_single_child") && capture.includes("neutral_single_element_wrapper") && capture.includes("neutral_single_positive_wrapper"), "capture must validate the W1 repair wires");
expect(fixture.includes("data-train-family=\"sample-repair-train\""), "fixture must carry the family marker");

// Parking control plus action children.
expect(fixture.includes('data-train-key="train-parking"'), "fixture must include the external parking control");

if (failures.length > 0) {
  console.error("selfcheck-sample-repair-train failed:");
  for (const message of failures) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log("selfcheck-sample-repair-train ok");
}
