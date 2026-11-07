// Real-adapter tests for the shared value-flow relationshipProjection.
//
// The adapter parses real TypeScript source and derives only raw local facts.
// It never reads gold, analyzer edges, A_g or future receipts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observeValueFlowSource,
  enumerateValueFlowCandidates,
  projectValueFlowRelationship,
  encodeValueFlowRelationshipStudent,
} from "../dist/training/value-flow-relationship-adapter.js";

const KILL_AND_ORDER = `
function killOrder() {
  let x = 0;
  const u0 = x;
  x = 3;
  const u1 = x;
}
`;

const CONDITIONAL = `
function conditional(c) {
  let x = 0;
  if (c) { x = 1; }
  const u = x;
}
`;

const CONDITIONAL_AFTER_UNCONDITIONAL = `
function condAfterUncond(c) {
  let x = 0;
  x = 3;
  if (c) { x = 1; }
  const u = x;
}
`;

const BRANCH_KILL = `
function branchKill(c) {
  let x = 0;
  if (c) { x = 1; } else { x = 2; }
  const u = x;
}
`;

const BRANCH_MAY = `
function branchMay(c) {
  let x = 0;
  if (c) { x = 1; x = 2; }
  const u = x;
}
`;

const OTHER_DECL = `
function otherDecl() {
  let x = 0;
  let y = 0;
  y = 1;
  const u = x;
}
`;

const CALLS = `
function g(a, b) { return a; }
function h(a, b) { return b; }
function callers() {
  g(1, 2);
  h(3, 4);
}
`;

const LOOP_WRITE = `
function loopWrite(c) {
  let x = 0;
  while (c) { x = 1; }
  const u = x;
}
`;

const FOR_INIT_WRITE = `
let x = 0;
for (x = 1; false; ) {}
console.log(x);
`;

const REPEATED_INIT_VAR = `
function f() {
  var x = 0;
  var x = 1;
  console.log(x);
}
`;

const ASSIGNMENT_READ_OWN_RHS = `
let x = 0;
x = x + 1;
`;

const ASSIGNMENT_READ_THEN_READ = `
let x = 0;
x = x + 1;
x;
`;

const ASSIGNMENT_THEN_READ = `
let x = 0;
x = 1;
x;
`;

const REPEATED_VAR_OWN_RHS = `
function f() {
  var x = 0;
  var x = x + 1;
  x;
}
`;

const OTHER_DECL_INITIALIZER_READ = `
let x = 0;
let y = x;
x;
`;

const MULTILINE_ASSIGNMENT_READ = `
let x = 0;
x =
  x + 1;
`;

const NESTED_ASSIGNMENT = `
let x = 0;
x = (x = 1);
x;
`;

const COMPOUND_ASSIGNMENT = `
let x = 0;
x += 1;
x;
`;

const DESTRUCTURING_ASSIGNMENT = `
let o = {};
let x = 0;
({ x } = o);
x;
`;

const CONDITIONAL_ASSIGNMENT = `
let c = true;
let x = 0;
x = (c ? (x = 1) : 2);
x;
`;

const UNCALLED_CALL_BODY = `
let x = 0;
function f() {
  g();
}
console.log(x);
`;

const UNCALLED_CONTROL_BODY = `
let x = 0;
function f() {
  while (true) {}
  try { g(); } catch (e) {}
}
console.log(x);
`;

const THREE_ARGS = `
function three(a, b) { return a; }
function caller() {
  three(1, 2, 3);
}
`;

const SHADOWED_DECL = `
function shadowed() {
  let x = 0;
  { let x = 1; x = 2; }
  const u = x;
}
`;

const INCREMENT_WRITE = `
function incrementWrite() {
  let x = 0;
  x++;
  const u = x;
}
`;

const NESTED_IF = `
function nestedIf(a, b) {
  let x = 0;
  if (a) { if (b) { x = 1; } }
  const u = x;
}
`;

const SYNTAX_ERROR = `
function syntaxError() {
  let x = ;
  const u = x;
}
`;

const SHADOWED_CALLEES = `
function g(a) { return a; }
function caller() {
  function g(a) { return a; }
  g(1);
}
`;

const HOISTED_BLOCK_CALLEE = `
function outer() {
  function f(p) { return p; }
  {
    f(1);
    function f(q) { return q; }
  }
}
`;

const FUNCTION_LOCAL_SHADOW = `
let x = 0;
function f() {
  x = 1;
  let x;
}
console.log(x);
`;

const UNCALLED_FUNCTION_WRITE = `
let x = 0;
function f() {
  x = 1;
}
console.log(x);
`;

const CALLED_FUNCTION_WRITE = `
let x = 0;
function f() {
  x = 1;
}
f();
console.log(x);
`;

const REPEATED_VAR = `
function f() {
  var x = 0;
  var x;
  console.log(x);
}
`;

const LOCAL_SEQUENTIAL_WRITE = `
function f() {
  let x = 0;
  x = 1;
  const u = x;
}
`;

function observe(sourceText) {
  return observeValueFlowSource({ relPath: "fixture.ts", sourceText });
}

function writeSite(observations, symbolName, startLine) {
  const site = observations.sites.find(s =>
    s.kind === "write" && s.symbolName === symbolName && s.span.startLine === startLine);
  assert.ok(site, `missing write site ${symbolName}@${startLine}`);
  return site;
}

function readSite(observations, symbolName, startLine) {
  const site = observations.sites.find(s =>
    s.kind === "read" && s.symbolName === symbolName && s.span.startLine === startLine);
  assert.ok(site, `missing read site ${symbolName}@${startLine}`);
  return site;
}

function argSite(observations, calleeName, ordinalIndex) {
  const site = observations.sites.find(s =>
    s.kind === "call_arg" && s.calleeName === calleeName && s.ordinalIndex === ordinalIndex);
  assert.ok(site, `missing arg site ${calleeName}#${ordinalIndex}`);
  return site;
}

function paramSite(observations, ownerName, ordinalIndex) {
  const site = observations.sites.find(s =>
    s.kind === "param" && s.scopeChain.includes(ownerName) && s.ordinalIndex === ordinalIndex);
  assert.ok(site, `missing param site ${ownerName}#${ordinalIndex}`);
  return site;
}

function reachingDefCandidate(write, read) {
  return {
    candidateRef: `cand:${write.siteRef}->${read.siteRef}`,
    relationKind: "reaching_def",
    source: { observed: true, siteRef: write.siteRef, role: "write", ordinalIndex: null },
    sink: { observed: true, siteRef: read.siteRef, role: "read", ordinalIndex: null },
    coverage: { orderObserved: true, bodyObserved: true },
  };
}

function argToParamCandidate(source, sink) {
  return {
    candidateRef: `cand:${source.siteRef}->${sink.siteRef}`,
    relationKind: "arg_to_param",
    source: { observed: true, siteRef: source.siteRef, role: "argument", ordinalIndex: source.ordinalIndex },
    sink: { observed: true, siteRef: sink.siteRef, role: "parameter", ordinalIndex: sink.ordinalIndex },
    coverage: { orderObserved: true, bodyObserved: true },
  };
}

function firstReachingCandidate(observations) {
  const source = observations.sites.find(s =>
    s.kind === "write" && s.symbolName === "x" && s.span.startLine === 3);
  const sink = observations.sites.find(s =>
    s.kind === "read" && s.symbolName === "x" && source !== undefined && s.declRef === source.declRef);
  assert.ok(source && sink, "expected outer declaration and later read");
  return reachingDefCandidate(source, sink);
}

function slots(student) {
  const x = student.xByOption["judge=unknown"];
  return { x15: x[15], x23: x[23], x31: x[31], x51: x[51], x55: x[55], missingMode: student.missingMode };
}

function reachingProjection(sourceText, sourceLine, sinkLine) {
  const observations = observe(sourceText);
  const source = writeSite(observations, "x", sourceLine);
  const sink = readSite(observations, "x", sinkLine);
  return projectValueFlowRelationship(reachingDefCandidate(source, sink), observations);
}

function reachingSlots(sourceText, sourceLine, sinkLine) {
  const observations = observe(sourceText);
  const source = writeSite(observations, "x", sourceLine);
  const sink = readSite(observations, "x", sinkLine);
  return slots(encodeValueFlowRelationshipStudent(reachingDefCandidate(source, sink), observations));
}

test("raw observation exposes write/read sites and branch conditionality", () => {
  const observations = observe(KILL_AND_ORDER);
  assert.equal(observations.parseError, null);
  const writes = observations.sites.filter(s => s.kind === "write" && s.symbolName === "x");
  assert.deepEqual(writes.map(s => s.span.startLine).sort((a, b) => a - b), [3, 5]);
  assert.ok(writes.every(s => s.conditionalKinds.length === 0));
  const conditional = observe(CONDITIONAL);
  const condWrite = conditional.sites.find(s =>
    s.kind === "write" && s.symbolName === "x" && s.span.startLine === 4);
  assert.ok(condWrite.conditionalKinds.includes("if_true"));
  assert.ok(condWrite.insideLoop === false);
});

test("raw observation keeps call ordinals and parameter ordinals", () => {
  const observations = observe(CALLS);
  const g0 = argSite(observations, "g", 0);
  assert.equal(g0.ordinalIndex, 0);
  assert.ok(g0.calleeDeclRef);
  assert.equal(g0.calleeDeclRef, paramSite(observations, "g", 0).ownerDeclRef);
  assert.notEqual(g0.calleeDeclRef, paramSite(observations, "h", 0).ownerDeclRef);
  assert.equal(argSite(observations, "g", 1).ordinalIndex, 1);
  assert.equal(paramSite(observations, "h", 1).ordinalIndex, 1);
});

test("callee and parameter binding use declaration identity rather than names", () => {
  const observations = observe(SHADOWED_CALLEES);
  const call = argSite(observations, "g", 0);
  const params = observations.sites.filter(site => site.kind === "param" && site.ordinalIndex === 0);
  assert.equal(params.length, 2);
  const matching = params.filter(site => site.ownerDeclRef === call.calleeDeclRef);
  const other = params.filter(site => site.ownerDeclRef !== call.calleeDeclRef);
  assert.equal(matching.length, 1);
  assert.equal(other.length, 1);
  const same = projectValueFlowRelationship(argToParamCandidate(call, matching[0]), observations);
  const different = projectValueFlowRelationship(argToParamCandidate(call, other[0]), observations);
  assert.equal(same.projection.bindingResolution.value, "same_callee");
  assert.equal(different.projection.bindingResolution.value, "different_callee");
});

test("block declarations bind calls even when the shadow is declared later", () => {
  const observations = observe(HOISTED_BLOCK_CALLEE);
  const call = argSite(observations, "f", 0);
  const params = observations.sites.filter(site =>
    site.kind === "param" && site.ordinalIndex === 0);
  const outer = params.find(site => site.span.startLine === 3);
  const inner = params.find(site => site.span.startLine === 6);
  assert.ok(outer && inner);
  assert.notEqual(call.calleeDeclRef, outer.ownerDeclRef);
  assert.equal(call.calleeDeclRef, inner.ownerDeclRef);
  assert.equal(
    projectValueFlowRelationship(argToParamCandidate(call, outer), observations)
      .projection.bindingResolution.value,
    "different_callee",
  );
  assert.equal(
    projectValueFlowRelationship(argToParamCandidate(call, inner), observations)
      .projection.bindingResolution.value,
    "same_callee",
  );
});

test("later lexical declarations shadow outer bindings throughout a function body", () => {
  const observations = observe(FUNCTION_LOCAL_SHADOW);
  const outer = writeSite(observations, "x", 2);
  const inner = writeSite(observations, "x", 4);
  const sink = readSite(observations, "x", 7);
  assert.notEqual(inner.declRef, outer.declRef);
  assert.equal(sink.declRef, outer.declRef);
  const result = projectValueFlowRelationship(reachingDefCandidate(outer, sink), observations);
  assert.equal(result.projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
});

test("function bodies are isolated execution domains for local reaching definitions", () => {
  const observations = observe(UNCALLED_FUNCTION_WRITE);
  const outer = writeSite(observations, "x", 2);
  const inner = writeSite(observations, "x", 4);
  const sink = readSite(observations, "x", 6);
  const outerResult = projectValueFlowRelationship(reachingDefCandidate(outer, sink), observations);
  assert.deepEqual(outerResult.admission, {
    denominatorEligible: true,
    status: "eligible",
    reasons: [],
  });
  assert.equal(outerResult.projection.orderFlowAndCoverage.value.orderFlowIndex, 1);

  const crossDomain = enumerateValueFlowCandidates(observations).find(candidate =>
    candidate.relationKind === "reaching_def"
    && candidate.source.siteRef === inner.siteRef
    && candidate.sink.siteRef === sink.siteRef);
  assert.ok(crossDomain, "expected the nested write to be enumerated for explicit admission");
  assert.deepEqual(projectValueFlowRelationship(crossDomain, observations).admission, {
    denominatorEligible: false,
    status: "unsupported",
    reasons: ["execution_domain_out_of_slice"],
  });

  const local = observe(LOCAL_SEQUENTIAL_WRITE);
  const localSource = writeSite(local, "x", 3);
  const localSink = readSite(local, "x", 5);
  const localResult = projectValueFlowRelationship(
    reachingDefCandidate(localSource, localSink),
    local,
  );
  assert.deepEqual(localResult.admission, {
    denominatorEligible: true,
    status: "eligible",
    reasons: [],
  });
  assert.equal(localResult.projection.orderFlowAndCoverage.value.orderFlowIndex, 2);
});

test("real calls keep their raw fact and leave uncovered call effects unsupported", () => {
  const observations = observe(CALLED_FUNCTION_WRITE);
  assert.ok(observations.sites.some(site =>
    site.kind === "call" && site.calleeName === "f" && site.ordinalIndex === null),
  "expected a raw zero-argument call fact");

  const source = writeSite(observations, "x", 2);
  const sink = readSite(observations, "x", 7);
  const result = projectValueFlowRelationship(reachingDefCandidate(source, sink), observations);
  assert.deepEqual(result.admission, {
    denominatorEligible: false,
    status: "unsupported",
    reasons: ["call_effect_out_of_slice"],
  });
});

test("repeated var shares one binding and an uninitialized duplicate is not a write", () => {
  const observations = observe(REPEATED_VAR);
  const writes = observations.sites.filter(site =>
    site.kind === "write" && site.symbolName === "x");
  assert.equal(writes.length, 1, "only the initialized var declaration writes");
  assert.equal(writes[0].span.startLine, 3);
  assert.equal(observations.sites.some(site =>
    site.kind === "write" && site.symbolName === "x" && site.span.startLine === 4), false);

  const source = writeSite(observations, "x", 3);
  const sink = readSite(observations, "x", 5);
  assert.equal(sink.declRef, source.declRef);
  const result = projectValueFlowRelationship(reachingDefCandidate(source, sink), observations);
  assert.deepEqual(result.admission, {
    denominatorEligible: true,
    status: "eligible",
    reasons: [],
  });
  assert.equal(result.projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
});

test("a repeated initialized var is a same-binding intervening write", () => {
  const observations = observe(REPEATED_INIT_VAR);
  const source = writeSite(observations, "x", 3);
  const sink = readSite(observations, "x", 5);
  const result = projectValueFlowRelationship(reachingDefCandidate(source, sink), observations);
  assert.deepEqual(result.admission, {
    denominatorEligible: true,
    status: "eligible",
    reasons: [],
  });
  assert.equal(result.projection.orderFlowAndCoverage.value.orderFlowIndex, 2);
});

test("an assignment write completes after its own RHS read", () => {
  const observations = observe(ASSIGNMENT_READ_OWN_RHS);
  const initial = writeSite(observations, "x", 2);
  const assignment = writeSite(observations, "x", 3);
  const rhs = readSite(observations, "x", 3);

  const initialToRhs = projectValueFlowRelationship(
    reachingDefCandidate(initial, rhs),
    observations,
  );
  assert.deepEqual(initialToRhs.admission, {
    denominatorEligible: true,
    status: "eligible",
    reasons: [],
  });
  assert.equal(initialToRhs.projection.orderFlowAndCoverage.value.orderFlowIndex, 1);

  const ownRhsCandidate = enumerateValueFlowCandidates(observations)
    .find(candidate => candidate.relationKind === "reaching_def"
      && candidate.source.siteRef === assignment.siteRef
      && candidate.sink.siteRef === rhs.siteRef);
  assert.equal(ownRhsCandidate, undefined);
});

test("an assignment RHS read is not covered by its future writeback", () => {
  const observations = observe(ASSIGNMENT_READ_THEN_READ);
  const initial = writeSite(observations, "x", 2);
  const assignment = writeSite(observations, "x", 3);
  const rhs = readSite(observations, "x", 3);
  const finalRead = readSite(observations, "x", 4);

  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(initial, rhs),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(initial, finalRead),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 2);
  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(assignment, finalRead),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
});

test("a normal assignment remains a same-binding intervening write", () => {
  const observations = observe(ASSIGNMENT_THEN_READ);
  const initial = writeSite(observations, "x", 2);
  const assignment = writeSite(observations, "x", 3);
  const finalRead = readSite(observations, "x", 4);

  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(initial, finalRead),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 2);
  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(assignment, finalRead),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
});

test("a repeated initialized var does not connect to its own initializer read", () => {
  const observations = observe(REPEATED_VAR_OWN_RHS);
  const initial = writeSite(observations, "x", 3);
  const repeated = writeSite(observations, "x", 4);
  const initializerRead = readSite(observations, "x", 4);
  const finalRead = readSite(observations, "x", 5);

  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(initial, initializerRead),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(initial, finalRead),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 2);
  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(repeated, finalRead),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
  assert.equal(enumerateValueFlowCandidates(observations)
    .find(candidate => candidate.relationKind === "reaching_def"
      && candidate.source.siteRef === repeated.siteRef
      && candidate.sink.siteRef === initializerRead.siteRef), undefined);
});

test("another declaration write completes before a later read but not inside its own initializer", () => {
  const observations = observe(OTHER_DECL_INITIALIZER_READ);
  const initial = writeSite(observations, "x", 2);
  const initializerRead = readSite(observations, "x", 3);
  const finalRead = readSite(observations, "x", 4);

  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(initial, initializerRead),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(initial, finalRead),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 4);
});

test("multiline assignment ordering uses the write completion position", () => {
  const observations = observe(MULTILINE_ASSIGNMENT_READ);
  const initial = writeSite(observations, "x", 2);
  const assignment = writeSite(observations, "x", 3);
  const rhs = readSite(observations, "x", 4);

  assert.equal(projectValueFlowRelationship(
    reachingDefCandidate(initial, rhs),
    observations,
  ).projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
  assert.equal(enumerateValueFlowCandidates(observations)
    .find(candidate => candidate.relationKind === "reaching_def"
      && candidate.source.siteRef === assignment.siteRef
      && candidate.sink.siteRef === rhs.siteRef), undefined);
});

test("out-of-slice assignment forms stay unsupported", () => {
  const cases = [
    { sourceText: NESTED_ASSIGNMENT, sourceLine: 2, sinkLine: 4, kind: "nested_assignment" },
    { sourceText: COMPOUND_ASSIGNMENT, sourceLine: 2, sinkLine: 4, kind: "compound_assignment" },
    { sourceText: DESTRUCTURING_ASSIGNMENT, sourceLine: 3, sinkLine: 5, kind: "complex_assignment" },
    { sourceText: CONDITIONAL_ASSIGNMENT, sourceLine: 3, sinkLine: 5, kind: "nested_assignment" },
  ];
  for (const sourceCase of cases) {
    const observations = observe(sourceCase.sourceText);
    assert.ok(observations.unsupportedSyntaxRecords.some(record =>
      record.kind === sourceCase.kind && record.reason === "assignment_out_of_slice"));
    const result = projectValueFlowRelationship(reachingDefCandidate(
      writeSite(observations, "x", sourceCase.sourceLine),
      readSite(observations, "x", sourceCase.sinkLine),
    ), observations);
    assert.deepEqual(result.admission, {
      denominatorEligible: false,
      status: "unsupported",
      reasons: ["assignment_out_of_slice"],
    });
  }
});

test("uncalled function facts do not isolate an outer candidate", () => {
  const callBody = observe(UNCALLED_CALL_BODY);
  const callResult = projectValueFlowRelationship(
    reachingDefCandidate(writeSite(callBody, "x", 2), readSite(callBody, "x", 6)),
    callBody,
  );
  assert.deepEqual(callResult.admission, {
    denominatorEligible: true,
    status: "eligible",
    reasons: [],
  });
  assert.equal(callResult.projection.orderFlowAndCoverage.value.orderFlowIndex, 1);

  const controlBody = observe(UNCALLED_CONTROL_BODY);
  const controlResult = projectValueFlowRelationship(
    reachingDefCandidate(writeSite(controlBody, "x", 2), readSite(controlBody, "x", 7)),
    controlBody,
  );
  assert.deepEqual(controlResult.admission, {
    denominatorEligible: true,
    status: "eligible",
    reasons: [],
  });
  assert.equal(controlResult.projection.orderFlowAndCoverage.value.orderFlowIndex, 1);
});

test("candidate enumeration yields raw pairs without truth fields", () => {
  const observations = observe(KILL_AND_ORDER);
  const reaching = enumerateValueFlowCandidates(observations)
    .filter(c => c.relationKind === "reaching_def");
  assert.equal(reaching.length, 3);
  assert.ok(reaching.every(c => !("gold" in c) && !("truth" in c)));
  const calls = enumerateValueFlowCandidates(observe(CALLS))
    .filter(c => c.relationKind === "arg_to_param");
  // Two call sites and two callee parameter tables yield eight raw ordinal-0 pairs.
  assert.equal(calls.filter(c => c.source.ordinalIndex === 0).length, 8);
});

test("reaching-def projection encodes order-flow and coverage without relation truth", () => {
  assert.deepEqual(reachingSlots(KILL_AND_ORDER, 3, 4), {
    x15: 1 / 7,
    x23: 4 / 19,
    x31: 4 / 19,
    x51: 6 / 39,
    x55: 0,
    missingMode: [],
  });
  assert.deepEqual(reachingSlots(KILL_AND_ORDER, 3, 6), {
    x15: 1 / 7,
    x23: 4 / 19,
    x31: 4 / 19,
    x51: 10 / 39,
    x55: 0,
    missingMode: [],
  });
  assert.deepEqual(reachingSlots(OTHER_DECL, 3, 6), {
    x15: 1 / 7,
    x23: 4 / 19,
    x31: 4 / 19,
    x51: 18 / 39,
    x55: 0,
    missingMode: [],
  });
  assert.equal(JSON.stringify(reachingProjection(KILL_AND_ORDER, 3, 4)).includes("judge="), false);
});

test("conditional and branch facts select the accepted order-flow codes", () => {
  assert.equal(reachingSlots(CONDITIONAL, 3, 5).x51, 14 / 39);
  assert.equal(reachingSlots(CONDITIONAL_AFTER_UNCONDITIONAL, 3, 6).x51, 26 / 39);
  assert.equal(reachingSlots(BRANCH_KILL, 3, 5).x51, 34 / 39);
  assert.equal(reachingSlots(BRANCH_MAY, 3, 5).x51, 38 / 39);
});

test("argument-to-parameter projection keeps ordinals and callee resolution separate", () => {
  const observations = observe(CALLS);
  const g0 = argSite(observations, "g", 0);
  const g1 = argSite(observations, "g", 1);
  const gp0 = paramSite(observations, "g", 0);
  const gp1 = paramSite(observations, "g", 1);
  const hp0 = paramSite(observations, "h", 0);

  assert.deepEqual(slots(encodeValueFlowRelationshipStudent(argToParamCandidate(g0, gp0), observations)), {
    x15: 5 / 7,
    x23: 8 / 19,
    x31: 8 / 19,
    x51: 30 / 39,
    x55: 0.5,
    missingMode: [],
  });
  assert.deepEqual(slots(encodeValueFlowRelationshipStudent(argToParamCandidate(g1, gp1), observations)), {
    x15: 5 / 7,
    x23: 9 / 19,
    x31: 9 / 19,
    x51: 30 / 39,
    x55: 0.5,
    missingMode: [],
  });
  assert.deepEqual(slots(encodeValueFlowRelationshipStudent(argToParamCandidate(g1, gp0), observations)), {
    x15: 5 / 7,
    x23: 9 / 19,
    x31: 8 / 19,
    x51: 30 / 39,
    x55: 0.5,
    missingMode: [],
  });
  assert.equal(
    slots(encodeValueFlowRelationshipStudent(argToParamCandidate(g0, hp0), observations)).x55,
    0.75,
  );
});

test("missing argument and parameter facts stay unresolved without inventing ordinals", () => {
  const observations = observe(CALLS);
  const arg1 = argSite(observations, "g", 1);
  const param1 = paramSite(observations, "g", 1);
  const missingArgument = {
    candidateRef: "cand:missing-argument",
    relationKind: "arg_to_param",
    source: { observed: false, siteRef: null, role: "argument", ordinalIndex: 1 },
    sink: { observed: true, siteRef: param1.siteRef, role: "parameter", ordinalIndex: 1 },
    coverage: { orderObserved: false, bodyObserved: true },
  };
  const missingParameter = {
    candidateRef: "cand:missing-parameter",
    relationKind: "arg_to_param",
    source: { observed: true, siteRef: arg1.siteRef, role: "argument", ordinalIndex: 1 },
    sink: { observed: false, siteRef: null, role: "parameter", ordinalIndex: 1 },
    coverage: { orderObserved: true, bodyObserved: false },
  };

  assert.deepEqual(slots(encodeValueFlowRelationshipStudent(missingArgument, observations)), {
    x15: 5 / 7,
    x23: 0,
    x31: 9 / 19,
    x51: 28 / 39,
    x55: 0.25,
    missingMode: [],
  });
  assert.deepEqual(slots(encodeValueFlowRelationshipStudent(missingParameter, observations)), {
    x15: 5 / 7,
    x23: 9 / 19,
    x31: 0,
    x51: 28 / 39,
    x55: 0.25,
    missingMode: [],
  });
});

test("admission isolates out-of-slice ordinals and loop control flow", () => {
  const threeArgs = observe(THREE_ARGS);
  const arg2 = argSite(threeArgs, "three", 2);
  const param0 = paramSite(threeArgs, "three", 0);
  const ordinalResult = projectValueFlowRelationship(argToParamCandidate(arg2, param0), threeArgs);
  assert.deepEqual(ordinalResult.admission, {
    denominatorEligible: false,
    status: "unsupported",
    reasons: ["ordinal_out_of_slice"],
  });
  const ordinalStudent = encodeValueFlowRelationshipStudent(argToParamCandidate(arg2, param0), threeArgs);
  assert.equal(ordinalStudent.xByOption["judge=unknown"][23], -1);
  assert.ok(ordinalStudent.missingMode.some(entry =>
    entry.slotIndex === 23 && entry.reason === "unsupported_pattern" && entry.fill === -1));

  const loop = observe(LOOP_WRITE);
  const loopSource = writeSite(loop, "x", 3);
  const loopSink = readSite(loop, "x", 5);
  const loopResult = projectValueFlowRelationship(reachingDefCandidate(loopSource, loopSink), loop);
  assert.deepEqual(loopResult.admission, {
    denominatorEligible: false,
    status: "unsupported",
    reasons: ["control_flow_out_of_slice"],
  });
  const loopStudent = encodeValueFlowRelationshipStudent(reachingDefCandidate(loopSource, loopSink), loop);
  assert.equal(loopStudent.xByOption["judge=unknown"][51], 2 / 39);
  assert.equal(loopStudent.missingMode.some(entry => entry.slotIndex === 51), false);
});

test("loop constructs are unsupported even when the write sits in the for header", () => {
  const observations = observe(FOR_INIT_WRITE);
  const source = writeSite(observations, "x", 2);
  const sink = readSite(observations, "x", 4);
  const result = projectValueFlowRelationship(reachingDefCandidate(source, sink), observations);
  assert.deepEqual(result.admission, {
    denominatorEligible: false,
    status: "unsupported",
    reasons: ["control_flow_out_of_slice"],
  });
  assert.equal(result.projection.orderFlowAndCoverage.value.orderFlowIndex, 0);
});

test("missing coverage stays not-ready and keeps a denominator-eligible candidate", () => {
  const observations = observe(KILL_AND_ORDER);
  const source = writeSite(observations, "x", 3);
  const sink = readSite(observations, "x", 4);
  const candidate = {
    ...reachingDefCandidate(source, sink),
    coverage: { orderObserved: false, bodyObserved: false },
  };
  const result = projectValueFlowRelationship(candidate, observations);
  assert.deepEqual(result.admission, {
    denominatorEligible: true,
    status: "not_ready",
    reasons: ["order_flow_not_observed", "branch_body_not_observed"],
  });
  const student = encodeValueFlowRelationshipStudent(candidate, observations);
  assert.deepEqual(slots(student), {
    x15: 1 / 7,
    x23: 4 / 19,
    x31: 4 / 19,
    x51: 0,
    x55: 0,
    missingMode: [],
  });
});

test("shadows, unary writes, nested control flow, and parse failures stay isolated", () => {
  const shadowed = observe(SHADOWED_DECL);
  const shadowedResult = projectValueFlowRelationship(firstReachingCandidate(shadowed), shadowed);
  assert.deepEqual(shadowedResult.admission, {
    denominatorEligible: true,
    status: "eligible",
    reasons: [],
  });
  assert.deepEqual(shadowedResult.projection.orderFlowAndCoverage, {
    state: "known",
    value: { orderFlowIndex: 4, coverageIndex: 2 },
    evidenceRefs: shadowedResult.projection.orderFlowAndCoverage.evidenceRefs,
  });
  assert.ok(shadowedResult.projection.orderFlowAndCoverage.evidenceRefs.length > 0);

  const increment = observe(INCREMENT_WRITE);
  assert.ok(increment.unsupportedSyntaxRecords.some(record => record.kind === "unary_write"));
  const incrementResult = projectValueFlowRelationship(firstReachingCandidate(increment), increment);
  assert.deepEqual(incrementResult.admission, {
    denominatorEligible: false,
    status: "unsupported",
    reasons: ["increment_out_of_slice"],
  });

  const nested = observe(NESTED_IF);
  const nestedResult = projectValueFlowRelationship(firstReachingCandidate(nested), nested);
  assert.deepEqual(nestedResult.admission, {
    denominatorEligible: false,
    status: "unsupported",
    reasons: ["control_flow_out_of_slice"],
  });
  assert.equal(nestedResult.projection.orderFlowAndCoverage.value.orderFlowIndex, 0);

  const invalid = observe(SYNTAX_ERROR);
  assert.ok(invalid.parseError !== null, "expected TypeScript parse diagnostic");
  const missingCandidate = {
    candidateRef: "cand:parse-failure",
    relationKind: "reaching_def",
    source: { observed: false, siteRef: null, role: "write", ordinalIndex: null },
    sink: { observed: false, siteRef: null, role: "read", ordinalIndex: null },
    coverage: { orderObserved: true, bodyObserved: true },
  };
  const invalidResult = projectValueFlowRelationship(missingCandidate, invalid);
  assert.deepEqual(invalidResult.admission, {
    denominatorEligible: true,
    status: "not_ready",
    reasons: ["observation_failed"],
  });
  assert.deepEqual(invalidResult.projection.orderFlowAndCoverage, {
    state: "missing",
    reason: "observation_failed",
    evidenceRefs: invalidResult.projection.orderFlowAndCoverage.evidenceRefs,
  });
  const missingStudent = encodeValueFlowRelationshipStudent(missingCandidate, invalid);
  assert.equal(missingStudent.xByOption["judge=unknown"][51], -1);
  assert.ok(missingStudent.missingMode.some(entry =>
    entry.slotIndex === 51 && entry.reason === "observation_failed"));
});

test("student evidence exposes only encoder inputs and versions", () => {
  const observations = observe(KILL_AND_ORDER);
  const candidate = reachingDefCandidate(writeSite(observations, "x", 3), readSite(observations, "x", 4));
  const student = encodeValueFlowRelationshipStudent(candidate, observations);
  assert.deepEqual(Object.keys(student).sort(), [
    "admission",
    "candidateRef",
    "encoderVersion",
    "inputSchema",
    "missingMode",
    "relationKind",
    "xByOption",
  ]);
  assert.equal(student.encoderVersion, "nnanything.unified-step.encoder.v2");
  assert.equal(student.inputSchema, "nnanything.unified-step.v1");
  const serialized = JSON.stringify(student);
  for (const forbidden of ["gold", "A_g", "goal_met", "oracle", "analyzer", "\"edges\""]) {
    assert.equal(serialized.includes(forbidden), false, `student evidence leaked ${forbidden}`);
  }
});
