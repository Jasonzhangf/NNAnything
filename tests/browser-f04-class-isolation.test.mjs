import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBasicKind, DEFAULT_BASIC_KIND_CONFIG } from "nnanything/browser";

// F04 isolation: state attributes and missing decorations must not erase a basic kind.
// Failure modes: a later wire adds a disabled/hidden veto; a "no poster" rule pushes video to other.
const complete = { contentEditable: false, directTextPresent: false, childElementCount: 0, positiveAreaChildCount: 0, repeatedChildGeometry: false, inVerifiedListParent: false, svgGraphicChildren: false };
const classify = (fields, profile) => classifyBasicKind({ role: null, ...complete, ...fields }, DEFAULT_BASIC_KIND_CONFIG, profile);

test("disabled and hidden are state facts and never a kind veto", () => {
  for (const disabled of [true, false]) {
    for (const hidden of [true, false]) {
      const button = classify({ tag: "button", disabled, hidden, directTextPresent: true, descendantTextPresent: true, tabIndexFocus: false, pointerCursor: true, parentPointerCursor: false });
      assert.equal(button.basicKind, "button", `button disabled=${disabled} hidden=${hidden}`);
      assert.equal(button.judgmentStatus, "judged");
      assert.deepEqual(button.evidence.stateFlags, { disabled, hidden });
    }
  }
});

test("readOnly input stays input because readOnly carries no basic-kind wire", () => {
  for (const disabled of [true, false]) {
    const input = classify({ tag: "input", inputType: "text", disabled, directTextPresent: false, tabIndexFocus: true, pointerCursor: true, parentPointerCursor: false });
    assert.equal(input.basicKind, "input", `input disabled=${disabled}`);
  }
});

test("a video without poster or background stays video and does not collapse to other", () => {
  for (const backgroundImagePresent of [false, null]) {
    const video = classify({ tag: "video", backgroundImagePresent, tabIndexFocus: false, pointerCursor: false, parentPointerCursor: false });
    assert.equal(video.basicKind, "video", `video backgroundImagePresent=${backgroundImagePresent}`);
    assert.equal(video.judgmentStatus, "judged");
    assert.notEqual(video.basicKind, "other");
  }
});

test("audio and native select classify without any interaction evidence", () => {
  const audio = classify({ tag: "audio", tabIndexFocus: false, pointerCursor: false, parentPointerCursor: false });
  assert.equal(audio.basicKind, "audio");
  const select = classify({ tag: "select", childElementCount: 3, tabIndexFocus: true, pointerCursor: true, parentPointerCursor: false });
  assert.equal(select.basicKind, "select");
});