import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repositoryRoot, "scripts/train-three-site.mjs");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

test("three-site consumer help exits without fitting", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--base-weight/);
  assert.match(result.stdout, /--gold-reference/);
  assert.match(result.stdout, /--objective priority_decision_v1/);
  assert.match(result.stdout, /--stop-when objective_feasible/);
});

test("three-site consumer preserves failure timing and completes the public workflow round-trip", async t => {
  const root = await mkdtemp(join(tmpdir(), "nnanything-three-site-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const training = await import("nnanything/training");
  const browser = await import("nnanything/browser-classify");
  const fixture = JSON.parse(await readFile(join(repositoryRoot, "playground/training/reviewed.fixture.json"), "utf8"));
  const source = training.readBasicKindTrainingRequest(fixture);
  const rows = source.rows
    .filter(row => row.review.status === "verified")
    .slice(0, 2)
    .map((row, index) => ({ ...row, inputRef: { ...row.inputRef, index } }));
  assert.ok(rows.length > 0, "reviewed fixture must contain verified rows");
  const request = training.readBasicKindTrainingRequest({
    schemaVersion: 1,
    taskId: "dom.basic-kinds.v1",
    rows,
  });
  const profile = structuredClone(browser.DEFAULT_BASIC_KIND_PROFILE);
  const asset = {
    targetOperator: "dom.basic_kinds",
    operatorVersion: "0.1.0",
    contractVersion: 1,
    taskId: "dom.basic-kinds.v1",
    profileId: profile.id,
    baseProfileId: profile.id,
    calibrated: false,
    compatibility: { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 },
    profile,
  };
  const inputPath = join(root, "request.json");
  const basePath = join(root, "base.weight.json");
  const backendPath = join(root, "empty-handwired");
  const outDir = join(root, "results");
  const weightsDir = join(root, "weights");
  await writeFile(inputPath, JSON.stringify(request));
  await writeFile(basePath, JSON.stringify(asset));
  await mkdir(backendPath);

  const result = await runCli([
    "--input", inputPath,
    "--base-weight", basePath,
    "--handwired-root", backendPath,
    "--out-dir", outDir,
    "--weights-dir", weightsDir,
    "--epochs", "1",
  ]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /partialTiming/);
  assert.match(output, /completedEpochs/);
  assert.match(output, /numeric-ui-core|handwired/i);
  const name = (await readdir(outDir)).find(name => name.endsWith('.failure.json'));
  assert.ok(name, output);
  const report = JSON.parse(await readFile(join(outDir, name), 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.partialTiming.completedEpochs, 0);
  assert.ok(report.partialTiming.backendLoadMs >= 0);
  assert.ok(report.partialTiming.fitTotalMs >= report.partialTiming.backendLoadMs);
  const success = await runCli([
    '--input', inputPath, '--base-weight', basePath,
    '--handwired-root', process.env.HANDWIRED_ROOT ?? '/Volumes/extension/code/handwired',
    '--out-dir', join(root, 'ok-results'), '--weights-dir', join(root, 'ok-weights'), '--epochs', '0',
  ]);
  assert.equal(success.status, 0, success.stderr || success.stdout);
  const receipt = JSON.parse(success.stdout);
  assert.equal(receipt.timing.completedEpochs, 0);
  const completed = JSON.parse(await readFile(receipt.reportPath, 'utf8'));
  assert.equal(completed.candidate.contractVersion, 2);
  assert.equal(completed.candidate.reloaded, true);
  assert.equal(completed.train.rows.length, rows.length);
  const warm = browser.parseBrowserWeightAsset(JSON.parse(await readFile(completed.candidate.warmBasePath, 'utf8')));
  assert.equal(warm.profile.familyWeights.control.nat_control_button, profile.familyWeights.control.nat_control_button);
  const decision = await runCli([
    '--input', inputPath, '--base-weight', basePath,
    '--handwired-root', process.env.HANDWIRED_ROOT ?? '/Volumes/extension/code/handwired',
    '--out-dir', join(root, 'decision-results'), '--weights-dir', join(root, 'decision-weights'),
    '--epochs', '0', '--objective', 'priority_decision_v1', '--stop-when', 'objective_feasible',
  ]);
  assert.equal(decision.status, 0, decision.stderr || decision.stdout);
  const decisionReceipt = JSON.parse(decision.stdout);
  const decisionReport = JSON.parse(await readFile(decisionReceipt.reportPath, 'utf8'));
  assert.equal(decisionReport.developmentAccepted, true);
  assert.equal(decisionReport.objective.mode, 'priority_decision_v1');
  assert.equal(decisionReport.stoppingReason, 'objective_feasible');
  assert.equal(decisionReport.timing.completedEpochs, 0);
  // Deliberately impossible synthetic supervision exercises rejection before gold.
  const wrongPath = join(root, 'wrong-request.json');
  await writeFile(wrongPath, JSON.stringify({ ...request, rows: rows.map(row => ({ ...row,
    review: { ...row.review, expectedLabel: 'image' },
  })) }));
  const rejected = await runCli([
    '--input', wrongPath, '--base-weight', basePath,
    '--handwired-root', process.env.HANDWIRED_ROOT ?? '/Volumes/extension/code/handwired',
    '--out-dir', join(root, 'reject-results'), '--weights-dir', join(root, 'reject-weights'),
    '--gold-reference', join(root, 'must-not-be-read.json'),
    '--epochs', '0', '--objective', 'priority_decision_v1', '--stop-when', 'objective_feasible',
  ]);
  assert.equal(rejected.status, 3, rejected.stderr || rejected.stdout);
  const rejectedReport = JSON.parse(await readFile(JSON.parse(rejected.stdout).reportPath, 'utf8'));
  assert.equal(rejectedReport.developmentAccepted, false);
  assert.equal(rejectedReport.goldEvaluation, null);
  assert.equal(rejectedReport.goldSkippedReason, 'development_rejected');
  assert.equal(rejectedReport.candidate.adoption, 'not_applied');
});
