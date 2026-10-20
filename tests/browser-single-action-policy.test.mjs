import assert from "node:assert/strict";
import { test } from "node:test";

const policyModuleUrl = process.env.NN_SINGLE_ACTION_POLICY_URL
  ?? new URL("../dist/filters/browser-single-action-policy.js", import.meta.url).href;
const contractModuleUrl = process.env.NN_SINGLE_ACTION_CONTRACT_URL
  ?? new URL("../dist/adapters/browser/single-action-contract.js", import.meta.url).href;
const numericModuleUrl = process.env.NN_SINGLE_ACTION_NUMERIC_URL
  ?? new URL("../dist/training/browser-single-action-numeric.js", import.meta.url).href;
const trainableModuleUrl = process.env.NN_SINGLE_ACTION_TRAINABLE_URL
  ?? new URL("../dist/nodes/trainable/browser-single-action-policy.js", import.meta.url).href;
const handwiredModuleUrl = process.env.NN_SINGLE_ACTION_HANDWIRED_URL
  ?? new URL("../dist/training/handwired.js", import.meta.url).href;

const loadPolicy = () => import(policyModuleUrl);
const loadContract = () => import(contractModuleUrl);
const loadNumeric = () => import(numericModuleUrl);
const loadTrainable = () => import(trainableModuleUrl);
const loadHandwiredModule = () => import(handwiredModuleUrl);

function observed(value) {
  return { status: "observed", value, evidenceRefs: ["fixture-evidence"] };
}

function unknown(reason = "fixture missing") {
  return { status: "unknown", reason };
}

function element(ref, {
  controls = [],
  enabled = true,
  hit = true,
  buttonSemantics = true,
  tag = "div",
  role = null,
} = {}) {
  return {
    ref,
    parentRef: null,
    tag,
    role,
    basicKind: null,
    judgmentStatus: "judged",
    candidateStatus: "ok",
    controls: Array.isArray(controls) ? observed(controls) : controls,
    enabled: typeof enabled === "boolean" ? observed(enabled) : enabled,
    hit: typeof hit === "boolean" ? observed(hit) : hit,
    buttonSemantics: typeof buttonSemantics === "boolean" ? observed(buttonSemantics) : buttonSemantics,
    point: observed({ x: 10, y: 20 }),
    evidenceRefs: ["fixture-evidence"],
  };
}

function region(ref, expanded = false) {
  return {
    ref,
    expanded: typeof expanded === "boolean" ? observed(expanded) : expanded,
    rendered: observed(true),
  };
}

function snapshot(elements, regions = [region("region-a"), region("region-b")]) {
  return {
    documentRef: "document-fixture",
    observationId: "observation-fixture",
    revision: 1,
    scopeRef: "scope-fixture",
    regions,
    elements,
    evidence: [{
      id: "fixture-evidence",
      observationId: "observation-fixture",
      source: "synthetic_projection",
      fact: "fixture only",
    }],
  };
}

function request(regionRef, elements, regions) {
  return {
    goal: { kind: "SetExpanded", regionRef, desired: true },
    satisfactionThreshold: 100,
    state: snapshot(elements, regions),
  };
}

function baseElements() {
  return [
    element("region-a", { controls: [], enabled: false, hit: true, buttonSemantics: false, tag: "section" }),
    element("control-a", { controls: ["region-a"], tag: "button" }),
    element("caption", { controls: [], buttonSemantics: false, tag: "span" }),
    element("control-b", { controls: ["region-b"], tag: "button" }),
    element("region-b", { controls: [], enabled: false, hit: true, buttonSemantics: false, tag: "section" }),
  ];
}

function requestsForGoalSwap() {
  return {
    a: request("region-a", baseElements()),
    b: request("region-b", baseElements()),
  };
}

async function fixtureProfile() {
  const policy = await loadPolicy();
  const contract = await loadContract();
  const zero = policy.createZeroBrowserSingleActionProfile();
  const relation = zero.relationWeights.map(row => [...row]);
  const capability = zero.capabilityWeights.map(row => [...row]);
  const relationWire = name => contract.SINGLE_ACTION_RELATION_WIRES.indexOf(name);
  const capabilityWire = name => contract.SINGLE_ACTION_CAPABILITY_WIRES.indexOf(name);

  relation[0][relationWire("bias")] = -3;
  relation[0][relationWire("controls.target*enabled.value*hit.value")] = 6;

  capability[0][capabilityWire("bias")] = -1;
  capability[0][capabilityWire("regionExpanded.value")] = -6;
  capability[0][capabilityWire("providers.one")] = 4;

  capability[1][capabilityWire("regionExpanded.value")] = 6;

  capability[2][capabilityWire("bias")] = 14;
  capability[2][capabilityWire("providers.zero")] = 10;
  capability[2][capabilityWire("providers.many")] = 10;
  capability[2][capabilityWire("relationCoverage.complete")] = -10;
  capability[2][capabilityWire("actionabilityCoverage.complete")] = -10;

  return policy.validateBrowserSingleActionProfile({
    ...zero,
    relationWeights: relation,
    capabilityWeights: capability,
  });
}

test("profile is exactly 50 named finite parameters with a strict uncalibrated status", async () => {
  const policy = await loadPolicy();
  const zero = policy.createZeroBrowserSingleActionProfile();
  assert.equal(zero.relationWeights.length, 2);
  assert.ok(zero.relationWeights.every(row => row.length === 13));
  assert.equal(zero.capabilityWeights.length, 3);
  assert.ok(zero.capabilityWeights.every(row => row.length === 8));
  assert.equal(zero.relationWeights.flat().length + zero.capabilityWeights.flat().length, 50);
  assert.equal(zero.calibration, "uncalibrated");
  assert.equal(zero.adoption, "not_applied");

  const cases = [
    { ...zero, relationWires: [...zero.relationWires].reverse() },
    { ...zero, relationWeights: zero.relationWeights.map((row, index) => index === 0 ? [Number.NaN, ...row.slice(1)] : row) },
    { ...zero, capabilityWeights: zero.capabilityWeights.slice(0, 2) },
    { ...zero, calibration: "calibrated" },
    { ...zero, adoption: "applied" },
    { ...zero, unexpected: true },
  ];
  for (const value of cases) assert.throws(() => policy.validateBrowserSingleActionProfile(value), TypeError);
  assert.throws(() => policy.createBrowserSingleActionPolicy({ profile: cases[0] }), TypeError);
});

test("zero weights cannot complete the goal-swap pairs and never invent a click target", async () => {
  const policy = await loadPolicy();
  const zero = policy.createZeroBrowserSingleActionProfile();
  const pairs = [
    { request: requestsForGoalSwap().a, expectedRef: "control-a" },
    { request: requestsForGoalSwap().b, expectedRef: "control-b" },
  ];
  let completed = 0;
  for (const pair of pairs) {
    const prediction = policy.predictBrowserSingleAction(pair.request, zero);
    assert.equal(prediction.capability, "DEFER");
    assert.equal(prediction.proposedTargetRef, null);
    assert.ok(prediction.relations.every(relation => relation.judgment === "unknown"));
    if (prediction.capability === "CLICK" && prediction.proposedTargetRef === pair.expectedRef) completed += 1;
  }
  assert.equal(completed, 0);
  assert.ok(completed < pairs.length);
});

test("swapping the goal changes the unique student provider without changing element order", async () => {
  const policy = await loadPolicy();
  const profile = await fixtureProfile();
  const requests = requestsForGoalSwap();
  const first = policy.predictBrowserSingleAction(requests.a, profile);
  const second = policy.predictBrowserSingleAction(requests.b, profile);
  assert.equal(first.capability, "CLICK");
  assert.equal(first.proposedTargetRef, "control-a");
  assert.equal(second.capability, "CLICK");
  assert.equal(second.proposedTargetRef, "control-b");
  assert.deepEqual(first.relations.map(relation => relation.ref), requests.a.state.elements.map(item => item.ref));

  const reversed = structuredClone(requests.a);
  reversed.state.elements.reverse();
  const reversedPrediction = policy.predictBrowserSingleAction(reversed, profile);
  assert.deepEqual(
    reversedPrediction.relations.map(relation => relation.ref),
    reversed.state.elements.map(item => item.ref),
  );
  assert.equal(reversedPrediction.proposedTargetRef, "control-a");
  assert.deepEqual(reversedPrediction.capabilityFeatures, first.capabilityFeatures);
  assert.throws(
    () => policy.singleActionCapabilityFeatures(requests.a, [...first.relations].reverse()),
    /preserve request element order/,
  );
});

test("multiple providers stay ambiguous and model outputs remain raw", async () => {
  const policy = await loadPolicy();
  const contract = await loadContract();
  const profile = await fixtureProfile();
  const elements = baseElements();
  elements[3] = element("control-b", { controls: ["region-a"], tag: "button" });
  const prediction = policy.predictBrowserSingleAction(request("region-a", elements), profile);
  assert.equal(prediction.relations.filter(relation => relation.judgment === "actionable_provider").length, 2);
  assert.equal(prediction.capability, "DEFER");
  assert.equal(prediction.proposedTargetRef, null);

  const clickWeights = profile.capabilityWeights.map(row => row.map(() => 0));
  clickWeights[0][contract.SINGLE_ACTION_CAPABILITY_WIRES.indexOf("bias")] = 1;
  const rawClick = policy.validateBrowserSingleActionProfile({ ...profile, capabilityWeights: clickWeights });
  const rawMultiple = policy.predictBrowserSingleAction(request("region-a", elements), rawClick);
  assert.equal(rawMultiple.capability, "CLICK");
  assert.equal(rawMultiple.proposedTargetRef, null);

  const expanded = request("region-a", baseElements(), [region("region-a", true), region("region-b")]);
  const noop = policy.predictBrowserSingleAction(expanded, profile);
  assert.equal(noop.capability, "NOOP");
  assert.equal(noop.proposedTargetRef, null);
});

test("disabled facts stay in the wire and policy does not rewrite a raw model provider", async () => {
  const policy = await loadPolicy();
  const contract = await loadContract();
  const zero = policy.createZeroBrowserSingleActionProfile();
  const relationWeights = zero.relationWeights.map(row => row.map(() => 0));
  relationWeights[0][contract.SINGLE_ACTION_RELATION_WIRES.indexOf("controls.target")] = 1;
  const capabilityWeights = zero.capabilityWeights.map(row => row.map(() => 0));
  capabilityWeights[0][contract.SINGLE_ACTION_CAPABILITY_WIRES.indexOf("bias")] = 1;
  const rawProviderProfile = policy.validateBrowserSingleActionProfile({
    ...zero,
    relationWeights,
    capabilityWeights,
  });
  const elements = baseElements();
  elements[1] = element("control-a", { controls: ["region-a"], enabled: false, tag: "button" });
  const prediction = policy.predictBrowserSingleAction(request("region-a", elements), rawProviderProfile);
  assert.equal(prediction.relations[1].judgment, "actionable_provider");
  assert.equal(prediction.capability, "CLICK");
  assert.equal(prediction.proposedTargetRef, "control-a");
});

test("missing decisive facts and score ties remain unknown rather than negative labels", async () => {
  const policy = await loadPolicy();
  const profile = await fixtureProfile();
  const elements = baseElements();
  elements[1] = element("control-a", { controls: ["region-a"], enabled: unknown("enabled not measured") });
  const prediction = policy.predictBrowserSingleAction(request("region-a", elements), profile);
  assert.equal(prediction.relations[1].judgment, "unknown");
  assert.notEqual(prediction.proposedTargetRef, "control-a");

  const wrapperUnknown = baseElements();
  wrapperUnknown[2] = element("caption", {
    controls: [],
    enabled: unknown("enabled not applicable to this wrapper"),
    buttonSemantics: false,
    tag: "span",
  });
  const wrapperPrediction = policy.predictBrowserSingleAction(request("region-a", wrapperUnknown), profile);
  assert.equal(wrapperPrediction.relations[2].judgment, "unknown");

  const tied = policy.predictBrowserSingleAction(request("region-a", baseElements()), policy.createZeroBrowserSingleActionProfile());
  assert.ok(tied.relations.every(relation => relation.judgment === "unknown"));
});

test("identity and text fields are absent from numeric features", async () => {
  const policy = await loadPolicy();
  const baseline = baseElements();
  const noisy = structuredClone(baseline);
  Object.assign(noisy[1], {
    id: "private-control-id",
    className: "site-specific-caption",
    text: "Open the exact private post",
    url: "https://example.invalid/private",
    ordinal: 99,
    tag: "a",
    role: "link",
  });
  const first = policy.singleActionRelationFeatures(request("region-a", baseline), baseline[1]);
  const second = policy.singleActionRelationFeatures(request("region-a", noisy), noisy[1]);
  assert.deepEqual(second, first);
  assert.equal(first.includes(1), true);
  assert.equal(first.some(value => value > 1), false);
});

test("zero-epoch fit skips unknown supervision and preserves an explicit zero profile", async () => {
  const policy = await loadPolicy();
  const numeric = await loadNumeric();
  const elements = baseElements();
  elements[1] = element("control-a", { controls: ["region-a"], enabled: unknown("not measured") });
  elements[2] = element("caption", { controls: unknown("controls unresolved"), buttonSemantics: false, tag: "span" });
  const episodeRequest = request("region-a", elements);
  const episode = {
    id: "skip-unknown",
    family: "train-skip",
    partition: "train",
    request: episodeRequest,
    teacher: {
      providerRefs: ["control-a"],
      unknownRefs: ["region-a"],
      capability: "DEFER",
      source: "synthetic_projection",
      evidenceRefs: ["teacher-fixture"],
    },
  };
  const initial = policy.createZeroBrowserSingleActionProfile();
  const result = await numeric.fitBrowserSingleActionProfile({
    initial,
    episodes: [episode],
    handwiredRoot: "/backend/not-loaded-for-frozen-fit",
    relationEpochs: 0,
    capabilityEpochs: 0,
    learningRate: 0.1,
  });
  assert.deepEqual(result.profile, initial);
  assert.equal(result.trajectory.length, 0);
  assert.equal(result.timing.backendLoadMs, 0);
  assert.equal(result.timing.trainableParamCount, 50);
  assert.equal(result.timing.relationRows, 2);
  assert.equal(result.timing.capabilityRows, 1);
  assert.equal(result.timing.skippedRelationRows, 3);
  assert.equal(result.timing.gradientRowEpochs, 0);
  assert.ok(result.timing.totalFitMs >= 0);

  await assert.rejects(numeric.fitBrowserSingleActionProfile({
    ...{
      initial,
      handwiredRoot: "/backend/not-loaded",
      relationEpochs: 0,
      capabilityEpochs: 0,
      learningRate: 0.1,
    },
    episodes: [{ ...episode, partition: "verification" }],
  }), /only train episodes/);
});

test("a failing backend load retains partial fit timing", async () => {
  const policy = await loadPolicy();
  const numeric = await loadNumeric();
  const requestValue = request("region-a", baseElements());
  const episode = {
    id: "missing-backend",
    family: "train-backend",
    partition: "train",
    request: requestValue,
    teacher: {
      providerRefs: ["control-a"],
      unknownRefs: [],
      capability: "CLICK",
      source: "synthetic_projection",
      evidenceRefs: ["teacher-fixture"],
    },
  };
  await assert.rejects(numeric.fitBrowserSingleActionProfile({
    initial: policy.createZeroBrowserSingleActionProfile(),
    episodes: [episode],
    handwiredRoot: "/definitely/missing/handwired",
    relationEpochs: 1,
    capabilityEpochs: 1,
    learningRate: 0.1,
  }), error => {
    assert.match(error.message, /Handwired core is missing/);
    assert.ok(error.timing.backendLoadMs > 0);
    assert.ok(error.timing.totalFitMs > 0);
    assert.equal(error.timing.relationRows, 5);
    assert.equal(error.timing.capabilityRows, 1);
    assert.equal(error.trajectory.length, 0);
    return true;
  });
});

test("real Handwired source gradients match a finite difference and capability rows use student relations", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const policy = await loadPolicy();
  const numeric = await loadNumeric();
  const trainable = await loadTrainable();
  const { loadHandwired } = await loadHandwiredModule();
  const contract = await loadContract();
  const handwired = await loadHandwired(process.env.NN_HANDWIRED_ROOT);
  const circuit = trainable.buildBrowserSingleActionRelationCircuit(handwired);
  const featureElement = baseElements()[1];
  const features = policy.singleActionRelationFeatures(request("region-a", baseElements()), featureElement);
  const weights = Array.from({ length: circuit.parameters.length }, (_, index) => Math.fround((index - 13) / 97));
  const expectedIndex = contract.SINGLE_ACTION_RELATION_HEADS.indexOf("actionable_provider");

  function lossFor(candidateWeights) {
    const source = new Float32Array(circuit.circuit.sourceSize);
    circuit.parameters.forEach((wire, index) => { source[wire] = Math.fround(candidateWeights[index]); });
    circuit.features.forEach((wire, index) => { source[wire] = Math.fround(features[index]); });
    const values = circuit.circuit.evaluateReference(source);
    const logits = circuit.logits.map(wire => values[wire]);
    const maximum = Math.max(...logits);
    const exps = logits.map(logit => Math.exp(logit - maximum));
    const sum = exps.reduce((left, right) => left + right, 0);
    return Math.log(sum) + maximum - logits[expectedIndex];
  }

  const source = new Float32Array(circuit.circuit.sourceSize);
  circuit.parameters.forEach((wire, index) => { source[wire] = Math.fround(weights[index]); });
  circuit.features.forEach((wire, index) => { source[wire] = Math.fround(features[index]); });
  const values = circuit.circuit.evaluateReference(source);
  const logits = circuit.logits.map(wire => values[wire]);
  const maximum = Math.max(...logits);
  const exps = logits.map(logit => Math.exp(logit - maximum));
  const sum = exps.reduce((left, right) => left + right, 0);
  const outputGradients = new Float32Array(values.length);
  circuit.logits.forEach((wire, index) => {
    outputGradients[wire] = Math.fround(exps[index] / sum - Number(index === expectedIndex));
  });
  const sourceGradients = circuit.circuit.backpropagateReference(values, outputGradients);
  const gradient = circuit.parameters.map(wire => sourceGradients[wire]);
  const parameterIndex = contract.SINGLE_ACTION_RELATION_WIRES.indexOf("controls.target*enabled.value*hit.value");
  const epsilon = 0.01;
  const plus = [...weights];
  const minus = [...weights];
  plus[parameterIndex] = Math.fround(plus[parameterIndex] + epsilon);
  minus[parameterIndex] = Math.fround(minus[parameterIndex] - epsilon);
  const numericGradient = (lossFor(plus) - lossFor(minus)) / (plus[parameterIndex] - minus[parameterIndex]);
  assert.ok(Number.isFinite(gradient[parameterIndex]));
  assert.ok(Math.abs(gradient[parameterIndex]) > 1e-6);
  assert.ok(Math.abs(gradient[parameterIndex] - numericGradient) < 2e-3);

  const elements = baseElements();
  elements[1] = element("control-a", { controls: ["region-a"], enabled: unknown("student cannot decide") });
  const episodeRequest = request("region-a", elements);
  const learningRate = 0.1;
  const fit = await numeric.fitBrowserSingleActionProfile({
    initial: policy.createZeroBrowserSingleActionProfile(),
    episodes: [{
      id: "student-capability-input",
      family: "train-gradient",
      partition: "train",
      request: episodeRequest,
      teacher: {
        providerRefs: ["control-a"],
        unknownRefs: [],
        capability: "CLICK",
        source: "synthetic_projection",
        evidenceRefs: ["teacher-fixture"],
      },
    }],
    handwiredRoot: process.env.NN_HANDWIRED_ROOT,
    relationEpochs: 1,
    capabilityEpochs: 1,
    learningRate,
  });
  assert.deepEqual(fit.trajectory.map(entry => entry.phase), ["relation", "capability"]);
  assert.ok(fit.trajectory.every(entry => entry.gradient.some(value => Math.abs(value) > 1e-8)));
  assert.ok(fit.trajectory.every(entry => entry.weights.every(Number.isFinite)));

  const relationOnly = policy.validateBrowserSingleActionProfile({
    ...fit.profile,
    capabilityWeights: fit.profile.capabilityWeights.map(row => row.map(() => 0)),
  });
  const studentRelations = policy.predictBrowserSingleAction(episodeRequest, relationOnly).relations;
  const studentFeatures = policy.singleActionCapabilityFeatures(episodeRequest, studentRelations);
  const providersZero = contract.SINGLE_ACTION_CAPABILITY_WIRES.indexOf("providers.zero");
  const providersOne = contract.SINGLE_ACTION_CAPABILITY_WIRES.indexOf("providers.one");
  const clickHead = contract.SINGLE_ACTION_CAPABILITY_HEADS.indexOf("CLICK");
  assert.equal(studentFeatures[providersZero], 1);
  assert.equal(studentFeatures[providersOne], 0);
  const capabilityEpoch = fit.trajectory.find(entry => entry.phase === "capability" && entry.epoch === 1);
  assert.ok(capabilityEpoch);
  const clickWeights = capabilityEpoch.weights.slice(
    clickHead * contract.SINGLE_ACTION_CAPABILITY_WIRES.length,
    (clickHead + 1) * contract.SINGLE_ACTION_CAPABILITY_WIRES.length,
  );
  for (let index = 0; index < studentFeatures.length; index += 1) {
    assert.ok(Math.abs(clickWeights[index] - studentFeatures[index] * (2 * learningRate / 3)) < 1e-6);
  }
});
