import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEEDBACK_HEADS } from 'nnanything/browser-feedback';
import { auditFeedbackProjections, feedbackFeatures, makeFeedbackSamples } from 'nnanything/browser-feedback';

test('public projection audit groups identical twelve-wire student projections', () => {
  const samples = makeFeedbackSamples();
  const audit = auditFeedbackProjections(samples);
  assert.equal(audit.count, samples.length);
  assert.ok(audit.projectionCount > 0 && audit.projectionCount < audit.count);
  const total = audit.groups.reduce((sum, group) => sum + group.ids.length, 0);
  assert.equal(total, samples.length);
  for (const group of audit.groups) {
    assert.equal(group.features.length, 12);
    assert.ok(FEEDBACK_HEADS.includes(group.head));
    for (const id of group.ids) {
      const sample = samples.find(row => row.id === id);
      assert.deepEqual(feedbackFeatures(sample.input), group.features);
      assert.equal(sample.teacher.head, group.head);
    }
  }
});

test('public projection audit stops on conflicting gold for one projection', () => {
  const sample = makeFeedbackSamples()[0];
  const conflictingHead = FEEDBACK_HEADS.find(head => head !== sample.teacher.head);
  const conflict = {
    ...structuredClone(sample),
    id: 'conflicting-projection-row',
    teacher: { ...sample.teacher, head: conflictingHead },
  };
  assert.throws(
    () => auditFeedbackProjections([sample, conflict]),
    /Conflicting feedback labels for one student projection/,
  );
});
