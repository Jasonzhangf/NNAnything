import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const api = () => import("../dist/browser-single-action.js");

test("built-in samples keep three train families and one development family", async () => {
  const library = await api();
  const episodes = library.makeBrowserSingleActionSamples();
  assert.equal(episodes.length, 40);
  const train = episodes.filter(episode => episode.partition === "train");
  const development = episodes.filter(episode => episode.partition === "development");
  assert.equal(train.length, 30);
  assert.equal(development.length, 10);
  assert.equal(new Set(train.map(episode => episode.family)).size, 3);
  assert.equal(new Set(development.map(episode => episode.family)).size, 1);
  assert.equal(episodes.every(episode => episode.teacher.source === "synthetic_projection"), true);
  assert.equal(episodes.every(episode => episode.request.state.elements.some(element => element.ref === "control-disabled")), true);
});

test("partition rejects verification leakage and contradictory relation features", async () => {
  const library = await api();
  const episodes = library.makeBrowserSingleActionSamples();
  const leaked = structuredClone(episodes);
  leaked[0].partition = "verification";
  assert.throws(
    () => library.partitionBrowserSingleActionSamples(leaked),
    /rejects verification/,
  );

  const first = structuredClone(episodes[0]);
  const second = structuredClone(episodes[0]);
  second.id = `${second.id}-opposite`;
  second.teacher.providerRefs = [];
  second.teacher.capability = "DEFER";
  assert.throws(
    () => library.partitionBrowserSingleActionSamples([first, second, ...structuredClone(episodes.slice(1))]),
    /feature collision/,
  );
});

test("zero-epoch training writes an unapplied candidate and reports development failure", async () => {
  const library = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-single-action-training-"));
  try {
    const receipt = await library.runBrowserSingleActionTraining({
      episodes: library.makeBrowserSingleActionSamples(),
      handwiredRoot: "/backend/not-loaded-for-zero-epochs",
      outputDirectory: root,
      relationEpochs: 0,
      capabilityEpochs: 0,
      learningRate: 0.1,
    });
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.fullyVerified, false);
    assert.match(receipt.error, /development_cases_failed/);
    assert.equal(receipt.profile.calibration, "uncalibrated");
    assert.equal(receipt.profile.adoption, "not_applied");
    assert.equal(receipt.timing.trainableParamCount, 50);
    const saved = JSON.parse(await readFile(receipt.candidatePath, "utf8"));
    assert.deepEqual(saved, receipt.profile);
    const report = JSON.parse(await readFile(receipt.reportPath, "utf8"));
    assert.equal(report.accepted, false);
    assert.equal(report.verification.status, "not_provided");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("missing Handwired source fails explicitly with no candidate artifact", async () => {
  const library = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-single-action-missing-backend-"));
  try {
    await assert.rejects(
      library.runBrowserSingleActionTraining({
        episodes: library.makeBrowserSingleActionSamples(),
        handwiredRoot: join(root, "missing-handwired-root"),
        outputDirectory: join(root, "output"),
        relationEpochs: 1,
        capabilityEpochs: 1,
        learningRate: 0.1,
      }),
      /Handwired core is missing/,
    );
    await assert.rejects(
      readFile(join(root, "output", "candidate.json"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new-process evaluation API reads a saved profile but never fits", async () => {
  const library = await api();
  const profile = library.createZeroBrowserSingleActionProfile();
  const cases = structuredClone(library.makeBrowserSingleActionSamples().slice(30));
  for (const [index, episode] of cases.entries()) {
    episode.id = `verification-${index}`;
    episode.partition = "verification";
  }
  const evaluation = library.evaluateBrowserSingleActionCases(profile, cases);
  assert.equal(evaluation.count, 10);
  assert.equal(evaluation.failed, 10);
  assert.equal(evaluation.rows.every(row => row.partition === "verification"), true);
});

test("real fixed-budget Handwired training meets development cases", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit NN_HANDWIRED_ROOT",
}, async () => {
  const library = await api();
  const root = await mkdtemp(join(tmpdir(), "nn-single-action-fit-"));
  try {
    const receipt = await library.runBrowserSingleActionTraining({
      episodes: library.makeBrowserSingleActionSamples(),
      handwiredRoot: process.env.NN_HANDWIRED_ROOT,
      outputDirectory: root,
      relationEpochs: 200,
      capabilityEpochs: 200,
      learningRate: 0.1,
    });
    assert.equal(receipt.accepted, true, receipt.error ?? "training should meet development cases");
    assert.equal(receipt.timing.relationEpochs, 200);
    assert.equal(receipt.timing.capabilityEpochs, 200);
    assert.equal(receipt.profile.calibration, "uncalibrated");
    assert.equal(receipt.profile.adoption, "not_applied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
