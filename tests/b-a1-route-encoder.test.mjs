import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BA1_ENCODER_VERSION,
  BA1_INPUT_SCHEMA,
  BA1_ROUTE_DECISION_KIND,
  BA1_ROUTE_DOMAIN,
  BA1RouteEncoderError,
  encodeBA1RouteCandidate,
  encodeBA1RouteGroup,
} from "../dist/training/b-a1-route-encoder.js";

function gateContext(overrides = {}) {
  return {
    requestedRole: "search-input-host",
    allowedScopeRef: "scope-1",
    coverage: {
      status: "complete",
      evaluatedCount: 3,
      expectedCount: 3,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
    },
    candidateGroupEnumerationComplete: true,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    candidateRef: "c1",
    candidateKind: "relation",
    optionSemantics: "select",
    scopeRef: "scope-1",
    host: "input",
    type: "text",
    contentEditable: false,
    editable: true,
    disabled: false,
    readOnly: false,
    cssHidden: false,
    intersectsViewport: true,
    explicitTabIndexKind: "absent",
    tabIndexFocus: true,
    inForm: true,
    formRoleSearch: false,
    nearbySubmit: true,
    depthBand: "middle",
    hasLabel: true,
    hasPlaceholder: true,
    hasAria: false,
    markerHit: false,
    nonSearchMarker: false,
    textLenBand: 1,
    access: "available",
    ...overrides,
  };
}

test("route constants are the accepted B-A1 identifiers", () => {
  assert.equal(BA1_ROUTE_DOMAIN, "browser");
  assert.equal(BA1_ROUTE_DECISION_KIND, "R");
  assert.equal(BA1_INPUT_SCHEMA, "nnanything.unified-step.v1");
  assert.equal(BA1_ENCODER_VERSION, "nnanything.browser.b-a1-search-input-host.encoder.v1");
});

test("encodeBA1RouteCandidate produces a 64-slot vector with reserved slots fixed at 0", () => {
  const x = encodeBA1RouteCandidate(gateContext(), candidate());
  assert.equal(x.length, 64);
  for (const slot of [38, 39, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 61, 62, 63]) {
    assert.equal(x[slot], 0, `reserved slot ${slot} must be 0`);
    assert.notEqual(x[slot], -1, `reserved slot ${slot} must not be a missing sentinel`);
  }
  assert.ok(x.every(value => value !== -1), "prime slice must not emit a -1 sentinel");
});

test("encodeBA1RouteCandidate maps the B-A1 slot table exactly", () => {
  const x = encodeBA1RouteCandidate(gateContext(), candidate());
  assert.deepEqual(x.slice(0, 8), [1, 1, 1, 1, 0, 0, 0, 1]);
  assert.equal(x[8], 1); // access available
  assert.equal(x[9], 1); // host input
  assert.equal(x[10], 0); // not textarea
  assert.equal(x[11], 0); // not contenteditable
  assert.equal(x[12], 1); // editable
  assert.equal(x[13], 0); // not disabled
  assert.equal(x[14], 0); // not readOnly
  assert.equal(x[15], 0); // not cssHidden
  assert.equal(x[16], 1); // intersects viewport
  assert.deepEqual(x.slice(17, 24), [1, 0, 0, 0, 0, 0, 0]); // type.text one-hot
  assert.equal(x[24], 1); // inForm
  assert.equal(x[25], 0); // formRoleSearch
  assert.equal(x[26], 1); // nearbySubmit
  assert.deepEqual(x.slice(27, 31), [0, 0, 1, 0]); // tabindex absent one-hot
  assert.equal(x[31], 1); // tabIndexFocus
  assert.deepEqual(x.slice(32, 35), [0, 1, 0]); // depth middle one-hot
  assert.equal(x[35], 1); // hasLabel
  assert.equal(x[36], 1); // hasPlaceholder
  assert.equal(x[37], 0); // hasAria
  assert.equal(x[40], 0); // markerHit
  assert.equal(x[41], 0); // nonSearchMarker
  assert.deepEqual(x.slice(42, 45), [0, 1, 0]); // textLen short one-hot
  // x59/x60 (scorable cardinality) are backfilled by encodeBA1RouteGroup, so a
  // standalone candidate encode leaves them 0.
  assert.deepEqual(x.slice(56, 64), [1, 1, 1, 0, 0, 0, 0, 0]);
});

test("encodeBA1RouteCandidate maps access levels to fixed gate constants", () => {
  assert.equal(encodeBA1RouteCandidate(gateContext(), candidate({ access: "available" }))[8], 1);
  assert.equal(encodeBA1RouteCandidate(gateContext(), candidate({ access: "challenge" }))[8], 0.5);
  assert.equal(encodeBA1RouteCandidate(gateContext(), candidate({ access: "login_required" }))[8], 0.25);
});

test("encodeBA1RouteCandidate rejects an illegal candidate shape before encoding", () => {
  assert.throws(
    () => encodeBA1RouteCandidate(gateContext(), candidate({ candidateKind: "action" })),
    error => error instanceof BA1RouteEncoderError && error.code === "ILLEGAL_CANDIDATE",
  );
  assert.throws(
    () => encodeBA1RouteCandidate(gateContext(), candidate({ optionSemantics: "judge=x" })),
    error => error instanceof BA1RouteEncoderError && error.code === "ILLEGAL_CANDIDATE",
  );
});

test("encodeBA1RouteCandidate fails on a missing required feature instead of filling -1", () => {
  assert.throws(
    () => encodeBA1RouteCandidate(gateContext(), candidate({ editable: null })),
    error => error instanceof BA1RouteEncoderError && error.code === "MISSING_FEATURE",
  );
  assert.throws(
    () => encodeBA1RouteCandidate(gateContext(), candidate({ access: "unknown" })),
    error => error instanceof BA1RouteEncoderError && error.code === "MISSING_FEATURE",
  );
  assert.throws(
    () => encodeBA1RouteCandidate(gateContext(), candidate({ host: null })),
    error => error instanceof BA1RouteEncoderError && error.code === "MISSING_FEATURE",
  );
});

test("encodeBA1RouteCandidate fails on a missing required gate", () => {
  assert.throws(
    () => encodeBA1RouteCandidate(gateContext({ allowedScopeRef: "" }), candidate()),
    error => error instanceof BA1RouteEncoderError && error.code === "MISSING_GATE",
  );
  assert.throws(
    () => encodeBA1RouteCandidate(gateContext({ coverage: { ...gateContext().coverage, evaluatedCount: undefined } }), candidate()),
    error => error instanceof BA1RouteEncoderError && error.code === "MISSING_GATE",
  );
});

test("encodeBA1RouteGroup sets the group cardinality gate constants", () => {
  const two = encodeBA1RouteGroup({
    groupRef: "g1",
    context: gateContext(),
    candidates: [candidate({ candidateRef: "c1" }), candidate({ candidateRef: "c2" })],
    allowedCandidateRefs: ["c1"],
  });
  assert.equal(two.candidates.length, 2);
  for (const entry of two.candidates) {
    assert.equal(entry.input[59], 1, "scorableCount>1 must be 1 for a two-candidate group");
    assert.equal(entry.input[60], 0);
  }
  const one = encodeBA1RouteGroup({
    groupRef: "g2",
    context: gateContext(),
    candidates: [candidate()],
    allowedCandidateRefs: ["c1"],
  });
  assert.equal(one.candidates[0].input[59], 0);
  assert.equal(one.candidates[0].input[60], 1);
});

test("encodeBA1RouteGroup keeps A_g as a subset of S_g only", () => {
  assert.throws(
    () => encodeBA1RouteGroup({
      groupRef: "g3",
      context: gateContext(),
      candidates: [candidate({ candidateRef: "c1" })],
      allowedCandidateRefs: ["c1", "outside"],
    }),
    /outside/,
  );
});
