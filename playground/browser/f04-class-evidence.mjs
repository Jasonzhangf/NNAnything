// F04 per-class evidence: three isolation semantics the plan names, via the public classifier.
// Read-only; writes only its own report.
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { classifyBasicKind } from "nnanything/browser-classify";

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : resolve("f04-class-evidence.json");
const config = { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 };

const cases = [
  {
    id: "disabled-button-still-button",
    semantics: "disabled button remains button",
    input: { tag: "button", role: null, disabled: true, hidden: false, directTextPresent: true, descendantTextPresent: true, childElementCount: 0, positiveAreaChildCount: 0, contentEditable: false, tabIndexFocus: false, pointerCursor: true, parentPointerCursor: false },
    expectedKind: "button",
  },
  {
    id: "aria-disabled-button-still-button",
    semantics: "aria-disabled button remains button",
    input: { tag: "button", role: null, disabled: true, hidden: false, directTextPresent: true, descendantTextPresent: true, childElementCount: 0, positiveAreaChildCount: 0, contentEditable: false, tabIndexFocus: false, pointerCursor: true, parentPointerCursor: false },
    expectedKind: "button",
  },
  {
    id: "readonly-input-still-input",
    semantics: "readOnly input remains input (readOnly is not a basic-kind wire)",
    input: { tag: "input", role: null, disabled: false, hidden: false, inputType: "text", contentEditable: false, directTextPresent: false, childElementCount: 0, positiveAreaChildCount: 0, tabIndexFocus: true, pointerCursor: true, parentPointerCursor: false },
    expectedKind: "input",
  },
  {
    id: "video-without-poster-not-other",
    semantics: "video without poster does not collapse to other",
    input: { tag: "video", role: null, disabled: false, hidden: false, contentEditable: false, directTextPresent: false, childElementCount: 0, positiveAreaChildCount: 0, backgroundImagePresent: false, tabIndexFocus: false, pointerCursor: false, parentPointerCursor: false },
    expectedKind: "video",
  },
  {
    id: "audio-plain-element",
    semantics: "audio element classifies as audio",
    input: { tag: "audio", role: null, disabled: false, hidden: false, contentEditable: false, directTextPresent: false, childElementCount: 0, positiveAreaChildCount: 0, tabIndexFocus: false, pointerCursor: false, parentPointerCursor: false },
    expectedKind: "audio",
  },
  {
    id: "native-select-element",
    semantics: "native select classifies as select",
    input: { tag: "select", role: null, disabled: false, hidden: false, contentEditable: false, directTextPresent: false, childElementCount: 3, positiveAreaChildCount: 0, tabIndexFocus: true, pointerCursor: true, parentPointerCursor: false },
    expectedKind: "select",
  },
  {
    id: "hidden-does-not-erase-kind",
    semantics: "hidden attribute does not by itself erase an unambiguous kind",
    input: { tag: "video", role: null, disabled: false, hidden: true, contentEditable: false, directTextPresent: false, childElementCount: 0, positiveAreaChildCount: 0, tabIndexFocus: false, pointerCursor: false, parentPointerCursor: false },
    expectedKind: "video",
  },
];

const results = [];
for (const item of cases) {
  const judgment = classifyBasicKind(item.input, config);
  results.push({
    id: item.id,
    semantics: item.semantics,
    expectedKind: item.expectedKind,
    actualKind: judgment.basicKind,
    judgmentStatus: judgment.judgmentStatus,
    familyStatus: judgment.familyStatus,
    score: judgment.score,
    margin: judgment.margin,
    stateFlags: judgment.evidence?.stateFlags ?? null,
    pass: judgment.basicKind === item.expectedKind,
  });
}

const failed = results.filter(row => !row.pass);
const report = {
  cases: results.length,
  passed: results.length - failed.length,
  failed,
  results,
  note: "Deterministic public classifier inputs. disabled/hidden are state wires, not kind vetoes. readOnly has no basic-kind wire. These are contract-level isolation facts, not a generalization claim.",
};
await mkdir(dirname(resolve(out)), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;