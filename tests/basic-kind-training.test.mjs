import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileWorkflow,
  createWorkflowInputEvent,
  loadWorkflow,
  runWorkflow,
} from "nnanything";
import {
  DEFAULT_BASIC_KIND_PROFILE,
  DEFAULT_BASIC_KIND_CONFIG,
  LEGACY_BASIC_KIND_PROFILE,
  classifyBasicKind,
  migrateBasicKindProfile,
  validateBasicKindProfile,
} from "nnanything/browser";
import { parseBrowserWeightAsset } from "nnanything/browser-classify";
import {
  assessBasicKindComparison,
  compareBasicKindCandidates,
  createTrainingNodeDefinitions,
  loadTrainingProfiles,
  partitionBasicKindSamples,
  prepareBasicKindSamples,
  readBasicKindTrainingRequest,
  toBasicKindFitRows,
  writeBasicKindTrainingArtifacts,
  fitBasicKinds,
  validateBasicKindTrainingConfig,
} from "nnanything/training";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const handwiredRoot = process.env.HANDWIRED_ROOT ?? "/Volumes/extension/code/handwired";
const complete = {
  contentEditable: false,
  directTextPresent: false,
  childElementCount: 0,
  positiveAreaChildCount: 0,
  repeatedChildGeometry: false,
  inVerifiedListParent: false,
  svgGraphicChildren: null,
};

function row(sampleId, options = {}) {
  const expectedLabel = options.expectedLabel ?? "button";
  const snapshot = options.snapshot ?? `snapshot-${sampleId}`;
  return {
    sampleId,
    inputRef: {
      snapshotRef: snapshot,
      documentRef: `document-${sampleId}`,
      frameRef: "frame-main",
      nodeRef: options.nodeRef ?? `node-${sampleId}`,
      index: options.index ?? 0,
    },
    provenanceRef: `evidence-${sampleId}`,
    sourceAssociations: {
      snapshotRefs: options.snapshotRefs ?? [snapshot],
      postRefs: options.postRefs ?? [],
      assetRefs: options.assetRefs ?? [],
    },
    candidateQualification: {
      status: options.candidateStatus ?? "ok",
      reasons: options.candidateStatus && options.candidateStatus !== "ok" ? ["upstream_filter"] : [],
    },
    captureCoverage: {
      frameContent: options.frameContent ?? "captured",
      directChildren: options.directChildren ?? "complete",
    },
    properties: options.properties ?? {
      tag: "button",
      role: null,
      ...complete,
    },
    proposal: {
      ruleRef: "rule-button",
      label: "button",
      status: "matched",
    },
    review: {
      status: options.reviewStatus ?? "verified",
      expectedLabel: options.reviewStatus && options.reviewStatus !== "verified" ? null : expectedLabel,
      reviewerRef: options.reviewStatus && options.reviewStatus !== "verified" ? null : "reviewer-human-1",
      evidenceRef: options.reviewStatus && options.reviewStatus !== "verified" ? null : `review-${sampleId}`,
      otherReason: expectedLabel === "other" ? "confirmed outside the current taxonomy" : null,
    },
  };
}

function request(rows) {
  return {
    schemaVersion: 1,
    taskId: "dom.basic-kinds.v1",
    rows: rows.map((item, index) => ({
      ...item,
      inputRef: { ...item.inputRef, index },
    })),
  };
}

const prepareConfig = {
  taskId: "dom.basic-kinds.v1",
  inputScope: "candidate_qualified",
};

function partitionConfig(overrides = {}) {
  return {
    mode: "source_group_holdout",
    seed: 7,
    evalFraction: 0.5,
    allowInSampleEval: false,
    ...overrides,
  };
}

function trainingConfig(overrides = {}) {
  return {
    taskId: "dom.basic-kinds.v1",
    minScore: 0.6,
    minMargin: 0.15,
    objective: { targetScore: 0.8, rivalCeiling: 0.4, otherGap: 0.05 },
    fit: { epochs: 3, learningRate: 0.01, anchorLambda: 0.01 },
    ...overrides,
  };
}

function emptyProfile() {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "deliberately-wrong-base";
  for (const group of [profile.familyWeights, profile.leafWeights]) {
    for (const weights of Object.values(group)) {
      for (const key of Object.keys(weights)) weights[key] = 0;
    }
  }
  return profile;
}

test("prepare refuses unreviewed proposals and keeps teacher fields out of student rows", () => {
  const proposalOnly = row("proposal-only", { reviewStatus: "unreviewed" });
  const malformed = row("leak");
  malformed.properties.className = "post-card";
  assert.throws(
    () => prepareBasicKindSamples(readBasicKindTrainingRequest(request([malformed])), prepareConfig),
    /unsupported|properties/i,
  );

  const prepared = prepareBasicKindSamples(
    readBasicKindTrainingRequest(request([proposalOnly])),
    prepareConfig,
  );
  assert.deepEqual(prepared.includedIndices, []);
  assert.ok(prepared.rows[0].reasons.includes("review_not_verified"));
  assert.equal(prepared.rows[0].review.expectedLabel, null);
});

test("training rows roundtrip nullable appearance fields without reconstructing old evidence", () => {
  const old = row("old-fields", {
    expectedLabel: "text",
    properties: { tag: "b", role: null, ...complete, directTextPresent: true },
  });
  const oldBefore = classifyBasicKind(old.properties);
  const readOld = readBasicKindTrainingRequest(request([old])).rows[0];
  assert.equal(readOld.properties.nonFormatDirectTextPresent, null);
  assert.equal(readOld.properties.beforeContentPresent, null);
  assert.equal(readOld.properties.afterContentPresent, null);
  assert.equal(readOld.properties.backgroundImagePresent, null);
  assert.equal(readOld.properties.maskImagePresent, null);
  assert.deepEqual(classifyBasicKind(readOld.properties), oldBefore);

  const fresh = row("fresh-fields", {
    expectedLabel: "text",
    properties: { tag: "b", role: null, ...complete, inputType: null, hrefPresent: null, disabled: null, hidden: null, directTextPresent: true,
      nonFormatDirectTextPresent: true, beforeContentPresent: true, afterContentPresent: false,
      backgroundImagePresent: false, maskImagePresent: null },
  });
  const parsed = readBasicKindTrainingRequest(request([fresh])).rows[0];
  const projectedFreshProperties = {
    ...fresh.properties,
    pointerCursor: null,
    parentPointerCursor: null,
    tabIndexFocus: null,
    borderPresent: null,
    aspectRatio: null,
    descendantTextPresent: null,
    directListChildPresent: null,
    singleChildTag: null,
    singleChildSameRect: null,
    withinControlAncestor: null,
    inSvgAncestor: null,
  };
  assert.deepEqual(parsed.properties, projectedFreshProperties);
  const prepared = prepareBasicKindSamples(readBasicKindTrainingRequest(request([fresh])), prepareConfig);
  assert.deepEqual(prepared.includedIndices, [0]);
  assert.deepEqual(toBasicKindFitRows(prepared)[0].properties, projectedFreshProperties);
  assert.throws(() => readBasicKindTrainingRequest(request([{
    ...fresh,
    properties: { ...fresh.properties, backgroundImage: "url(secret)" },
  }])), /unsupported|properties/i);
});

test("all-null properties are legal but stay diagnostic instead of becoming observed zeros", () => {
  const allNull = row("all-null", {
    properties: {
      tag: null,
      role: null,
      inputType: null,
      hrefPresent: null,
      contentEditable: null,
      directTextPresent: null,
      childElementCount: null,
      positiveAreaChildCount: null,
      repeatedChildGeometry: null,
      inVerifiedListParent: null,
      disabled: null,
      hidden: null,
    },
  });
  const prepared = prepareBasicKindSamples(
    readBasicKindTrainingRequest(request([allNull])),
    prepareConfig,
  );
  assert.deepEqual(prepared.includedIndices, []);
  assert.ok(prepared.rows[0].reasons.includes("no_observed_wires"));
  assert.deepEqual(toBasicKindFitRows(prepared), []);
});

test("training projection normalizes missing svg child evidence to null", () => {
  const missing = row("missing-svg-property", {
    expectedLabel: "image",
    properties: { tag: "svg", role: null, ...complete, childElementCount: 1, positiveAreaChildCount: 1, svgGraphicChildren: undefined },
  });
  delete missing.properties.svgGraphicChildren;
  const prepared = prepareBasicKindSamples(readBasicKindTrainingRequest(request([missing])), {
    taskId: "dom.basic-kinds.v1",
    inputScope: "properties_offline",
  });
  assert.deepEqual(prepared.includedIndices, [0]);
  assert.equal(prepared.rows[0].properties.svgGraphicChildren, null);
  assert.equal(toBasicKindFitRows(prepared)[0].properties.svgGraphicChildren, null);
});

test("source closure combines snapshots, posts and assets and never fakes independent holdout", () => {
  const rows = [
    row("a", {
      snapshot: "snapshot-a",
      snapshotRefs: ["snapshot-a"],
      assetRefs: ["asset-1"],
      nodeRef: "duplicate-node",
    }),
    row("b", {
      snapshot: "snapshot-b",
      snapshotRefs: ["snapshot-b"],
      assetRefs: ["asset-1", "asset-2"],
      postRefs: ["post-1"],
      nodeRef: "duplicate-node",
    }),
    row("c", {
      snapshot: "snapshot-c",
      snapshotRefs: ["snapshot-c"],
      postRefs: ["post-1"],
    }),
  ];
  const samples = prepareBasicKindSamples(
    readBasicKindTrainingRequest(request(rows)),
    prepareConfig,
  );
  assert.deepEqual(samples.includedIndices, [0, 1, 2]);
  assert.deepEqual(toBasicKindFitRows(samples).map(item => item.expectedLabel), [
    "button",
    "button",
    "button",
  ]);
  assert.equal(samples.rows[0].inputRef.nodeRef, samples.rows[1].inputRef.nodeRef);

  const refused = partitionBasicKindSamples(samples, partitionConfig());
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "insufficient_independent_source_clusters");

  const diagnostic = partitionBasicKindSamples(
    samples,
    partitionConfig({ allowInSampleEval: true }),
  );
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.partitions.evaluationMode, "development_only_in_sample");
  assert.deepEqual(diagnostic.partitions.trainIndices, [0, 1, 2]);
  assert.deepEqual(diagnostic.partitions.evalIndices, [0, 1, 2]);
  assert.equal(diagnostic.partitions.sourceClusters.length, 1);
});

test("paired comparison reports exact old/new transitions and nullable class metrics", () => {
  const rows = [
    row("train-button", {
      snapshot: "snapshot-train",
      snapshotRefs: ["snapshot-train"],
    }),
    row("eval-image", {
      snapshot: "snapshot-eval",
      snapshotRefs: ["snapshot-eval"],
      expectedLabel: "image",
      properties: { tag: "img", role: null, ...complete },
    }),
  ];
  const samples = prepareBasicKindSamples(
    readBasicKindTrainingRequest(request(rows)),
    prepareConfig,
  );
  const partitioned = partitionBasicKindSamples(samples, partitionConfig());
  assert.equal(partitioned.ok, true);
  assert.equal(partitioned.partitions.evaluationMode, "source_group_holdout");

  const baseProfile = emptyProfile();
  const candidateProfile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  candidateProfile.id = "candidate-fixed";
  const comparison = compareBasicKindCandidates({
    candidate: {
      schemaVersion: 1,
      taskId: "dom.basic-kinds.v1",
      candidateId: "candidate-fixed",
      baseProfileId: baseProfile.id,
      profile: candidateProfile,
      trajectory: [],
      lossBefore: 1,
      lossAfter: 0,
      sampleCoverage: { trainRows: 1, labelCounts: { button: 1 } },
    },
    partitions: partitioned.partitions,
    baseProfile,
    config: trainingConfig(),
  });

  assert.equal(comparison.summary.fixed, 2);
  assert.equal(comparison.summary.regressed, 0);
  assert.equal(comparison.summary.retained, 0);
  assert.equal(comparison.summary.unresolved, 0);
  assert.equal(comparison.summary.unassessed, 0);
  for (const split of ["train", "eval"]) {
    const metrics = comparison.splits[split];
    assert.ok(metrics.classMetrics.button);
    assert.ok(metrics.classMetrics.image);
    for (const metric of Object.values(metrics.classMetrics)) {
      if (metric.support === 0) {
        assert.equal(metric.precision, null);
        assert.equal(metric.recall, null);
        assert.equal(metric.f1, null);
        assert.equal(metric.uncovered, true);
      }
    }
  }
  assert.equal(comparison.splits.eval.classMetrics.image.recall, 1);
});

function evidenceAssessment(taskId = "dom.basic-kinds.v1") {
  return {
    schemaVersion: 1,
    taskId,
    candidate: null,
    comparison: null,
    evidenceInsufficient: true,
    independentEvidence: false,
    recommendation: "evidence_insufficient",
    reasons: ["verified_or_usable_samples_absent"],
  };
}

test("report writes create-new artifacts and preserves the weight path on partial failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "nnanything-training-report-"));
  const config = { weightsDirectory: "weights", resultsDirectory: "results" };
  const assessment = evidenceAssessment();
  const first = await writeBasicKindTrainingArtifacts({
    allowedRoot: root,
    config,
    runId: "report-run",
    taskId: "dom.basic-kinds.v1",
    assessment,
  });
  assert.equal(first.persistStatus, "evidence_insufficient");
  assert.equal(first.weightFileRef, null);
  assert.equal((await readFile(first.resultFileRef, "utf8")).includes("evidence_insufficient"), true);
  const before = await readFile(first.resultFileRef, "utf8");

  await assert.rejects(
    writeBasicKindTrainingArtifacts({
      allowedRoot: root,
      config,
      runId: "report-run",
      taskId: "dom.basic-kinds.v1",
      assessment,
    }),
    /exist|EEXIST/i,
  );
  assert.equal(await readFile(first.resultFileRef, "utf8"), before);

  await rm(first.resultFileRef);
  await mkdir(join(root, "results"), { recursive: true });
  const completeAssessment = assessBasicKindComparison(comparisonFixture(), { forbidGoldRegression: true });
  const second = await writeBasicKindTrainingArtifacts({
    allowedRoot: root,
    config,
    runId: "report-run",
    taskId: "dom.basic-kinds.v1",
    assessment: completeAssessment,
  });
  assert.notEqual(second.weightFileRef, null);
  const resultPath = join(root, "results", "report-run.result.json");
  await rm(second.resultFileRef);
  await (await import("node:fs/promises")).writeFile(resultPath, "occupied", { flag: "wx" });
  await rm(second.weightFileRef);
  await assert.rejects(
    writeBasicKindTrainingArtifacts({
      allowedRoot: root,
      config,
      runId: "report-run",
      taskId: "dom.basic-kinds.v1",
      assessment: completeAssessment,
    }),
    error => {
      assert.match(error.message, /report-run\.weight\.json/);
      return true;
    },
  );
  await stat(join(root, "weights", "report-run.weight.json"));
});

test("public six-node consumer fits, saves, reloads and classifies with the candidate profile", async t => {
  try {
    await stat(join(handwiredRoot, "src/runtime/numeric-ui-core.ts"));
  } catch {
    t.skip(`Handwired source root unavailable: ${handwiredRoot}`);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "nnanything-training-consumer-"));
  const rows = [
    row("button-a", {
      snapshot: "snapshot-button-a",
      snapshotRefs: ["snapshot-button-a"],
    }),
    row("button-b", {
      snapshot: "snapshot-button-b",
      snapshotRefs: ["snapshot-button-b"],
    }),
    row("image-a", {
      snapshot: "snapshot-image-a",
      snapshotRefs: ["snapshot-image-a"],
      expectedLabel: "image",
      properties: { tag: "img", role: null, ...complete },
    }),
    row("text-a", {
      snapshot: "snapshot-text-a",
      snapshotRefs: ["snapshot-text-a"],
      expectedLabel: "text",
      properties: { tag: "p", role: null, ...complete },
    }),
  ];
  const definition = await loadWorkflow({
    configPath: join(repositoryRoot, "workflows/node-training.workflow.json"),
    allowedRoot: repositoryRoot,
  });
  const fitBinding = definition.bindings["拟合目标节点参数"];
  const compareBinding = definition.bindings["比较新旧节点在相同样本的输出"];
  const target = trainingConfig({ fit: { epochs: 4, learningRate: 0.02, anchorLambda: 0.001 } });
  fitBinding.config = target;
  compareBinding.config = target;
  const baseProfile = emptyProfile();
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createTrainingNodeDefinitions({ handwiredRoot, allowedRoot: root }),
    grantedEffects: ["filesystem.read", "filesystem.write"],
    profiles: { "dom-basic-kinds-handwritten-v1": baseProfile },
  });
  const result = await runWorkflow(
    compiled,
    createWorkflowInputEvent({
      runId: "training-public-run",
      eventId: "training-public-run:input",
      port: compiled.entryArc.id,
      type: "training.request.v1",
      payload: request(rows),
    }),
  );
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.outputEvent.status, "ok", JSON.stringify(result.outputEvent));
  assert.ok(result.events.length === 6);
  assert.equal(result.outputEvent.payload.persistStatus, "saved");
  const weightAsset = JSON.parse(await readFile(result.outputEvent.payload.weightFileRef, "utf8"));
  const candidateProfile = validateBasicKindProfile(weightAsset.profile);
  const reloaded = classifyBasicKind(
    { tag: "button", role: null, ...complete },
    { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 },
    candidateProfile,
  );
  assert.equal(reloaded.calibratedConfidence, null);
  assert.equal(reloaded.evidence.wires.nat_control_button, 1);
  const report = JSON.parse(await readFile(result.outputEvent.payload.resultFileRef, "utf8"));
  assert.equal(report.calibrated, false);
  assert.equal(report.candidateAdoption, "not_applied");
});

test("public six-node consumer trains a migrated zero coefficient and parse reloads it", async t => {
  try {
    await stat(join(handwiredRoot, "src/runtime/numeric-ui-core.ts"));
  } catch {
    t.skip(`Handwired source root unavailable: ${handwiredRoot}`);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "nnanything-training-migration-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { tag: "svg", role: null, ...complete, childElementCount: 1, positiveAreaChildCount: 1, svgGraphicChildren: true };
  const rows = [
    row("svg-a", { snapshot: "snapshot-svg-a", expectedLabel: "image", properties: source, postRefs: ["source-svg"] }),
    row("svg-b", { snapshot: "snapshot-svg-b", expectedLabel: "image", properties: source, postRefs: ["source-svg"] }),
    row("svg-c", { snapshot: "snapshot-svg-c", expectedLabel: "image", properties: source, postRefs: ["source-svg-holdout"] }),
  ];
  const definition = await loadWorkflow({
    configPath: join(repositoryRoot, "workflows/node-training.workflow.json"),
    allowedRoot: repositoryRoot,
  });
  definition.bindings["准备节点输入与期望输出"].config = { taskId: "dom.basic-kinds.v1", inputScope: "properties_offline" };
  definition.bindings["按来源分组并划分用途"].config = { mode: "source_group_holdout", seed: 7, evalFraction: 0.5, allowInSampleEval: false };
  const target = trainingConfig({ fit: { epochs: 40, learningRate: 0.03, anchorLambda: 0 } });
  definition.bindings["拟合目标节点参数"] = { config: target, profileId: LEGACY_BASIC_KIND_PROFILE.id };
  definition.bindings["比较新旧节点在相同样本的输出"] = { config: target, profileId: LEGACY_BASIC_KIND_PROFILE.id };
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createTrainingNodeDefinitions({ handwiredRoot, allowedRoot: root }),
    grantedEffects: ["filesystem.read", "filesystem.write"],
    profiles: loadTrainingProfiles({ profileId: LEGACY_BASIC_KIND_PROFILE.id, profile: LEGACY_BASIC_KIND_PROFILE }),
  });
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId: "training-migration-public-run",
    eventId: "training-migration-public-run:input",
    port: compiled.entryArc.id,
    type: "training.request.v1",
    payload: request(rows),
  }));
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.outputEvent.status, "ok", JSON.stringify(result.outputEvent));
  assert.equal(result.outputEvent.payload.persistStatus, "saved");
  const rawAsset = JSON.parse(await readFile(result.outputEvent.payload.weightFileRef, "utf8"));
  assert.equal(rawAsset.profile.familyWeights.media.nat_svg !== 0, true);
  assert.equal(rawAsset.profile.leafWeights.image.nat_svg !== 0, true);
  assert.equal(rawAsset.profile.familyWeights.media.svg_graphic_children !== 0, true);
  const reloadedAsset = parseBrowserWeightAsset(rawAsset);
  assert.equal(reloadedAsset.profile.id, rawAsset.profile.id);
  assert.equal(reloadedAsset.profile.familyWeights.media.nat_svg, rawAsset.profile.familyWeights.media.nat_svg);
  assert.equal(classifyBasicKind(source, DEFAULT_BASIC_KIND_CONFIG, reloadedAsset.profile).basicKind, "image");
  assert.equal(reloadedAsset.calibrated, false);
});

test("incremental fit freezes all non-allowlisted wires and keeps the full Handwired graph", async t => {
  try {
    await stat(join(handwiredRoot, "src/runtime/numeric-ui-core.ts"));
  } catch {
    t.skip(`Handwired source root unavailable: ${handwiredRoot}`);
    return;
  }

  const combobox = { tag: "input", role: "combobox", ...complete, inputType: "text" };
  const rows = [
    {
      properties: combobox,
      expectedLabel: "input",
    },
  ];
  const baseProfile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  baseProfile.id = "incremental-mask-base";
  baseProfile.familyWeights.control.input_text_combobox = 0;
  baseProfile.leafWeights.input.input_text_combobox = 0;
  baseProfile.leafWeights.select.input_text_combobox = 0;
  const config = trainingConfig({
    fit: {
      epochs: 14,
      learningRate: 0.03,
      anchorLambda: 0.01,
      trainableWires: ["input_text_combobox"],
    },
  });
  const frozenBefore = {
    nat_input_tag: baseProfile.familyWeights.control.nat_input_tag,
    role_select: baseProfile.leafWeights.select.role_select,
    role_select_family: baseProfile.familyWeights.control.role_select,
  };
  const oldJudgment = classifyBasicKind(combobox, {
    taskId: "dom.basic-kinds.v1",
    minScore: config.minScore,
    minMargin: config.minMargin,
  }, baseProfile);

  const fitted = await fitBasicKinds({
    handwiredRoot,
    rows,
    baseProfile,
    config,
    candidateId: "incremental-mask-candidate",
  });

  assert.equal(fitted.profile.familyWeights.control.nat_input_tag, frozenBefore.nat_input_tag);
  assert.equal(fitted.profile.leafWeights.input.nat_input_tag, baseProfile.leafWeights.input.nat_input_tag);
  assert.equal(fitted.profile.leafWeights.select.role_select, frozenBefore.role_select);
  assert.equal(fitted.profile.familyWeights.control.role_select, frozenBefore.role_select_family);
  assert.equal(fitted.profile.familyWeights.control.input_type_text, baseProfile.familyWeights.control.input_type_text);
  assert.equal(fitted.profile.leafWeights.input.input_type_text, baseProfile.leafWeights.input.input_type_text);
  assert.notEqual(fitted.profile.leafWeights.input.input_text_combobox, baseProfile.leafWeights.input.input_text_combobox);
  assert.ok(fitted.lossAfter < fitted.lossBefore);
  const newJudgment = classifyBasicKind(combobox, {
    taskId: "dom.basic-kinds.v1",
    minScore: config.minScore,
    minMargin: config.minMargin,
  }, fitted.profile);
  assert.equal(oldJudgment.basicKind, "other");
  assert.equal(newJudgment.basicKind, "input");
});

test("empty incremental allowlist is an exact optimizer identity", async t => {
  try {
    await stat(join(handwiredRoot, "src/runtime/numeric-ui-core.ts"));
  } catch {
    t.skip(`Handwired source root unavailable: ${handwiredRoot}`);
    return;
  }

  const baseProfile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  baseProfile.id = "incremental-mask-identity-base";
  const rows = [{ properties: { tag: "input", role: "combobox", ...complete, inputType: "text" }, expectedLabel: "input" }];
  const config = trainingConfig({ fit: { epochs: 4, learningRate: 0.03, anchorLambda: 0.01, trainableWires: [] } });
  const fitted = await fitBasicKinds({ handwiredRoot, rows, baseProfile, config, candidateId: "incremental-mask-identity" });

  assert.deepEqual(fitted.profile.familyWeights, baseProfile.familyWeights);
  assert.deepEqual(fitted.profile.leafWeights, baseProfile.leafWeights);
  assert.equal(fitted.lossAfter, fitted.lossBefore);
  assert.equal(fitted.trajectory.every(progress => progress.anchorLoss === 0 && progress.projectedWeightCount === 0), true);
});

test("incremental allowlist rejects unregistered and invalid wire names", () => {
  const invalid = trainingConfig({ fit: { epochs: 1, learningRate: 0.01, anchorLambda: 0, trainableWires: ["not_a_wire"] } });
  assert.throws(() => validateBasicKindTrainingConfig(invalid), /trainableWires.*registered/i);
  const malformed = trainingConfig({ fit: { epochs: 1, learningRate: 0.01, anchorLambda: 0, trainableWires: "nat_input_tag" } });
  assert.throws(() => validateBasicKindTrainingConfig(malformed), /trainableWires/i);
});

test("unauthorized report effects write nothing and backend failures keep the concrete message", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "nnanything-training-denied-"));
  const definition = await loadWorkflow({
    configPath: join(repositoryRoot, "workflows/node-training.workflow.json"),
    allowedRoot: repositoryRoot,
  });
  assert.throws(
    () =>
      compileWorkflow(definition, {
        nodeDefinitions: createTrainingNodeDefinitions({
          handwiredRoot,
          allowedRoot: outputRoot,
        }),
        profiles: { "dom-basic-kinds-handwritten-v1": DEFAULT_BASIC_KIND_PROFILE },
      }),
    error => error.code === "COMPILE_EFFECT_UNAUTHORIZED",
  );
  assert.deepEqual(await readdir(outputRoot), []);

  const missingRoot = join(outputRoot, "missing-handwired");
  await mkdir(missingRoot);
  const granted = compileWorkflow(definition, {
    nodeDefinitions: createTrainingNodeDefinitions({
      handwiredRoot: missingRoot,
      allowedRoot: outputRoot,
    }),
    grantedEffects: ["filesystem.read", "filesystem.write"],
    profiles: { "dom-basic-kinds-handwritten-v1": DEFAULT_BASIC_KIND_PROFILE },
  });
  const failed = await runWorkflow(
    granted,
    createWorkflowInputEvent({
      runId: "training-backend-failure",
      eventId: "training-backend-failure:input",
      port: granted.entryArc.id,
      type: "training.request.v1",
      payload: request([
        row("a", { snapshot: "snapshot-fail-a" }),
        row("b", { snapshot: "snapshot-fail-b", expectedLabel: "image", properties: { tag: "img", role: null, ...complete } }),
      ]),
    }),
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.error.message, /numeric-ui-core|handwired/i);
});

test("terminal non-ok evidence is reported without a fake weight profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "nnanything-training-insufficient-"));
  const definition = await loadWorkflow({
    configPath: join(repositoryRoot, "workflows/node-training.workflow.json"),
    allowedRoot: repositoryRoot,
  });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createTrainingNodeDefinitions({ handwiredRoot, allowedRoot: root }),
    grantedEffects: ["filesystem.read", "filesystem.write"],
    profiles: { "dom-basic-kinds-handwritten-v1": DEFAULT_BASIC_KIND_PROFILE },
  });
  const result = await runWorkflow(
    compiled,
    createWorkflowInputEvent({
      runId: "training-no-labels",
      eventId: "training-no-labels:input",
      port: compiled.entryArc.id,
      type: "training.request.v1",
      payload: request([row("unreviewed", { reviewStatus: "unreviewed" })]),
    }),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.outputEvent.status, "unknown");
  assert.equal(result.outputEvent.payload.reason, "no_included_samples");
  assert.equal(result.outputEvent.payload.persistStatus, "evidence_insufficient");
  assert.equal(result.outputEvent.payload.weightFileRef, null);
  assert.ok(result.outputEvent.payload.resultFileRef.endsWith(".result.json"));
  const files = await readdir(root, { recursive: true });
  assert.equal(files.some(file => file.endsWith(".weight.json")), false);
  assert.equal(files.some(file => file.endsWith(".result.json")), true);
});

test("public training profile loader accepts only the bound task contract", () => {
  const profiles = loadTrainingProfiles({
    profileId: LEGACY_BASIC_KIND_PROFILE.id,
    profile: LEGACY_BASIC_KIND_PROFILE,
  });
  assert.equal(profiles[LEGACY_BASIC_KIND_PROFILE.id].id, LEGACY_BASIC_KIND_PROFILE.id);
  const migratedLegacy = structuredClone(LEGACY_BASIC_KIND_PROFILE);
  delete migratedLegacy.familyWeights.media.nat_svg;
  const loaded = loadTrainingProfiles({ profileId: "legacy-with-missing-cell", profile: migratedLegacy });
  assert.equal(loaded["legacy-with-missing-cell"].familyWeights.media.nat_svg, 0);
  assert.equal(migrateBasicKindProfile(DEFAULT_BASIC_KIND_PROFILE).familyWeights.media.nat_svg, 0.45);
  assert.throws(
    () => loadTrainingProfiles({ profileId: "broken", profile: { ...DEFAULT_BASIC_KIND_PROFILE, id: "" } }),
    /profile\.id/,
  );
});

function comparisonFixture(regressButton = false) {
  const samples = prepareBasicKindSamples(request([
    row("button", { snapshot: "known-button" }),
    row("span", { snapshot: "new-span", expectedLabel: "text", properties: {
      tag: "span", role: null, ...complete, childElementCount: null, directTextPresent: true,
    } }),
  ]), prepareConfig);
  const partitions = partitionBasicKindSamples(samples, partitionConfig({ seed: 20261017 })).partitions;
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.id = "comparison-fixture";
  profile.familyWeights.text.nat_span = 0.5;
  profile.leafWeights.text.nat_span = 0.5;
  if (regressButton) {
    profile.familyWeights.control.nat_control_button = 0;
    profile.leafWeights.button.nat_control_button = 0;
  }
  const labelCounts = {};
  for (const index of partitions.trainIndices) {
    const label = partitions.rows[index].review.expectedLabel;
    labelCounts[label] = (labelCounts[label] ?? 0) + 1;
  }
  return compareBasicKindCandidates({
    candidate: { schemaVersion: 1, taskId: "dom.basic-kinds.v1", candidateId: profile.id,
      baseProfileId: DEFAULT_BASIC_KIND_PROFILE.id, profile, trajectory: [], lossBefore: 1,
      lossAfter: 0.5, sampleCoverage: { trainRows: partitions.trainIndices.length, labelCounts } },
    partitions, baseProfile: DEFAULT_BASIC_KIND_PROFILE, config: trainingConfig(),
  });
}

test("gold training regressions reject a candidate even when held-out cases improve", () => {
  const comparison = comparisonFixture(true);
  assert.equal(comparison.splits.train.transitions.regressed, 1);
  assert.equal(comparison.splits.eval.transitions.fixed, 1);
  assert.equal(assessBasicKindComparison(comparison, { forbidGoldRegression: true }).recommendation, "candidate_rejected_regression");
});

test("saved inference thresholds come from comparison, with no second report setting", async () => {
  const root = await mkdtemp(join(tmpdir(), "nnanything-threshold-owner-"));
  const comparison = comparisonFixture();
  const receipt = await writeBasicKindTrainingArtifacts({ allowedRoot: root,
    config: { weightsDirectory: "weights", resultsDirectory: "results" },
    runId: "threshold-owner", taskId: "dom.basic-kinds.v1",
    assessment: assessBasicKindComparison(comparison, { forbidGoldRegression: true }),
  });
  assert.deepEqual(receipt.inference, comparison.inference);
  const asset = JSON.parse(await readFile(receipt.weightFileRef, "utf8"));
  assert.deepEqual(asset.compatibility, { taskId: "dom.basic-kinds.v1", ...comparison.inference });
});
