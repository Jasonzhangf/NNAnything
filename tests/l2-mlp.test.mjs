import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createL2Unit,
  fitL2Mlp,
  readL2Profile,
  saveL2Profile,
  validateL2Profile,
} from "../dist/training/l2-mlp.js";
import { L2_HEADS } from "../dist/adapters/l2/contracts.js";

const handwiredRoot = process.env.NN_HANDWIRED_ROOT;
const assetGated = { skip: !handwiredRoot && "provide explicit NN_HANDWIRED_ROOT" };
const moduleUrl = new URL("../dist/training/l2-mlp.js", import.meta.url).href;

function diagnosticSpecs() {
  return {
    R: { features: ["x0", "x1"], labels: ["same", "diff"], hidden: [4, 4] },
    D: { features: ["d0"], labels: ["planA", "planB"], hidden: [2, 2] },
    E: { features: ["e0"], labels: ["yes", "no"], hidden: [2, 2] },
    A: { features: ["a0"], labels: ["act", "skip"], hidden: [2, 2] },
  };
}

function parameterCount(spec) {
  const [hiddenOne, hiddenTwo] = spec.hidden;
  const features = spec.features.length;
  const labels = spec.labels.length;
  return hiddenOne * features + hiddenOne
    + hiddenTwo * hiddenOne + hiddenTwo
    + labels * hiddenTwo + labels;
}

function diagnosticRows() {
  const rows = [
    ["R", [0, 0], ["same"]],
    ["R", [0, 1], ["diff"]],
    ["R", [1, 0], ["diff"]],
    ["R", [1, 1], ["same"]],
    ["D", [1], ["planA"]],
    ["E", [0], ["yes"]],
    ["A", [1], ["act"]],
  ];
  return rows.map(([head, features, allowed], index) => ({
    id: `row-${index + 1}`,
    sourceGroup: `source-${index + 1}`,
    partition: "train",
    head,
    features,
    allowed,
  }));
}

function diagnosticInput(overrides = {}) {
  return {
    handwiredRoot,
    specs: diagnosticSpecs(),
    rows: diagnosticRows(),
    seed: 7,
    learningRate: 0.3,
    epochs: 1200,
    stopCheckpoints: [1200],
    ...overrides,
  };
}

function minimalProfile() {
  const specs = diagnosticSpecs();
  const heads = {};
  for (const head of L2_HEADS) {
    const spec = specs[head];
    heads[head] = {
      spec,
      parameters: Array.from({ length: parameterCount(spec) }, () => 0),
    };
  }
  return {
    schema: "nnanything.l2.mlp.v1",
    heads,
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function zeroScore() {
  return Object.fromEntries(L2_HEADS.map(head => [head, { correct: 0, scored: 0 }]));
}

function allowedLossFromPrediction(prediction, allowed, labels) {
  const maximum = Math.max(...prediction.logits);
  const exponentials = prediction.logits.map(logit => Math.exp(logit - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  const allowedMass = allowed
    .map(label => exponentials[labels.indexOf(label)])
    .reduce((sum, value) => sum + value, 0) / total;
  return -Math.log(allowedMass);
}

test("fit rejects mixed partitions and invalid supervision before loading the backend", async () => {
  const input = diagnosticInput({ handwiredRoot: "/unused-backend", epochs: 1, stopCheckpoints: [] });
  const rows = input.rows;
  const last = rows.length - 1;
  await assert.rejects(
    fitL2Mlp({ ...input, rows: [...rows.slice(0, last), { ...rows[last], partition: "dev" }] }),
    /partition dev is not train/,
  );
  await assert.rejects(
    fitL2Mlp({
      ...input,
      rows: [...rows, { ...rows[0], id: "row-verification", partition: "verification" }],
    }),
    /partition verification is not train/,
  );
  await assert.rejects(
    fitL2Mlp({ ...input, rows: [...rows, { ...rows[0], sourceGroup: "other-source" }] }),
    /repeats row id row-1/,
  );
  await assert.rejects(
    fitL2Mlp({ ...input, rows: [...rows.slice(0, last), { ...rows[last], allowed: [] }] }),
    /allowed must not be empty/,
  );
  await assert.rejects(
    fitL2Mlp({ ...input, rows: [...rows.slice(0, last), { ...rows[last], allowed: ["missing"] }] }),
    /is not a label of head A/,
  );
  await assert.rejects(
    fitL2Mlp({ ...input, rows: rows.map(row => row.head === "R" ? { ...row, features: [0] } : row) }),
    /must contain 2 values for head R/,
  );
  const { sourceGroup: _sourceGroup, ...missingSource } = rows[0];
  await assert.rejects(
    fitL2Mlp({ ...input, rows: [missingSource, ...rows.slice(1)] }),
    /sourceGroup/,
  );
  await assert.rejects(
    fitL2Mlp({ ...input, rows: rows.filter(row => row.head !== "A") }),
    /head A has no train rows/,
  );
  await assert.rejects(
    fitL2Mlp({ ...input, specs: { ...input.specs, R: { ...input.specs.R, hidden: [0, 2] } } }),
    /positive integer width/,
  );
  await assert.rejects(
    fitL2Mlp({ ...input, specs: { ...input.specs, R: { ...input.specs.R, labels: ["same", "same"] } } }),
    /duplicate name same/,
  );
  await assert.rejects(fitL2Mlp({ ...input, learningRate: 0 }), /learningRate must be positive/);
  await assert.rejects(fitL2Mlp({ ...input, epochs: -1 }), /epochs must be a nonnegative integer/);
  await assert.rejects(fitL2Mlp({ ...input, stopCheckpoints: [0] }), /positive integer epoch/);
  await assert.rejects(fitL2Mlp({ ...input, stopCheckpoints: [3, 3] }), /repeats checkpoint 3/);
  await assert.rejects(
    fitL2Mlp({ ...input, rows: rows.map((row, index) => index === 0 ? { ...row, features: [NaN, 0] } : row) }),
    /must be a finite number/,
  );
});

test("warm-start specs must match the fit specs", async () => {
  const input = diagnosticInput({ handwiredRoot: "/unused-backend", epochs: 1, stopCheckpoints: [] });
  const profile = minimalProfile();
  profile.heads.R = {
    ...profile.heads.R,
    spec: { ...profile.heads.R.spec, labels: ["other", "labels"] },
  };
  await assert.rejects(
    fitL2Mlp({ ...input, initialProfile: profile }),
    /warm-start profile spec for head R does not match/,
  );
});

test("XOR relation diagnostic learns with a declared finite small-network recipe", assetGated, async () => {
  const result = await fitL2Mlp(diagnosticInput());
  const { report, profile } = result;
  assert.deepEqual(report.trainedHeads, L2_HEADS);
  assert.equal(report.initialization, "pretraining");
  assert.equal(report.fittedRows, 7);
  assert.deepEqual(report.fittedByHead, { R: 4, D: 1, E: 1, A: 1 });
  assert.deepEqual(report.epochZero.R, { correct: 2, scored: 4 });
  assert.equal(report.stopped, "satisfied");
  assert.equal(report.epochsCompleted, 1200);
  assert.deepEqual(report.final, {
    R: { correct: 4, scored: 4 },
    D: { correct: 1, scored: 1 },
    E: { correct: 1, scored: 1 },
    A: { correct: 1, scored: 1 },
  });
  assert.equal(report.trajectory.length, 1200);
  assert.equal(report.trajectory.at(-1).epoch, 1200);
  for (const head of L2_HEADS) {
    assert.ok(Number.isFinite(report.trajectory[0].loss[head]));
    assert.ok(report.trajectory.at(-1).loss[head] < report.trajectory[0].loss[head]);
  }
  assert.equal(report.parameterCount, 90);
  assert.ok(report.changedParameters > 0);
  assert.equal(report.gradientProbe.checked, 8);
  assert.equal(report.gradientProbe.passed, true);
  assert.ok(Number.isFinite(report.gradientProbe.maxAbsoluteError));
  assert.ok(report.gradientProbe.maxAbsoluteError <= 1e-3);
  assert.equal(profile.schema, "nnanything.l2.mlp.v1");
  assert.equal(profile.calibration, "uncalibrated");
  assert.equal(profile.adoption, "not_applied");
  assert.deepEqual(validateL2Profile(profile), profile);
});

test("warm start captures epoch zero from supplied parameters without mutating them", assetGated, async () => {
  const input = diagnosticInput();
  const seeded = await fitL2Mlp({ ...input, seed: 7, epochs: 0, stopCheckpoints: [] });
  assert.equal(seeded.report.initialization, "pretraining");
  assert.equal(seeded.report.stopped, "epochs_exhausted");
  assert.equal(seeded.report.epochsCompleted, 0);
  assert.equal(seeded.report.changedParameters, 0);
  const snapshot = structuredClone(seeded.profile);
  const frozen = deepFreeze(structuredClone(seeded.profile));
  const warm = await fitL2Mlp({
    ...input,
    seed: 12345,
    learningRate: 0.05,
    epochs: 2,
    stopCheckpoints: [2],
    initialProfile: frozen,
  });
  assert.equal(warm.report.initialization, "warm_start");
  assert.deepEqual(frozen, snapshot);
  assert.deepEqual(seeded.profile, snapshot);
  assert.ok(warm.report.changedParameters > 0);

  const unit = await createL2Unit(seeded.profile, handwiredRoot);
  const expected = zeroScore();
  const manualLoss = { R: 0, D: 0, E: 0, A: 0 };
  for (const row of input.rows) {
    const prediction = unit.infer(row.head, row.features);
    expected[row.head].scored += 1;
    if (row.allowed.includes(prediction.label)) expected[row.head].correct += 1;
    manualLoss[row.head] += allowedLossFromPrediction(
      prediction,
      row.allowed,
      input.specs[row.head].labels,
    );
  }
  assert.deepEqual(warm.report.epochZero, expected);
  for (const head of L2_HEADS) {
    manualLoss[head] /= expected[head].scored;
    assert.ok(
      Math.abs(warm.report.trajectory[0].loss[head] - manualLoss[head]) < 1e-9,
      `head ${head} warm-start loss must come from the supplied parameters`,
    );
  }
});

test("trainHeads is validated and frozen-head rows are rejected before the backend loads", async () => {
  const input = diagnosticInput({ handwiredRoot: "/unused-backend", epochs: 1, stopCheckpoints: [] });
  const rows = input.rows;
  const rRows = rows.filter(row => row.head === "R");
  await assert.rejects(fitL2Mlp({ ...input, trainHeads: [] }), /trainHeads must not be empty/);
  await assert.rejects(fitL2Mlp({ ...input, trainHeads: ["R", "R"] }), /trainHeads contains duplicate head R/);
  await assert.rejects(fitL2Mlp({ ...input, trainHeads: ["X"] }), /trainHeads\[0\] X is not an L2 head/);
  await assert.rejects(fitL2Mlp({ ...input, trainHeads: [""] }), /trainHeads\[0\] must not be empty/);
  await assert.rejects(fitL2Mlp({ ...input, trainHeads: [5] }), /trainHeads\[0\] must be a string/);
  await assert.rejects(fitL2Mlp({ ...input, trainHeads: "R" }), /trainHeads must be an array/);
  await assert.rejects(
    fitL2Mlp({ ...input, trainHeads: ["R"], rows }),
    /rows\[4\] targets frozen head D/,
  );
  await assert.rejects(
    fitL2Mlp({
      ...input,
      trainHeads: ["R"],
      rows: [...rRows.slice(0, -1), { ...rRows.at(-1), partition: "dev" }],
    }),
    /partition dev is not train/,
  );
  await assert.rejects(
    fitL2Mlp({ ...input, trainHeads: ["R", "D"], rows: rRows }),
    /head D has no train rows/,
  );
  await assert.rejects(fitL2Mlp({ ...input, trainHeads: ["R"], rows: [] }), /rows must not be empty/);
});

test("staged R-only then D-only fits update one head and keep frozen parameters exact", assetGated, async t => {
  const dir = await mkdtemp(join(tmpdir(), "nn-l2-staged-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const input = diagnosticInput();
  const rRows = input.rows.filter(row => row.head === "R");
  const dRows = input.rows.filter(row => row.head === "D");

  const before = await fitL2Mlp({ ...input, seed: 7, epochs: 0, stopCheckpoints: [] });
  const beforeUnit = await createL2Unit(before.profile, handwiredRoot);
  const rInitialLogits = rRows.map(row => beforeUnit.infer("R", row.features).logits);

  const learnedR = await fitL2Mlp({
    ...input,
    rows: rRows,
    trainHeads: ["R"],
    initialProfile: before.profile,
    learningRate: 0.3,
    epochs: 1200,
    stopCheckpoints: [1200],
  });
  const rReport = learnedR.report;
  assert.deepEqual(rReport.trainedHeads, ["R"]);
  assert.equal(rReport.initialization, "warm_start");
  assert.equal(rReport.fittedRows, 4);
  assert.deepEqual(rReport.fittedByHead, { R: 4, D: 0, E: 0, A: 0 });
  assert.deepEqual(rReport.epochZero.D, { correct: 0, scored: 0 });
  assert.deepEqual(rReport.final.D, { correct: 0, scored: 0 });
  assert.deepEqual(rReport.final.R, { correct: 4, scored: 4 });
  assert.equal(rReport.stopped, "satisfied");
  assert.equal(rReport.gradientProbe.checked, 2);
  assert.equal(rReport.gradientProbe.passed, true);
  assert.ok(Number.isFinite(rReport.trajectory[0].loss.R));
  assert.equal(rReport.trajectory[0].loss.D, null);
  assert.deepEqual(JSON.parse(JSON.stringify(rReport)).trajectory[0].loss, rReport.trajectory[0].loss);
  assert.notDeepEqual(learnedR.profile.heads.R.parameters, before.profile.heads.R.parameters);
  for (const head of ["D", "E", "A"]) {
    assert.deepEqual(learnedR.profile.heads[head].parameters, before.profile.heads[head].parameters);
  }
  assert.ok(rReport.changedParameters > 0);
  assert.ok(rReport.changedParameters <= parameterCount(input.specs.R));

  const afterRUnit = await createL2Unit(learnedR.profile, handwiredRoot);
  const rAfterLogits = rRows.map(row => afterRUnit.infer("R", row.features).logits);
  assert.ok(rAfterLogits.some((logits, rowIndex) =>
    logits.some((value, logitIndex) => value !== rInitialLogits[rowIndex][logitIndex]),
  ));
  for (const row of rRows) {
    assert.ok(row.allowed.includes(afterRUnit.infer("R", row.features).label));
  }
  for (const [head, features] of [["D", [1]], ["E", [0]], ["A", [1]]]) {
    assert.deepEqual(afterRUnit.infer(head, features), beforeUnit.infer(head, features));
  }

  const path = join(dir, "R-only.json");
  await saveL2Profile(path, learnedR.profile);
  const reloadedR = await readL2Profile(path);
  for (const head of ["D", "E", "A"]) {
    assert.deepEqual(reloadedR.heads[head].parameters, before.profile.heads[head].parameters);
  }
  assert.deepEqual(reloadedR.heads.R.parameters, learnedR.profile.heads.R.parameters);

  const learnedD = await fitL2Mlp({
    ...input,
    rows: dRows,
    trainHeads: ["D"],
    initialProfile: reloadedR,
    learningRate: 0.3,
    epochs: 1200,
    stopCheckpoints: [1200],
  });
  const dReport = learnedD.report;
  assert.deepEqual(dReport.trainedHeads, ["D"]);
  assert.equal(dReport.initialization, "warm_start");
  assert.deepEqual(dReport.fittedByHead, { R: 0, D: 1, E: 0, A: 0 });
  assert.deepEqual(dReport.epochZero.R, { correct: 0, scored: 0 });
  assert.deepEqual(dReport.final.D, { correct: 1, scored: 1 });
  assert.equal(dReport.gradientProbe.checked, 2);
  assert.deepEqual(learnedD.profile.heads.R.parameters, learnedR.profile.heads.R.parameters);
  assert.notDeepEqual(learnedD.profile.heads.D.parameters, learnedR.profile.heads.D.parameters);
  for (const head of ["E", "A"]) {
    assert.deepEqual(learnedD.profile.heads[head].parameters, before.profile.heads[head].parameters);
  }
});

test("single-head stages probe two active parameters each and aggregate to eight", assetGated, async () => {
  const input = diagnosticInput({ epochs: 0, stopCheckpoints: [] });
  let total = 0;
  for (const head of L2_HEADS) {
    const headRows = input.rows.filter(row => row.head === head);
    const staged = await fitL2Mlp({ ...input, rows: headRows, trainHeads: [head] });
    assert.deepEqual(staged.report.trainedHeads, [head]);
    assert.equal(staged.report.gradientProbe.checked, 2);
    assert.equal(staged.report.gradientProbe.passed, true);
    assert.equal(staged.report.changedParameters, 0);
    total += staged.report.gradientProbe.checked;
  }
  assert.equal(total, 8);
});

test("fit is deterministic for one seed and a different seed changes initialization", assetGated, async () => {
  const input = diagnosticInput({ learningRate: 0.1, epochs: 2, stopCheckpoints: [2] });
  const first = await fitL2Mlp({ ...input, seed: 11 });
  const second = await fitL2Mlp({ ...input, seed: 11 });
  const third = await fitL2Mlp({ ...input, seed: 12 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first.profile, third.profile);
  const parameters = L2_HEADS.flatMap(head => first.profile.heads[head].parameters);
  assert.ok(parameters.every(Number.isFinite));
  assert.ok(parameters.some(value => value !== 0));
});

test("profiles save exclusively, reload, and infer in a fresh process", assetGated, async t => {
  const dir = await mkdtemp(join(tmpdir(), "nn-l2-mlp-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const input = diagnosticInput({ seed: 3, epochs: 0, stopCheckpoints: [] });
  const { profile } = await fitL2Mlp(input);
  const path = join(dir, "four-head.json");
  await saveL2Profile(path, profile);
  await assert.rejects(saveL2Profile(path, profile), /EEXIST|exists/i);
  const loaded = await readL2Profile(path);
  assert.deepEqual(loaded, validateL2Profile(profile));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), loaded);

  const unit = await createL2Unit(loaded, handwiredRoot);
  const head = "R";
  const features = [1, 0];
  const expected = unit.infer(head, features);
  const script = `
    const { readL2Profile, createL2Unit } = await import(process.env.L2_MODULE_URL);
    const profile = await readL2Profile(process.env.L2_PROFILE);
    const unit = await createL2Unit(profile, process.env.NN_HANDWIRED_ROOT);
    const prediction = unit.infer(process.env.L2_HEAD, JSON.parse(process.env.L2_FEATURES));
    console.log(JSON.stringify(prediction));
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      NN_HANDWIRED_ROOT: handwiredRoot,
      L2_MODULE_URL: moduleUrl,
      L2_PROFILE: path,
      L2_HEAD: head,
      L2_FEATURES: JSON.stringify(features),
    },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(stdout), expected);
});

test("missing and invalid profiles are rejected without a zero fallback", async t => {
  const dir = await mkdtemp(join(tmpdir(), "nn-l2-invalid-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(readL2Profile(join(dir, "absent.json")), /could not be read/);
  const invalidJson = join(dir, "invalid.json");
  await writeFile(invalidJson, "{ definitely not json", "utf8");
  await assert.rejects(readL2Profile(invalidJson), /not valid JSON/);

  assert.throws(() => validateL2Profile({}), /profile schema/);
  assert.throws(
    () => validateL2Profile({ ...minimalProfile(), schema: "nnanything.l2.mlp.v2" }),
    /schema/,
  );
  assert.throws(
    () => validateL2Profile({ ...minimalProfile(), calibration: "calibrated" }),
    /calibration must be uncalibrated/,
  );
  assert.throws(
    () => validateL2Profile({ ...minimalProfile(), adoption: "applied" }),
    /adoption must be not_applied/,
  );
  const missingHead = minimalProfile();
  delete missingHead.heads.A;
  assert.throws(() => validateL2Profile(missingHead), /profile\.heads\.A/);
  const extraHead = minimalProfile();
  extraHead.heads.X = extraHead.heads.A;
  assert.throws(() => validateL2Profile(extraHead), /unsupported head X/);
  const shortParameters = minimalProfile();
  shortParameters.heads.R.parameters = [];
  assert.throws(() => validateL2Profile(shortParameters), /must contain \d+ values/);
  const nonfiniteParameters = minimalProfile();
  nonfiniteParameters.heads.R.parameters[0] = Number.NaN;
  assert.throws(() => validateL2Profile(nonfiniteParameters), /finite number/);
  const zeroWidth = minimalProfile();
  zeroWidth.heads.R.spec.hidden = [0, 4];
  assert.throws(() => validateL2Profile(zeroWidth), /positive integer width/);

  await assert.rejects(createL2Unit(undefined, "/unused-backend"), /profile must be an object/);
  await assert.rejects(
    createL2Unit({ ...minimalProfile(), heads: { ...minimalProfile().heads, R: { ...minimalProfile().heads.R, parameters: [] } } }, "/unused-backend"),
    /must contain \d+ values/,
  );
  await assert.rejects(createL2Unit(minimalProfile(), "/unused-backend"), /Handwired core is missing/);
  await assert.rejects(saveL2Profile(join(dir, "never-written.json"), {}), /profile schema/);
  await assert.rejects(readFile(join(dir, "never-written.json")), /ENOENT/);
});

test("non-finite training state is reported with row and epoch context", assetGated, async () => {
  const input = diagnosticInput({ seed: 7, epochs: 0, stopCheckpoints: [] });
  const { profile } = await fitL2Mlp(input);
  const broken = structuredClone(profile);
  broken.heads.R.parameters[0] = 1e38;
  const rows = input.rows.map(row =>
    row.head === "R" && row.features[0] === 1 ? { ...row, features: [1e38, row.features[1]] } : row,
  );
  let failure;
  try {
    await fitL2Mlp({
      ...input,
      rows,
      epochs: 1,
      stopCheckpoints: [],
      initialProfile: broken,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /non-finite/);
  assert.match(failure.message, /head R/);
  assert.equal(failure.phase, "epoch_zero");
  assert.equal(failure.epochsCompleted, 0);
});
