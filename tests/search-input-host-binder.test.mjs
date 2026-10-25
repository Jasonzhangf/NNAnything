import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEARCH_INPUT_HOST_WIRES,
  inferSearchInputHostBinding,
  migrateSearchInputHostProfile,
  neutralSearchInputHostProfile,
  searchInputHostFeatures,
  trainSearchInputHostBinder,
  validateSearchInputHostProfile,
} from "../dist/search-input-host.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const consumer = resolve(repoRoot, "playground/browser/search-input-host/run.mjs");
const trainRowsPath = resolve(repoRoot, "playground/browser/search-input-host/fixtures/train-rows.json");
const devCasesPath = resolve(repoRoot, "playground/browser/search-input-host/fixtures/dev-cases.json");

const baseCandidate = (overrides = {}) => ({
  ref: "c1",
  scopeRef: "scope-1",
  documentRef: "doc-1",
  observationId: "obs-1",
  revision: 1,
  host: "input",
  type: "text",
  contentEditable: false,
  editable: true,
  disabled: false,
  readOnly: false,
  cssHidden: false,
  intersectsViewport: true,
  explicitTabIndexKind: "absent",
  tabIndexFocus: false,
  inForm: false,
  formRoleSearch: false,
  nearbySubmit: false,
  depthBand: "shallow",
  hasLabel: false,
  hasPlaceholder: false,
  hasAria: false,
  markerHit: false,
  nonSearchMarker: false,
  textLenBand: 0,
  access: "available",
  ...overrides,
});

const searchCandidate = (overrides = {}) => baseCandidate({
  ref: "search",
  type: "search",
  inForm: true,
  formRoleSearch: true,
  hasPlaceholder: true,
  markerHit: true,
  ...overrides,
});

const memoCandidate = (overrides = {}) => baseCandidate({
  ref: "memo",
  inForm: true,
  hasLabel: true,
  nonSearchMarker: true,
  ...overrides,
});

const requestFor = (candidates, overrides = {}) => ({
  goal: { requestedRole: "search-input-host", allowedScopeRef: "scope-1" },
  coverage: {
    scopeRef: "scope-1",
    observedCandidateCount: candidates.length,
    unassessedIframeCount: 0,
    unassessedObjectCount: 0,
    unassessedOpenShadowRootCount: 0,
    excluded: [],
  },
  currentControl: { documentRef: "doc-1", observationId: "obs-1", revision: 1 },
  candidates,
  ...overrides,
});

const profileWith = changes => {
  const neutral = neutralSearchInputHostProfile();
  const weights = neutral.weights.map((weight, index) => changes[SEARCH_INPUT_HOST_WIRES[index]] ?? weight);
  return validateSearchInputHostProfile({ ...neutral, weights });
};

const selectionProfile = profileWith({
  "type.search": 1,
  "hasPlaceholder": 1,
  "markerHit": 2,
  "formRoleSearch": 1,
  "nonSearchMarker": -2,
});

test("selected: unique highest roleMatch comes from the batch", () => {
  const result = inferSearchInputHostBinding(
    requestFor([searchCandidate(), memoCandidate()]),
    { profile: selectionProfile },
  );
  assert.equal(result.state, "selected");
  assert.equal(result.selectedRef, "search");
  assert.deepEqual(result.evidenceRefs, ["search"]);
  assert.equal(result.observedRevision, 1);
});

test("none: an empty applicable set is none", () => {
  const empty = inferSearchInputHostBinding(requestFor([]), { profile: selectionProfile });
  assert.equal(empty.state, "none");
  assert.equal(empty.selectedRef, null);
  assert.equal(empty.observedRevision, 1);

  // A read-only search control is still a search host. Only the smallest
  // "currently operable" set is empty; that is NOT a whole-scope absence claim
  // (Alice ruling 2026-10-24: "disabled/readOnly 同样不能泛称角色消失").
  const allReadOnly = inferSearchInputHostBinding(
    requestFor([searchCandidate({ ref: "readonly", readOnly: true })]),
    { profile: selectionProfile },
  );
  assert.equal(allReadOnly.state, "insufficient_observation");
  assert.equal(allReadOnly.rejection, "unassessed_scope_content");
  assert.equal(allReadOnly.selectedRef, null);
  assert.deepEqual(allReadOnly.evidenceRefs, ["readonly"]);
});

test("none requires positive non-search evidence, not just a low score", () => {
  // An applicable host with no search cue and no non-search cue is simply
  // unclassified. That is insufficient evidence, never `none`.
  const unclassified = inferSearchInputHostBinding(
    requestFor([baseCandidate({ ref: "plain" })]),
    { profile: neutralSearchInputHostProfile() },
  );
  assert.equal(unclassified.state, "insufficient_observation");

  // The same host becomes `none` only once a non-search usage fact is measured on
  // every applicable host.
  const confirmed = inferSearchInputHostBinding(
    requestFor([baseCandidate({ ref: "plain", nonSearchMarker: true })]),
    { profile: neutralSearchInputHostProfile() },
  );
  assert.equal(confirmed.state, "none");
});

test("type is an operational guard: a non-text-entry control is not applicable", () => {
  // A checkbox cannot carry typed input, so it can never be a search-input host
  // no matter how strong its usage cues are.
  const checkbox = inferSearchInputHostBinding(
    requestFor([searchCandidate({ ref: "check", type: "other", host: "input" })]),
    { profile: selectionProfile },
  );
  assert.equal(checkbox.state, "none");
  assert.equal(checkbox.selectedRef, null);

  // A contenteditable host has no input type at all and stays applicable.
  const editableHost = inferSearchInputHostBinding(
    requestFor([searchCandidate({ ref: "ce", type: "other", host: "contenteditable" })]),
    { profile: selectionProfile },
  );
  assert.equal(editableHost.state, "selected");
  assert.equal(editableHost.selectedRef, "ce");
});

test("ambiguous: tied top scores are ambiguous", () => {
  const result = inferSearchInputHostBinding(
    requestFor([
      searchCandidate({ ref: "a" }),
      searchCandidate({ ref: "b" }),
    ]),
    { profile: selectionProfile },
  );
  assert.equal(result.state, "ambiguous");
  assert.equal(result.selectedRef, null);
  assert.deepEqual([...result.evidenceRefs].sort(), ["a", "b"]);
});

test("insufficient_observation: a missing measurement is not none", () => {
  const result = inferSearchInputHostBinding(
    requestFor([searchCandidate({ editable: null })]),
    { profile: selectionProfile },
  );
  assert.equal(result.state, "insufficient_observation");
  assert.equal(result.state === "none", false);
  assert.equal(result.selectedRef, null);
  assert.equal(result.rejection, "unmeasured_candidate_fields");
});

test("insufficient_observation: neutral weights keep zero-evidence hosts below theta", () => {
  const result = inferSearchInputHostBinding(
    requestFor([searchCandidate()]),
    { profile: neutralSearchInputHostProfile() },
  );
  assert.equal(result.state, "insufficient_observation");
  assert.equal(result.selectedRef, null);
});

test("unread iframe, object or open shadow root can never be none or selected", () => {
  for (const field of ["unassessedIframeCount", "unassessedObjectCount", "unassessedOpenShadowRootCount"]) {
    const coverage = {
      scopeRef: "scope-1",
      observedCandidateCount: 1,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
      excluded: [],
      [field]: 1,
    };
    const result = inferSearchInputHostBinding(
      requestFor([searchCandidate()], { coverage }),
      { profile: selectionProfile },
    );
    assert.equal(result.state, "insufficient_observation", `${field} must be insufficient`);
    assert.notEqual(result.state, "none");
    assert.notEqual(result.state, "selected");
    assert.equal(result.rejection, "unassessed_scope_content");
  }
});

test("stale revision is rejected instead of silently reselected", () => {
  const result = inferSearchInputHostBinding(
    requestFor([searchCandidate({ revision: 2 })], {
      currentControl: { documentRef: "doc-1", observationId: "obs-1", revision: 3 },
    }),
    { profile: selectionProfile },
  );
  assert.equal(result.state, "insufficient_observation");
  assert.equal(result.selectedRef, null);
  assert.equal(result.rejection, "stale_candidate");
  assert.deepEqual(result.evidenceRefs, ["search"]);
});

test("unknown requestedRole is explicitly rejected, not mapped to none", () => {
  const result = inferSearchInputHostBinding(
    requestFor([searchCandidate()], {
      goal: { requestedRole: "search-result-host", allowedScopeRef: "scope-1" },
    }),
    { profile: selectionProfile },
  );
  assert.equal(result.state, "insufficient_observation");
  assert.notEqual(result.state, "none");
  assert.equal(result.rejection, "unsupported_requested_role");
});

test("fitting decreases the pairwise loss and changes neutral weights", async () => {
  const rows = JSON.parse(await readFile(trainRowsPath, "utf8"));
  const result = trainSearchInputHostBinder({ batches: rows.batches });
  assert.ok(result.fit.lossAfter < result.fit.lossBefore,
    `loss must fall: ${result.fit.lossBefore} -> ${result.fit.lossAfter}`);
  assert.ok(result.fit.changedWeightCount > 0);
  assert.ok(result.fit.pairCount > 0);
  assert.equal(result.fit.devBatchCount, 1);
  assert.equal(result.profile.calibration, "uncalibrated");
  assert.equal(result.profile.adoption, "not_applied");
  assert.equal(result.profile.threshold, 0.5);
  assert.ok(result.profile.weights.some(weight => weight !== 0));
});

// ---------------------------------------------------------------------------
// G1 (Alice ruling 2026-10-24): being outside the viewport cannot prove the role
// is absent. Structural existence, perceivability and current operability are
// different facts, and only the last one gates the current action.
// ---------------------------------------------------------------------------

test("G1 viewport-only: an off-viewport eligible host is insufficient, never none", () => {
  // The control exists and could carry typed input, but it sits below the fold.
  // It has not been assessed, so the scope is not proven to lack the role.
  const onlyOffscreen = inferSearchInputHostBinding(
    requestFor([searchCandidate({ ref: "below-fold", intersectsViewport: false })]),
    { profile: selectionProfile },
  );
  assert.equal(onlyOffscreen.state, "insufficient_observation");
  assert.equal(onlyOffscreen.rejection, "unassessed_scope_content");
  assert.equal(onlyOffscreen.selectedRef, null);
  assert.deepEqual(onlyOffscreen.evidenceRefs, ["below-fold"]);

  // Same answer when the off-viewport host is a plain input with no cues at all:
  // the reason is "not assessed", not "no evidence of search usage".
  const offscreenPlain = inferSearchInputHostBinding(
    requestFor([baseCandidate({ ref: "plain-offscreen", intersectsViewport: false })]),
    { profile: neutralSearchInputHostProfile() },
  );
  assert.equal(offscreenPlain.state, "insufficient_observation");
  assert.equal(offscreenPlain.rejection, "unassessed_scope_content");
});

test("G1 no-candidates: a scope with no structurally eligible host is none", () => {
  // Structurally ineligible controls are an operational fact, so their presence
  // IS positive structural evidence that the role cannot exist in this scope.
  const empty = inferSearchInputHostBinding(requestFor([]), { profile: selectionProfile });
  assert.equal(empty.state, "none");
  assert.deepEqual(empty.evidenceRefs, []);

  const onlyCheckbox = inferSearchInputHostBinding(
    requestFor([baseCandidate({ ref: "check", type: "other", host: "input" })]),
    { profile: selectionProfile },
  );
  assert.equal(onlyCheckbox.state, "none");

  // Disabled / read-only / hidden / off-viewport hosts are all of an eligible
  // KIND. None of them can justify `none`: the role is unassessed for current
  // operation, not absent (Alice ruling 2026-10-24).
  for (const [ref, override] of [
    ["disabled", { disabled: true }],
    ["readonly", { readOnly: true }],
    ["hidden", { cssHidden: true }],
    ["offscreen", { intersectsViewport: false }],
    ["not-editable", { editable: false }],
  ]) {
    const result = inferSearchInputHostBinding(
      requestFor([searchCandidate({ ref, ...override })]),
      { profile: selectionProfile },
    );
    assert.equal(result.state, "insufficient_observation", `${ref} must be insufficient`);
    assert.equal(result.rejection, "unassessed_scope_content", `${ref} rejection`);
    assert.deepEqual(result.evidenceRefs, [ref], `${ref} evidenceRefs`);
  }
});

test("G1 explicit non-search: every operable host carries a non-search usage fact", () => {
  const confirmed = inferSearchInputHostBinding(
    requestFor([memoCandidate({ ref: "memo-a" }), memoCandidate({ ref: "memo-b" })]),
    { profile: selectionProfile },
  );
  assert.equal(confirmed.state, "none");
  assert.deepEqual([...confirmed.evidenceRefs].sort(), ["memo-a", "memo-b"]);

  // A single host without an explicit non-search fact breaks the proof.
  const mixed = inferSearchInputHostBinding(
    requestFor([memoCandidate({ ref: "memo-a" }), baseCandidate({ ref: "plain" })]),
    { profile: selectionProfile },
  );
  assert.notEqual(mixed.state, "none");
});

test("G1 operable search: an in-viewport host with search evidence is selected", () => {
  const operable = inferSearchInputHostBinding(
    requestFor([searchCandidate({ ref: "search", intersectsViewport: true })]),
    { profile: selectionProfile },
  );
  assert.equal(operable.state, "selected");
  assert.equal(operable.selectedRef, "search");
});

test("G1 coverage unknown: unassessed scope content is insufficient, never none", () => {
  for (const field of ["unassessedIframeCount", "unassessedObjectCount", "unassessedOpenShadowRootCount"]) {
    const coverage = {
      scopeRef: "scope-1",
      observedCandidateCount: 0,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
      excluded: [],
      [field]: 1,
    };
    const result = inferSearchInputHostBinding(
      requestFor([], { coverage }),
      { profile: selectionProfile },
    );
    assert.equal(result.state, "insufficient_observation", `${field} must be insufficient`);
    assert.equal(result.rejection, "unassessed_scope_content");
  }
});

test("G1 mixed scope: an in-viewport non-search host plus an off-viewport unassessed host is insufficient", () => {
  // The defect this guards: `confirmedNonSearch` used to iterate only `applied`
  // (in-viewport hosts). With one in-viewport memo field plus one off-viewport
  // unassessed input, every applied host looked non-search, so the whole scope
  // was reported `none` while a host had never been assessed. Unassessed coverage
  // is not absence.
  const mixed = inferSearchInputHostBinding(
    requestFor([
      memoCandidate({ ref: "memo-visible" }),
      baseCandidate({ ref: "below-fold-unknown", intersectsViewport: false }),
    ]),
    { profile: selectionProfile },
  );
  assert.equal(mixed.state, "insufficient_observation");
  assert.equal(mixed.rejection, "unassessed_scope_content");
  assert.equal(mixed.selectedRef, null);
  assert.deepEqual(mixed.evidenceRefs, ["below-fold-unknown"]);

  // Once the off-viewport host is assessed and also carries a non-search fact,
  // the same scope is a justified `none`.
  const bothAssessed = inferSearchInputHostBinding(
    requestFor([
      memoCandidate({ ref: "memo-visible" }),
      memoCandidate({ ref: "memo-below-fold" }),
    ]),
    { profile: selectionProfile },
  );
  assert.equal(bothAssessed.state, "none");
  assert.deepEqual([...bothAssessed.evidenceRefs].sort(), ["memo-below-fold", "memo-visible"]);
});

test("G1 preserves the original failure: off-viewport hosts used to read as none", () => {
  // Regression guard for the indep-4 defect. Before G1 the guard dropped
  // off-viewport hosts from applicability, so `applied` was empty and the scope
  // reported `none` with an empty evidenceRefs. That silently converted
  // "unassessed" into "absent". The evidenceRefs check below is what separates
  // the two `none` exits: structural absence returns [], the usage-evidence exit
  // returns the applicable refs.
  const offscreen = inferSearchInputHostBinding(
    requestFor([
      baseCandidate({ ref: "indep-4-107", intersectsViewport: false }),
      baseCandidate({ ref: "indep-4-108", host: "textarea", type: "other", intersectsViewport: false }),
    ]),
    { profile: neutralSearchInputHostProfile() },
  );
  assert.equal(offscreen.state, "insufficient_observation");
  assert.deepEqual([...offscreen.evidenceRefs].sort(), ["indep-4-107", "indep-4-108"]);

  // The usage-evidence `none` exit keeps returning the applicable refs, so the
  // two exits stay distinguishable in the result contract.
  const usageNone = inferSearchInputHostBinding(
    requestFor([memoCandidate({ ref: "memo" })]),
    { profile: selectionProfile },
  );
  assert.equal(usageNone.state, "none");
  assert.deepEqual(usageNone.evidenceRefs, ["memo"]);
});

test("adopted or calibrated profiles are rejected", () => {
  const neutral = neutralSearchInputHostProfile();
  assert.throws(() => validateSearchInputHostProfile({ ...neutral, adoption: "applied" }));
  assert.throws(() => validateSearchInputHostProfile({ ...neutral, calibration: "calibrated" }));
});

test("consumer train saves an uncalibrated candidate and a new process reproduces infer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "search-input-host-"));
  const weightsPath = join(directory, "candidate.json");

  const trainRun = spawnSync(
    process.execPath,
    [consumer, "--mode", "train", "--rows", trainRowsPath, "--weights", weightsPath],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(trainRun.status, 0, trainRun.stderr);
  const trained = JSON.parse(trainRun.stdout);
  assert.equal(trained.calibration, "uncalibrated");
  assert.equal(trained.adoption, "not_applied");
  assert.ok(trained.fit.lossAfter < trained.fit.lossBefore);
  assert.ok(trained.fit.changedWeightCount > 0);

  const saved = JSON.parse(await readFile(weightsPath, "utf8"));
  assert.equal(saved.profile.calibration, "uncalibrated");
  assert.equal(saved.profile.adoption, "not_applied");

  const observeRun = spawnSync(
    process.execPath,
    [consumer, "--mode", "observe", "--profile", weightsPath, "--cases", devCasesPath],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(observeRun.status, 0, observeRun.stderr);
  const observed = JSON.parse(observeRun.stdout);
  assert.notEqual(observed.processId, process.pid);
  assert.notEqual(observed.processId, trained.processId);
  assert.equal(observed.fitted, false);

  const cases = JSON.parse(await readFile(devCasesPath, "utf8")).cases;
  const expectedStates = new Map([
    ["dev-selected", "selected"],
    ["dev-none", "none"],
    ["dev-ambiguous", "ambiguous"],
    ["dev-insufficient-missing", "insufficient_observation"],
    ["dev-insufficient-coverage", "insufficient_observation"],
    ["dev-insufficient-threshold", "insufficient_observation"],
    ["dev-role-rejected", "insufficient_observation"],
    ["dev-stale", "insufficient_observation"],
  ]);
  for (const entry of cases) {
    const inProcess = inferSearchInputHostBinding(entry.request, { profile: saved.profile });
    const child = observed.results.find(result => result.id === entry.id);
    assert.ok(child, `missing child result for ${entry.id}`);
    assert.deepEqual(
      {
        state: child.state,
        selectedRef: child.selectedRef,
        evidenceRefs: child.evidenceRefs,
        rejection: child.rejection ?? null,
      },
      {
        state: inProcess.state,
        selectedRef: inProcess.selectedRef,
        evidenceRefs: inProcess.evidenceRefs,
        rejection: inProcess.rejection ?? null,
      },
      `new-process result must reproduce in-process infer for ${entry.id}`,
    );
    assert.equal(child.state, expectedStates.get(entry.id), `unexpected state for ${entry.id}`);
  }

  // The saved file is the candidate, never a production weight.
  assert.equal(saved.fit.changedWeightCount, trained.fit.changedWeightCount);
});

// ---------------------------------------------------------------------------
// Absolute supervision (m1-new-experiment-contract.md, Alice 2026-10-24).
//
// The shipped pairwise objective cannot express an absolute margin, so a
// labelled negative only ever appears as a rival of some target and its own
// crossing of θ is never evaluated. The absolute objective learns only the
// usage-evidence wires and reports what it excluded.
// ---------------------------------------------------------------------------

const TRAIN_ABSOLUTE_PATH = resolve(repoRoot, "playground/browser/search-input-host/fixtures/train-rows-absolute.json");

const label = (ref, polarity) => ({ ref, polarity });

// The pre-member replay fixture predates the relation member, so none of its
// candidates carries a support score. Under the corrected missing-measurement
// semantics it cannot supervise a fit (milestone recheck P1). The helpers below
// build synthetic measured candidates: they exercise the fitter mechanics and are
// not evidence about the delivered data.
const measuredPositive = (ref, overrides = {}) => baseCandidate({
  ref,
  type: "search",
  inForm: true,
  formRoleSearch: true,
  hasPlaceholder: true,
  markerHit: true,
  usageQuerySupport: 0.9,
  usageFieldSupport: -0.9,
  ...overrides,
});

const measuredNegative = (ref, overrides = {}) => baseCandidate({
  ref,
  type: "text",
  inForm: true,
  hasLabel: true,
  nonSearchMarker: true,
  usageQuerySupport: -0.9,
  usageFieldSupport: 0.9,
  ...overrides,
});

const measuredBatch = (overrides = {}) => ({
  id: "batch-measured",
  partition: "train",
  targetRef: "search",
  candidates: [measuredPositive("search"), measuredNegative("memo")],
  labels: [label("search", "positive"), label("memo", "negative")],
  ...overrides,
});

const LEARNABLE_WIRES = new Set([
  "markerHit", "nonSearchMarker", "formRoleSearch", "usage.query_support", "usage.field_support",
]);

test("absolute: only usage-evidence wires change; the other 31 stay exactly zero", () => {
  const result = trainSearchInputHostBinder({ batches: [measuredBatch()] }, { objective: "absolute" });
  assert.equal(result.fit.objective, "absolute");
  for (let index = 0; index < SEARCH_INPUT_HOST_WIRES.length; index += 1) {
    const wire = SEARCH_INPUT_HOST_WIRES[index];
    if (!LEARNABLE_WIRES.has(wire)) {
      assert.equal(result.profile.weights[index], 0, `carrier wire ${wire} must stay frozen at zero`);
    }
  }
  assert.equal(result.profile.weights.length, 36);
  assert.ok(result.profile.weights.some(weight => weight !== 0));
  assert.equal(result.profile.calibration, "uncalibrated");
  assert.equal(result.profile.adoption, "not_applied");
});

test("absolute: a memo field inside a role=search form is not selected after fitting", () => {
  // The delivered s7a shape with measured member support: the query field carries
  // a positive query cue and the memo a negative one, so the fitted profile must
  // still prefer the query field inside the same role=search form.
  const query = measuredPositive("search");
  const memo = measuredNegative("memo");
  const request = requestFor([query, memo]);
  const result = trainSearchInputHostBinder({ batches: [measuredBatch()] }, { objective: "absolute" });
  const outcome = inferSearchInputHostBinding(request, { profile: result.profile });
  assert.equal(outcome.selectedRef, "search", "the query field must win inside the same role=search form");
  assert.notEqual(outcome.selectedRef, "memo", "the search-form memo must not be selected");
});

test("absolute: a measured all-zero-evidence negative is reported excluded, never silently given a margin", () => {
  const zero = baseCandidate({ ref: "z1", usageQuerySupport: 0, usageFieldSupport: 0 });
  const batch = {
    id: "batch-zero",
    partition: "train",
    targetRef: "search",
    // A second, measured negative keeps one fitted negative row in the objective.
    candidates: [measuredPositive("search"), zero, measuredNegative("memo")],
    labels: [label("search", "positive"), label("z1", "negative"), label("memo", "negative")],
  };
  const result = trainSearchInputHostBinder({ batches: [batch] }, { objective: "absolute" });
  const excluded = result.fit.excludedRows.find(row => row.ref === "z1");
  assert.ok(excluded, "a measured all-zero negative must be reported, not fitted");
  assert.equal(excluded.reason, "zero-usage-evidence");
  assert.equal(excluded.roleMatch, 0, "below theta by construction, not recognised as non-search");
  assert.equal(result.fit.fittedRowCount, 2, "the measured positive and the measured negative both fit");
});

test("absolute: a missing member support is unassessed even beside a marker bit (recheck P1)", () => {
  // Failure mode this guards: the fit built the numeric row through the feature
  // vector, where a null support became 0. A negative carrying a marker bit then
  // entered the fitted set with both usage wires silently zeroed, while inference
  // rejects the same input. A missing cue must never be fitted as a measured zero.
  const missing = baseCandidate({ ref: "m1", markerHit: true, usageQuerySupport: null, usageFieldSupport: null });
  const batch = {
    id: "batch-missing",
    partition: "train",
    targetRef: "search",
    candidates: [measuredPositive("search"), missing, measuredNegative("memo")],
    labels: [label("search", "positive"), label("m1", "negative"), label("memo", "negative")],
  };
  const result = trainSearchInputHostBinder({ batches: [batch] }, { objective: "absolute" });
  const excluded = result.fit.excludedRows.find(row => row.ref === "m1");
  assert.ok(excluded, "the row must be reported, not fitted as zero support");
  assert.equal(excluded.reason, "insufficient-observation");
  assert.equal(excluded.roleMatch, null, "the cue was missing, so no score exists");
  assert.equal(result.fit.fittedRowCount, 2, "only the two measured rows fit");
});

test("absolute: a positive row without member support is not supervision either (recheck P1)", () => {
  const missingPositive = baseCandidate({ ref: "p1", markerHit: true, usageQuerySupport: null, usageFieldSupport: undefined });
  const batch = {
    id: "batch-missing-positive",
    partition: "train",
    targetRef: "p1",
    // A measured positive keeps the fit able to run after the missing row is out.
    candidates: [missingPositive, measuredPositive("search"), measuredNegative("memo")],
    labels: [label("p1", "positive"), label("search", "positive"), label("memo", "negative")],
  };
  const result = trainSearchInputHostBinder({ batches: [batch] }, { objective: "absolute" });
  const excluded = result.fit.excludedRows.find(row => row.ref === "p1");
  assert.ok(excluded, "a positive with a missing support must be reported too");
  assert.equal(excluded.reason, "insufficient-observation");
  assert.equal(result.fit.fittedRowCount, 2, "the two measured rows still fit");
});

test("absolute: the pre-member replay fixture cannot supervise a fit (recheck P1 impact)", async () => {
  const rows = JSON.parse(await readFile(TRAIN_ABSOLUTE_PATH, "utf8"));
  // Every candidate in this fixture predates the relation member, so no support
  // is present. The fit has no measured row at all and must refuse instead of
  // absorbing the abstentions as zeros.
  assert.throws(
    () => trainSearchInputHostBinder({ batches: rows.batches }, { objective: "absolute" }),
    /at least one fitted positive row/,
  );
});

test("absolute: the stop metric is reported as a number the caller can judge", () => {
  const result = trainSearchInputHostBinder({ batches: [measuredBatch()] }, { objective: "absolute" });
  assert.equal(typeof result.fit.stopEpoch, "number");
  assert.ok(result.fit.stopEpoch > 0 && result.fit.stopEpoch <= 400);
  assert.ok(result.fit.worstMarginViolation <= 0, "the reported stop metric is the fitted-set maximum");
  assert.deepEqual([...result.fit.boundHitWires], [], "this budget never crosses the optimisation box");
});

test("absolute: touching the weight bound is an observable statistic, not an error", () => {
  // The ±8 box is an optimisation constraint. A finite parameter may sit on it;
  // only a non-finite parameter is an error. Alice ruling 2026-10-24.
  const result = trainSearchInputHostBinder({ batches: [measuredBatch()] }, { objective: "absolute", learningRate: 100 });
  assert.equal(result.profile.weights.length, 36);
  assert.equal(result.profile.calibration, "uncalibrated");
  assert.ok(result.fit.boundHitWires.length > 0, "the crossed box must be observable in the result");
  for (const weight of result.profile.weights) {
    assert.ok(Math.abs(weight) <= 8, "bounded optimisation keeps every parameter inside the box");
    assert.ok(Number.isFinite(weight));
  }
});

test("absolute: an unmet stop metric is reported, not thrown", () => {
  // A learning rate this small cannot reach the margin in one epoch, so no
  // checkpoint passes and the unmet metric must be reported instead of thrown.
  const short = trainSearchInputHostBinder(
    { batches: [measuredBatch()] },
    { objective: "absolute", epochs: 1, learningRate: 0.01 },
  );
  assert.equal(short.fit.stopEpoch, null, "no checkpoint was reached, so no stop epoch exists");
  assert.equal(typeof short.fit.worstMarginViolation, "number", "the unmet metric is still reported");
  assert.ok(short.fit.worstMarginViolation > 0);
});

test("absolute: an unknown objective selector throws instead of falling back to pairwise", async () => {
  const rows = JSON.parse(await readFile(TRAIN_ABSOLUTE_PATH, "utf8"));
  assert.throws(
    () => trainSearchInputHostBinder({ batches: rows.batches }, { objective: "absolut" }),
    /objective must be pairwise or absolute/,
  );
});

test("absolute: the pairwise objective stays the default and is unchanged", async () => {
  const rows = JSON.parse(await readFile(trainRowsPath, "utf8"));
  const result = trainSearchInputHostBinder({ batches: rows.batches });
  assert.equal(result.fit.objective, "pairwise");
  assert.ok(result.fit.pairCount > 0);
  assert.equal(result.fit.fittedRowCount, 0);
});

// ---------------------------------------------------------------------------
// Ruling 1/6: the 36-wire boundary and migration of delivered 34-wire profiles.
//
// Failure mode this guards: the delivered wire list grows from 34 to 36, but
// saved profiles still carry 34 weights. A positional copy would silently shift
// every coefficient once a wire is inserted anywhere but the tail. Migration
// must therefore align by wire NAME and pad only the appended wires with zero.
// ---------------------------------------------------------------------------

const DELIVERED_34_WIRES = Object.freeze([
  "type.text", "type.search", "type.tel", "type.email", "type.url", "type.number",
  "type.other", "contentEditable", "tag.input", "tag.textarea", "editable", "disabled",
  "readOnly", "cssHidden", "intersectsViewport", "explicitTabIndex.negative",
  "explicitTabIndex.nonnegative", "explicitTabIndex.absent", "explicitTabIndex.invalid",
  "tabIndexFocus", "inForm", "formRoleSearch", "nearbySubmit", "depth.shallow",
  "depth.middle", "depth.deep", "hasLabel", "hasPlaceholder", "hasAria", "markerHit",
  "nonSearchMarker", "textLenBand.empty", "textLenBand.short", "textLenBand.long",
]);

const deliveredProfile = (order = DELIVERED_34_WIRES) => {
  const weightOf = name => DELIVERED_34_WIRES.indexOf(name) + 1; // distinct, nonzero
  return {
    contract: "browser.search-input-host.v1",
    role: "search-input-host",
    wires: [...order],
    weights: order.map(weightOf),
    threshold: 0.5,
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
};

test("the declared wire list appends exactly two usage wires after the delivered 34", () => {
  assert.equal(SEARCH_INPUT_HOST_WIRES.length, 36);
  assert.deepEqual(SEARCH_INPUT_HOST_WIRES.slice(0, 34), DELIVERED_34_WIRES,
    "the delivered 34 keep their names and order; only an append is allowed");
  assert.deepEqual(SEARCH_INPUT_HOST_WIRES.slice(34), ["usage.query_support", "usage.field_support"]);
});

test("a delivered 34-wire profile migrates to 36 by name, new wires starting at zero", () => {
  const migrated = migrateSearchInputHostProfile(deliveredProfile());
  assert.equal(migrated.wires.length, 36);
  assert.equal(migrated.weights.length, 36);
  // Every delivered coefficient survives with the same value at the same name.
  for (const wire of DELIVERED_34_WIRES) {
    const index = migrated.wires.indexOf(wire);
    assert.equal(migrated.weights[index], DELIVERED_34_WIRES.indexOf(wire) + 1, `wire ${wire} must keep its weight`);
  }
  assert.equal(migrated.weights[34], 0, "appended usage wire starts at zero");
  assert.equal(migrated.weights[35], 0, "appended usage wire starts at zero");
  // Migration must not launder the candidate's delivery state.
  assert.equal(migrated.calibration, "uncalibrated");
  assert.equal(migrated.adoption, "not_applied");
  // And it must pass the real validator with no second definition of the order.
  validateSearchInputHostProfile(migrated);
});

test("migration aligns by wire name, never by array position", () => {
  // A positional copy would pass the test above but break here: the same 34
  // names and weights are stored in a deliberately different order.
  const shuffled = [...DELIVERED_34_WIRES].reverse();
  const migrated = migrateSearchInputHostProfile(deliveredProfile(shuffled));
  for (const wire of DELIVERED_34_WIRES) {
    const index = migrated.wires.indexOf(wire);
    assert.equal(migrated.weights[index], DELIVERED_34_WIRES.indexOf(wire) + 1,
      `wire ${wire} must follow its NAME through a reordered source profile`);
  }
  assert.equal(migrated.weights[34], 0);
  assert.equal(migrated.weights[35], 0);
});

test("migration refuses to zero-fill a delivered wire it cannot find", () => {
  // Only the two appended wires may default to zero. A missing delivered wire is
  // a corrupt profile: filling it with zero would erase a learned coefficient
  // while looking like a successful migration.
  const broken = deliveredProfile();
  const dropIndex = broken.wires.indexOf("markerHit");
  broken.wires.splice(dropIndex, 1);
  broken.weights.splice(dropIndex, 1);
  assert.throws(() => migrateSearchInputHostProfile(broken), /markerHit|missing/i);
});

// ---------------------------------------------------------------------------
// Ruling 1/6: the relation member's two support scores are learnable binder
// evidence, and the zero-evidence exclusion must not swallow them.
// ---------------------------------------------------------------------------

test("the two member supports land on wires 34 and 35 as continuous values", () => {
  const base = baseCandidate({
    usageQuerySupport: 0.8123,
    usageFieldSupport: -0.4567,
  });
  const features = searchInputHostFeatures(base);
  assert.equal(features.length, 36);
  assert.equal(features[34], 0.8123, "usage.query_support is wire 34");
  assert.equal(features[35], -0.4567, "usage.field_support is wire 35");
});

test("an abstained member contributes zero to the dot product but is not a neutral score", () => {
  // null means "the member abstained", which is not evidence of a neutral score.
  const abstained = searchInputHostFeatures(baseCandidate({ usageQuerySupport: null, usageFieldSupport: null }));
  const neutral = searchInputHostFeatures(baseCandidate({ usageQuerySupport: 0, usageFieldSupport: 0 }));
  assert.equal(abstained[34], 0);
  assert.equal(abstained[35], 0);
  assert.deepEqual([...abstained], [...neutral], "the dot product is identical");
  // ...but the exclusion decision reads the raw candidate, so the two remain
  // distinguishable where it matters.
  assert.equal(baseCandidate({ usageQuerySupport: null }).usageQuerySupport, null);
  assert.equal(baseCandidate({ usageQuerySupport: 0 }).usageQuerySupport, 0);
});

test("inference rejects an abstained member when the profile depends on its wire (milestone P1-1)", () => {
  // A profile that learned a non-zero usage support weight must not silently
  // read a null support as 0: the marker wires would then decide alone. The
  // missing measurement is a rejection, not a score.
  const dependant = profileWith({ "usage.query_support": 1, "usage.field_support": -1 });
  const search = searchCandidate({ usageQuerySupport: null, usageFieldSupport: null });
  const result = inferSearchInputHostBinding(
    requestFor([search]),
    { profile: dependant },
  );
  assert.equal(result.state, "insufficient_observation");
  assert.equal(result.rejection, "unmeasured_candidate_fields");
  assert.deepEqual(result.evidenceRefs, ["search"]);
});

test("inference does not reject missing support under an all-zero profile (milestone P1-1)", () => {
  // An old all-zero profile reads neither support wire, so null support is not a
  // new dependency: the guard must not fire and turn every legacy call into a
  // rejection. The marker wires stay the only evidence.
  const search = searchCandidate({ usageQuerySupport: null, usageFieldSupport: null });
  const result = inferSearchInputHostBinding(
    requestFor([search]),
    { profile: neutralSearchInputHostProfile() },
  );
  assert.notEqual(result.rejection, "unmeasured_candidate_fields");
});

test("a negative carrying positive member support is fitted, not excluded as zero evidence", async () => {
  // The candidate has no marker bits at all. Under the delivered 3-wire rule it
  // was "zero usage evidence" and got dropped. With the member support present it
  // carries real evidence, so dropping it would silently delete a decidable row.
  const rows = {
    batches: [{
      id: "batch-usage",
      partition: "train",
      targetRef: "n1",
      candidates: [
        baseCandidate({ ref: "n1", usageQuerySupport: 0.9, usageFieldSupport: -0.9 }),
        baseCandidate({ ref: "n2", usageQuerySupport: -0.9, usageFieldSupport: 0.9 }),
      ],
      labels: [
        { ref: "n1", polarity: "negative" },
        { ref: "n2", polarity: "positive" },
      ],
    }],
  };
  const result = trainSearchInputHostBinder({ batches: rows.batches }, { objective: "absolute" });
  assert.deepEqual([...result.fit.excludedRows], [], "member support is real evidence, so nothing is excluded here");
  assert.equal(result.profile.weights.length, 36);
  // The fit must be able to use the two new wires.
  const used = [
    result.profile.weights[34] !== 0 || result.profile.weights[35] !== 0,
  ].some(Boolean);
  assert.ok(used, "at least one member support wire must move when it is the only evidence");
});

test("an abstained member is recorded as insufficient observation, not as measured zero", () => {
  // No marker bits and both supports null: the cue is missing, not absent.
  const rows = {
    batches: [{
      id: "batch-abstain",
      partition: "train",
      targetRef: "n2",
      candidates: [
        baseCandidate({ ref: "n1", usageQuerySupport: null, usageFieldSupport: null }),
        baseCandidate({ ref: "n2", usageQuerySupport: 0.9, usageFieldSupport: -0.9 }),
        baseCandidate({ ref: "n3", usageQuerySupport: 0, usageFieldSupport: 0 }),
        // A negative with real evidence, so the fit still has one fitted negative row.
        baseCandidate({ ref: "n4", usageQuerySupport: 0.3, usageFieldSupport: -0.3 }),
      ],
      labels: [
        { ref: "n1", polarity: "negative" },
        { ref: "n2", polarity: "positive" },
        { ref: "n3", polarity: "negative" },
        { ref: "n4", polarity: "negative" },
      ],
    }],
  };
  const result = trainSearchInputHostBinder({ batches: rows.batches }, { objective: "absolute" });
  const byRef = new Map(result.fit.excludedRows.map(row => [row.ref, row.reason]));
  assert.equal(byRef.get("n1"), "insufficient-observation",
    "an abstained member means the cue is missing, so it must not be called measured zero");
  assert.equal(byRef.get("n3"), "zero-usage-evidence",
    "a member that really scored zero, with no marker bits, is measured zero evidence");
});
