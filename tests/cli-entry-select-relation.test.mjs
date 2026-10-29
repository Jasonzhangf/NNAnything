import assert from "node:assert/strict";
import { posix } from "node:path";
import test from "node:test";

const MODULE_URL = "../dist/filters/cli-entry-select-relation.js";

async function api() {
  return import(MODULE_URL);
}

const DIRECTORY_SELECTOR = Object.freeze({
  name: "humanagent",
  type: "directory",
  parent: "/workspace",
});

const REGULAR_SELECTOR = Object.freeze({
  name: "humanagent",
  type: "regular",
  parent: "/workspace",
});

function directoryProfile(overrides = {}) {
  return Object.freeze({
    contract: "cli.directory-select-relation.v1",
    targetType: "directory",
    wires: ["bias", "name_equal", "type_equal", "parent_equal"],
    // Engineering fixture only. This is not a trained weight or a capability result.
    weights: [-3.5, 1.5, 1.5, 1.5],
    threshold: 0.5,
    calibration: "uncalibrated",
    adoption: "not_applied",
    ...overrides,
  });
}

function regularProfile(overrides = {}) {
  return Object.freeze({
    contract: "cli.file-select-relation.v1",
    targetType: "regular",
    wires: ["bias", "name_equal", "type_equal", "parent_equal"],
    weights: [-3.5, 1.5, 1.5, 1.5],
    threshold: 0.5,
    calibration: "uncalibrated",
    adoption: "not_applied",
    ...overrides,
  });
}

function cand(ref, name, type, parent, path) {
  return Object.freeze({
    ref,
    path: path ?? (name === null || parent === null ? "/workspace/opaque" : posix.join(parent, name)),
    name,
    type,
    parent,
  });
}

function asArray(value) {
  return value === null ? null : [...value];
}

test("module exports the fixed four-wire contract and freezes profile schema", async () => {
  const module = await api();
  assert.deepEqual([...module.ENTRY_SELECT_WIRES], ["bias", "name_equal", "type_equal", "parent_equal"]);
  assert.equal(Object.isFrozen(module.ENTRY_SELECT_WIRES), true);

  const validated = module.validateEntrySelectProfile(directoryProfile());
  assert.equal(validated.contract, "cli.directory-select-relation.v1");
  assert.equal(validated.targetType, "directory");
  assert.deepEqual([...validated.wires], ["bias", "name_equal", "type_equal", "parent_equal"]);
  assert.deepEqual([...validated.weights], [-3.5, 1.5, 1.5, 1.5]);
  assert.equal(validated.threshold, 0.5);
  assert.equal(validated.calibration, "uncalibrated");
  assert.equal(validated.adoption, "not_applied");
  assert.equal(Object.isFrozen(validated), true);
});

test("profile validation rejects mixing, wire reorder, non-finite weights and out-of-range thresholds", async () => {
  const module = await api();
  assert.throws(
    () => module.validateEntrySelectProfile(directoryProfile({ targetType: "regular" })),
    TypeError,
  );
  assert.throws(
    () => module.validateEntrySelectProfile(directoryProfile({ contract: "cli.file-select-relation.v1" })),
    TypeError,
  );
  assert.throws(
    () => module.validateEntrySelectProfile(directoryProfile({ wires: ["name_equal", "bias", "type_equal", "parent_equal"] })),
    TypeError,
  );
  assert.throws(
    () => module.validateEntrySelectProfile(directoryProfile({ weights: [-3.5, 1.5, 1.5] })),
    TypeError,
  );
  assert.throws(
    () => module.validateEntrySelectProfile(directoryProfile({ weights: [-3.5, 1.5, 1.5, Number.NaN] })),
    TypeError,
  );
  assert.throws(
    () => module.validateEntrySelectProfile(directoryProfile({ weights: [-3.5, 1.5, 1.5, Number.POSITIVE_INFINITY] })),
    TypeError,
  );
  for (const threshold of [0, 1, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => module.validateEntrySelectProfile(directoryProfile({ threshold })),
      TypeError,
    );
  }
  assert.throws(
    () => module.validateEntrySelectProfile(directoryProfile({ calibration: "calibrated" })),
    TypeError,
  );
  assert.throws(
    () => module.validateEntrySelectProfile(directoryProfile({ adoption: "applied" })),
    TypeError,
  );
  assert.doesNotThrow(() => module.validateEntrySelectProfile(directoryProfile({ threshold: 0.25 })));
});

test("sigmoid maps finite logits into (0, 1) and stays monotone and symmetric", async () => {
  const module = await api();
  assert.equal(module.entrySelectSigmoid(0), 0.5);
  for (const logit of [-10, -3.5, -1, 0, 1, 3.5, 10]) {
    const score = module.entrySelectSigmoid(logit);
    assert.ok(score > 0 && score < 1, `sigmoid(${logit}) must stay strictly inside (0, 1)`);
  }
  assert.ok(module.entrySelectSigmoid(2) > module.entrySelectSigmoid(1));
  assert.ok(module.entrySelectSigmoid(-2) < module.entrySelectSigmoid(-1));
  assert.ok(Math.abs(module.entrySelectSigmoid(3) + module.entrySelectSigmoid(-3) - 1) < 1e-12);
});

test("logit and score follow the explicit four-parameter linear contract", async () => {
  const module = await api();
  const profile = directoryProfile();
  const prediction = module.predictEntrySelectRelation(
    DIRECTORY_SELECTOR,
    cand("c-target", "humanagent", "directory", "/workspace"),
    profile,
  );
  assert.equal(prediction.status, "judged");
  assert.deepEqual(asArray(prediction.features), [1, 1, 1, 1]);
  assert.equal(prediction.logit, 1);
  assert.ok(Math.abs(prediction.score - 1 / (1 + Math.exp(-1))) < 1e-12);
  assert.ok(prediction.score > profile.threshold);
  assert.equal(prediction.relation, "matches_selector");
});

test("all eight 0/1 comparison combinations are separated by the fixture profile", async () => {
  const module = await api();
  const profile = directoryProfile();
  const rows = [];
  for (const nameEqual of [1, 0]) {
    for (const typeEqual of [1, 0]) {
      for (const parentEqual of [1, 0]) {
        const candidate = cand(
          `c-${nameEqual}${typeEqual}${parentEqual}`,
          nameEqual === 1 ? DIRECTORY_SELECTOR.name : "other",
          typeEqual === 1 ? "directory" : "regular",
          parentEqual === 1 ? DIRECTORY_SELECTOR.parent : "/workspace/sub",
        );
        const prediction = module.predictEntrySelectRelation(DIRECTORY_SELECTOR, candidate, profile);
        assert.equal(prediction.status, "judged");
        assert.deepEqual(asArray(prediction.features), [1, nameEqual, typeEqual, parentEqual]);
        const expected = nameEqual === 1 && typeEqual === 1 && parentEqual === 1
          ? "matches_selector"
          : "does_not_match_selector";
        assert.equal(prediction.relation, expected, `features [1, ${nameEqual}, ${typeEqual}, ${parentEqual}]`);
        rows.push({ nameEqual, typeEqual, parentEqual, score: prediction.score });
      }
    }
  }
  assert.equal(rows.length, 8);
  assert.equal(rows.filter(row => row.score >= profile.threshold).length, 1);
});

test("type_equal keeps directory, regular, legacy file and symlink distinct", async () => {
  const module = await api();
  const directoryCases = [
    ["directory", 1, "matches_selector"],
    ["regular", 0, "does_not_match_selector"],
    ["file", 0, "does_not_match_selector"],
    ["symlink", 0, "does_not_match_selector"],
  ];
  for (const [type, typeEqual, relation] of directoryCases) {
    const prediction = module.predictEntrySelectRelation(
      DIRECTORY_SELECTOR,
      cand(`dir-${type}`, "humanagent", type, "/workspace"),
      directoryProfile(),
    );
    assert.deepEqual(asArray(prediction.features), [1, 1, typeEqual, 1]);
    assert.equal(prediction.relation, relation);
  }

  const regularCases = [
    ["regular", 1, "matches_selector"],
    ["file", 1, "matches_selector"],
    ["directory", 0, "does_not_match_selector"],
    ["symlink", 0, "does_not_match_selector"],
  ];
  for (const [type, typeEqual, relation] of regularCases) {
    const prediction = module.predictEntrySelectRelation(
      REGULAR_SELECTOR,
      cand(`file-${type}`, "humanagent", type, "/workspace"),
      regularProfile(),
    );
    assert.deepEqual(asArray(prediction.features), [1, 1, typeEqual, 1]);
    assert.equal(prediction.relation, relation);
  }
});

test("missing comparisons produce null features, logit and score and never zero fill", async () => {
  const module = await api();
  const profile = directoryProfile();
  const missing = [
    cand("c-unknown", "humanagent", "unknown", "/workspace"),
    cand("c-null-type", "humanagent", null, "/workspace"),
    cand("c-null-name", null, "directory", "/workspace", "/workspace/opaque"),
    cand("c-null-parent", "humanagent", "directory", null, "/workspace/humanagent"),
  ];
  for (const candidate of missing) {
    const prediction = module.predictEntrySelectRelation(DIRECTORY_SELECTOR, candidate, profile);
    assert.equal(prediction.status, "unknown");
    assert.equal(prediction.features, null);
    assert.equal(prediction.logit, null);
    assert.equal(prediction.score, null);
    assert.equal(prediction.relation, null);
  }

  const result = module.resolveEntrySelectSet(
    DIRECTORY_SELECTOR,
    [cand("c-unknown", "humanagent", "unknown", "/workspace")],
    "complete",
    profile,
  );
  assert.equal(result.outcome, "insufficient_evidence");
  assert.equal(result.status, "unknown");
  assert.equal(result.satisfaction, null);
  assert.equal(result.reason, "unknown_comparison");
});

test("a missing comparison is insufficient evidence even when a known comparison already fails", async () => {
  const module = await api();
  const result = module.resolveEntrySelectSet(
    DIRECTORY_SELECTOR,
    [
      cand("c-target", "humanagent", "directory", "/workspace"),
      // name_equal is already 0, but the type is missing: the conservative set
      // contract still refuses to return a partial not_found/selected verdict.
      cand("c-partial-unknown", "other", "unknown", "/workspace"),
    ],
    "complete",
    directoryProfile(),
  );
  assert.equal(result.outcome, "insufficient_evidence");
  assert.equal(result.reason, "unknown_comparison");
});

test("partial coverage is insufficient evidence even when every judged candidate misses", async () => {
  const module = await api();
  const result = module.resolveEntrySelectSet(
    DIRECTORY_SELECTOR,
    [cand("c-other", "other", "directory", "/workspace")],
    "partial",
    directoryProfile(),
  );
  assert.equal(result.outcome, "insufficient_evidence");
  assert.equal(result.status, "unknown");
  assert.equal(result.satisfaction, null);
  assert.equal(result.reason, "coverage_partial");
});

test("empty candidate sets distinguish complete not_found from partial insufficient evidence", async () => {
  const module = await api();
  const complete = module.resolveEntrySelectSet(DIRECTORY_SELECTOR, [], "complete", directoryProfile());
  assert.equal(complete.outcome, "not_found");
  assert.equal(complete.status, "unmet");
  assert.equal(complete.satisfaction, 0);
  assert.equal(complete.ref, null);

  const partial = module.resolveEntrySelectSet(DIRECTORY_SELECTOR, [], "partial", directoryProfile());
  assert.equal(partial.outcome, "insufficient_evidence");
  assert.equal(partial.status, "unknown");
  assert.equal(partial.satisfaction, null);
});

test("duplicate refs, duplicate entities and contradictory paths are invalid_input", async () => {
  const module = await api();
  const profile = directoryProfile();

  const duplicateRef = module.resolveEntrySelectSet(
    DIRECTORY_SELECTOR,
    [
      cand("same-ref", "humanagent", "directory", "/workspace"),
      cand("same-ref", "other", "directory", "/workspace"),
    ],
    "complete",
    profile,
  );
  assert.equal(duplicateRef.outcome, "invalid_input");
  assert.equal(duplicateRef.status, "rejected");
  assert.equal(duplicateRef.satisfaction, 0);
  assert.equal(duplicateRef.reason, "duplicate_ref");

  const duplicateEntity = module.resolveEntrySelectSet(
    DIRECTORY_SELECTOR,
    [
      cand("ref-one", "humanagent", "directory", "/workspace"),
      cand("ref-two", "humanagent", "regular", "/workspace"),
    ],
    "complete",
    profile,
  );
  assert.equal(duplicateEntity.outcome, "invalid_input");
  assert.equal(duplicateEntity.reason, "duplicate_entity");

  const pathMismatch = module.resolveEntrySelectSet(
    DIRECTORY_SELECTOR,
    [cand("ref-three", "humanagent", "directory", "/workspace", "/elsewhere/humanagent")],
    "complete",
    profile,
  );
  assert.equal(pathMismatch.outcome, "invalid_input");
  assert.equal(pathMismatch.reason, "path_mismatch");
});

test("candidate order does not change selection and the original ref is returned", async () => {
  const module = await api();
  const profile = directoryProfile();
  const target = cand("target-ref", "humanagent", "directory", "/workspace");
  const readme = cand("readme-ref", "readme.txt", "regular", "/workspace");
  const archive = cand("archive-ref", "archive", "directory", "/workspace");
  const shortcut = cand("shortcut-ref", "shortcut", "symlink", "/workspace");
  const permutations = [
    [target, readme, archive, shortcut],
    [shortcut, archive, readme, target],
    [readme, target, shortcut, archive],
    [archive, readme, target, shortcut],
  ];
  for (const candidates of permutations) {
    const result = module.resolveEntrySelectSet(DIRECTORY_SELECTOR, candidates, "complete", profile);
    assert.equal(result.outcome, "selected");
    assert.equal(result.status, "achieved");
    assert.equal(result.satisfaction, 100);
    assert.equal(result.ref, "target-ref");
  }

  const refObject = Object.freeze({
    kind: "cli.directory",
    scenarioId: "scenario",
    sessionId: "session",
    path: "/workspace/humanagent",
  });
  const objectResult = module.resolveEntrySelectSet(
    DIRECTORY_SELECTOR,
    [cand(refObject, "humanagent", "directory", "/workspace")],
    "complete",
    profile,
  );
  assert.equal(objectResult.outcome, "selected");
  assert.equal(objectResult.ref, refObject);
});

test("multiple numeric matches report conflict instead of taking the first or highest score", async () => {
  const module = await api();
  const flat = directoryProfile({ weights: [0, 0, 0, 0], threshold: 0.4 });
  const result = module.resolveEntrySelectSet(
    DIRECTORY_SELECTOR,
    [
      cand("c-a", "humanagent", "directory", "/workspace"),
      cand("c-b", "other", "directory", "/workspace"),
    ],
    "complete",
    flat,
  );
  assert.equal(result.outcome, "conflict");
  assert.equal(result.status, "unknown");
  assert.equal(result.satisfaction, null);
  assert.equal(result.ref, null);
  assert.equal(result.reason, "multiple_matches_in_single_parent");
});

test("a deliberately wrong profile drives the result, proving no teacher-rule override", async () => {
  const module = await api();
  // Inverted engineering profile: it rewards candidates that fail the exact AND
  // and punishes the exact AND candidate. The module must report the numeric
  // result, never silently rewrite it with the teacher's three-way AND.
  const inverted = directoryProfile({ weights: [0.6, -1, -1, -1], threshold: 0.5 });

  const trueCandidate = cand("true-ref", "humanagent", "directory", "/workspace");
  const truePrediction = module.predictEntrySelectRelation(DIRECTORY_SELECTOR, trueCandidate, inverted);
  assert.deepEqual(asArray(truePrediction.features), [1, 1, 1, 1]);
  assert.equal(truePrediction.relation, "does_not_match_selector");
  const trueSet = module.resolveEntrySelectSet(DIRECTORY_SELECTOR, [trueCandidate], "complete", inverted);
  assert.equal(trueSet.outcome, "not_found");

  const falseCandidate = cand("false-ref", "other", "regular", "/workspace/sub");
  const falsePrediction = module.predictEntrySelectRelation(DIRECTORY_SELECTOR, falseCandidate, inverted);
  assert.deepEqual(asArray(falsePrediction.features), [1, 0, 0, 0]);
  assert.equal(falsePrediction.relation, "matches_selector");
  const falseSet = module.resolveEntrySelectSet(DIRECTORY_SELECTOR, [falseCandidate], "complete", inverted);
  assert.equal(falseSet.outcome, "selected");
  assert.equal(falseSet.ref, "false-ref");
});

test("threshold comparison is inclusive at the exact boundary", async () => {
  const module = await api();
  const candidate = cand("c-flat", "other", "regular", "/workspace/sub");
  const at = module.predictEntrySelectRelation(
    DIRECTORY_SELECTOR,
    candidate,
    directoryProfile({ weights: [0, 0, 0, 0], threshold: 0.5 }),
  );
  assert.equal(at.logit, 0);
  assert.equal(at.score, 0.5);
  assert.equal(at.relation, "matches_selector");

  const above = module.predictEntrySelectRelation(
    DIRECTORY_SELECTOR,
    candidate,
    directoryProfile({ weights: [0, 0, 0, 0], threshold: 0.5000001 }),
  );
  assert.equal(above.relation, "does_not_match_selector");
});

test("directory and regular profiles cannot be mixed across selector target types", async () => {
  const module = await api();
  assert.throws(
    () => module.predictEntrySelectRelation(
      REGULAR_SELECTOR,
      cand("c-file", "humanagent", "regular", "/workspace"),
      directoryProfile(),
    ),
    TypeError,
  );
  assert.throws(
    () => module.resolveEntrySelectSet(
      REGULAR_SELECTOR,
      [cand("c-file", "humanagent", "regular", "/workspace")],
      "complete",
      directoryProfile(),
    ),
    TypeError,
  );
  assert.throws(
    () => module.resolveEntrySelectSet(
      DIRECTORY_SELECTOR,
      [cand("c-dir", "humanagent", "directory", "/workspace")],
      "unknown",
      directoryProfile(),
    ),
    TypeError,
  );
});

test("resolution does not mutate the selector, candidates or profile", async () => {
  const module = await api();
  const selector = { ...DIRECTORY_SELECTOR };
  const profile = directoryProfile();
  const candidates = [
    cand("c-target", "humanagent", "directory", "/workspace"),
    cand("c-other", "other", "regular", "/workspace"),
  ];
  const selectorBefore = JSON.stringify(selector);
  const profileBefore = JSON.stringify(profile);
  const candidatesBefore = JSON.stringify(candidates);
  module.resolveEntrySelectSet(selector, candidates, "complete", profile);
  assert.equal(JSON.stringify(selector), selectorBefore);
  assert.equal(JSON.stringify(profile), profileBefore);
  assert.equal(JSON.stringify(candidates), candidatesBefore);
});

test("zeroEntrySelectProfile constructs valid uncalibrated/not_applied zero profiles", async () => {
  const module = await api();
  const dirZero = module.zeroEntrySelectProfile("directory", 0.5);
  assert.equal(dirZero.contract, "cli.directory-select-relation.v1");
  assert.equal(dirZero.targetType, "directory");
  assert.deepEqual([...dirZero.weights], [0, 0, 0, 0]);
  assert.equal(dirZero.threshold, 0.5);
  assert.equal(dirZero.calibration, "uncalibrated");
  assert.equal(dirZero.adoption, "not_applied");

  const regZero = module.zeroEntrySelectProfile("regular", 0.5);
  assert.equal(regZero.contract, "cli.file-select-relation.v1");
  assert.equal(regZero.targetType, "regular");
  assert.deepEqual([...regZero.weights], [0, 0, 0, 0]);
});

test("makeEntrySelectDataset and validateEntrySelectDataset verify 36 sets / 144 candidates and 10 non-BCE probes", async () => {
  const samplesMod = await import("../dist/training/cli-entry-select-samples.js");
  const dataset = samplesMod.makeEntrySelectDataset();
  const summary = samplesMod.validateEntrySelectDataset(dataset);

  assert.equal(summary.totalSets, 36);
  assert.equal(summary.totalCandidates, 144);
  assert.equal(summary.totalProbes, 10);
  assert.equal(summary.familyDisjoint, true);
  assert.equal(summary.conflictingFeatureLabelPairs, 0);

  assert.equal(summary.partitions.train.setCount, 16);
  assert.equal(summary.partitions.train.candidateCount, 64);
  assert.equal(summary.partitions.train.selectedSets, 12);
  assert.equal(summary.partitions.train.notFoundSets, 4);
  assert.deepEqual([...summary.partitions.train.families], [
    "B_TRAIN_workspace_tree",
    "B_TRAIN_package_tree",
    "B_TRAIN_service_tree",
    "B_TRAIN_docs_tree",
  ]);

  assert.equal(summary.partitions.development.setCount, 8);
  assert.equal(summary.partitions.development.candidateCount, 32);
  assert.equal(summary.partitions.development.selectedSets, 6);
  assert.equal(summary.partitions.development.notFoundSets, 2);
  assert.deepEqual([...summary.partitions.development.families], [
    "B_DEV_release_tree",
    "B_DEV_config_tree",
  ]);

  assert.equal(summary.partitions.verification.setCount, 12);
  assert.equal(summary.partitions.verification.candidateCount, 48);
  assert.equal(summary.partitions.verification.selectedSets, 8);
  assert.equal(summary.partitions.verification.notFoundSets, 4);
  assert.equal(summary.partitions.verification.role, "bounded_synthetic_held_out");
  assert.equal(summary.partitions.verification.provenance, "synthetic_held_out_from_eight_boolean_templates");
  assert.equal(summary.partitions.verification.allEightFeatureVectorsSeenInTrain, true);
  assert.equal(summary.partitions.verification.unseenFeatureCapabilityVerified, false);
  assert.equal(summary.verificationProvenance.role, "bounded_synthetic_held_out");
  assert.equal(summary.verificationProvenance.fullyVerified, false);
  assert.deepEqual([...summary.partitions.verification.families], [
    "B_VERIFY_alpha_tree",
    "B_VERIFY_beta_tree",
    "B_VERIFY_gamma_tree",
  ]);

  assert.deepEqual(summary.byCombinationTotal, {
    "B-C111": 26,
    "B-C110": 10,
    "B-C101": 10,
    "B-C011": 10,
    "B-C100": 10,
    "B-C010": 10,
    "B-C001": 10,
    "B-C000": 58,
  });
});

test("reload.mjs consumer executes zero-fit witness in a child process and persists reload.json and reload-rows.json", async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const samplesMod = await import("../dist/training/cli-entry-select-samples.js");
  const dataset = samplesMod.makeEntrySelectDataset();
  const tempRoot = await mkdtemp(join(tmpdir(), "nn-entry-select-reload-witness-"));
  try {
    const dirProfile = directoryProfile({ weights: [-2.5, 1, 1, 1] });
    const regProfile = regularProfile({ weights: [-2.5, 1, 1, 1] });
    const dirPath = join(tempRoot, "directory-candidate.json");
    const regPath = join(tempRoot, "file-candidate.json");
    const samplesPath = join(tempRoot, "samples.json");
    const reportPath = join(tempRoot, "report.json");

    await writeFile(dirPath, JSON.stringify(dirProfile, null, 2) + "\n", "utf8");
    await writeFile(regPath, JSON.stringify(regProfile, null, 2) + "\n", "utf8");
    await writeFile(samplesPath, JSON.stringify(dataset, null, 2) + "\n", "utf8");
    await writeFile(reportPath, JSON.stringify({
      profiles: { directory: dirProfile, regular: regProfile },
    }, null, 2) + "\n", "utf8");
    await writeFile(join(tempRoot, "latest-report.json"), JSON.stringify({
      runId: "witness-0",
      directoryProfilePath: dirPath,
      regularProfilePath: regPath,
      samplesPath,
      reportPath,
    }, null, 2) + "\n", "utf8");

    const reloadScript = fileURLToPath(new URL("../playground/cli/entry-select-learning/reload.mjs", import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [
      reloadScript,
      "--output-root",
      tempRoot,
    ], { encoding: "utf8" });

    const receipt = JSON.parse(stdout);
    assert.equal(receipt.contract, "cli.entry-select-reload.receipt.v1");
    assert.equal(receipt.fitted, false);
    assert.equal(receipt.profileMatchesSavedFile, true);
    assert.equal(receipt.knownReplay.train.setsChecked, 16);
    assert.equal(receipt.knownReplay.train.setsCorrect, 16);
    assert.equal(receipt.knownReplay.train.candidatesChecked, 64);
    assert.equal(receipt.knownReplay.train.candidatesCorrect, 64);
    assert.equal(receipt.knownReplay.development.setsChecked, 8);
    assert.equal(receipt.knownReplay.development.setsCorrect, 8);
    assert.equal(receipt.knownReplay.development.candidatesChecked, 32);
    assert.equal(receipt.knownReplay.development.candidatesCorrect, 32);
    assert.equal(receipt.knownReplay.combinedSetsChecked, 24);
    assert.equal(receipt.knownReplay.combinedSetsCorrect, 24);
    assert.equal(receipt.independentVerification.role, "bounded_synthetic_held_out");
    assert.equal(receipt.independentVerification.provenance, "synthetic_held_out_from_eight_boolean_templates");
    assert.equal(receipt.independentVerification.allEightFeatureVectorsSeenInTrain, true);
    assert.equal(receipt.independentVerification.unseenFeatureCapabilityVerified, false);
    assert.equal(receipt.independentVerification.fullyVerified, false);
    assert.equal(receipt.independentVerification.verification.setsChecked, 12);
    assert.equal(receipt.independentVerification.verification.setsCorrect, 12);
    assert.equal(receipt.independentVerification.verification.candidatesChecked, 48);
    assert.equal(receipt.independentVerification.verification.candidatesCorrect, 48);
    assert.equal(receipt.probes.checked, 10);
    assert.equal(receipt.probes.correct, 10);
    assert.equal(receipt.totals.failed, 0);

    const savedRows = JSON.parse(await readFile(join(tempRoot, "reload-rows.json"), "utf8"));
    assert.equal(savedRows.setExecutionRows.length, 36);
    assert.equal(savedRows.candidateExecutionRows.length, 144);
    assert.equal(savedRows.probeExecutionRows.length, 10);
    assert.equal(savedRows.setExecutionRows.some(r => r.partition === "verification" && r.role === "bounded_synthetic_held_out"), true);
    assert.equal(savedRows.candidateExecutionRows.some(r => r.partition === "verification" && r.role === "bounded_synthetic_held_out"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("engineering numerical pipeline smoke test: Handwired single-logit BCE circuit and SGD update", async () => {
  const handwiredRoot = process.env.NN_HANDWIRED_ROOT ?? "/Volumes/extension/code/handwired";
  const numericMod = await import("../dist/training/cli-entry-select-numeric.js");
  const module = await api();

  // Synthetic 8-combination truth table smoke test (engineering pipeline verification only)
  const syntheticRows = [
    { features: [1, 1, 1, 1], expectedLabel: 1 },
    { features: [1, 1, 1, 0], expectedLabel: 0 },
    { features: [1, 1, 0, 1], expectedLabel: 0 },
    { features: [1, 0, 1, 1], expectedLabel: 0 },
    { features: [1, 1, 0, 0], expectedLabel: 0 },
    { features: [1, 0, 1, 0], expectedLabel: 0 },
    { features: [1, 0, 0, 1], expectedLabel: 0 },
    { features: [1, 0, 0, 0], expectedLabel: 0 },
  ];

  const zeroResult = await numericMod.fitEntrySelectRelation({
    initial: module.zeroEntrySelectProfile("directory", 0.5),
    rows: syntheticRows,
    handwiredRoot,
    epochs: 0,
    learningRate: 0.1,
  });
  assert.equal(zeroResult.timing.completedEpochs, 0);
  assert.deepEqual([...zeroResult.profile.weights], [0, 0, 0, 0]);
  assert.equal(zeroResult.separatesAllBooleanCombinations, false);

  const fitResult = await numericMod.fitEntrySelectRelation({
    initial: module.zeroEntrySelectProfile("directory", 0.5),
    rows: syntheticRows,
    handwiredRoot,
    epochs: 25,
    learningRate: 0.5,
  });
  assert.equal(fitResult.timing.completedEpochs, 25);
  assert.equal(fitResult.timing.processedRowCount, 8);
  assert.equal(fitResult.timing.gradientRowEpochs, 200);
  assert.equal(fitResult.timing.trainableParamCount, 4);
  assert.equal(fitResult.trajectory.length, 25);
  assert.equal(fitResult.trajectory[24].loss < fitResult.trajectory[0].loss, true);
  assert.equal(fitResult.profile.calibration, "uncalibrated");
  assert.equal(fitResult.profile.adoption, "not_applied");
});

test("train.mjs exits nonzero after preserving candidate, report, trajectory and reload receipts when acceptance fails", async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const handwiredRoot = process.env.NN_HANDWIRED_ROOT ?? "/Volumes/extension/code/handwired";
  const tempRoot = await mkdtemp(join(tmpdir(), "nn-entry-select-rejection-exit-"));
  const trainScript = fileURLToPath(new URL("../playground/cli/entry-select-learning/train.mjs", import.meta.url));
  try {
    let caughtError = null;
    try {
      await execFileAsync(process.execPath, [
        trainScript,
        "--mode",
        "train",
        "--handwired-root",
        handwiredRoot,
        "--epochs",
        "1",
        "--learning-rate",
        "0.0001",
        "--output-root",
        tempRoot,
      ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      caughtError = error;
    }

    assert.ok(caughtError !== null, "train.mjs must reject with a nonzero exit code when acceptance fails");
    assert.equal(caughtError.code, 1);

    const summary = JSON.parse(caughtError.stdout);
    assert.equal(summary.accepted, false);
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.fullyVerified, false);
    assert.equal(summary.verificationScope, "bounded_synthetic_held_out");
    assert.equal(summary.unseenFeatureCapabilityVerified, false);

    const latestMeta = JSON.parse(await readFile(join(tempRoot, "latest-report.json"), "utf8"));
    const savedDirProfile = JSON.parse(await readFile(latestMeta.directoryProfilePath, "utf8"));
    const savedRegProfile = JSON.parse(await readFile(latestMeta.regularProfilePath, "utf8"));
    const savedReport = JSON.parse(await readFile(latestMeta.reportPath, "utf8"));
    const savedReload = JSON.parse(await readFile(join(dirname(latestMeta.reportPath), "reload.json"), "utf8"));
    const savedReloadRows = JSON.parse(await readFile(join(dirname(latestMeta.reportPath), "reload-rows.json"), "utf8"));

    assert.equal(savedDirProfile.contract, "cli.directory-select-relation.v1");
    assert.equal(savedRegProfile.contract, "cli.file-select-relation.v1");
    assert.equal(savedReport.accepted, false);
    assert.equal(savedReport.fullyVerified, false);
    assert.equal(savedReport.verificationScope, "bounded_synthetic_held_out");
    assert.equal(savedReport.units.directory.trajectory.length, 1);
    assert.equal(savedReport.units.regular.trajectory.length, 1);
    assert.equal(savedReload.contract, "cli.entry-select-reload.receipt.v1");
    assert.equal(savedReload.fitted, false);
    assert.equal(savedReloadRows.setExecutionRows.length, 36);
    assert.equal(savedReloadRows.candidateExecutionRows.length, 144);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
