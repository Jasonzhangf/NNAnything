import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildDefaultCliHybridPackage,
  createHybridPackageResource,
  E19_FEATURES,
  E_LABELS,
  expectedHeadParameterCount,
  HYBRID_CONTRACT_ERROR,
  loadHybridPackageFromFile,
  saveHybridPackageAtomic,
} from "../dist/training/l2-hybrid-package.js";
import { OLD_READ_12_COLUMNS } from "../dist/training/l2-standard-data-gate.js";
import { inferHead } from "../dist/training/l2-mlp-backend.js";
import {
  executeStandardRunner,
} from "../dist/training/l2-standard-runner.js";

const WORKTREE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HANDWIRED_ROOT = "/Volumes/extension/code/handwired";
const RUNNER_CLI_PATH = resolve(WORKTREE_ROOT, "dist/training/l2-standard-runner.js");

function makeDeterministicParams(count, seedOffset = 1) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const raw = Math.sin((i + 1) * 0.37 + seedOffset) * 0.25;
    out.push(Math.fround(raw === 0 ? 0.05 : raw));
  }
  return out;
}

function makeTinyBaseProfile() {
  const rSpec = {
    features: [
      "list.known",
      "list.execError",
      "name.matched",
      "name.absent",
      "type.known",
      "type.execError",
      "type.isRegular",
      "type.isNonRegular",
      "goal.isLiteral",
      "grep.present",
      "grep.execError",
      "grep.queryMatches",
      "grep.rawHit",
      "grep.rawCompleteNoMatch",
    ],
    labels: ["insufficient", "holds", "refuted"],
    hidden: [16, 16],
  };
  const dSpec = {
    features: Array.from({ length: 26 }, (_, idx) => `d_feat_${idx}`),
    labels: [
      "SEARCH_TARGET_S0",
      "READ_TARGET_S0",
      "RETURN_RESULT",
      "REPORT_NO_MATCH",
      "SEARCH_TARGET_S1",
      "READ_TARGET_S1",
      "SEARCH_LITERAL_S0",
      "SEARCH_LITERAL_S1",
    ],
    hidden: [16, 16],
  };
  const eSpec = {
    features: [...E19_FEATURES],
    labels: [...E_LABELS],
    hidden: [16, 16],
  };
  const aSpec = {
    features: [
      "goal.head",
      "goal.tail",
      "e.unsatisfied",
      "e.satisfied",
      "e.unknown",
      "goal.isLiteral",
    ],
    labels: ["head", "tail", "RETURN", "SEARCH_LITERAL"],
    hidden: [16, 16],
  };

  return {
    schema: "nnanything.l2.mlp.v1",
    calibration: "uncalibrated",
    adoption: "not_applied",
    heads: {
      R: { spec: rSpec, parameters: makeDeterministicParams(expectedHeadParameterCount(rSpec), 1) },
      D: { spec: dSpec, parameters: makeDeterministicParams(expectedHeadParameterCount(dSpec), 2) },
      E: { spec: eSpec, parameters: makeDeterministicParams(expectedHeadParameterCount(eSpec), 3) },
      A: { spec: aSpec, parameters: makeDeterministicParams(expectedHeadParameterCount(aSpec), 4) },
    },
  };
}

function makeTinyValidTrainJsonlRows() {
  // 2 literal fixed rows (literal absent -> unknown)
  // + 3 literal learned rows (including 2 identical-feature/identical-gold rows to verify
  // deduplicated projection aggregation)
  return [
    {
      sampleId: "row-fixed-literal-0",
      partition: "TRAIN",
      features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
      label: 2,
      labelName: "unknown",
    },
    {
      sampleId: "row-fixed-literal-1",
      partition: "TRAIN",
      features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
      label: 2,
      labelName: "unknown",
    },
    {
      sampleId: "row-learned-hit-2",
      partition: "TRAIN",
      features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 0],
      label: 1,
      labelName: "satisfied",
    },
    {
      sampleId: "row-learned-hit-dup-3",
      partition: "TRAIN",
      features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 0],
      label: 1,
      labelName: "satisfied",
    },
    {
      sampleId: "row-learned-nomatch-4",
      partition: "TRAIN",
      features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1],
      label: 0,
      labelName: "unsatisfied",
    },
  ];
}

test("Scenario 1 & 7: valid tiny TRAIN completes 2 updates, fresh OS-process reload, exact head isolation, and Handwired pre/MLP/post stage contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "std-runner-s1-"));
  try {
    const baseProfile = makeTinyBaseProfile();
    const basePkg = buildDefaultCliHybridPackage(baseProfile);
    const pkgPath = await saveHybridPackageAtomic(join(dir, "base-package.json"), basePkg);

    // Build tiny curated (read) + g3-derived (literal) TRAIN files
    const curatedRows = [
      {
        stateId: "cur-fixed-0",
        partition: "TRAIN",
        input: {
          "goal.head": 1,
          "goal.tail": 0,
          "goal.N/16": 0.5,
          "receipt.present": 0,
          "actual.head": 0,
          "actual.tail": 0,
          "execution.succeeded": 0,
          "execution.failed": 0,
          "execution.unknown": 0,
          "output.linesKnown": 0,
          "output.logicalLines/16": 0,
          "actual.N/16": 0,
        },
        supervision: { E: "unsatisfied" },
      },
      {
        stateId: "cur-learned-1",
        partition: "TRAIN",
        input: {
          "goal.head": 1,
          "goal.tail": 0,
          "goal.N/16": 0.5,
          "receipt.present": 1,
          "actual.head": 1,
          "actual.tail": 0,
          "execution.succeeded": 1,
          "execution.failed": 0,
          "execution.unknown": 0,
          "output.linesKnown": 1,
          "output.logicalLines/16": 0.5,
          "actual.N/16": 0.5,
        },
        supervision: { E: "satisfied" },
      },
    ];
    const curatedPath = join(dir, "curated.json");
    await writeFile(curatedPath, JSON.stringify(curatedRows, null, 2), "utf8");

    const g3Rows = makeTinyValidTrainJsonlRows().slice(1); // 1 literal fixed + 3 literal learned
    const g3Path = join(dir, "g3-train.jsonl");
    await writeFile(g3Path, `${g3Rows.map(r => JSON.stringify(r)).join("\n")}\n`, "utf8");

    const outDir = join(dir, "run-s1");
    const configPath = join(dir, "config-s1.json");
    const config = {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: outDir,
      computeBackend: "batch-cpu",
      trainSources: [
        {
          name: "tiny-curated-read",
          path: curatedPath,
          format: "curated-read-json",
          expectedPartition: "TRAIN",
        },
        {
          name: "tiny-g3-literal",
          path: g3Path,
          format: "g3-derived-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
      budget: {
        budgetSteps: 2,
        learningRate: 0.05,
        seed: 20261026,
        checkpointEverySteps: 1,
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    // Run via CLI in a fresh child OS process
    const cliRun = spawnSync(
      process.execPath,
      [RUNNER_CLI_PATH, "train", "--config", configPath],
      { encoding: "utf8" },
    );
    assert.equal(cliRun.status, 0, `CLI train failed: ${cliRun.stderr}`);

    const report = JSON.parse(await readFile(join(outDir, "run-report.json"), "utf8"));
    assert.equal(report.status, "completed");
    assert.equal(report.head, "E");
    assert.equal(report.phase, "posttraining");
    assert.equal(report.stepsThisInvocation, 2);
    assert.equal(report.stepsCumulative, 2);
    assert.equal(report.budgetSteps, 2);
    assert.equal(report.processedRows, 6);
    assert.equal(report.fixedRows, 2);
    assert.equal(report.learnedRows, 4);
    assert.equal(report.uniqueLearnedProjections, 3);
    assert.equal(report.headIsolation.frozenHeadsUnchanged, true);
    assert.ok(report.headIsolation.changedParameterCount > 0);
    assert.ok(report.wallSeconds >= report.optimizationSeconds);
    assert.ok(report.optimizationSeconds > 0);
    assert.ok(report.validationSeconds >= 0);
    assert.ok(report.loadSeconds >= 0);
    assert.ok(report.packageLoadSeconds > 0);
    assert.ok(report.backendLoadSeconds > 0);
    assert.equal(report.loadSeconds, report.packageLoadSeconds + report.backendLoadSeconds);
    assert.ok(report.checkpointIOSeconds >= 0);
    assert.ok(report.otherProcessOverheadSeconds >= 0);
    // Strictly mutually exclusive phases: sum of phases equals wallSeconds
    const phaseSum =
      report.validationSeconds
      + report.loadSeconds
      + report.optimizationSeconds
      + report.checkpointIOSeconds
      + report.evaluationSeconds
      + report.otherProcessOverheadSeconds;
    assert.ok(Math.abs(phaseSum - report.wallSeconds) < 1e-9);
    assert.ok(report.optimizationSeconds < report.loadSeconds);
    assert.ok(report.samplesPerSecond > 0);
    assert.ok(report.stepsPerSecond > 0);
    assert.ok(report.backend.recipeNote.includes("full_batch_sgd"));
    assert.ok(existsSync(join(outDir, "run-report.md")));

    const candidatePath = report.paths.candidatePackagePath;
    assert.ok(candidatePath && existsSync(candidatePath));

    // Fresh OS process reload check + Scenario 7 stage probes
    const probeScript = `
      import assert from "node:assert/strict";
      import {
        loadHybridPackageFromFile,
        createHybridPackageResource,
      } from ${JSON.stringify(resolve(WORKTREE_ROOT, "dist/training/l2-hybrid-package.js"))};
      import { inferHead } from ${JSON.stringify(resolve(WORKTREE_ROOT, "dist/training/l2-mlp-backend.js"))};

      const base = await loadHybridPackageFromFile(${JSON.stringify(pkgPath)}, ${JSON.stringify(HANDWIRED_ROOT)});
      const cand = await loadHybridPackageFromFile(${JSON.stringify(candidatePath)}, ${JSON.stringify(HANDWIRED_ROOT)});

      // R, D, A parameters and stages must be untouched
      for (const h of ["R", "D", "A"]) {
        assert.deepEqual(cand.package.heads[h].parameters, base.package.heads[h].parameters);
      }
      assert.notDeepEqual(cand.package.heads.E.parameters, base.package.heads.E.parameters);
      assert.deepEqual(cand.package.stages, base.package.stages);

      // Read absent -> fixed [1,0,0] ("unsatisfied")
      const rAbsent = cand.inferE({
        goal: { kind: "gcm.read" },
        features19: [1,0,0.5,0, 0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0],
        receiptFact: { known: true, present: false },
      });
      assert.equal(rAbsent.fixed, true);
      assert.equal(rAbsent.readGate, 1);
      assert.equal(rAbsent.literalGate, 0);
      assert.deepEqual(rAbsent.logits, [1, 0, 0]);
      assert.equal(rAbsent.label, "unsatisfied");

      // Literal absent -> fixed [0,0,1] ("unknown")
      const lAbsent = cand.inferE({
        goal: { kind: "g3.literal-search" },
        features19: [0,0,0,0, 0,0,0,0,0,0,0,0, 1,0,0,0,0,0,0],
        receiptFact: { known: true, present: false },
      });
      assert.equal(lAbsent.fixed, true);
      assert.equal(lAbsent.readGate, 0);
      assert.equal(lAbsent.literalGate, 1);
      assert.deepEqual(lAbsent.logits, [0, 0, 1]);
      assert.equal(lAbsent.label, "unknown");

      // Both read present and literal present share the same E MLP and match raw inferHead
      const rPresentVec = [1,0,0.5,1, 1,0,1,0,0,1,0.5,0.5, 0,0,0,0,0,0,0];
      const rPresent = cand.inferE({
        goal: { kind: "gcm.read" },
        features19: rPresentVec,
        receiptFact: { known: true, present: true },
      });
      const rRaw = inferHead(cand.profile, "E", rPresentVec);
      assert.equal(rPresent.fixed, false);
      assert.deepEqual(rPresent.logits, rRaw.logits);
      assert.equal(rPresent.label, rRaw.label);

      const lPresentVec = [0,0,0,0, 0,0,0,0,0,0,0,0, 1,1,1,0,1,1,0];
      const lPresent = cand.inferE({
        goal: { kind: "g3.literal-search" },
        features19: lPresentVec,
        receiptFact: { known: true, present: true },
      });
      const lRaw = inferHead(cand.profile, "E", lPresentVec);
      assert.equal(lPresent.fixed, false);
      assert.deepEqual(lPresent.logits, lRaw.logits);
      assert.equal(lPresent.label, lRaw.label);

      // Unknown receiptFact disables both gates and returns raw MLP output
      const unkFact = cand.inferE({
        goal: { kind: "gcm.read" },
        features19: [1,0,0.5,0, 0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0],
        receiptFact: { known: false, present: null },
      });
      const unkRaw = inferHead(cand.profile, "E", [1,0,0.5,0, 0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0]);
      assert.equal(unkFact.fixed, false);
      assert.deepEqual(unkFact.logits, unkRaw.logits);

      // Temporary stage score modification changes gated output
      const altPkg = structuredClone(cand.package);
      altPkg.annotations.fixed_rule_scores.read_no_receipt = [0, 5, 0];
      for (const op of altPkg.stages[2].operations) {
        if (op.id === "readNoReceipt0") op.value = 0;
        if (op.id === "readNoReceipt1") op.value = 5;
        if (op.id === "readNoReceipt2") op.value = 0;
      }
      const altRes = await createHybridPackageResource(altPkg, ${JSON.stringify(HANDWIRED_ROOT)});
      const altOut = altRes.inferE({
        goal: { kind: "gcm.read" },
        features19: [1,0,0.5,0, 0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0],
        receiptFact: { known: true, present: false },
      });
      assert.deepEqual(altOut.logits, [0, 5, 0]);
      assert.equal(altOut.label, "satisfied");

      // Disconnected wire in stage fails explicitly with HYBRID_CONTRACT_ERROR
      const brokenPkg = structuredClone(cand.package);
      brokenPkg.stages[2].outputNames.final0 = "missing_wire_id";
      await assert.rejects(
        () => createHybridPackageResource(brokenPkg, ${JSON.stringify(HANDWIRED_ROOT)}),
        err => err.code === ${JSON.stringify(HYBRID_CONTRACT_ERROR)},
      );
    `;
    const reloadChild = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", probeScript],
      { encoding: "utf8" },
    );
    assert.equal(reloadChild.status, 0, `Fresh-process reload failed: ${reloadChild.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 2: wrong partition, bad feature order/width, fixed/gold contradiction, or same-feature gold conflict => DATA_INVALID with 0 steps and no candidate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "std-runner-s2-"));
  try {
    const pkgPath = await saveHybridPackageAtomic(
      join(dir, "base-package.json"),
      buildDefaultCliHybridPackage(makeTinyBaseProfile()),
    );

    // 2a: Wrong partition (DEV row inside dedicated TRAIN JSONL)
    const wrongPartPath = join(dir, "wrong-partition.jsonl");
    await writeFile(
      wrongPartPath,
      `${JSON.stringify({
        sampleId: "bad-dev-row",
        partition: "DEV",
        features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 0],
        label: 1,
        labelName: "satisfied",
      })}\n`,
      "utf8",
    );
    const out2a = join(dir, "out-2a");
    const res2a = await executeStandardRunner("train", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: out2a,
      trainSources: [
        {
          name: "wrong-part",
          path: wrongPartPath,
          format: "g3-derived-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
      budget: { budgetSteps: 2, learningRate: 0.05, seed: 1 },
    });
    assert.equal(res2a.exitCode, 1);
    assert.equal(res2a.report.status, "DATA_INVALID");
    assert.equal(res2a.report.stepsThisInvocation, 0);
    assert.equal(res2a.report.optimizationSeconds, 0);
    assert.equal(res2a.report.error?.rowId, "bad-dev-row");
    assert.equal(res2a.report.paths.candidatePackagePath, null);
    assert.equal(existsSync(join(out2a, "candidate-hybrid-package.json")), false);

    // 2b: Contradictory no-receipt gold (read absent where Handwired rule outputs "unsatisfied", but gold is "satisfied")
    const contraPath = join(dir, "contradictory-gold.json");
    const badCuratedObj = {};
    for (const col of OLD_READ_12_COLUMNS) badCuratedObj[col] = 0;
    badCuratedObj["goal.head"] = 1;
    badCuratedObj["receipt.present"] = 0; // absent!
    await writeFile(
      contraPath,
      JSON.stringify([
        {
          stateId: "contra-no-receipt-row",
          partition: "TRAIN",
          input: badCuratedObj,
          supervision: { E: "satisfied" }, // contradicts fixed rule "unsatisfied"!
        },
      ]),
      "utf8",
    );
    const out2b = join(dir, "out-2b");
    const res2b = await executeStandardRunner("train", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: out2b,
      trainSources: [
        {
          name: "contra-curated",
          path: contraPath,
          format: "curated-read-json",
          expectedPartition: "TRAIN",
        },
      ],
      budget: { budgetSteps: 2, learningRate: 0.05, seed: 1 },
    });
    assert.equal(res2b.exitCode, 1);
    assert.equal(res2b.report.status, "DATA_INVALID");
    assert.equal(res2b.report.stepsThisInvocation, 0);
    assert.equal(res2b.report.optimizationSeconds, 0);
    assert.equal(res2b.report.error?.rowId, "contra-no-receipt-row");
    assert.equal(res2b.report.error?.rowIndex, 0);
    assert.match(res2b.report.error?.reason ?? "", /contradicts semanticGold/);
    assert.equal(existsSync(join(out2b, "candidate-hybrid-package.json")), false);

    // 2c: Conflicting gold on identical learned features
    const conflictLearnedPath = join(dir, "conflict-learned.jsonl");
    const vec = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 0];
    await writeFile(
      conflictLearnedPath,
      [
        JSON.stringify({ sampleId: "learn-a", partition: "TRAIN", features: vec, label: 1, labelName: "satisfied" }),
        JSON.stringify({ sampleId: "learn-b", partition: "TRAIN", features: vec, label: 0, labelName: "unsatisfied" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out2c = join(dir, "out-2c");
    const res2c = await executeStandardRunner("train", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: out2c,
      trainSources: [
        {
          name: "conflict-learned",
          path: conflictLearnedPath,
          format: "g3-derived-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
      budget: { budgetSteps: 2, learningRate: 0.05, seed: 1 },
    });
    assert.equal(res2c.exitCode, 1);
    assert.equal(res2c.report.status, "DATA_INVALID");
    assert.equal(res2c.report.error?.rowId, "learn-b");
    assert.match(res2c.report.error?.reason ?? "", /conflicting learned gold/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 3 & 4: 4 updates continuous vs 2+resume 2 parameter/loss parity, and mid-run cancel at step 2 + resume to 4 without fabricated completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "std-runner-s34-"));
  try {
    const pkgPath = await saveHybridPackageAtomic(
      join(dir, "base-package.json"),
      buildDefaultCliHybridPackage(makeTinyBaseProfile()),
    );
    const trainPath = join(dir, "tiny-train.jsonl");
    await writeFile(
      trainPath,
      `${makeTinyValidTrainJsonlRows().map(r => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );

    const sources = [
      {
        name: "tiny-g3",
        path: trainPath,
        format: "g3-derived-jsonl",
        expectedPartition: "TRAIN",
      },
    ];

    // Run A: 4 updates continuous
    const outContinuous = join(dir, "run-continuous-4");
    const resCont = await executeStandardRunner("train", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: outContinuous,
      computeBackend: "batch-cpu",
      trainSources: sources,
      budget: {
        budgetSteps: 4,
        learningRate: 0.05,
        seed: 20261026,
        checkpointEverySteps: 1,
      },
    });
    assert.equal(resCont.exitCode, 0);
    assert.equal(resCont.report.status, "completed");
    assert.equal(resCont.report.stepsThisInvocation, 4);
    assert.equal(resCont.report.stepsCumulative, 4);

    // Run B: 2 updates bounded + resume 2 updates
    const outSplit = join(dir, "run-split-2plus2");
    const ckptSplit = join(outSplit, "checkpoint.json");
    const resPart1 = await executeStandardRunner("train", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: outSplit,
      checkpointPath: ckptSplit,
      computeBackend: "batch-cpu",
      trainSources: sources,
      budget: {
        budgetSteps: 4,
        updatesThisRun: 2,
        learningRate: 0.05,
        seed: 20261026,
        checkpointEverySteps: 1,
      },
    });
    assert.equal(resPart1.exitCode, 0);
    assert.equal(resPart1.report.status, "paused_or_cancelled");
    assert.equal(resPart1.report.stepsThisInvocation, 2);
    assert.equal(resPart1.report.stepsCumulative, 2);
    assert.equal(resPart1.report.budgetSteps, 4);
    assert.equal(resPart1.report.paths.candidatePackagePath, null);
    assert.equal(existsSync(join(outSplit, "candidate-hybrid-package.json")), false);

    const resPart2 = await executeStandardRunner("resume", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: outSplit,
      checkpointPath: ckptSplit,
      computeBackend: "batch-cpu",
      trainSources: sources,
      budget: {
        budgetSteps: 4,
        learningRate: 0.05,
        seed: 20261026,
        checkpointEverySteps: 1,
      },
    });
    assert.equal(resPart2.exitCode, 0);
    assert.equal(resPart2.report.status, "completed");
    assert.equal(resPart2.report.resumedFromStep, 2);
    assert.equal(resPart2.report.stepsThisInvocation, 2);
    assert.equal(resPart2.report.stepsCumulative, 4);
    assert.equal(resPart2.report.budgetSteps, 4);
    assert.ok(resPart2.report.previousOptimizationSeconds > 0);
    assert.ok(resPart2.report.optimizationSeconds > 0);
    assert.equal(
      resPart2.report.cumulativeOptimizationSeconds,
      resPart2.report.previousOptimizationSeconds + resPart2.report.optimizationSeconds,
    );

    const contPkg = JSON.parse(await readFile(resCont.report.paths.candidatePackagePath, "utf8"));
    const splitPkg = JSON.parse(await readFile(resPart2.report.paths.candidatePackagePath, "utf8"));
    assert.deepEqual(splitPkg.heads.E.parameters, contPkg.heads.E.parameters);

    const contCkpt = JSON.parse(await readFile(resCont.report.paths.checkpointPath, "utf8"));
    const splitCkpt = JSON.parse(await readFile(ckptSplit, "utf8"));
    assert.deepEqual(splitCkpt.trajectory, contCkpt.trajectory);

    // Scenario 4: Cancel after committed step 2 via real caller AbortSignal (not updatesThisRun), then resume
    const outCancel = join(dir, "run-cancel-resume");
    const ckptCancel = join(outCancel, "checkpoint.json");
    const realCancelController = new AbortController();
    const resCancel = await executeStandardRunner(
      "train",
      {
        schema: "nnanything.l2.standard-runner-config.v1",
        head: "E",
        phase: "posttraining",
        handwiredRoot: HANDWIRED_ROOT,
        inputPackagePath: pkgPath,
        outputDir: outCancel,
        checkpointPath: ckptCancel,
        computeBackend: "batch-cpu",
        trainSources: sources,
        budget: {
          budgetSteps: 4,
          learningRate: 0.05,
          seed: 20261026,
          checkpointEverySteps: 1,
        },
      },
      {
        signal: realCancelController.signal,
        onProgress: event => {
          if (event.type === "step" && event.completedUpdates >= 2) {
            realCancelController.abort();
          }
        },
      },
    );
    assert.equal(resCancel.exitCode, 0);
    assert.equal(resCancel.report.status, "paused_or_cancelled");
    assert.equal(resCancel.report.stopReason, "controlled_cancel");
    assert.equal(resCancel.report.stepsCumulative, 2);
    assert.equal(resCancel.report.paths.candidatePackagePath, null);
    assert.equal(existsSync(join(outCancel, "candidate-hybrid-package.json")), false);
    assert.equal(existsSync(ckptCancel), true);

    const resCancelResume = await executeStandardRunner("resume", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: outCancel,
      checkpointPath: ckptCancel,
      computeBackend: "batch-cpu",
      trainSources: sources,
      budget: {
        budgetSteps: 4,
        learningRate: 0.05,
        seed: 20261026,
        checkpointEverySteps: 1,
      },
    });
    assert.equal(resCancelResume.exitCode, 0);
    assert.equal(resCancelResume.report.status, "completed");
    assert.equal(resCancelResume.report.resumedFromStep, 2);
    assert.equal(resCancelResume.report.stepsThisInvocation, 2);
    assert.equal(resCancelResume.report.stepsCumulative, 4);
    const cancelResumedPkg = JSON.parse(
      await readFile(resCancelResume.report.paths.candidatePackagePath, "utf8"),
    );
    assert.deepEqual(cancelResumedPkg.heads.E.parameters, contPkg.heads.E.parameters);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 5 & 6: empty learned subset returns NO_LEARNED_ROWS with 0 updates; separate evaluator does not mutate package and retains unresolved/failed rows in denominator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "std-runner-s56-"));
  try {
    const pkgPath = await saveHybridPackageAtomic(
      join(dir, "base-package.json"),
      buildDefaultCliHybridPackage(makeTinyBaseProfile()),
    );

    // Scenario 5: Only fixed rows (known absent read + known absent literal)
    const fixedOnlyPath = join(dir, "fixed-only.jsonl");
    await writeFile(
      fixedOnlyPath,
      `${makeTinyValidTrainJsonlRows().slice(0, 2).map(r => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );
    const outS5 = join(dir, "out-s5");
    const resS5 = await executeStandardRunner("train", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: outS5,
      trainSources: [
        {
          name: "fixed-only",
          path: fixedOnlyPath,
          format: "g3-derived-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
      budget: { budgetSteps: 2, learningRate: 0.05, seed: 1 },
    });
    assert.equal(resS5.exitCode, 0);
    assert.equal(resS5.report.status, "NO_LEARNED_ROWS");
    assert.equal(resS5.report.stopReason, "NO_LEARNED_ROWS");
    assert.equal(resS5.report.stepsThisInvocation, 0);
    assert.equal(resS5.report.optimizationSeconds, 0);
    assert.equal(resS5.report.fixedRows, 2);
    assert.equal(resS5.report.learnedRows, 0);
    assert.equal(resS5.report.paths.candidatePackagePath, null);
    assert.equal(existsSync(join(outS5, "candidate-hybrid-package.json")), false);

    // Scenario 6: Separate evaluator on DEV rows (including 1 fixed, 2 learned where 1 fails, and 1 unresolved row)
    const evalUnifiedPath = join(dir, "eval-dev.jsonl");
    const evalRows = [
      {
        sourceRef: { file: "dev-src", rowIndex: 0, originalId: "dev-fixed-0" },
        head: "E",
        partition: "DEV",
        originalRow: {},
        originalFeatures: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
        mlpFeatures19: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
        semanticGold: "unknown",
        ruleProfile: "cli.hybrid-package.v1",
        family: "literal",
        receiptFact: { known: true, present: false },
        expectedGate: { read: 0, literal: 1 },
        supervisionRoute: "fixed",
        unresolvedReason: null,
      },
      {
        sourceRef: { file: "dev-src", rowIndex: 1, originalId: "dev-learned-1" },
        head: "E",
        partition: "DEV",
        originalRow: {},
        originalFeatures: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 0],
        mlpFeatures19: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 0],
        semanticGold: "satisfied",
        ruleProfile: "cli.hybrid-package.v1",
        family: "literal",
        receiptFact: { known: true, present: true },
        expectedGate: { read: 0, literal: 0 },
        supervisionRoute: "learned",
        unresolvedReason: null,
      },
      {
        sourceRef: { file: "dev-src", rowIndex: 2, originalId: "dev-learned-2" },
        head: "E",
        partition: "DEV",
        originalRow: {},
        // Same features as row 1, so one of {satisfied, unsatisfied} is guaranteed to be a wrong prediction!
        originalFeatures: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1],
        mlpFeatures19: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1],
        semanticGold: "unknown",
        ruleProfile: "cli.hybrid-package.v1",
        family: "literal",
        receiptFact: { known: true, present: true },
        expectedGate: { read: 0, literal: 0 },
        supervisionRoute: "learned",
        unresolvedReason: null,
      },
      {
        sourceRef: { file: "dev-src", rowIndex: 3, originalId: "dev-unresolved-3" },
        head: "E",
        partition: "DEV",
        originalRow: {},
        originalFeatures: [1, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        mlpFeatures19: [1, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        semanticGold: "unsatisfied",
        ruleProfile: "cli.hybrid-package.v1",
        family: "read",
        receiptFact: { known: false, present: null },
        expectedGate: { read: 0, literal: 0 },
        supervisionRoute: "learned",
        unresolvedReason: "missing source receipt knownness contract",
      },
    ];
    await writeFile(
      evalUnifiedPath,
      `${evalRows.map(r => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );

    const beforeBytes = await readFile(pkgPath, "utf8");
    const outS6 = join(dir, "out-s6");
    const resS6 = await executeStandardRunner("evaluate", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "evaluation",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: outS6,
      evalSources: [
        {
          name: "dev-eval",
          path: evalUnifiedPath,
          format: "hybrid-unified-jsonl",
          expectedPartition: "DEV",
        },
      ],
    });
    const afterBytes = await readFile(pkgPath, "utf8");
    assert.equal(beforeBytes, afterBytes);
    assert.equal(resS6.exitCode, 0);
    assert.equal(resS6.report.status, "not_trained");
    assert.equal(resS6.report.optimizationSeconds, 0);
    assert.equal(resS6.report.stepsThisInvocation, 0);
    assert.ok(resS6.report.evaluation);
    assert.equal(resS6.report.evaluation.packageImmutableVerified, true);
    assert.equal(resS6.report.evaluation.fixed.total, 1);
    assert.equal(resS6.report.evaluation.fixed.correct, 1);
    assert.equal(resS6.report.evaluation.learned.total, 2);
    assert.equal(resS6.report.evaluation.unresolved.total, 1);
    assert.equal(resS6.report.evaluation.unresolved.status, "unassessable_retained_in_denominator");
    assert.deepEqual(resS6.report.evaluation.unresolved.rowIds, ["dev-unresolved-3"]);
    // Overall denominator MUST include fixed (1) + learned (2) + unresolved (1) = 4!
    assert.equal(resS6.report.evaluation.overallDenominator, 4);

    // Scenario 6b: Evaluate on a fixed-only dataset (learnedRows === 0, fixedRows > 0) must still run evaluation!
    const evalFixedOnlyPath = join(dir, "eval-fixed-only.jsonl");
    await writeFile(evalFixedOnlyPath, `${JSON.stringify(evalRows[0])}\n`, "utf8");
    const outS6b = join(dir, "out-s6b-fixed-only");
    const resS6b = await executeStandardRunner("evaluate", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "evaluation",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: outS6b,
      evalSources: [
        {
          name: "dev-fixed-only",
          path: evalFixedOnlyPath,
          format: "hybrid-unified-jsonl",
          expectedPartition: "DEV",
        },
      ],
    });
    assert.equal(resS6b.exitCode, 0);
    assert.equal(resS6b.report.status, "not_trained");
    assert.equal(resS6b.report.stopReason, "evaluation_only");
    assert.ok(resS6b.report.evaluation);
    assert.equal(resS6b.report.evaluation.fixed.total, 1);
    assert.equal(resS6b.report.evaluation.fixed.correct, 1);
    assert.equal(resS6b.report.evaluation.fixed.status, "evaluated");
    assert.equal(resS6b.report.evaluation.fixed.accuracy, 1);
    assert.equal(resS6b.report.evaluation.learned.total, 0);
    assert.equal(resS6b.report.evaluation.learned.status, "not_applicable");
    assert.equal(resS6b.report.evaluation.learned.accuracy, null);
    assert.equal(resS6b.report.evaluation.overallDenominator, 1);
    assert.equal(resS6b.report.evaluation.overallCorrect, 1);
    assert.equal(resS6b.report.evaluation.overallAccuracy, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Sample structural migration converter (convert-samples) and validate-data CLI command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "std-runner-conv-"));
  try {
    const pkgPath = await saveHybridPackageAtomic(
      join(dir, "base-package.json"),
      buildDefaultCliHybridPackage(makeTinyBaseProfile()),
    );

    // 1. Curated multi-partition file (contains 1 TRAIN fixed, 1 TRAIN learned, 1 DEV fixed)
    const curatedPath = join(dir, "curated.json");
    await writeFile(
      curatedPath,
      JSON.stringify([
        {
          stateId: "c-train-fixed",
          partition: "TRAIN",
          input: {
            "goal.head": 1,
            "goal.tail": 0,
            "goal.N/16": 0.5,
            "receipt.present": 0,
            "actual.head": 0,
            "actual.tail": 0,
            "execution.succeeded": 0,
            "execution.failed": 0,
            "execution.unknown": 0,
            "output.linesKnown": 0,
            "output.logicalLines/16": 0,
            "actual.N/16": 0,
          },
          supervision: { E: "unsatisfied" },
        },
        {
          stateId: "c-dev-skipped",
          partition: "DEV",
          input: {
            "goal.head": 0,
            "goal.tail": 1,
            "goal.N/16": 0.5,
            "receipt.present": 0,
            "actual.head": 0,
            "actual.tail": 0,
            "execution.succeeded": 0,
            "execution.failed": 0,
            "execution.unknown": 0,
            "output.linesKnown": 0,
            "output.logicalLines/16": 0,
            "actual.N/16": 0,
          },
          supervision: { E: "unsatisfied" },
        },
        {
          stateId: "c-train-learned",
          partition: "TRAIN",
          input: {
            "goal.head": 1,
            "goal.tail": 0,
            "goal.N/16": 0.5,
            "receipt.present": 1,
            "actual.head": 1,
            "actual.tail": 0,
            "execution.succeeded": 1,
            "execution.failed": 0,
            "execution.unknown": 0,
            "output.linesKnown": 1,
            "output.logicalLines/16": 0.5,
            "actual.N/16": 0.5,
          },
          supervision: { E: "satisfied" },
        },
      ]),
      "utf8",
    );

    // 2. Incremental 12-column array file
    const incPath = join(dir, "incremental.json");
    await writeFile(
      incPath,
      JSON.stringify([
        {
          episode: "ep-inc-0",
          partition: "TRAIN",
          input: [0, 1, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          E: "unsatisfied",
        },
        {
          episode: "ep-inc-1",
          partition: "TRAIN",
          input: [0, 1, 0.25, 1, 0, 1, 1, 0, 0, 1, 0.25, 0.25],
          E: "satisfied",
        },
      ]),
      "utf8",
    );

    // 3. G3 derived 19-column JSONL (including old-query O row where grep.present=1 and grep.queryMatches=0 -> learned!)
    const g3Path = join(dir, "g3.jsonl");
    await writeFile(
      g3Path,
      [
        JSON.stringify({
          sampleId: "g3-absent-0",
          partition: "TRAIN",
          features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
          label: 2,
          labelName: "unknown",
        }),
        JSON.stringify({
          sampleId: "g3-old-query-1",
          partition: "TRAIN",
          features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 0],
          label: 2,
          labelName: "unknown",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const outConv = join(dir, "out-conv");
    const convJsonlPath = join(outConv, "converted.jsonl");
    const resConv = await executeStandardRunner("convert-samples", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "sample_migration",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: outConv,
      convertedJsonlPath: convJsonlPath,
      trainSources: [
        {
          name: "curated",
          path: curatedPath,
          format: "curated-read-json",
          expectedPartition: "TRAIN",
        },
        {
          name: "incremental",
          path: incPath,
          format: "incremental-read-json",
          expectedPartition: "TRAIN",
        },
        {
          name: "g3",
          path: g3Path,
          format: "g3-derived-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
    });
    assert.equal(resConv.exitCode, 0);
    assert.equal(resConv.report.status, "not_trained");
    assert.equal(resConv.report.optimizationSeconds, 0);
    assert.equal(resConv.report.processedRows, 6);
    assert.equal(resConv.report.fixedRows, 3);
    assert.equal(resConv.report.learnedRows, 3);
    assert.equal(existsSync(convJsonlPath), true);

    const migratedLines = (await readFile(convJsonlPath, "utf8"))
      .trim()
      .split("\n")
      .map(l => JSON.parse(l));
    assert.equal(migratedLines.length, 6);
    // Verify curated rowIndex preserved across skipped DEV row (index 0 and index 2!)
    assert.equal(migratedLines[0].sourceRef.rowIndex, 0);
    assert.equal(migratedLines[0].originalFeatures.length, 12);
    assert.equal(migratedLines[0].mlpFeatures19.length, 19);
    assert.equal(migratedLines[0].supervisionRoute, "fixed");
    assert.equal(migratedLines[1].sourceRef.rowIndex, 2);
    assert.equal(migratedLines[1].supervisionRoute, "learned");
    // Verify old-query literal O row has receipt present and remains learned, not forced absent!
    const oldQueryRow = migratedLines.find(r => r.sourceRef.originalId === "g3-old-query-1");
    assert.ok(oldQueryRow);
    assert.deepEqual(oldQueryRow.receiptFact, { known: true, present: true });
    assert.deepEqual(oldQueryRow.expectedGate, { read: 0, literal: 0 });
    assert.equal(oldQueryRow.supervisionRoute, "learned");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Scenario 9: P1 regressions — Head E head-rows-jsonl semantic gate, candidate preservation on DATA_INVALID, and mid-run backend failure accounting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "std-runner-s9-"));
  try {
    const pkgPath = await saveHybridPackageAtomic(
      join(dir, "base-package.json"),
      buildDefaultCliHybridPackage(makeTinyBaseProfile()),
    );
    const originalBaseBytes = await readFile(pkgPath, "utf8");

    // 9a (Finding 1): Generic format "head-rows-jsonl" is directly rejected for Head E
    // so it can never bypass Head E's knownness/fixed-gold gate; R/D/A reject supervisionRoute !== "learned".
    const eGenericHeadRowsPath = join(dir, "e-generic-head-rows.jsonl");
    await writeFile(
      eGenericHeadRowsPath,
      `${JSON.stringify({
        id: "e-bypass-attempt",
        partition: "TRAIN",
        head: "E",
        features: [1, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        gold: "satisfied",
      })}\n`,
      "utf8",
    );
    const out9a1 = join(dir, "out-9a1");
    const res9a1 = await executeStandardRunner("train", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: out9a1,
      trainSources: [
        {
          name: "e-generic-head-rows",
          path: eGenericHeadRowsPath,
          format: "head-rows-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
      budget: { budgetSteps: 2, learningRate: 0.05, seed: 1 },
    });
    assert.equal(res9a1.exitCode, 1);
    assert.equal(res9a1.report.status, "DATA_INVALID");
    assert.equal(res9a1.report.stepsThisInvocation, 0);
    assert.equal(existsSync(join(out9a1, "candidate-hybrid-package.json")), false);
    assert.match(res9a1.report.error?.reason ?? "", /head E does not support generic format "head-rows-jsonl"/);

    // Case 2: Non-E head (R) with supervisionRoute="fixed" -> DATA_INVALID
    const rBadRoutePath = join(dir, "r-bad-route.jsonl");
    await writeFile(
      rBadRoutePath,
      `${JSON.stringify({
        id: "r-fixed-route",
        partition: "TRAIN",
        head: "R",
        supervisionRoute: "fixed",
        features: new Array(14).fill(0.1),
        gold: "insufficient",
      })}\n`,
      "utf8",
    );
    const res9a3 = await executeStandardRunner("validate-data", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "R",
      phase: "validation",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: join(dir, "out-9a3"),
      sources: [
        {
          name: "r-bad-route",
          path: rBadRoutePath,
          format: "head-rows-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
    });
    assert.equal(res9a3.exitCode, 1);
    assert.equal(res9a3.report.status, "DATA_INVALID");
    assert.match(res9a3.report.error?.reason ?? "", /supervisionRoute/);

    // 9b (Finding 2): Existing candidate package and inputPackagePath are never deleted on DATA_INVALID
    // in evaluate, validate-data, or train!
    const existingCandPath = await saveHybridPackageAtomic(
      join(dir, "existing-candidate.json"),
      buildDefaultCliHybridPackage(makeTinyBaseProfile()),
    );
    const existingCandBytes = await readFile(existingCandPath, "utf8");

    const res9bEval = await executeStandardRunner("evaluate", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "evaluation",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: existingCandPath,
      candidatePackagePath: existingCandPath,
      outputDir: join(dir, "out-9b-eval"),
      evalSources: [
        {
          name: "e-generic-head-rows",
          path: eGenericHeadRowsPath,
          format: "head-rows-jsonl",
          expectedPartition: "DEV",
        },
      ],
    });
    assert.equal(res9bEval.exitCode, 1);
    assert.equal(res9bEval.report.status, "DATA_INVALID");
    assert.equal(existsSync(existingCandPath), true);
    assert.equal(await readFile(existingCandPath, "utf8"), existingCandBytes);

    const res9bVal = await executeStandardRunner("validate-data", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "validation",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      candidatePackagePath: existingCandPath,
      outputDir: join(dir, "out-9b-val"),
      sources: [
        {
          name: "e-generic-head-rows",
          path: eGenericHeadRowsPath,
          format: "head-rows-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
    });
    assert.equal(res9bVal.exitCode, 1);
    assert.equal(res9bVal.report.status, "DATA_INVALID");
    assert.equal(existsSync(existingCandPath), true);
    assert.equal(await readFile(existingCandPath, "utf8"), existingCandBytes);

    const res9bTrain = await executeStandardRunner("train", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      candidatePackagePath: existingCandPath,
      outputDir: join(dir, "out-9b-train"),
      trainSources: [
        {
          name: "e-generic-head-rows",
          path: eGenericHeadRowsPath,
          format: "head-rows-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
      budget: { budgetSteps: 2, learningRate: 0.05, seed: 1 },
    });
    assert.equal(res9bTrain.exitCode, 1);
    assert.equal(res9bTrain.report.status, "DATA_INVALID");
    assert.equal(existsSync(existingCandPath), true);
    assert.equal(await readFile(existingCandPath, "utf8"), existingCandBytes);
    assert.equal(await readFile(pkgPath, "utf8"), originalBaseBytes);

    // 9c (Finding 3): Backend failure after completing updates retains typed completedUpdates
    // and lastPersistedStep boundaries, reports measured optimizationSeconds and null for unavailable
    // metrics, and resume starts from lastPersistedStep without double-counting replayed steps while
    // preserving failed-attempt compute time!
    const validELearnedPath = join(dir, "valid-e-learned.jsonl");
    await writeFile(
      validELearnedPath,
      [
        JSON.stringify({
          sampleId: "g3-learned-1",
          partition: "TRAIN",
          features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 0],
          label: 1,
          labelName: "satisfied",
        }),
        JSON.stringify({
          sampleId: "g3-learned-2",
          partition: "TRAIN",
          features: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 0],
          label: 2,
          labelName: "unknown",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    // 9c (Finding 3): Backend failure after completing updates (Step 1 persisted, Step 2 completed
    // in memory then checkpoint save fails):
    // - Reports stepsThisInvocation=2, stepsCumulative=2, lastPersistedStep=1, optimizationSeconds>0,
    //   checkpointIOSeconds>=0, and null for unavailable post-fit metrics (backendLoadSeconds, loadSeconds,
    //   headIsolation.changedParameterCount).
    // - Subsequent resume starts from persisted boundary (resumedFromStep=1, not 2), completes to
    //   budgetSteps=3 (stepsThisInvocation=2, stepsCumulative=3, without double-counting replayed Step 2),
    //   and preserves the failed attempt's compute time in previousOptimizationSeconds / cumulativeOptimizationSeconds!
    const out9c = join(dir, "out-9c-midfail");
    const ckptDir9c = join(out9c, "ckpt-holder");
    const ckptPath9c = join(ckptDir9c, "checkpoint.json");
    const res9c = await executeStandardRunner(
      "train",
      {
        schema: "nnanything.l2.standard-runner-config.v1",
        head: "E",
        phase: "posttraining",
        handwiredRoot: HANDWIRED_ROOT,
        inputPackagePath: pkgPath,
        outputDir: out9c,
        checkpointPath: ckptPath9c,
        computeBackend: "batch-cpu",
        trainSources: [
          {
            name: "valid-e-learned",
            path: validELearnedPath,
            format: "g3-derived-jsonl",
            expectedPartition: "TRAIN",
          },
        ],
        budget: {
          budgetSteps: 3,
          learningRate: 0.05,
          seed: 7,
          checkpointEverySteps: 1,
        },
      },
      {
        onProgress: event => {
          if (event.type === "checkpoint" && event.completedUpdates === 1) {
            // Freeze checkpoint directory after step 1 is persisted so step 2 completes in memory
            // (completedUpdates=2) and then fails when attempting to persist step 2 (lastPersistedStep=1)
            chmodSync(ckptDir9c, 0o555);
          }
          if (event.type === "error") {
            chmodSync(ckptDir9c, 0o755);
          }
        },
      },
    );
    chmodSync(ckptDir9c, 0o755);
    assert.equal(res9c.exitCode, 1);
    assert.equal(res9c.report.status, "failed");
    assert.equal(res9c.report.stopReason, "backend_fit_failed");
    assert.equal(res9c.report.stepsThisInvocation, 2);
    assert.equal(res9c.report.stepsCumulative, 2);
    assert.equal(res9c.report.lastPersistedStep, 1);
    assert.ok(res9c.report.optimizationSeconds !== null && res9c.report.optimizationSeconds > 0);
    assert.ok(res9c.report.checkpointIOSeconds !== null && res9c.report.checkpointIOSeconds >= 0);
    assert.equal(res9c.report.backendLoadSeconds, null);
    assert.equal(res9c.report.loadSeconds, null);
    assert.equal(res9c.report.headIsolation.frozenHeadsUnchanged, null);
    assert.equal(res9c.report.headIsolation.changedParameterCount, null);
    assert.notEqual(res9c.report.backend.device, "unknown");

    // Verify checkpoint on disk is at persisted boundary 1 while progress-events.jsonl recorded 2 step events
    const ckpt9c = JSON.parse(await readFile(ckptPath9c, "utf8"));
    assert.equal(ckpt9c.completedUpdates, 1);
    const events9c = (await readFile(join(out9c, "progress-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(l => JSON.parse(l));
    const stepEvents9c = events9c.filter(e => e.type === "step");
    assert.equal(stepEvents9c.length, 2);
    assert.equal(stepEvents9c[1].completedUpdates, 2);

    // Resume from persisted boundary 1 with the exact same config
    const res9cResume = await executeStandardRunner("resume", {
      schema: "nnanything.l2.standard-runner-config.v1",
      head: "E",
      phase: "posttraining",
      handwiredRoot: HANDWIRED_ROOT,
      inputPackagePath: pkgPath,
      outputDir: out9c,
      checkpointPath: ckptPath9c,
      computeBackend: "batch-cpu",
      trainSources: [
        {
          name: "valid-e-learned",
          path: validELearnedPath,
          format: "g3-derived-jsonl",
          expectedPartition: "TRAIN",
        },
      ],
      budget: {
        budgetSteps: 3,
        learningRate: 0.05,
        seed: 7,
        checkpointEverySteps: 1,
      },
    });
    assert.equal(res9cResume.exitCode, 0);
    assert.equal(res9cResume.report.status, "completed");
    assert.equal(res9cResume.report.resumedFromStep, 1);
    assert.equal(res9cResume.report.stepsThisInvocation, 2); // Replayed step 2 + step 3
    assert.equal(res9cResume.report.stepsCumulative, 3); // Unique completed steps = 3, not 2 + 2 = 4!
    assert.equal(res9cResume.report.lastPersistedStep, 3);
    assert.equal(res9cResume.report.previousOptimizationSeconds, res9c.report.optimizationSeconds);
    assert.ok(
      res9cResume.report.cumulativeOptimizationSeconds !== null
      && res9cResume.report.optimizationSeconds !== null
      && Math.abs(
        res9cResume.report.cumulativeOptimizationSeconds
          - (res9c.report.optimizationSeconds + res9cResume.report.optimizationSeconds),
      ) < 1e-9,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
