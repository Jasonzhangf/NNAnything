import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runStandardRunnerCli } from "../dist/training/l2-standard-runner.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { zeroTensors } from "../dist/training/unified-forward.js";
import { runTsJsSymbolTable } from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
} from "../dist/training/unified-student-converter.js";
import { admitInitialEvidence } from "../dist/adapters/tsjs-unified-recursive.js";

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

const SOURCE_GROUP = "tsjs-evaluate-dev-producer-fixture";
const FAMILY_ID = "tsjs-evaluate-dev-producer-family";
const SAMPLE_ID = "producer-runner-a";
const REQUEST_REF = "request:dv-c01";
const PENDING_RELATION_REF = "relation:dv-c01";

const ENGINEERING_FILES = {
  "src/helper.js": `const table = {
  a: (x) => x,
  b: (x) => x + 1,
};
export function pick(k) {
  return table[k];
}
`,
  "src/caller.js": `import { pick } from "./helper.js";
export function run(k, x) {
  return pick(k)(x);
}
`,
};

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(path, rows) {
  return writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function buildProducerRecord(repo) {
  const producerRequest = {
    repo,
    language: "javascript",
    scope: ["src"],
    files: ["src/caller.js", "src/helper.js"],
  };
  const producer = await runTsJsSymbolTable(producerRequest);
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") throw new Error("producer failed");
  const observation = producer.result.runtimeSelectorObservations[0];
  assert.ok(observation);
  const member = observation.callableTable.members.find(entry => entry.name === "a");
  assert.ok(member?.callableIdentity);
  const requestedDeclaration = {
    declarationRef: member.callableIdentity.declarationRef,
    moduleRef: `module:${member.callableIdentity.moduleRef}`,
    name: member.name,
    role: "member",
    kind: "function",
    evidenceRefs: [],
  };
  const bridge = await observeTsJsStepwiseRequest({
    sourceGroup: SOURCE_GROUP,
    language: "javascript",
    semanticStratum: "module_export",
    partition: "DEV",
    derivationFamily: FAMILY_ID,
    sampleId: SAMPLE_ID,
    entryFile: "src/caller.js",
    request: {
      requestRef: REQUEST_REF,
      requestedDeclaration,
      relationObligation: {
        requestRef: REQUEST_REF,
        pendingRelationRef: PENDING_RELATION_REF,
        callSiteRef: observation.callSiteRef,
        calleeName: "pick",
      },
    },
    stepId: "step:0",
    fromStepId: null,
    remainingObligations: [],
    localCandidateCursor: {
      pendingRelationRef: PENDING_RELATION_REF,
      state: "closed",
      evidenceRefs: [],
    },
    producerRequest,
  });
  assert.deepEqual(bridge.reasons, []);
  assert.ok(bridge.record);
  return { record: bridge.record, observation };
}

async function makeEngineeringRepo() {
  const repo = await mkdtemp(join(tmpdir(), "tsjs-evaluate-dev-producer-repo-"));
  await mkdir(join(repo, "src"), { recursive: true });
  for (const [file, source] of Object.entries(ENGINEERING_FILES)) {
    await writeFile(join(repo, file), source);
  }
  return repo;
}

async function loadRecord(record) {
  const familyDir = await mkdtemp(join(tmpdir(), "tsjs-evaluate-dev-producer-family-"));
  try {
    await mkdir(familyDir, { recursive: true });
    await writeJson(join(familyDir, "manifest.json"), {
      sourceGroup: record.sourceGroup,
      language: record.language,
      semanticStratum: record.semanticStratum,
      partition: record.partition,
      derivationFamily: { familyId: record.family },
    });
    await writeFile(
      join(familyDir, "student-observations.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    return await loadStepwiseEpisodeFamily(familyDir);
  } finally {
    await rm(familyDir, { recursive: true, force: true });
  }
}

async function makeRunnerFixture({ mutateRecord = null } = {}) {
  const repo = await makeEngineeringRepo();
  const root = await mkdtemp(join(tmpdir(), "tsjs-evaluate-dev-producer-runner-"));
  try {
    const { record, observation } = await buildProducerRecord(repo);
    const finalRecord = mutateRecord === null ? record : mutateRecord(record);
    const familyDir = join(root, "dev-family");
    await mkdir(join(familyDir, "labels"), { recursive: true });
    await mkdir(join(familyDir, "src"), { recursive: true });
    for (const [file, source] of Object.entries(ENGINEERING_FILES)) {
      await writeFile(join(familyDir, file), source);
    }
    await writeJson(join(familyDir, "manifest.json"), {
      sourceGroup: SOURCE_GROUP,
      language: "javascript",
      semanticStratum: "module_export",
      partition: "DEV",
      derivationFamily: { familyId: FAMILY_ID, independentVerificationEligible: false },
      oracleRefs: [],
    });
    await writeFile(
      join(familyDir, "student-observations.jsonl"),
      `${JSON.stringify(finalRecord)}\n`,
    );
    await writeJsonl(join(familyDir, "labels", "gold.jsonl"), [{
      sampleId: SAMPLE_ID,
      stepId: "step:0",
      sourceGroup: SOURCE_GROUP,
      partition: "DEV",
      labelMissing: true,
      unknownReason: "runtime_dynamic_selector",
      goldAction: "c:judge:unknown",
      labelAuthority: "researcher_structural_proof+typescript_compiler_api",
      oracleKind: "independent_tsc+typescript_compiler_api",
    }]);

    const admissionsPath = join(root, "familyAdmissions.json");
    await writeJson(admissionsPath, {
      schema: "nnanything.tsjs.request-aware-admission.family-admissions.v1",
      familyAdmissions: [{
        sourceGroup: SOURCE_GROUP,
        partition: "DEV",
        usableForTrainingSupervision: false,
        usableForIndependentVerification: false,
      }],
    });

    await writeJson(join(root, "feature-thresholds.json"), THRESHOLDS);
    await writeJson(join(root, "missing-mode.json"), MISSING_MODE);
    const tensors = zeroTensors();
    tensors.W1[36] = 1;
    tensors.W2[0] = 1;
    tensors.W3[0] = 1;
    const basePackage = createUnifiedModelPackage({
      modelId: "unified-evaluate-synthetic",
      version: "1",
      route: { domain: "tsjs", decisionKind: "R" },
      tensors,
      resources: {
        thresholdsRef: join(root, "feature-thresholds.json"),
        thresholdsSchema: THRESHOLDS.schema,
        missingModeTableRef: join(root, "missing-mode.json"),
        missingModeSchema: MISSING_MODE.schema,
      },
      fixedStages: ["nnanything.unified-step.encoder.v2"],
    });
    const packagePath = await saveUnifiedModelPackageAtomic(join(root, "package.json"), basePackage);
    const outputDir = join(root, "out");
    const config = {
      schema: "nnanything.unified.runner-config.v1",
      command: "evaluate-dev",
      route: { domain: "tsjs", decisionKind: "R" },
      phase: "evaluation",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      dataGate: {
        schema: "nnanything.unified.data-gate.v1",
        partition: "DEV",
        encoderVersion: "nnanything.unified-step.encoder.v2",
        thresholdsPath: join(root, "feature-thresholds.json"),
        rowsPath: join(outputDir, "unused-rows.jsonl"),
      },
      outputDir,
      evaluateDev: {
        schema: "nnanything.unified.dev-evaluate-config.v1",
        candidatePackagePath: packagePath,
        devFamilyPath: familyDir,
        admissionsPath,
        consumerEntry: "tsjs-unified-recursive:runTsJsUnifiedMultiStepDecision",
        runId: SAMPLE_ID,
      },
    };
    const configPath = join(root, "runner-config.json");
    await writeJson(configPath, config);
    return { root, repo, outputDir, observation, sourceReadRef: observation.sourceReadRef };
  } catch (error) {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("evaluate-dev admits a producer-backed DEV family through its own requestId", async () => {
  const fixture = await makeRunnerFixture();
  try {
    const exitCode = await runStandardRunnerCli([
      "evaluate-dev",
      "--config",
      join(fixture.root, "runner-config.json"),
    ]);
    assert.equal(exitCode, 1);
    const report = await readJson(join(fixture.outputDir, "run-report.json"));
    assert.equal(report.status, "failed");
    assert.equal(report.admission.sourceGroup, SOURCE_GROUP);
    assert.equal(JSON.stringify(report).includes("producer source episode request mismatch"), false);
    assert.deepEqual(report.error.detail.initialEvidenceInvalidReasons, []);
  } finally {
    await rm(fixture.repo, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("producer-backed request identity gates reject a wrong or mixed request", async () => {
  const repo = await makeEngineeringRepo();
  try {
    const { record } = await buildProducerRecord(repo);
    const episodes = await loadRecord(record);
    const wrong = admitInitialEvidence("request:other", episodes);
    assert.equal(wrong.initialObservation, null);
    assert.ok(wrong.invalidReasons.includes("producer source episode request mismatch"));

    const mixed = structuredClone(episodes);
    mixed.push({
      ...structuredClone(episodes[0]),
      stepId: "step:other",
      requestId: "request:other",
    });
    const mixedAdmission = admitInitialEvidence(episodes[0].requestId, mixed);
    assert.equal(mixedAdmission.initialObservation, null);
    assert.ok(mixedAdmission.invalidReasons.includes("producer source episode request mismatch"));

    await assert.rejects(loadRecord({
      ...record,
      steps: record.steps.map(step => ({
        ...step,
        receipts: step.receipts.map(receipt => ({
          ...receipt,
          producerSource: { ...receipt.producerSource, requestRef: "request:other" },
        })),
      })),
    }), /producer bridge requestRef mismatch/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
