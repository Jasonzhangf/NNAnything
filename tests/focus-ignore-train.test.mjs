import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadWorkflow } from "nnanything";
import { BASIC_KIND_WIRE_NAMES, DEFAULT_BASIC_KIND_PROFILE, migrateBasicKindProfile } from "nnanything/browser";

import {
  EXPECTED_TRAINABLE_WIRES,
  applyBindings,
  enumerateTrainableCells,
  readRecipe,
  readStartProfile,
  validateExplicitUsage,
} from "../playground/browser/focus-ignore/train.mjs";
import {
  auditFactFidelity,
  auditMatrix,
  auditUsageAndClosure,
  auditVerificationIsolation,
  prepareExperiments,
} from "../playground/browser/focus-ignore/prepare-request.mjs";
import {
  assessUnseal,
  evaluateExperimentRows,
} from "../playground/browser/focus-ignore/evaluate.mjs";
import { auditProjection } from "../playground/browser/focus-ignore/projection-audit.mjs";
import { summarizeRetentionChecks } from "../playground/browser/f04-retention-checks.mjs";

function focusProperties(overrides = {}) {
  return {
    tag: "div",
    role: null,
    contentEditable: false,
    disabled: false,
    hidden: false,
    positiveAreaChildCount: 1,
    childElementCount: 1,
    directTextPresent: false,
    nonFormatDirectTextPresent: false,
    descendantTextPresent: false,
    pointerCursor: true,
    parentPointerCursor: false,
    tabIndexFocus: true,
    activeElementFocus: true,
    singleChildTag: "span",
    singleChildSameRect: false,
    borderPresent: false,
    aspectRatio: 0.4,
    inSvgAncestor: false,
    withinControlAncestor: false,
    inVerifiedListParent: false,
    svgGraphicChildren: false,
    ...overrides,
  };
}

function captureState(overrides = {}) {
  return {
    schemaVersion: "browser-focus-sample-repair.snapshot.v1",
    caseId: "w1-n1-0",
    family: "sample-repair-train",
    construction: "w1",
    wrapperType: "W1",
    tabindex: -1,
    state: "focused",
    stateName: "focused",
    snapshotRef: "sample-repair-train/w1-n1-0",
    documentRef: "sample-repair-train",
    objectId: "t1",
    pageState: { activeElement: "t1", readyState: "complete" },
    objectRefs: { wrapper: "ref-t1" },
    wrapperRow: { nodeRef: "ref-t1", ...focusProperties() },
    properties: [{ nodeRef: "ref-t1", ...focusProperties() }],
    evidence: { activeElementFocus: true, tabIndexFocus: true },
    connected: true,
    gold: "container",
    ...overrides,
  };
}

function sampleRow(overrides = {}) {
  return {
    sampleId: "sample-repair-train:t1:focused",
    inputRef: { snapshotRef: "sample-repair-train/t1", documentRef: "sample-repair-train", frameRef: "top", nodeRef: "ref-t1", index: 0 },
    provenanceRef: "sample-repair-train:t1:evidence",
    sourceAssociations: { snapshotRefs: ["sample-repair-train/t1"], postRefs: [], assetRefs: ["sample-repair-train"] },
    candidateQualification: { status: "ok", reasons: [] },
    captureCoverage: { frameContent: "captured", directChildren: "complete" },
    properties: focusProperties(),
    proposal: { ruleRef: null, label: null, status: "unknown" },
    review: { status: "verified", expectedLabel: "container", reviewerRef: "p4-supervision", evidenceRef: "evidence#t1", otherReason: null },
    ...overrides,
  };
}

function captureForFamily(family) {
  if (family === "sample-repair-dev") {
    return captureForExperimentFamily("sample-repair-dev", {
      schemaVersion: "browser-focus-sample-repair.capture-dev.snapshot.v1",
      positiveStates: ["initial", "focused", "blurred", "refocused"],
      ignoreStates: ["descendant-initial", "descendant-focused"],
      rowField: "containerRow",
      targetField: "target",
      stateKindField: "kind",
      goldFromKind: kind => kind === "ignore" ? "ignore" : "container",
    });
  }
  if (family === "sample-repair-verification") {
    return captureForExperimentFamily("sample-repair-verification", {
      schemaVersion: "browser-focus-sample-repair-verification.snapshot.v1",
      positiveStates: ["initial", "focused", "blurred", "refocused"],
      ignoreStates: ["unfocused", "focused"],
      rowField: "targetProperties",
      targetField: null,
      stateKindField: "kind",
      goldFromKind: kind => kind === "ignore" ? "ignore" : "container",
    });
  }
  return captureForTrainFamily(family);
}

function captureForTrainFamily(family) {
  const states = [];
  for (const wrapperType of ["W1", "W2", "W3"]) {
    for (const tabindex of [-1, 0]) {
      const objectId = `p-${wrapperType.toLowerCase()}-${tabindex === -1 ? "neg1" : "zero"}`;
      for (const stateName of ["initial", "focused", "blurred", "refocused"]) {
        const focused = stateName === "focused" || stateName === "refocused";
        const properties = focusProperties({
          activeElementFocus: focused,
          tabIndexFocus: tabindex === 0,
          positiveAreaChildCount: wrapperType === "W3" ? 2 : 1,
          childElementCount: wrapperType === "W3" ? 2 : 1,
        });
        states.push(captureState({
          family,
          documentRef: family,
          construction: wrapperType.toLowerCase(),
          wrapperType,
          tabindex,
          state: stateName,
          stateName,
          sampleId: `${family}:${objectId}:${stateName}`,
          caseId: `${objectId}-${stateName}`,
          snapshotRef: `${family}/${objectId}`,
          objectId,
          objectRefs: { wrapper: `ref-${family}-${objectId}` },
          wrapperRow: { nodeRef: `ref-${family}-${objectId}`, ...properties },
          properties: [{ nodeRef: `ref-${family}-${objectId}`, ...properties }],
          evidence: { activeElementFocus: focused, tabIndexFocus: tabindex === 0 },
          gold: "container",
        }));
      }
    }
    const objectId = `i-${wrapperType.toLowerCase()}`;
    for (const stateName of ["before", "after"]) {
      const properties = focusProperties({
        activeElementFocus: false,
        tabIndexFocus: false,
        pointerCursor: false,
        positiveAreaChildCount: wrapperType === "W3" ? 2 : 1,
        childElementCount: wrapperType === "W3" ? 2 : 1,
      });
      states.push(captureState({
        family,
        documentRef: family,
        construction: wrapperType.toLowerCase(),
        wrapperType,
        tabindex: null,
        state: stateName,
        stateName,
        sampleId: `${family}:${objectId}:${stateName}`,
        caseId: `${objectId}-${stateName}`,
        snapshotRef: `${family}/${objectId}`,
        objectId,
        objectRefs: { wrapper: `ref-${family}-${objectId}` },
        wrapperRow: { nodeRef: `ref-${family}-${objectId}`, ...properties },
        properties: [{ nodeRef: `ref-${family}-${objectId}`, ...properties }],
        evidence: { activeElementFocus: false, tabIndexFocus: false },
        gold: "ignore",
      }));
    }
  }
  return { schemaVersion: 1, family, states };
}

function captureForExperimentFamily(family, shape) {
  const states = [];
  const buildRow = (wrapperType, tabindex, gold, stateName) => {
    const focused = gold === "container" && (stateName === "focused" || stateName === "refocused");
    return focusProperties({
      activeElementFocus: focused,
      tabIndexFocus: gold === "container" ? tabindex === 0 && focused : false,
      positiveAreaChildCount: wrapperType === "W3" ? 2 : 1,
      childElementCount: wrapperType === "W3" ? 2 : 1,
    });
  };
  const stateFor = (objectId, wrapperType, tabindex, gold, stateName) => {
    const nodeRef = `ref-${family}-${objectId}`;
    const properties = buildRow(wrapperType, tabindex, gold, stateName);
    const row = { nodeRef, ...properties };
    const state = {
      schemaVersion: shape.schemaVersion,
      caseId: objectId,
      construction: wrapperType.toLowerCase(),
      [shape.stateKindField]: gold === "container" ? "positive" : "ignore",
      state: stateName,
      gold,
      snapshotRef: `${family}/${objectId}/${stateName}`,
      documentRef: family,
      [shape.rowField]: row,
      properties: [{ nodeRef, ...properties }],
    };
    if (shape.targetField !== null) {
      state[shape.targetField] = {
        tabindexAttribute: gold === "container" ? String(tabindex) : null,
        connected: true,
        rect: { x: 0, y: 0, width: 120, height: 40 },
      };
    } else {
      state.tabindexAttribute = gold === "container" ? String(tabindex) : null;
      state.targetRef = nodeRef;
    }
    return state;
  };
  for (const wrapperType of ["W1", "W2", "W3"]) {
    for (const tabindex of [-1, 0]) {
      const objectId = `p-${wrapperType.toLowerCase()}-${tabindex === -1 ? "neg1" : "zero"}`;
      for (const stateName of shape.positiveStates) {
        states.push(stateFor(objectId, wrapperType, tabindex, "container", stateName));
      }
    }
    const objectId = `i-${wrapperType.toLowerCase()}`;
    for (const stateName of shape.ignoreStates) {
      states.push(stateFor(objectId, wrapperType, null, "ignore", stateName));
    }
  }
  return { schemaVersion: shape.schemaVersion, family, states };
}

function normalizedSampleId(family, state) {
  const stateName = state.gold === "ignore"
    ? state.state === "descendant-initial" || state.state === "unfocused"
      ? "before"
      : "after"
    : state.state;
  return `${family}:${state.caseId}:${stateName}`;
}

function experimentUsage() {
  return [
    { sampleId: "old-1", usage: "train" },
    { sampleId: "old-2", usage: "eval" },
    { sampleId: "sample-repair-train:t1:focused", usage: "train" },
    { sampleId: "sample-repair-dev:t1:focused", usage: "dev" },
  ];
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const candidatePath = join(
  repositoryRoot,
  "training/weights/dom-basic-kinds/ignore-capability-20261021.weight.json",
);

function weightAsset(overrides = {}) {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "focus-ignore-file-start-test";
  return {
    targetOperator: "dom.basic_kinds",
    operatorVersion: "0.1.0",
    contractVersion: 1,
    taskId: "dom.basic-kinds.v1",
    profileId: profile.id,
    baseProfileId: "dom-basic-kinds-handwritten-v2",
    calibrated: false,
    compatibility: { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 },
    profile,
    ...overrides,
  };
}

function validRecipe(overrides = {}) {
  return {
    epochs: 200,
    learningRate: 0.02,
    anchorLambda: 0.001,
    trainableWires: [...EXPECTED_TRAINABLE_WIRES],
    objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
    explicitUsage: [
      { sampleId: "s0", usage: "train" },
      { sampleId: "s1", usage: "eval" },
    ],
    ...overrides,
  };
}

test("file start consumer binds both fit and compare to the file profile, never DEFAULT", async () => {
  const root = await mkdtemp(join(tmpdir(), "nnanything-file-start-"));
  const weightPath = join(root, "current.weight.json");
  await writeFile(weightPath, JSON.stringify(weightAsset()));

  const start = readStartProfile(weightPath);
  assert.equal(start.profileId, "focus-ignore-file-start-test");
  assert.notEqual(start.profileId, DEFAULT_BASIC_KIND_PROFILE.id);
  assert.notEqual(start.profileId, "dom-basic-kinds-handwritten-v2");

  const definition = await loadWorkflow({
    configPath: join(repositoryRoot, "workflows/node-training.workflow.json"),
    allowedRoot: repositoryRoot,
  });
  applyBindings(definition, {
    profileId: start.profileId,
    target: {
      taskId: "dom.basic-kinds.v1",
      minScore: 0.6,
      minMargin: 0.15,
      objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
      fit: { epochs: 200, learningRate: 0.02, anchorLambda: 0.001 },
    },
    explicitUsage: validRecipe().explicitUsage,
  });
  assert.equal(definition.bindings["拟合目标节点参数"].profileId, start.profileId);
  assert.equal(definition.bindings["比较新旧节点在相同样本的输出"].profileId, start.profileId);
  assert.equal(definition.bindings["准备节点输入与期望输出"].config.inputScope, "candidate_qualified");

  await rm(root, { recursive: true, force: true });
});

test("file start consumer rejects bad or incompatible assets without DEFAULT fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "nnanything-file-start-bad-"));
  const invalid = join(root, "invalid.weight.json");
  await writeFile(invalid, "not json");
  assert.throws(() => readStartProfile(invalid), /weight asset/i);

  const wrongTask = join(root, "wrong-task.weight.json");
  await writeFile(wrongTask, JSON.stringify(weightAsset({ taskId: "other-task" })));
  assert.throws(() => readStartProfile(wrongTask), /task|compat/i);

  const wrongThreshold = join(root, "wrong-threshold.weight.json");
  await writeFile(wrongThreshold, JSON.stringify(weightAsset({
    compatibility: { taskId: "dom.basic-kinds.v1", minScore: 0.5, minMargin: 0.15 },
  })));
  assert.throws(() => readStartProfile(wrongThreshold), /minScore|threshold/i);

  await rm(root, { recursive: true, force: true });
});

test("recipe validation pins the fixed 18 wires and compatible objective", () => {
  const recipe = readRecipe(validRecipe());
  assert.equal(recipe.trainableWires.length, 18);
  assert.deepEqual(recipe.objective, { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 });
  assert.deepEqual(recipe.explicitUsage, validRecipe().explicitUsage);

  assert.throws(
    () => readRecipe(validRecipe({ trainableWires: EXPECTED_TRAINABLE_WIRES.slice(0, 17) })),
    /trainableWires/,
  );
  assert.throws(
    () => readRecipe(validRecipe({ boundarySlack: 0.0001 })),
    /priority_decision_v1|boundarySlack/,
  );
});

test("recipe validation accepts the C-RivalCeiling-0.6 objective once the consumer adopts the public config validator", () => {
  const recipe = readRecipe(validRecipe({ objective: { targetScore: 0.8, rivalCeiling: 0.6, otherGap: 0.05 } }));
  assert.deepEqual(recipe.objective, { targetScore: 0.8, rivalCeiling: 0.6, otherGap: 0.05 });
  assert.deepEqual(readRecipe(validRecipe()).objective, { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 });
});

test("trainable cell enumeration selects whole addresses by wire name and reports unselected cells", () => {
  const profile = migrateBasicKindProfile(structuredClone(DEFAULT_BASIC_KIND_PROFILE));
  const wires = ["neutral_actual_focus", "neutral_focusable_control", "own_focus_target"];
  const cells = enumerateTrainableCells(profile, wires);
  assert.equal(cells.wireCount, wires.length);
  assert.ok(cells.cellCount > 0);
  assert.equal(cells.selected.length, cells.cellCount);
  assert.ok(cells.selected.every(cell => wires.some(wire => cell.fullAddress.endsWith(`.${wire}`))));
  assert.ok(cells.unselectedSample.length > 0);
});

test("actual ignore candidate exposes the expected 78 trainable addresses", { skip: !existsSync(candidatePath) }, () => {
  const start = readStartProfile(candidatePath);
  const cells = enumerateTrainableCells(start.profile, EXPECTED_TRAINABLE_WIRES);
  assert.equal(cells.wireCount, 18);
  assert.equal(cells.cellCount, 78);
  assert.equal(cells.sparseCellCount, 301);
  assert.equal(cells.registeredWireCount, 81);
});

test("explicit usage coverage validation rejects missing and unknown sample ids", () => {
  const included = new Set(["s0", "s1"]);
  validateExplicitUsage(validRecipe().explicitUsage, included);
  assert.throws(
    () => validateExplicitUsage(
      [{ sampleId: "s0", usage: "train" }],
      included,
    ),
    /missing|s1/,
  );
  assert.throws(
    () => validateExplicitUsage(
      [
        { sampleId: "s0", usage: "train" },
        { sampleId: "s1", usage: "eval" },
        { sampleId: "s2", usage: "train" },
      ],
      included,
    ),
    /unknown|s2/,
  );
});

test("matrix audit rejects a missing -1 focused positive state", () => {
  const train = captureForFamily("sample-repair-train");
  assert.doesNotThrow(() => auditMatrix(train));
  const negative = train.states.filter(state => state.wrapperType === "W1" && state.tabindex === -1 && state.state === "focused");
  train.states = train.states.filter(state => !negative.includes(state));
  assert.throws(() => auditMatrix(train), /matrix audit|focused|-1|W1/i);
});

test("matrix audit rejects a refocused positive without the measured focus facts", () => {
  const train = captureForFamily("sample-repair-train");
  const refocused = train.states.find(state => state.wrapperType === "W1" && state.tabindex === -1 && state.state === "refocused");
  assert.ok(refocused);
  refocused.wrapperRow = { ...refocused.wrapperRow, activeElementFocus: false, tabIndexFocus: false };
  refocused.properties = [{ nodeRef: refocused.wrapperRow.nodeRef, ...refocused.wrapperRow }];
  assert.throws(() => auditMatrix(train), /hold-focus|af=true|refocused/i);

  const zero = captureForFamily("sample-repair-train");
  const zeroRefocused = zero.states.find(state => state.wrapperType === "W1" && state.tabindex === 0 && state.state === "refocused");
  assert.ok(zeroRefocused);
  assert.doesNotThrow(() => auditMatrix(zero));
  zeroRefocused.wrapperRow = { ...zeroRefocused.wrapperRow, activeElementFocus: true, tabIndexFocus: false };
  zeroRefocused.properties = [{ nodeRef: zeroRefocused.wrapperRow.nodeRef, ...zeroRefocused.wrapperRow }];
  assert.throws(() => auditMatrix(zero), /hold-focus|fc matching tabindex|activeElementFocus/i);
});

test("usage and closure audit rejects dev family assigned to train or split objects", () => {
  const dev = captureForFamily("sample-repair-dev");
  const devUsage = dev.states.map(state => ({ sampleId: normalizedSampleId("sample-repair-dev", state), usage: "dev" }));
  assert.doesNotThrow(() => auditUsageAndClosure({
    family: "sample-repair-dev",
    capture: dev,
    usage: devUsage,
  }));
  const wrongUsage = dev.states.map((state, index) => ({
    sampleId: normalizedSampleId("sample-repair-dev", state),
    usage: index === 0 ? "train" : "dev",
  }));
  assert.throws(() => auditUsageAndClosure({ family: "sample-repair-dev", capture: dev, usage: wrongUsage }), /usage|closure|dev/i);
});

test("fact fidelity audit rejects null converted to false", () => {
  const dev = captureForFamily("sample-repair-dev");
  assert.doesNotThrow(() => auditFactFidelity({
    capture: dev,
    rowField: "wrapperRow",
    assertNullPreserved: value => value === null,
  }));
  const missing = dev.states[0];
  missing.wrapperRow = { ...missing.wrapperRow, activeElementFocus: null };
  missing.properties = [{ nodeRef: missing.wrapperRow.nodeRef, ...missing.wrapperRow, activeElementFocus: false }];
  assert.throws(() => auditFactFidelity({
    capture: dev,
    rowField: "wrapperRow",
    assertNullPreserved: value => value === null,
  }), /fact fidelity|null|false/i);
});

test("verification isolation rejects verification family inside a fit request", () => {
  const verification = captureForFamily("sample-repair-verification");
  assert.doesNotThrow(() => auditVerificationIsolation({
    fitRequests: [{ rows: [sampleRow({ sampleId: "old-1" })] }],
    verification: verification.states,
  }));
  const fakeFit = {
    rows: [
      sampleRow({ sampleId: "sample-repair-verification:p-w1-neg1:focused", sourceAssociations: { snapshotRefs: ["sample-repair-verification/p-w1-neg1"], postRefs: [], assetRefs: ["sample-repair-verification"] } }),
    ],
  };
  assert.throws(() => auditVerificationIsolation({
    fitRequests: [fakeFit],
    verification: verification.states,
  }), /verification|isolation|fit/i);
});

test("experiment prepare outputs the exact fit request shapes and usage counts", async () => {
  const oldRows = [
    sampleRow({
      sampleId: "old-1",
      inputRef: { snapshotRef: "old-source/1", documentRef: "old-source", frameRef: "top", nodeRef: "ref-old-1", index: 0 },
      sourceAssociations: { snapshotRefs: ["old-source/1"], postRefs: [], assetRefs: ["old-source-a"] },
    }),
    sampleRow({
      sampleId: "old-2",
      inputRef: { snapshotRef: "old-source/2", documentRef: "old-source", frameRef: "top", nodeRef: "ref-old-2", index: 1 },
      sourceAssociations: { snapshotRefs: ["old-source/2"], postRefs: [], assetRefs: ["old-source-b"] },
    }),
  ];
  const oldUsage = [
    { sampleId: "old-1", usage: "train" },
    { sampleId: "old-2", usage: "eval" },
  ];
  const train = captureForFamily("sample-repair-train");
  const dev = captureForFamily("sample-repair-dev");
  const verification = captureForFamily("sample-repair-verification");
  const result = await prepareExperiments({
    request: { schemaVersion: 1, taskId: "dom.basic-kinds.v1", rows: oldRows },
    partition: { explicitUsage: oldUsage },
    trainCapture: train,
    devCapture: dev,
    verificationCapture: verification,
  });
  assert.equal(result.control.rows.length, 2);
  assert.equal(result.treatment.rows.length, 32);
  assert.equal(result.usage.control.filter(entry => entry.usage === "train").length, 1);
  assert.equal(result.usage.control.filter(entry => entry.usage === "eval").length, 1);
  assert.equal(result.usage.treatment.filter(entry => entry.usage === "train").length, 31);
  assert.equal(result.usage.treatment.filter(entry => entry.usage === "eval").length, 1);
  assert.deepEqual(result.control.rows.map(row => row.sampleId), ["old-1", "old-2"]);
  assert.equal(result.dev.rows.length, 30);
  assert.equal(result.usage.verification.length, 30);
  assert.ok(!JSON.stringify(result.treatment.rows).includes("sample-repair-verification"));
});

test("unseal assessment gates on counterexample, new train/dev gold, old regression and ignore retention", () => {
  const evaluation = {
    rows: [
      { sampleId: "cex", group: "counterexample", status: "judged", basicKind: "container", gold: "container", baselineCorrect: false },
      { sampleId: "human-1", group: "human", status: "judged", basicKind: "container", gold: "container", reviewStatus: "verified" },
      { sampleId: "new-1", group: "new-train", status: "judged", basicKind: "container", gold: "container" },
      { sampleId: "new-2", group: "new-dev", status: "judged", basicKind: "container", gold: "container" },
      { sampleId: "old-ignore", group: "original", status: "judged", basicKind: "ignore", gold: "ignore", baselineCorrect: true },
    ],
  };
  const result = assessUnseal(evaluation);
  assert.equal(result.unseal, true);
  assert.deepEqual(Object.fromEntries(result.gates.map(gate => [gate.id, gate.pass])), {
    counterexampleAndHumanContainer: true,
    newTrainDevGold: true,
    oldRegression: true,
    ignoreRetention: true,
  });

  const failing = {
    rows: [
      ...evaluation.rows,
      { sampleId: "old-2", group: "original", status: "judged", basicKind: "ignore", gold: "container", baselineCorrect: true },
    ],
  };
  const resultFailing = assessUnseal(failing);
  assert.equal(resultFailing.unseal, false);
});

test("unseal treats an unconfirmed human row as report-only, not as a zero-count blocker", () => {
  const base = { sampleId: "new-1", group: "new-train", status: "judged", basicKind: "container", gold: "container" };
  const withUnconfirmedHuman = {
    rows: [
      { sampleId: "cex", group: "counterexample", status: "judged", basicKind: "container", gold: "container", baselineCorrect: false },
      { sampleId: "human-unconfirmed", group: "human", status: "judged", basicKind: "ignore", gold: "unlabeled_exploration", reviewStatus: "unlabeled_exploration" },
      { ...base },
      { sampleId: "new-2", group: "new-dev", status: "judged", basicKind: "container", gold: "container" },
      { sampleId: "old-ignore", group: "original", status: "judged", basicKind: "ignore", gold: "ignore", baselineCorrect: true },
    ],
  };
  const gate = assessUnseal(withUnconfirmedHuman).gates.find(item => item.id === "counterexampleAndHumanContainer");
  assert.equal(gate.pass, true);
  assert.equal(gate.details.confirmedHumanPositiveCount, 0);

  const withVerifiedHumanMiss = {
    rows: [
      ...withUnconfirmedHuman.rows.filter(row => row.sampleId !== "human-unconfirmed"),
      { sampleId: "human-verified-miss", group: "human", status: "judged", basicKind: "ignore", gold: "container", reviewStatus: "verified" },
    ],
  };
  assert.equal(assessUnseal(withVerifiedHumanMiss).unseal, false);
});

test("per-row evaluation produces status, kind, family, leaf interval, score and margin", () => {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "focus-ignore-per-row-test";
  const evaluation = evaluateExperimentRows(
    [sampleRow({ sampleId: "new-1", group: "new-train" })],
    { config: { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 }, profile },
    new Map([["new-1", "train"]]),
  );
  assert.equal(evaluation.rows.length, 1);
  const row = evaluation.rows[0];
  for (const key of ["status", "basicKind", "family", "leafInterval", "score", "margin", "usage", "group"]) {
    assert.ok(Object.hasOwn(row, key), `row missing ${key}`);
  }
});

test("projection audit separates old train conflicts from old train/eval repeats", () => {
  const properties = focusProperties({ tabIndexFocus: null });
  const oldTrain = sampleRow({
    sampleId: "old-train",
    properties,
    review: { ...sampleRow().review, expectedLabel: "container" },
    sourceAssociations: { snapshotRefs: ["old/one"], postRefs: [], assetRefs: ["old-source"] },
  });
  const oldEval = sampleRow({
    sampleId: "old-eval",
    properties,
    review: { ...sampleRow().review, expectedLabel: "container" },
    sourceAssociations: { snapshotRefs: ["old/two"], postRefs: [], assetRefs: ["old-source"] },
  });
  const newTrain = sampleRow({
    sampleId: "sample-repair-train:t1:focused",
    properties,
    review: { ...sampleRow().review, expectedLabel: "ignore" },
    sourceAssociations: { snapshotRefs: ["sample-repair-train/t1"], postRefs: [], assetRefs: ["sample-repair-train"] },
  });
  const usage = [
    { sampleId: oldTrain.sampleId, usage: "train" },
    { sampleId: oldEval.sampleId, usage: "eval" },
    { sampleId: newTrain.sampleId, usage: "train" },
  ];
  const result = auditProjection([{ rows: [oldTrain, oldEval, newTrain] }], usage);
  assert.equal(result.dimension, BASIC_KIND_WIRE_NAMES.length);
  assert.equal(result.rowsByProjection[0].projection.neutral_focusable_control, null);
  assert.equal(result.sameInputDifferentGold.length, 1);
  assert.equal(result.oldTrainEvalOverlaps.length, 1);
  assert.equal(result.crossUsageOverlaps.length, 1);
  assert.ok(result.rowsByProjection[0].rows.every(row => row.projectionGroupId === "projection-001"));
  assert.throws(
    () => auditProjection([{ rows: [oldTrain, sampleRow({ sampleId: "sample-repair-verification:t1:focused" })] }], usage),
    /verification|unseal/i,
  );
});

test("projection audit detects a same-projection different-gold conflict inside the new train family alone", () => {
  const properties = focusProperties({ tabIndexFocus: null });
  const container = sampleRow({
    sampleId: "sample-repair-train:w1-neg1:initial",
    properties,
    review: { ...sampleRow().review, expectedLabel: "container" },
    sourceAssociations: { snapshotRefs: ["sample-repair-train/w1"], postRefs: [], assetRefs: ["sample-repair-train"] },
  });
  const ignore = sampleRow({
    sampleId: "sample-repair-train:ignore-w1:before",
    properties,
    review: { ...sampleRow().review, expectedLabel: "ignore" },
    sourceAssociations: { snapshotRefs: ["sample-repair-train/w1i"], postRefs: [], assetRefs: ["sample-repair-train"] },
  });
  const usage = [
    { sampleId: container.sampleId, usage: "train" },
    { sampleId: ignore.sampleId, usage: "train" },
  ];
  const result = auditProjection([{ rows: [container, ignore] }], usage);
  assert.equal(result.sameInputDifferentGold.length, 1);
  const group = result.sameInputDifferentGold[0];
  assert.equal(group.rows.length, 2);
  assert.deepEqual(group.rows.map(row => row.sampleId).sort(), [container.sampleId, ignore.sampleId].sort());
});

test("retention aggregation requires every expected ignore-parent case, not just one", () => {
  const base = [
    { id: "standalone-container", present: true, refStableAcrossReobservation: true, descendantPropertiesAgain: true, parentCandidateStatus: "ok", parentKind: "container" },
    { id: "ignore-wrap-button", present: true, refStableAcrossReobservation: true, descendantPropertiesAgain: true, parentCandidateStatus: "ok", parentKind: "ignore", descendantCandidateStatus: "ok" },
    { id: "ignore-wrap-link", present: true, refStableAcrossReobservation: true, descendantPropertiesAgain: true, parentCandidateStatus: "ok", parentKind: "ignore", descendantCandidateStatus: "ok" },
  ];
  assert.equal(summarizeRetentionChecks(base).parentIgnoreDescendantIndependent, true);

  const oneOfTwoFails = base.map(row => row.id === "ignore-wrap-link"
    ? { ...row, parentKind: "other", descendantCandidateStatus: "ok" }
    : row);
  assert.equal(summarizeRetentionChecks(oneOfTwoFails).parentIgnoreDescendantIndependent, false);

  const oneMissing = base.filter(row => row.id !== "ignore-wrap-link");
  assert.equal(summarizeRetentionChecks(oneMissing).parentIgnoreDescendantIndependent, false);
});
