import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const distRoot = process.env.NN_BOUNDED_DECISION_DIST;
const moduleUrl = path =>
  distRoot === undefined
    ? new URL(`../dist/${path}`, import.meta.url).href
    : pathToFileURL(join(distRoot, path)).href;

const contractsUrl = moduleUrl("workflow/recursive-goal/decision-contracts.js");
const ruleUrl = moduleUrl("filters/bounded-planning-decision.js");
const numericUrl = moduleUrl("training/bounded-planning-decision.js");
const handwiredUrl = moduleUrl("training/handwired.js");

const handwiredRoot =
  process.env.NN_HANDWIRED_ROOT ?? "/Volumes/extension/code/handwired";

const loadContracts = () => import(contractsUrl);
const loadRule = () => import(ruleUrl);
const loadNumeric = () => import(numericUrl);
const loadHandwiredModule = () => import(handwiredUrl);

const scaleRef = { id: "goal.expected-satisfaction", version: "1" };
const riskScaleRef = { id: "risk", version: "1" };
const satisfactionNormalization = { min: 0, max: 1 };
const riskNormalization = { scaleRef: riskScaleRef, maxOrdinal: 4 };
const costNormalization = { unit: "step", min: 0, max: 10 };
const rankOrderNormalization = { min: 0, max: 2 };

function profileWeights(contracts, overrides) {
  const weights = Array(contracts.PLANNING_DECISION_WIRES.length).fill(0);
  for (const [name, value] of Object.entries(overrides)) {
    const index = contracts.PLANNING_DECISION_WIRES.indexOf(name);
    assert.notEqual(index, -1, `unknown wire ${name}`);
    weights[index] = value;
  }
  return weights;
}

function makeProfile(contracts, overrides, unitVersion = "1") {
  return {
    contract: contracts.PLANNING_DECISION_CONTRACT,
    providerRef: { id: "test.planning.handwired", version: "1" },
    unitRef: { id: "test.planning.decision", version: unitVersion },
    wireSchemaVersion: contracts.PLANNING_DECISION_WIRE_SCHEMA_VERSION,
    wires: [...contracts.PLANNING_DECISION_WIRES],
    featureRange: { min: 0, max: 1 },
    weights: profileWeights(contracts, overrides),
    normalization: {
      satisfaction: satisfactionNormalization,
      risk: riskNormalization,
      cost: costNormalization,
      rankOrder: rankOrderNormalization,
    },
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
}

function candidate(pathId, options = {}) {
  return {
    pathId,
    rankOrder: options.rankOrder ?? 0,
    projection: {
      terminalSatisfaction: options.satisfaction ?? null,
      riskLevels:
        options.riskOrdinal === undefined
          ? []
          : [{ scaleRef: riskScaleRef, level: options.riskLevel ?? "declared", ordinal: options.riskOrdinal }],
      maximumCost: options.cost ?? null,
      costUnit: options.cost === undefined ? null : "step",
      unknownRefs: options.unknownRefs ?? [],
      coverage: options.coverage ?? "covered",
    },
    attemptOrder: [
      {
        order: 0,
        nodeRef: `${pathId}:node`,
        skillRef: { id: `${pathId}:skill`, version: "1" },
      },
    ],
  };
}

function decisionInput(preference = "score_first", priorInfluences = []) {
  return {
    preference: { kind: preference, projectionScaleRef: scaleRef },
    candidates: [
      candidate("path:a", {
        satisfaction: 0.8,
        riskOrdinal: 1,
        riskLevel: "low",
        cost: 5,
        rankOrder: 1,
      }),
      candidate("path:b", {
        satisfaction: 0.4,
        riskOrdinal: 3,
        riskLevel: "high",
        cost: 1,
        rankOrder: 0,
      }),
    ],
    priorInfluences,
    unknown: [],
  };
}

function utilityAWeights(contracts) {
  return makeProfile(contracts, {
    "satisfaction.value": 3,
    "risk.value": -0.5,
  });
}

function utilityBWeights(contracts, unitVersion = "2") {
  return makeProfile(
    contracts,
    {
      "satisfaction.value": 1,
      "risk.value": -4,
      "cost.value": -10,
    },
    unitVersion,
  );
}

test("default rule wraps the shared rankPlanningPaths behavior", async () => {
  const contracts = await loadContracts();
  const rule = await loadRule();
  const binding = rule.createDefaultPlanningDecisionBinding();

  const scoreRanking = await contracts.resolvePlanningDecision(
    binding,
    decisionInput("score_first"),
  );
  assert.deepEqual(scoreRanking, {
    kind: "ranked",
    pathRefs: ["path:a", "path:b"],
  });

  const orderRanking = await contracts.resolvePlanningDecision(
    binding,
    decisionInput("order_first"),
  );
  assert.deepEqual(orderRanking, {
    kind: "ranked",
    pathRefs: ["path:b", "path:a"],
  });
});

test("two real Handwired weight sets reverse the same candidate ranking", async () => {
  const contracts = await loadContracts();
  const numeric = await loadNumeric();
  const handwired = await loadHandwiredModule();
  const input = decisionInput("score_first");
  const profileA = utilityAWeights(contracts);
  const profileB = utilityBWeights(contracts);
  const module = await handwired.loadHandwired(handwiredRoot);

  const circuit = numeric.buildPlanningDecisionCircuit(module, profileA);
  const originalEvaluate = circuit.circuit.evaluateReference.bind(circuit.circuit);
  let evaluateCalls = 0;
  const spyCore = Object.create(circuit.circuit);
  spyCore.evaluateReference = source => {
    evaluateCalls += 1;
    return originalEvaluate(source);
  };
  const spyCircuit = { ...circuit, circuit: spyCore };
  const evaluationA = numeric.evaluatePlanningDecision(input, profileA, spyCircuit);
  assert.equal(evaluateCalls, input.candidates.length);
  assert.deepEqual(evaluationA.ranking, {
    kind: "ranked",
    pathRefs: ["path:a", "path:b"],
  });
  const utilityByPath = Object.fromEntries(
    evaluationA.rows.map(row => [row.pathId, row.utility]),
  );
  assert.ok(Math.abs(utilityByPath["path:a"] - 2.275) < 1e-6);
  assert.ok(Math.abs(utilityByPath["path:b"] - 0.825) < 1e-6);

  const bindingA = await numeric.createHandwiredPlanningDecisionBinding({
    kind: "planning_decision.handwired.v1",
    profile: profileA,
    handwiredRoot,
  });
  const bindingB = await numeric.createHandwiredPlanningDecisionBinding({
    kind: "planning_decision.handwired.v1",
    profile: profileB,
    handwiredRoot,
  });
  assert.deepEqual(await contracts.resolvePlanningDecision(bindingA, input), {
    kind: "ranked",
    pathRefs: ["path:a", "path:b"],
  });
  assert.deepEqual(await contracts.resolvePlanningDecision(bindingB, input), {
    kind: "ranked",
    pathRefs: ["path:b", "path:a"],
  });
});

test("applicable deprioritize prior is an explicit weight-bearing input", async () => {
  const contracts = await loadContracts();
  const numeric = await loadNumeric();
  const profile = makeProfile(contracts, {
    "satisfaction.value": 3,
    "risk.value": -0.5,
    "prior.deprioritized": -2,
  });
  const binding = await numeric.createHandwiredPlanningDecisionBinding({
    kind: "planning_decision.handwired.v1",
    profile,
    handwiredRoot,
  });
  const withoutPrior = await contracts.resolvePlanningDecision(
    binding,
    decisionInput("score_first"),
  );
  assert.deepEqual(withoutPrior, {
    kind: "ranked",
    pathRefs: ["path:a", "path:b"],
  });
  const withPrior = await contracts.resolvePlanningDecision(
    binding,
    decisionInput("score_first", [
      {
        priorRef: "prior:verified-failure",
        pathRef: "path:a",
        transitionRefs: ["transition:a"],
      },
    ]),
  );
  assert.deepEqual(withPrior, {
    kind: "ranked",
    pathRefs: ["path:b", "path:a"],
  });
  assert.throws(
    () =>
      contracts.validatePlanningDecisionInput(
        decisionInput("score_first", [
          {
            priorRef: "prior:outside",
            pathRef: "path:outside",
            transitionRefs: ["transition:outside"],
          },
        ]),
      ),
    /outside the legal candidate set/,
  );
});

test("missing required measurements defer instead of zero-filling", async () => {
  const contracts = await loadContracts();
  const numeric = await loadNumeric();
  const input = {
    preference: { kind: "score_first", projectionScaleRef: scaleRef },
    candidates: [
      candidate("path:a", { satisfaction: 0.8, riskOrdinal: 1 }),
      candidate("path:b", { satisfaction: 0.4, riskOrdinal: 3 }),
    ],
    priorInfluences: [],
    unknown: [],
  };
  const costProfile = makeProfile(contracts, { "cost.value": 1 });
  const costBinding = await numeric.createHandwiredPlanningDecisionBinding({
    kind: "planning_decision.handwired.v1",
    profile: costProfile,
    handwiredRoot,
  });
  assert.deepEqual(await contracts.resolvePlanningDecision(costBinding, input), {
    kind: "defer",
    missingKeys: ["cost.value"],
    reason: "planning decision features are unknown for a required wire",
  });

  const noCostProfile = makeProfile(contracts,{"satisfaction.value":3});
  const noCostBinding = await numeric.createHandwiredPlanningDecisionBinding({
    kind: "planning_decision.handwired.v1",
    profile: noCostProfile,
    handwiredRoot,
  });
  assert.deepEqual(await contracts.resolvePlanningDecision(noCostBinding, input), {
    kind: "ranked",
    pathRefs: ["path:a", "path:b"],
  });
});

test("zero utility and exact ties defer", async () => {
  const contracts = await loadContracts();
  const numeric = await loadNumeric();
  const zeroProfile = makeProfile(contracts, {});
  const zeroBinding = await numeric.createHandwiredPlanningDecisionBinding({
    kind: "planning_decision.handwired.v1",
    profile: zeroProfile,
    handwiredRoot,
  });
  assert.deepEqual(
    await contracts.resolvePlanningDecision(zeroBinding, decisionInput()),
    {
      kind: "defer",
      missingKeys: ["utility.tie"],
      reason: "planning decision utilities are tied",
    },
  );

  const sameInput = {
    preference: { kind: "score_first", projectionScaleRef: scaleRef },
    candidates: [
      candidate("path:a", { satisfaction: 0.5, riskOrdinal: 1, cost: 2 }),
      candidate("path:b", { satisfaction: 0.5, riskOrdinal: 1, cost: 2 }),
    ],
    priorInfluences: [],
    unknown: [],
  };
  const tieProfile = utilityAWeights(contracts);
  const tieBinding = await numeric.createHandwiredPlanningDecisionBinding({
    kind: "planning_decision.handwired.v1",
    profile: tieProfile,
    handwiredRoot,
  });
  assert.deepEqual(
    await contracts.resolvePlanningDecision(tieBinding, sameInput),
    {
      kind: "defer",
      missingKeys: ["utility.tie"],
      reason: "planning decision utilities are tied",
    },
  );
});

test("profile and Handwired resource failures do not fall back to rules", async () => {
  const contracts = await loadContracts();
  const numeric = await loadNumeric();
  const valid = utilityAWeights(contracts);

  assert.throws(
    () =>
      numeric.validatePlanningDecisionProfile({
        ...valid,
        weights: valid.weights.slice(0, -1),
      }),
    /must contain 18 finite values/,
  );
  assert.throws(
    () =>
      numeric.validatePlanningDecisionProfile({
        ...valid,
        weights: valid.weights.map((weight, index) =>
          index === 0 ? Number.NaN : weight,
        ),
      }),
    /finite number/,
  );
  assert.throws(
    () =>
      numeric.validatePlanningDecisionProfile({
        ...valid,
        wires: [...valid.wires].reverse(),
      }),
    /must be exactly/,
  );

  await assert.rejects(
    numeric.createHandwiredPlanningDecisionBinding({
      kind: "planning_decision.handwired.v1",
      profile: valid,
      handwiredRoot: "",
    }),
    /handwiredRoot/,
  );
  await assert.rejects(
    numeric.createHandwiredPlanningDecisionBinding({
      kind: "planning_decision.handwired.v1",
      profile: valid,
      handwiredRoot: "/Volumes/Intel/playground/nnanything-runs/bounded-reasoning-prototype-20261020/temp/missing-handwired",
    }),
    /Handwired core is missing/,
  );
});

test("async fake binding is awaited, guarded, and rejection passes through", async () => {
  const contracts = await loadContracts();
  const input = decisionInput();
  const delayed = {
    ref: { id: "test.delayed", version: "1" },
    infer: async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return { kind: "ranked", pathRefs: ["path:b", "path:a"] };
    },
  };
  const started = Date.now();
  assert.deepEqual(await contracts.resolvePlanningDecision(delayed, input), {
    kind: "ranked",
    pathRefs: ["path:b", "path:a"],
  });
  assert.ok(Date.now() - started >= 20);

  const rejected = {
    ref: { id: "test.rejected", version: "1" },
    infer: async () => {
      throw new Error("fake decision rejection");
    },
  };
  await assert.rejects(
    contracts.resolvePlanningDecision(rejected, input),
    /fake decision rejection/,
  );

  const invalidRankings = [
    { kind: "ranked", pathRefs: ["path:a", "path:outside"] },
    { kind: "ranked", pathRefs: ["path:a", "path:a"] },
    { kind: "ranked", pathRefs: ["path:a"] },
  ];
  for (const ranking of invalidRankings) {
    const fake = {
      ref: { id: "test.invalid", version: "1" },
      infer: async () => ranking,
    };
    await assert.rejects(
      contracts.resolvePlanningDecision(fake, input),
      /pathRefs|omits|unknown path|exactly once/,
    );
  }
});

test("training is explicitly not implemented for both units", async () => {
  const contracts = await loadContracts();
  const rule = await loadRule();
  const numeric = await loadNumeric();
  const trainingInput = { kind: "planning_decision.training.v1" };
  const trainingResources = { kind: "planning_decision.training.v1" };
  for (const unit of [
    rule.createDefaultPlanningDecisionUnit(),
    numeric.createHandwiredPlanningDecisionUnit(),
  ]) {
    await assert.rejects(
      unit.train(trainingInput, trainingResources),
      error =>
        error.code === contracts.PLANNING_DECISION_TRAINING_NOT_IMPLEMENTED,
    );
  }
});
