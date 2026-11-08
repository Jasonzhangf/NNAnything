import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";

const here = new URL(".", import.meta.url);
const thresholdsFixture = resolve(
  here.pathname,
  "fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json",
);
const missingModeTableFixture = resolve(
  here.pathname,
  "fixtures/unified-64-slot/missing-mode-table.json",
);

const THRESHOLDS = {
  schema: "nnanything.feature-thresholds.v1",
  route: "r",
  encoderVersion: "nnanything.unified-step.encoder.v2",
  buckets: {
    constraints: [0, 1, 2, 4],
    knownFacts: [1, 2, 4, 8],
    missingFacts: [0, 1, 2, 4],
    objectRefs: [1, 2, 4, 8],
    requiredArgsRatio: [0, 0.25, 0.5, 1],
    requiredMissing: [0, 1, 2, 4],
  },
};

const MISSING_MODE = {
  schema: "nnanything.unified.missing-mode.v1",
  entries: [],
};

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path, rows) {
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function packageFor(route = { domain: "tsjs", decisionKind: "R" }) {
  const tensors = zeroTensors();
  // x[36] is the judge=true feature slot in the unified R encoder. Prefer it
  // so a synthetic fixture produces a deterministic terminal judgement.
  tensors.W1[36] = 1;
  tensors.W2[0] = 1;
  tensors.W3[0] = 1;
  return createUnifiedModelPackage({
    modelId: "unified-evaluate-synthetic",
    version: "1",
    route,
    tensors,
    resources: {
      thresholdsRef: "feature-thresholds.json",
      thresholdsSchema: THRESHOLDS.schema,
      missingModeTableRef: "missing-mode.json",
      missingModeSchema: MISSING_MODE.schema,
    },
    fixedStages: ["nnanything.unified-step.encoder.v2"],
  });
}

async function writePackage(root, pkg = packageFor()) {
  await writeJson(join(root, "feature-thresholds.json"), THRESHOLDS);
  await writeJson(join(root, "missing-mode.json"), MISSING_MODE);
  return saveUnifiedModelPackageAtomic(join(root, "package.json"), pkg);
}

function goldRow(sampleId, label) {
  return {
    sampleId,
    sourceGroup: "tsjs-evaluate-verification-fixture",
    partition: "verification",
    label,
    allowedEquivalentLabels: [label],
    labelAuthority: "researcher_structural_proof+typescript_compiler_api",
    labelMissing: false,
    unknownReason: null,
    oracleKind: "independent_tsc+typescript_compiler_api",
    goldAction: `c:judge:${label}`,
    candidateSet: [`c:judge:${label}`],
  };
}

function studentRecord(sampleId, { evidenceRefs = [`ev:${sampleId}:read`] } = {}) {
  return {
    schemaVersion: "emma-tsjs-student-observation-v2",
    sampleId,
    family: "tsjs-evaluate-verification-fixture",
    partition: "verification",
    language: "ts",
    semanticStratum: "module_export",
    entryFile: "sources/src/entry.ts",
    request: {
      requestRef: `request:${sampleId}`,
      requestedDeclaration: {
        declarationRef: `decl:sources/src/entry.ts#top:helper`,
        moduleRef: "mod:sources/src/entry.ts",
        name: "helper",
        kind: "function",
        sourceTargetRef: "sources/src/entry.ts#top:helper",
      },
      relationObligation: {
        pendingRelationRef: `pending:${sampleId}`,
        callSiteRef: `call:${sampleId}`,
        calleeName: "helper",
      },
    },
    steps: [
      {
        stepId: "step:0",
        observedAt: "current-step",
        localSyntax: {
          observedBindings: [],
          observedDeclarations: [],
          sourceContent: {
            state: "observed",
            resultRefs: [],
            reason: null,
            evidenceRefs,
          },
          shadowFacts: [],
        },
        remainingObligations: [],
        S_g: ["c:judge:true", "c:judge:false", "c:judge:unknown", "c:return"],
        receipts: [],
        coverage: null,
        notReady: false,
      },
    ],
  };
}

async function makeFixture({
  samples = [],
  admissionsOverride,
  packageOverride,
  packageDir = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "unified-runner-evaluate-"));
  const familyDir = join(root, "verification-family");
  await mkdir(join(familyDir, "labels"), { recursive: true });
  await writeJson(join(familyDir, "manifest.json"), {
    schemaVersion: "neural-cli-source-family-v1",
    sourceGroup: "tsjs-evaluate-verification-fixture",
    language: "ts",
    semanticStratum: "module_export",
    partition: "verification",
    derivationFamily: {
      familyId: "tsjs-evaluate-fixture-v1",
      independentVerificationEligible: true,
    },
    sourceRefs: ["sources/src/entry.ts"],
    oracleRefs: [
      "evidence/manual-structural-proof.md",
      "evidence/tsc-receipt.txt",
      "evidence/oracle-receipt.json",
    ],
  });
  await writeJsonl(
    join(familyDir, "labels", "gold.jsonl"),
    samples.map(({ sampleId, label }) => goldRow(sampleId, label)),
  );
  await writeJsonl(
    join(familyDir, "student-observations.jsonl"),
    samples.map(({ sampleId, evidenceRefs }) => studentRecord(sampleId, { evidenceRefs })),
  );

  const admissionsPath = join(root, "corpus-admissions-v1.json");
  await writeJson(admissionsPath, admissionsOverride ?? {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    familyAdmissions: [
      {
        sourceGroup: "tsjs-evaluate-verification-fixture",
        partition: "verification",
        usableForTrainingSupervision: false,
        usableForIndependentVerification: true,
        evidence: "evidence/oracle-receipt.json",
      },
    ],
  });

  let packagePath;
  if (packageOverride !== undefined) {
    packagePath = packageOverride;
  } else if (packageDir) {
    const dir = join(root, "packages");
    await mkdir(dir, { recursive: true });
    packagePath = dir;
  } else {
    packagePath = await writePackage(root);
  }

  const outputDir = join(root, "out");
  const configPath = join(root, "runner-config.json");
  await writeJson(configPath, {
    schema: "nnanything.unified.runner-config.v1",
    command: "evaluate",
    route: { domain: "tsjs", decisionKind: "R" },
    phase: "evaluation",
    encoderVersion: "nnanything.unified-step.encoder.v2",
    dataGate: {
      schema: "nnanything.unified.data-gate.v1",
      partition: "VERIFICATION",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      thresholdsPath: thresholdsFixture,
      rowsPath: join(outputDir, "unused-rows.jsonl"),
    },
    outputDir,
    evaluate: {
      schema: "nnanything.unified.evaluate-config.v1",
      candidatePackagePath: packagePath,
      independentFamilyPath: familyDir,
      admissionsPath,
      consumerEntry: "tsjs-unified-recursive:runTsJsUnifiedDecision",
      runId: "evaluate-fixture",
    },
  });

  return { root, familyDir, admissionsPath, packagePath, outputDir, configPath };
}

async function readReport(outputDir) {
  return JSON.parse(await readFile(join(outputDir, "run-report.json"), "utf8"));
}

test("evaluate route runs a synthetic admitted fixture and writes an evaluate report", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      0,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.schema, "nnanything.unified.evaluate-report.v1");
    assert.equal(report.command, "evaluate");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate rejects a missing candidate package with a typed non-zero exit", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
    packageOverride: join(tmpdir(), "definitely-missing-evaluate-package.json"),
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      1,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.error.code, "CANDIDATE_MISSING");
    assert.equal(report.candidateOutput.emitted, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate rejects non-independent source partitions and TRAIN/DEV families", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "train-source", label: "true" }],
    admissionsOverride: {
      schemaVersion: "neural-cli-corpus-admissions-v1",
      familyAdmissions: [
        {
          sourceGroup: "tsjs-evaluate-verification-fixture",
          partition: "train",
          usableForTrainingSupervision: true,
          usableForIndependentVerification: false,
        },
      ],
    },
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      1,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.error.code, "ADMISSION_NOT_INDEPENDENT");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate rejects ambiguous independent admission", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
    admissionsOverride: {
      schemaVersion: "neural-cli-corpus-admissions-v1",
      familyAdmissions: [
        {
          sourceGroup: "tsjs-evaluate-verification-fixture",
          partition: "verification",
          usableForIndependentVerification: true,
        },
        {
          sourceGroup: "tsjs-evaluate-verification-fixture",
          partition: "verification",
          usableForIndependentVerification: true,
        },
      ],
    },
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      1,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.error.code, "ADMISSION_AMBIGUOUS");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate counts gold and student denominators without synthesizing a package", async () => {
  const fixture = await makeFixture({
    samples: [
      { sampleId: "known-true", label: "true" },
      { sampleId: "known-false", label: "false" },
      { sampleId: "valid-unknown", label: "unknown" },
    ],
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      0,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.gold.total, 3);
    assert.equal(report.studentPrediction.total, 3);
    assert.equal(report.candidateOutput.emitted, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate machine and human receipts expose the same fixed-engine evidence fields", async () => {
  const fixture = await makeFixture({
    samples: [
      { sampleId: "known-true", label: "true" },
      { sampleId: "known-false", label: "false" },
      { sampleId: "valid-unknown", label: "unknown" },
    ],
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      0,
    );
    const report = await readReport(fixture.outputDir);
    const markdown = await readFile(join(fixture.outputDir, "run-report.md"), "utf8");
    assert.equal(report.consumerEntry, "tsjs-unified-recursive:runTsJsUnifiedDecision");
    assert.equal(report.executionEntries.length, 3);
    assert.ok(report.executionEntries.every(entry =>
      entry.candidateRef !== undefined
      && entry.optionSemantics !== undefined
      && entry.score !== undefined
      && entry.executionReceiptRef !== undefined
      && entry.postStateRef !== undefined
      && entry.newStateRef !== undefined
    ));
    assert.ok(markdown.includes(`Unified Runner Evaluate Report (${report.runId})`));
    assert.ok(markdown.includes(`Consumer Entry: \`${report.consumerEntry}\``));
    assert.ok(markdown.includes(`Candidate Output Emitted: \`false\``));
    assert.ok(markdown.includes(`Gold: \`${report.gold.total}\``));
    assert.ok(markdown.includes(`Student Predictions: \`${report.studentPrediction.total}\``));
    assert.ok(markdown.includes(`Per-Step: \`${report.perStepEvaluation.correct}/${report.perStepEvaluation.unknown}/${report.perStepEvaluation.incorrect}\``));
    assert.ok(markdown.includes(`Root: \`${report.rootEvaluation.evaluated}/${report.rootEvaluation.satisfied}/${report.rootEvaluation.unsatisfied}/${report.rootEvaluation.unknown}\``));
    assert.ok(markdown.includes(`Unknown Recall: \`${report.unknownRecall.toFixed(4)}\``));
    assert.ok(markdown.includes(`Overall: \`${report.overall}\``));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evaluate failure never emits a candidate package and has no fallback", async () => {
  const fixture = await makeFixture({
    samples: [{ sampleId: "known-true", label: "true" }],
    packageOverride: join(tmpdir(), "absent-evaluate-package.json"),
  });
  try {
    assert.equal(
      await runStandardRunnerCli(["evaluate", "--config", fixture.configPath]),
      1,
    );
    const report = await readReport(fixture.outputDir);
    assert.equal(report.error.code, "CANDIDATE_MISSING");
    await assert.rejects(
      readFile(join(fixture.outputDir, "package.json"), "utf8"),
      error => error.code === "ENOENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
