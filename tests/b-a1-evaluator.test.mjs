import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateBA1Sample,
  summarizeBA1Evaluations,
} from "../dist/training/b-a1-evaluator.js";

const identity = {
  documentRef: "doc-1",
  observationId: "obs-1",
  revision: 9,
};

function candidate(ref, overrides = {}) {
  return { ref, scopeRef: "scope-1", ...identity, ...overrides };
}

function evidence(evidenceRef, type, payload = {}, overrides = {}) {
  return { evidenceRef, type, scopeRef: "scope-1", ...identity, payload, ...overrides };
}

function input(overrides = {}) {
  return {
    gold: { kind: "bound", state: "selected", selectedRef: "search", family: "family-a", group: "A1" },
    output: { kind: "bound", state: "selected", selectedRef: "search", evidenceRefs: ["search-evidence"], observedRevision: 9 },
    allowedScopeRef: "scope-1",
    candidates: [candidate("search")],
    coverage: {
      status: "complete",
      scopeRef: "scope-1",
      ...identity,
      evaluatedCount: 1,
      expectedCount: 1,
      evidenceRefs: ["coverage-evidence"],
    },
    currentControl: identity,
    evidenceRecords: [
      evidence("search-evidence", "search_host"),
      evidence("coverage-evidence", "coverage"),
    ],
    ...overrides,
  };
}

function errorsFor(overrides) {
  return evaluateBA1Sample(input(overrides)).errors;
}

test("bound selected, none, ambiguous and insufficient_observation pass independently", () => {
  assert.equal(evaluateBA1Sample(input()).passed, true);

  const none = input({
    gold: { kind: "bound", state: "none", family: "family-a", group: "A3" },
    output: { kind: "bound", state: "none", selectedRef: null, evidenceRefs: ["coverage-evidence"], observedRevision: 9 },
    candidates: [candidate("nickname")],
  });
  assert.equal(evaluateBA1Sample(none).passed, true);

  const ambiguous = input({
    gold: { kind: "bound", state: "ambiguous", family: "family-a", group: "A5" },
    output: { kind: "bound", state: "ambiguous", selectedRef: null, evidenceRefs: ["ambiguity-1", "ambiguity-2"], observedRevision: 9 },
    candidates: [candidate("header-search"), candidate("footer-search")],
    evidenceRecords: [
      ...input().evidenceRecords,
      evidence("ambiguity-1", "ambiguity"),
      evidence("ambiguity-2", "ambiguity"),
    ],
  });
  assert.equal(evaluateBA1Sample(ambiguous).passed, true);

  const insufficient = input({
    gold: { kind: "bound", state: "insufficient_observation", family: "family-a", group: "A4" },
    output: { kind: "bound", state: "insufficient_observation", selectedRef: null, evidenceRefs: ["missing-field"], observedRevision: 9 },
    evidenceRecords: [
      ...input().evidenceRecords,
      evidence("missing-field", "insufficient_observation", { insufficientReason: "missing_measurement" }),
    ],
  });
  assert.equal(evaluateBA1Sample(insufficient).passed, true);
});

test("wrong kind, state and reason are reported without hiding the mismatch", () => {
  assert.deepEqual(
    errorsFor({
      gold: { kind: "reject", reason: "outside_scope", family: "family-a", group: "A8" },
    }),
    ["wrong_kind", "reject_misclassified"],
  );
  assert.deepEqual(
    errorsFor({
      output: { kind: "bound", state: "none", selectedRef: null, evidenceRefs: ["coverage-evidence"], observedRevision: 9 },
    }),
    ["wrong_state", "wrong_ref"],
  );
  assert.deepEqual(
    errorsFor({
      gold: { kind: "reject", reason: "stale_candidate", family: "family-a", group: "A7" },
      output: { kind: "reject", reason: "outside_scope", evidenceRefs: ["scope-evidence"], observedRevision: 9 },
      candidates: [candidate("search", { scopeRef: "scope-2" })],
      evidenceRecords: [...input().evidenceRecords, evidence("scope-evidence", "outside_scope", {}, { scopeRef: "scope-2" })],
    }),
    ["wrong_reason"],
  );
});

test("none requires complete coverage evidence", () => {
  assert.deepEqual(
    errorsFor({
      gold: { kind: "bound", state: "none", family: "family-a", group: "A3" },
      output: { kind: "bound", state: "none", selectedRef: null, evidenceRefs: [], observedRevision: 9 },
      coverage: { ...input().coverage, status: "partial" },
    }),
    ["missing_coverage"],
  );
});

test("stale identity and out-of-scope facts fail bound evaluation", () => {
  assert.deepEqual(
    errorsFor({
      candidates: [candidate("search", { documentRef: "doc-old" })],
    }),
    ["stale_identity"],
  );
  assert.deepEqual(
    errorsFor({
      evidenceRecords: [evidence("search-evidence", "search_host", {}, { scopeRef: "scope-2" })],
    }),
    ["out_of_scope"],
  );
});

test("forced selection and insufficient downgraded to none are explicit errors", () => {
  assert.deepEqual(
    errorsFor({
      gold: { kind: "bound", state: "ambiguous", family: "family-a", group: "A5" },
      output: { kind: "bound", state: "selected", selectedRef: "header-search", evidenceRefs: ["ambiguity-1", "ambiguity-2"], observedRevision: 9 },
      candidates: [candidate("header-search"), candidate("footer-search")],
      evidenceRecords: [
        ...input().evidenceRecords,
        evidence("ambiguity-1", "ambiguity"),
        evidence("ambiguity-2", "ambiguity"),
      ],
    }),
    ["wrong_state", "forced_selection"],
  );
  assert.deepEqual(
    errorsFor({
      gold: { kind: "bound", state: "insufficient_observation", family: "family-a", group: "A4" },
      output: { kind: "bound", state: "none", selectedRef: null, evidenceRefs: ["coverage-evidence"], observedRevision: 9 },
    }),
    ["wrong_state", "insufficient_downgraded_to_none", "missing_evidence"],
  );
});

test("ref rules distinguish bound and reject channels", () => {
  assert.deepEqual(
    errorsFor({
      gold: { kind: "bound", state: "none", family: "family-a", group: "A3" },
      output: { kind: "bound", state: "none", selectedRef: "search", evidenceRefs: ["coverage-evidence"], observedRevision: 9 },
    }),
    ["unexpected_ref"],
  );
  assert.deepEqual(
    errorsFor({
      gold: { kind: "reject", reason: "access_unknown", family: "family-a", group: "A9" },
      output: { kind: "reject", reason: "access_unknown", selectedRef: null, evidenceRefs: ["access-evidence"], observedRevision: 9 },
      candidates: [candidate("search", { access: "unknown" })],
      evidenceRecords: [...input().evidenceRecords, evidence("access-evidence", "access_unknown")],
    }),
    ["unexpected_ref"],
  );
  assert.deepEqual(
    errorsFor({
      output: { kind: "bound", state: "selected", selectedRef: "comment", evidenceRefs: ["search-evidence"], observedRevision: 9 },
    }),
    ["wrong_ref"],
  );
});

test("evidence must resolve and support the claimed state", () => {
  assert.deepEqual(
    errorsFor({
      output: { kind: "bound", state: "selected", selectedRef: "search", evidenceRefs: ["missing-ref"], observedRevision: 9 },
    }),
    ["missing_evidence"],
  );
  assert.deepEqual(
    errorsFor({
      gold: { kind: "bound", state: "ambiguous", family: "family-a", group: "A5" },
      output: { kind: "bound", state: "ambiguous", selectedRef: null, evidenceRefs: ["ambiguity-1"], observedRevision: 9 },
      candidates: [candidate("header-search"), candidate("footer-search")],
      evidenceRecords: [...input().evidenceRecords, evidence("ambiguity-1", "ambiguity")],
    }),
    ["missing_evidence"],
  );
  assert.deepEqual(
    errorsFor({
      gold: { kind: "bound", state: "insufficient_observation", family: "family-a", group: "A4" },
      output: { kind: "bound", state: "insufficient_observation", selectedRef: null, evidenceRefs: ["search-evidence"], observedRevision: 9 },
    }),
    ["missing_evidence"],
  );
});

test("correct rejects pass when their original violation facts are present", () => {
  const outsideScope = input({
    gold: { kind: "reject", reason: "outside_scope", family: "family-a", group: "A8" },
    output: { kind: "reject", reason: "outside_scope", evidenceRefs: ["scope-evidence"], observedRevision: 9 },
    candidates: [candidate("search", { scopeRef: "scope-2" })],
    evidenceRecords: [...input().evidenceRecords, evidence("scope-evidence", "outside_scope", {}, { scopeRef: "scope-2" })],
  });
  assert.equal(evaluateBA1Sample(outsideScope).passed, true);

  const stale = input({
    gold: { kind: "reject", reason: "stale_candidate", family: "family-a", group: "A7" },
    output: { kind: "reject", reason: "stale_candidate", evidenceRefs: ["stale-evidence"], observedRevision: 9 },
    candidates: [candidate("search", { observationId: "obs-old" })],
    evidenceRecords: [...input().evidenceRecords, evidence("stale-evidence", "stale_candidate", {}, { observationId: "obs-old" })],
  });
  assert.equal(evaluateBA1Sample(stale).passed, true);
});

test("reject without matching original evidence fails", () => {
  assert.deepEqual(
    errorsFor({
      gold: { kind: "reject", reason: "access_unknown", family: "family-a", group: "A9" },
      output: { kind: "reject", reason: "access_unknown", evidenceRefs: ["search-evidence"], observedRevision: 9 },
    }),
    ["missing_reason_evidence"],
  );
});

test("gold requires the typed kind and reject reason", () => {
  assert.throws(() => evaluateBA1Sample(input({ gold: { state: "selected", selectedRef: "search", family: "family-a", group: "A1" } })));
  assert.throws(() => evaluateBA1Sample(input({ gold: { kind: "reject", family: "family-a", group: "A7" } })));
});

test("summary separates sample kinds, families and groups", () => {
  const summary = summarizeBA1Evaluations([
    { ...input(), sampleId: "a1", sampleKind: "model-semantic", family: "family-a", group: "A1" },
    { ...input(), sampleId: "b1", sampleKind: "model-semantic", family: "family-b", group: "B1" },
    {
      ...input({
        gold: { kind: "reject", reason: "unverified_coverage", family: "family-a", group: "A6" },
        output: { kind: "reject", reason: "unverified_coverage", evidenceRefs: ["coverage-evidence"], observedRevision: 9 },
        coverage: { ...input().coverage, status: "partial" },
      }),
      sampleId: "a6",
      sampleKind: "contract-gate",
      family: "family-a",
      group: "A6",
    },
  ]);

  assert.deepEqual(
    summary.denominators.map(({ sampleKind, family, group, total, passed, failed }) => ({ sampleKind, family, group, total, passed, failed })),
    [
      { sampleKind: "contract-gate", family: "family-a", group: "A6", total: 1, passed: 1, failed: 0 },
      { sampleKind: "model-semantic", family: "family-a", group: "A1", total: 1, passed: 1, failed: 0 },
      { sampleKind: "model-semantic", family: "family-b", group: "B1", total: 1, passed: 1, failed: 0 },
    ],
  );
});
