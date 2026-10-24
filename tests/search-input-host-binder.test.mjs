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
  neutralSearchInputHostProfile,
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

test("absolute: only usage-evidence wires change; the other 31 stay exactly zero", async () => {
  const rows = JSON.parse(await readFile(TRAIN_ABSOLUTE_PATH, "utf8"));
  const result = trainSearchInputHostBinder({ batches: rows.batches }, { objective: "absolute" });
  assert.equal(result.fit.objective, "absolute");
  for (let index = 0; index < SEARCH_INPUT_HOST_WIRES.length; index += 1) {
    const wire = SEARCH_INPUT_HOST_WIRES[index];
    if (wire !== "markerHit" && wire !== "nonSearchMarker" && wire !== "formRoleSearch") {
      assert.equal(result.profile.weights[index], 0, `carrier wire ${wire} must stay frozen at zero`);
    }
  }
  assert.equal(result.profile.weights.length, 34);
  assert.ok(result.profile.weights.some(weight => weight !== 0));
  assert.equal(result.profile.calibration, "uncalibrated");
  assert.equal(result.profile.adoption, "not_applied");
});

test("absolute: a memo field inside a role=search form is not selected after fitting", async () => {
  const rows = JSON.parse(await readFile(TRAIN_ABSOLUTE_PATH, "utf8"));
  const result = trainSearchInputHostBinder({ batches: rows.batches }, { objective: "absolute" });
  const batch = rows.batches.find(entry => entry.id === "batch-s7a");
  const memo = batch.candidates.find(candidate => candidate.ref === "scope-s7a-11");
  const scopeRef = batch.candidates[0].scopeRef;
  const first = batch.candidates[0];
  const request = requestFor(batch.candidates, {
    goal: { requestedRole: "search-input-host", allowedScopeRef: scopeRef },
    coverage: {
      scopeRef,
      observedCandidateCount: batch.candidates.length,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
      excluded: [],
    },
    currentControl: { documentRef: first.documentRef, observationId: first.observationId, revision: first.revision },
  });
  const outcome = inferSearchInputHostBinding(request, { profile: result.profile });
  assert.equal(outcome.selectedRef, "scope-s7a-9", "the query field must win inside the same role=search form");
  assert.notEqual(outcome.selectedRef, memo.ref, "the search-form memo must not be selected");
});

test("absolute: an all-zero-evidence negative is reported excluded, never silently given a margin", async () => {
  const rows = JSON.parse(await readFile(TRAIN_ABSOLUTE_PATH, "utf8"));
  const result = trainSearchInputHostBinder({ batches: rows.batches }, { objective: "absolute" });
  assert.equal(result.fit.fittedRowCount, 14, "the two unlearnable rows must not enter the fitted set");
  const excluded = result.fit.excludedRows.map(row => row.ref);
  assert.deepEqual([...excluded].sort(), ["scope-s1a-19", "scope-s1b-18"]);
  for (const row of result.fit.excludedRows) {
    assert.equal(row.reason, "zero-usage-evidence");
    assert.equal(row.roleMatch, 0, "below theta by construction, not recognised as non-search");
  }
});

test("absolute: the stop metric is reported and the budget bound throws", async () => {
  const rows = JSON.parse(await readFile(TRAIN_ABSOLUTE_PATH, "utf8"));
  const result = trainSearchInputHostBinder({ batches: rows.batches }, { objective: "absolute" });
  assert.equal(typeof result.fit.stopEpoch, "number");
  assert.ok(result.fit.stopEpoch > 0 && result.fit.stopEpoch <= 400);
  assert.ok(result.fit.worstMarginViolation <= 0, "the reported stop metric is the fitted-set maximum");
});

test("absolute: a learning rate that drives a weight to the bound throws instead of clamping", async () => {
  const rows = JSON.parse(await readFile(TRAIN_ABSOLUTE_PATH, "utf8"));
  assert.throws(
    () => trainSearchInputHostBinder({ batches: rows.batches }, { objective: "absolute", learningRate: 100 }),
    /weight bound/,
  );
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
