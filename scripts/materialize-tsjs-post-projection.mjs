// Non-fitting preparation for the fixed post-projection TS/JS TRAIN run.
// Reuses accepted structured observations, reacquires the retention pair and
// the new lexical pair through the public producer/bridge/loader, reconciles
// A_g against current candidate enumeration, and writes TRAIN-only configs.
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";

import { runTsJsSymbolTable } from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  convertEpisodeToStudentGroup,
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
  STEPWISE_STUDENT_OBSERVATIONS_FILE,
} from "../dist/training/unified-student-converter.js";
import {
  loadStepwiseSupervisionFamily,
  STEPWISE_SUPERVISION_FILE,
  STEPWISE_SUPERVISION_SCHEMA,
} from "../dist/training/unified-supervision-converter.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TSJS_POST_PROJECTION_MATERIALIZE_SCHEMA =
  "nnanything.tsjs.post-projection-materialize.v1";
export const TSJS_POST_PROJECTION_REPLAY_SPEC_SCHEMA =
  "nnanything.tsjs.post-projection-replay-spec.v1";

const INHERITANCE_SOURCE_PACKAGE =
  "/Volumes/Intel/playground/nnanything-runs/tsjs-fixed-candidate-resume-checker-prep-r1-20261110/execution/package/model-package.json";
const THRESHOLDS_PATH =
  "/Volumes/extension/code/NNAnything/tests/fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json";
const MISSING_MODE_TABLE_PATH =
  "/Volumes/extension/code/NNAnything/tests/fixtures/unified-64-slot/missing-mode-table.json";
const FORMAL_REPLAY_STUDENT_ROWS =
  "/Volumes/Intel/playground/nnanything-runs/tsjs-unknown-supervision-recipe-binding-config-r1-20261110/config-evidence/train/formal-replay-correction-20261111T0907Z/student-rows.jsonl";
const FORMAL_REPLAY_SUPERVISION_ROWS =
  "/Volumes/Intel/playground/nnanything-runs/tsjs-unknown-supervision-recipe-binding-config-r1-20261110/config-evidence/train/formal-replay-correction-20261111T0907Z/supervision-rows.jsonl";
const RETENTION_SOURCE_GROUP = "tsjs-train-retention-contrast-r1";
const NEW_SOURCE_GROUP = "tsjs-train-lexical-declaration-contrast-r1-20261113";
const NEW_DERIVATION_FAMILY = "tsjs-lexical-declaration-contrast-v1";

const NEW_FAMILY_FILES = [
  "sources/caller.ts",
  "sources/primary.ts",
  "sources/secondary.ts",
];

const EXPECTED_SOURCES = new Map([
  ["sources/primary.ts", "export function normalizeReading(value: number): number {\n  return value + 1;\n}\n"],
  ["sources/secondary.ts", "export function normalizeReading(value: number): number {\n  return value - 1;\n}\n"],
  ["sources/caller.ts", "import { normalizeReading as normalize } from \"./primary\";\nexport const result = normalize(7);\n"],
]);

const LEXICAL_ARMS = [
  {
    sampleId: "lp-r1-same-declaration",
    semanticDeclarationRef: "decl:sources/primary.ts#top:normalizeReading",
    requestedFile: "sources/primary.ts",
    requestedModuleRef: "module:sources/primary.ts",
    requestedName: "normalizeReading",
    requestedKind: "function",
    allowedCandidateRef: "c:judge:true",
    expectedIdentitySlots: { moduleEqual: 1, declarationEqual: 1 },
  },
  {
    sampleId: "lp-r1-different-module",
    semanticDeclarationRef: "decl:sources/secondary.ts#top:normalizeReading",
    requestedFile: "sources/secondary.ts",
    requestedModuleRef: "module:sources/secondary.ts",
    requestedName: "normalizeReading",
    requestedKind: "function",
    allowedCandidateRef: "c:judge:false",
    expectedIdentitySlots: { moduleEqual: 0, declarationEqual: 0 },
  },
];

function requireArg(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || args[index + 1] === undefined) {
    throw new Error(`missing required ${name}`);
  }
  return args[index + 1];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

async function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} ${path} must be an object`);
  return parsed;
}

async function readJsonl(path, label) {
  const text = await readFile(path, "utf8");
  return text.split("\n").flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("line is not an object");
      return [parsed];
    } catch (error) {
      throw new Error(`${label} ${path} line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path, rows) {
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function assertNotProtectedHold(path) {
  const resolvedPath = resolve(path);
  if (resolvedPath.split("/").includes("PROTECTED_HOLD")) {
    throw new Error(`refusing PROTECTED_HOLD input ${resolvedPath}`);
  }
  const metadata = await lstat(resolvedPath);
  if (metadata.isSymbolicLink()) {
    const target = await realpath(resolvedPath);
    if (target.split("/").includes("PROTECTED_HOLD")) {
      throw new Error(`refusing PROTECTED_HOLD symlink target ${target}`);
    }
  }
}

function sourceCandidateRefs(group) {
  return group.candidates.map(candidate => candidate.candidateRef);
}

function sameNameSpan(left, right) {
  return isRecord(left)
    && isRecord(right)
    && left.startLine === right.startLine
    && left.startColumn === right.startCol
    && left.endLine === right.endLine
    && left.endColumn === right.endCol;
}

function uniqueExportSymbol(producer, arm) {
  const matches = producer.result.symbols.filter(symbol =>
    symbol.file === arm.requestedFile
    && symbol.name === arm.requestedName
    && symbol.kind === arm.requestedKind
    && symbol.visibility === "exported"
    && symbol.declaredIn === "file"
  );
  if (matches.length !== 1) {
    throw new Error(
      `${arm.sampleId} expected one exported ${arm.requestedKind} ${arm.requestedFile}#${arm.requestedName}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function requestedDeclarationRefForArm(producer, compilerProof, arm) {
  const symbol = uniqueExportSymbol(producer, arm);
  const proofDeclaration = arm.requestedFile === "sources/primary.ts"
    ? compilerProof.primaryDeclaration
    : compilerProof.secondaryDeclaration;
  if (
    !isRecord(proofDeclaration)
    || proofDeclaration.declarationRef !== arm.semanticDeclarationRef
    || proofDeclaration.moduleRef !== arm.requestedModuleRef
    || proofDeclaration.name !== arm.requestedName
    || !isRecord(proofDeclaration.location)
    || proofDeclaration.location.file !== arm.requestedFile
    || !sameNameSpan(proofDeclaration.location, symbol.nameSpan)
  ) {
    throw new Error(`${arm.sampleId} compiler proof does not map to the current producer declaration`);
  }
  return arm.semanticDeclarationRef;
}

function reconcileSupervisionRecords(acceptedRecords, groups) {
  const groupsBySample = new Map();
  for (const group of groups) {
    const entries = groupsBySample.get(group.sampleId) ?? [];
    entries.push(group);
    groupsBySample.set(group.sampleId, entries);
  }

  const reconciled = [];
  for (const accepted of acceptedRecords) {
    const sampleId = requireString(accepted.sampleId, "accepted supervision sampleId");
    const acceptedSteps = accepted.steps;
    if (!Array.isArray(acceptedSteps) || acceptedSteps.length === 0) {
      throw new Error(`accepted supervision ${sampleId} has no steps`);
    }
    const sampleGroups = groupsBySample.get(sampleId) ?? [];
    if (sampleGroups.length !== acceptedSteps.length) {
      throw new Error(
        `${sampleId} current groups ${sampleGroups.length} do not reconcile with accepted steps ${acceptedSteps.length}`,
      );
    }
    const groupByStep = new Map(sampleGroups.map(group => [group.stepId, group]));
    const steps = acceptedSteps.map(rawStep => {
      if (!isRecord(rawStep)) throw new Error(`${sampleId} accepted supervision step is not an object`);
      const stepId = requireString(rawStep.stepId, `${sampleId}.stepId`);
      const group = groupByStep.get(stepId);
      if (group === undefined) throw new Error(`${sampleId} current groups lost accepted step ${stepId}`);
      const A_g = rawStep.A_g;
      if (!Array.isArray(A_g) || A_g.length === 0 || A_g.some(ref => typeof ref !== "string")) {
        throw new Error(`${sampleId}/${stepId} accepted A_g is invalid`);
      }
      const S_g = sourceCandidateRefs(group);
      const missing = A_g.filter(ref => !S_g.includes(ref));
      if (missing.length > 0) {
        throw new Error(
          `${sampleId}/${stepId} accepted A_g is outside current S_g: ${missing.join(", ")}`,
        );
      }
      return {
        stepId,
        S_g,
        A_g: [...A_g],
        agSubsetOfSg: true,
        labelAuthority: requireString(rawStep.labelAuthority, `${sampleId}/${stepId}.labelAuthority`),
        oracleKind: requireString(rawStep.oracleKind, `${sampleId}/${stepId}.oracleKind`),
        unknownReason: typeof rawStep.unknownReason === "string" ? rawStep.unknownReason : null,
      };
    });
    reconciled.push({
      schemaVersion: STEPWISE_SUPERVISION_SCHEMA,
      sampleId,
      family: requireString(accepted.family, `${sampleId}.family`),
      requestRef: requireString(accepted.requestRef, `${sampleId}.requestRef`),
      steps,
      trainingEligible: accepted.trainingEligible === true,
      notReadyReason: typeof accepted.notReadyReason === "string" ? accepted.notReadyReason : null,
    });
  }

  const acceptedSamples = new Set(reconciled.map(record => record.sampleId));
  const extraSamples = groups
    .map(group => group.sampleId)
    .filter(sampleId => !acceptedSamples.has(sampleId));
  if (extraSamples.length > 0) {
    throw new Error(`current groups contain unaccepted samples: ${[...new Set(extraSamples)].join(", ")}`);
  }
  return reconciled;
}

async function materializeAcceptedFamily({ input, destDir }) {
  const sourceDir = resolve(requireString(input.path, `${input.role}.path`));
  await assertNotProtectedHold(sourceDir);
  const expectedSourceGroup = requireString(input.sourceGroup, `${input.role}.sourceGroup`);
  const manifest = await readJson(join(sourceDir, "manifest.json"), `${input.role} manifest`);
  if (manifest.sourceGroup !== expectedSourceGroup) {
    throw new Error(`${input.role} sourceGroup ${String(manifest.sourceGroup)} != ${expectedSourceGroup}`);
  }

  await mkdir(destDir, { recursive: true });
  await copyFile(join(sourceDir, "manifest.json"), join(destDir, "manifest.json"));
  await copyFile(
    join(sourceDir, STEPWISE_STUDENT_OBSERVATIONS_FILE),
    join(destDir, STEPWISE_STUDENT_OBSERVATIONS_FILE),
  );

  const acceptedRecords = await readJsonl(
    join(sourceDir, STEPWISE_SUPERVISION_FILE),
    `${input.role} accepted supervision`,
  );
  const episodes = await loadStepwiseEpisodeFamily(destDir);
  const groups = episodes.map(episode => convertEpisodeToStudentGroup(episode));
  const supervisionRecords = reconcileSupervisionRecords(acceptedRecords, groups);
  await writeJsonl(join(destDir, STEPWISE_SUPERVISION_FILE), supervisionRecords);
  await loadStepwiseSupervisionFamily(destDir);

  return {
    role: input.role,
    sourceGroup: expectedSourceGroup,
    dir: destDir,
    groupCount: groups.length,
    candidateRowCount: groups.reduce((sum, group) => sum + group.candidates.length, 0),
    supervisionRowCount: supervisionRecords.reduce((sum, record) => sum + record.steps.length, 0),
    evidencePath: join(sourceDir, "manifest.json"),
  };
}

async function materializeRetentionFamily({ input, destDir, out }) {
  const acceptedFamilyDir = resolve(requireString(input.path, `${input.role}.path`));
  await assertNotProtectedHold(acceptedFamilyDir);
  const acceptedStudentRecords = await readJsonl(
    join(acceptedFamilyDir, STEPWISE_STUDENT_OBSERVATIONS_FILE),
    "accepted retention student observations",
  );
  const producerRepos = [...new Set(acceptedStudentRecords.flatMap(record => {
    const repo = record?.steps?.[0]?.receipts?.[0]?.producerSource?.producerRequest?.repo;
    return typeof repo === "string" && repo.length > 0 ? [repo] : [];
  }))];
  if (producerRepos.length !== 1) {
    throw new Error(`retention input must identify exactly one producer repo, found ${producerRepos.length}`);
  }
  const sourceDir = resolve(producerRepos[0]);
  await assertNotProtectedHold(sourceDir);
  const materializedRoot = join(out, "retention-materialized");
  const stdoutPath = join(out, "retention-materializer.stdout.json");
  const stderrPath = join(out, "retention-materializer.stderr.log");
  let stdout;
  let stderr;
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        join(REPO_ROOT, "scripts", "materialize-tsjs-retention-contrast.mjs"),
        "--repo", sourceDir,
        "--initialization-source", INHERITANCE_SOURCE_PACKAGE,
        "--baseline-student", FORMAL_REPLAY_STUDENT_ROWS,
        "--baseline-supervision", FORMAL_REPLAY_SUPERVISION_ROWS,
        "--out", materializedRoot,
      ],
      { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    stderr = typeof error?.stderr === "string" ? error.stderr : "";
    await writeFile(stdoutPath, stdout, "utf8");
    await writeFile(stderrPath, stderr, "utf8");
    throw error;
  }
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");

  const sourceFamilyDir = join(
    materializedRoot,
    "corpus-union",
    RETENTION_SOURCE_GROUP,
  );
  await mkdir(destDir, { recursive: true });
  await copyFile(join(sourceFamilyDir, "manifest.json"), join(destDir, "manifest.json"));
  await copyFile(
    join(sourceFamilyDir, STEPWISE_STUDENT_OBSERVATIONS_FILE),
    join(destDir, STEPWISE_STUDENT_OBSERVATIONS_FILE),
  );
  const acceptedSupervisionRecords = await readJsonl(
    join(sourceFamilyDir, STEPWISE_SUPERVISION_FILE),
    "reacquired retention supervision",
  );
  const episodes = await loadStepwiseEpisodeFamily(destDir);
  const groups = episodes.map(episode => convertEpisodeToStudentGroup(episode));
  const supervisionRecords = reconcileSupervisionRecords(acceptedSupervisionRecords, groups);
  await writeJsonl(join(destDir, STEPWISE_SUPERVISION_FILE), supervisionRecords);
  await loadStepwiseSupervisionFamily(destDir);

  return {
    role: input.role,
    sourceGroup: RETENTION_SOURCE_GROUP,
    dir: destDir,
    groupCount: groups.length,
    candidateRowCount: groups.reduce((sum, group) => sum + group.candidates.length, 0),
    supervisionRowCount: supervisionRecords.reduce((sum, record) => sum + record.steps.length, 0),
    evidence: {
      stdoutPath,
      stderrPath,
      materializedRoot,
    },
    evidencePath: join(sourceDir, "proofs", "semantic-proofs.md"),
  };
}

function lexicalProducerRequest(familyRoot, files = NEW_FAMILY_FILES) {
  return {
    repo: familyRoot,
    language: "typescript",
    scope: ["."],
    files,
  };
}

function lexicalObservation(producer, calleeName) {
  const matches = producer.result.lexicalCallSiteBindings.filter(
    observation => observation.calleeName === calleeName,
  );
  if (matches.length !== 1) {
    throw new Error(`expected one lexical observation for ${calleeName}, found ${matches.length}`);
  }
  return matches[0];
}

function lexicalBridgeInput({ request, observation, arm, requestedDeclarationRef, requestedModuleRef }) {
  const requestRef = `request:${arm.sampleId}`;
  const pendingRelationRef = `relation:${arm.sampleId}`;
  return {
    sourceGroup: NEW_SOURCE_GROUP,
    language: "typescript",
    semanticStratum: "module_export",
    partition: "TRAIN",
    derivationFamily: NEW_DERIVATION_FAMILY,
    sampleId: arm.sampleId,
    entryFile: "sources/caller.ts",
    route: "lexical",
    request: {
      requestRef,
      requestedDeclaration: {
        declarationRef: requestedDeclarationRef,
        moduleRef: requestedModuleRef,
        name: "normalizeReading",
        role: "export",
        kind: "function",
        evidenceRefs: [],
      },
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef: observation.callSiteRef,
        calleeName: "normalize",
      },
    },
    stepId: "step:0",
    fromStepId: null,
    remainingObligations: [],
    localCandidateCursor: {
      pendingRelationRef,
      state: "closed",
      evidenceRefs: [],
    },
    producerRequest: request,
  };
}

async function loadRecordInControlDir(controlDir, record) {
  await mkdir(controlDir, { recursive: true });
  await writeJson(join(controlDir, "manifest.json"), {
    sourceGroup: record.sourceGroup,
    language: record.language,
    semanticStratum: record.semanticStratum,
    partition: record.partition,
    derivationFamily: { familyId: record.family },
  });
  await writeJsonl(join(controlDir, STEPWISE_STUDENT_OBSERVATIONS_FILE), [record]);
  return await loadStepwiseEpisodeFamily(controlDir);
}

function assertNoVerdict(record, label) {
  const text = JSON.stringify(record);
  for (const forbidden of ["c:judge:true", "c:judge:false", "c:judge:unknown", "\"verdict\""]) {
    if (text.includes(forbidden)) {
      throw new Error(`${label} injects forbidden verdict token ${forbidden}`);
    }
  }
}

async function materializeLexicalFamily({ familyRoot, destDir, out }) {
  await assertNotProtectedHold(familyRoot);
  for (const [relativePath, expectedText] of EXPECTED_SOURCES) {
    const actualText = await readFile(join(familyRoot, relativePath), "utf8");
    if (actualText !== expectedText) {
      throw new Error(`${relativePath} does not match the fixed design source`);
    }
  }

  const request = lexicalProducerRequest(familyRoot);
  const producer = await runTsJsSymbolTable(request);
  if (producer.status !== "ok") throw new Error(`lexical producer failed: ${producer.message}`);
  const compilerProof = await readJson(
    join(familyRoot, "proofs", "compiler-api-receipt.json"),
    "lexical compiler proof",
  );
  if (
    compilerProof.schemaVersion !== "nnanything.tsjs.compiler-api-receipt.v1"
    || !Array.isArray(compilerProof.diagnostics)
    || compilerProof.diagnostics.length !== 0
    || !isRecord(compilerProof.proof)
    || compilerProof.proof.sameDeclarationForPrimaryRequest !== true
    || compilerProof.proof.sameNameDifferentModuleForSecondaryRequest !== true
  ) {
    throw new Error("lexical compiler proof schema or conclusions are invalid");
  }
  const observation = lexicalObservation(producer, "normalize");
  if (
    observation.bindingKind !== "import"
    || observation.sourceName !== "normalizeReading"
    || observation.targetName !== "normalize"
    || observation.sourceModuleFile !== "sources/primary.ts"
    || observation.sourceModuleReadReceipt === null
  ) {
    throw new Error(`unexpected lexical binding: ${JSON.stringify(observation)}`);
  }
  if (
    observation.calleeSpan.startLine !== 2
    || observation.calleeSpan.startCol !== 23
    || observation.calleeSpan.endLine !== 2
    || observation.calleeSpan.endCol !== 35
  ) {
    throw new Error(`observed call span ${JSON.stringify(observation.calleeSpan)} != 2:23-2:35`);
  }

  const records = [];
  const requestIdentities = [];
  for (const arm of LEXICAL_ARMS) {
    const producerDeclarationRef = requestedDeclarationRefForArm(
      producer,
      compilerProof,
      arm,
    );
    const bridge = await observeTsJsStepwiseRequest(
      lexicalBridgeInput({
        request,
        observation,
        arm,
        requestedDeclarationRef: producerDeclarationRef,
        requestedModuleRef: arm.requestedModuleRef,
      }),
    );
    if (bridge.record === null || bridge.reasons.length > 0) {
      throw new Error(`${arm.sampleId} lexical bridge failed: ${JSON.stringify(bridge.reasons)}`);
    }
    assertNoVerdict(bridge.record, arm.sampleId);
    const observedDeclarations = bridge.record.steps?.[0]?.localSyntax?.observedDeclarations;
    if (
      !Array.isArray(observedDeclarations)
      || observedDeclarations.length !== 1
      || !isRecord(observedDeclarations[0])
      || observedDeclarations[0].declarationRef !== "decl:sources/primary.ts#top:normalizeReading"
      || observedDeclarations[0].moduleRef !== "module:sources/primary.ts"
    ) {
      throw new Error(`${arm.sampleId} did not observe the primary declaration`);
    }
    if (bridge.record.steps[0].currentRelation.binding.state !== "not_observed") {
      throw new Error(`${arm.sampleId} overwrote currentRelation`);
    }
    records.push(bridge.record);
    requestIdentities.push({
      sampleId: arm.sampleId,
      semanticDeclarationRef: arm.semanticDeclarationRef,
      producerDeclarationRef,
    });
  }

  await mkdir(destDir, { recursive: true });
  await writeJson(join(destDir, "manifest.json"), {
    sourceGroup: NEW_SOURCE_GROUP,
    language: "typescript",
    semanticStratum: "module_export",
    partition: "TRAIN",
    derivationFamily: {
      familyId: NEW_DERIVATION_FAMILY,
      independentVerificationEligible: false,
    },
  });
  await writeJsonl(join(destDir, STEPWISE_STUDENT_OBSERVATIONS_FILE), records);
  const episodes = await loadStepwiseEpisodeFamily(destDir);
  const groups = episodes.map(episode => convertEpisodeToStudentGroup(episode));
  if (groups.length !== LEXICAL_ARMS.length) {
    throw new Error(`lexical family produced ${groups.length} groups, expected ${LEXICAL_ARMS.length}`);
  }

  for (const group of groups) {
    const arm = LEXICAL_ARMS.find(entry => entry.sampleId === group.sampleId);
    if (arm === undefined) throw new Error(`unexpected lexical group ${group.sampleId}`);
    const S_g = sourceCandidateRefs(group);
    if (!S_g.includes(arm.allowedCandidateRef)) {
      throw new Error(`${arm.sampleId} current S_g lacks ${arm.allowedCandidateRef}`);
    }
    const allowedCandidate = group.candidates.find(
      candidate => candidate.candidateRef === arm.allowedCandidateRef,
    );
    if (
      allowedCandidate === undefined
      || allowedCandidate.input[61] !== arm.expectedIdentitySlots.moduleEqual
      || allowedCandidate.input[62] !== arm.expectedIdentitySlots.declarationEqual
    ) {
      throw new Error(`${arm.sampleId} declaration identity slots do not match the fixed proof`);
    }
    const episode = episodes.find(value => value.sampleId === group.sampleId);
    for (const candidate of relationStepContext(episode).candidateGroup.candidates) {
      if (candidate.optionSemantics.startsWith("judge=")
        && (candidate.bindingProjection === null
          || candidate.bindingProjection.resolution.status !== "resolved")) {
        throw new Error(`${arm.sampleId} judge candidate lacks a resolved declaration projection`);
      }
    }
  }

  const supervisionRecords = LEXICAL_ARMS.map(arm => {
    const record = records.find(entry => entry.sampleId === arm.sampleId);
    const group = groups.find(entry => entry.sampleId === arm.sampleId);
    if (record === undefined || group === undefined) {
      throw new Error(`missing lexical reconciliation for ${arm.sampleId}`);
    }
    return {
      schemaVersion: STEPWISE_SUPERVISION_SCHEMA,
      sampleId: arm.sampleId,
      family: record.family,
      requestRef: record.request.requestRef,
      steps: [{
        stepId: "step:0",
        S_g: sourceCandidateRefs(group),
        A_g: [arm.allowedCandidateRef],
        agSubsetOfSg: true,
        labelAuthority: "researcher_structural_proof+typescript_compiler_api",
        oracleKind: "independent_typescript_compiler_api",
        unknownReason: null,
      }],
      trainingEligible: true,
      notReadyReason: null,
    };
  });
  await writeJsonl(join(destDir, STEPWISE_SUPERVISION_FILE), supervisionRecords);
  await loadStepwiseSupervisionFamily(destDir);

  const missingSourceRequest = lexicalProducerRequest(familyRoot, ["sources/caller.ts"]);
  const missingProducer = await runTsJsSymbolTable(missingSourceRequest);
  if (missingProducer.status !== "ok") {
    throw new Error(`missing-source control producer failed: ${missingProducer.message}`);
  }
  const missingObservation = lexicalObservation(missingProducer, "normalize");
  if (
    missingObservation.bindingKind !== "unresolved"
    || missingObservation.unresolvedReason !== "module_not_in_read_set"
    || missingObservation.sourceModuleReadReceipt !== null
  ) {
    throw new Error(`missing-source control did not stay unresolved: ${JSON.stringify(missingObservation)}`);
  }
  const missingRequestedDeclarationRef = requestedDeclarationRefForArm(
    producer,
    compilerProof,
    LEXICAL_ARMS[0],
  );
  const missingBridge = await observeTsJsStepwiseRequest(
    lexicalBridgeInput({
      request: missingSourceRequest,
      observation: missingObservation,
      arm: LEXICAL_ARMS[0],
      requestedDeclarationRef: missingRequestedDeclarationRef,
      requestedModuleRef: LEXICAL_ARMS[0].requestedModuleRef,
    }),
  );
  if (missingBridge.record === null || missingBridge.reasons.length > 0) {
    throw new Error(`missing-source bridge failed: ${JSON.stringify(missingBridge.reasons)}`);
  }
  const missingEpisodes = await loadRecordInControlDir(
    join(out, "receipt-controls", "missing-source-read"),
    missingBridge.record,
  );
  for (const candidate of relationStepContext(missingEpisodes[0]).candidateGroup.candidates) {
    if (candidate.optionSemantics.startsWith("judge=") && candidate.bindingProjection !== null) {
      throw new Error("missing source read produced a declaration projection");
    }
  }

  return {
    role: "lexical-declaration-contrast",
    sourceGroup: NEW_SOURCE_GROUP,
    dir: destDir,
    groupCount: groups.length,
    candidateRowCount: groups.reduce((sum, group) => sum + group.candidates.length, 0),
    supervisionRowCount: supervisionRecords.length,
    requestIdentities,
    observedCallSiteRef: observation.callSiteRef,
    sourceModuleFile: observation.sourceModuleFile,
    missingSourceReadProjectionCount: 0,
    verdictInjectionCount: 0,
    evidencePath: join(familyRoot, "proofs", "semantic-proofs.md"),
  };
}

function commonDataGate(out) {
  return {
    schema: "nnanything.unified.data-gate.v1",
    partition: "TRAIN",
    encoderVersion: "nnanything.unified-step.encoder.v2",
    thresholdsPath: THRESHOLDS_PATH,
    rowsPath: join(out, "data-gate-rows.jsonl"),
  };
}

function commonCorpus(out, packagePath) {
  return {
    root: join(out, "corpus-union"),
    admissionsPath: join(out, "corpus-admissions.train-only.json"),
    studentRowsPath: join(out, "student-rows.jsonl"),
    supervisionRowsPath: join(out, "supervision-rows.jsonl"),
    packagePath,
    missingModeTablePath: MISSING_MODE_TABLE_PATH,
  };
}

async function writeRunConfigs(out) {
  const commonRoute = { domain: "tsjs", decisionKind: "R" };
  const configs = {
    "convert.runner-config.json": {
      schema: "nnanything.unified.runner-config.v1",
      command: "convert-samples",
      route: commonRoute,
      phase: "sample_migration",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      dataGate: commonDataGate(out),
      outputDir: join(out, "convert-out"),
      corpus: commonCorpus(out, join(out, "convert-package.json")),
    },
    "validate-data.runner-config.json": {
      schema: "nnanything.unified.runner-config.v1",
      command: "validate-data",
      route: commonRoute,
      phase: "validation",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      dataGate: commonDataGate(out),
      outputDir: join(out, "validation-out"),
    },
    "warmstart.runner-config.json": {
      schema: "nnanything.unified.runner-config.v1",
      command: "warmstart",
      route: commonRoute,
      phase: "posttraining",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      dataGate: commonDataGate(out),
      outputDir: join(out, "warmstart-out"),
      corpus: commonCorpus(out, join(out, "candidate-package.json")),
      training: {
        modelId: "nn-code.tsjs.symbols.r",
        version: "0.1.2-post-projection-r1",
        optimizer: "full_batch_sgd",
        learningRate: 0.01,
        maxEpochs: 200,
        seed: 20261104,
        init: "xavier_uniform",
        checkpointPath: join(out, "candidate-package.checkpoint.json"),
      },
      warmStart: { sourcePackagePath: INHERITANCE_SOURCE_PACKAGE },
    },
    "warmstart-acceptance.runner-config.json": {
      schema: "nnanything.unified.runner-config.v1",
      command: "warmstart-acceptance",
      route: commonRoute,
      phase: "evaluation",
      encoderVersion: "nnanything.unified-step.encoder.v2",
      dataGate: commonDataGate(out),
      outputDir: join(out, "warmstart-acceptance-out"),
      warmstartAcceptance: {
        schema: "nnanything.unified.warmstart-acceptance-config.v1",
        rowsReportPath: join(out, "warmstart-out", "run-report.json"),
        sourcePackagePath: INHERITANCE_SOURCE_PACKAGE,
        candidatePackagePath: join(out, "candidate-package.json"),
        candidateCheckpointPath: join(out, "candidate-package.checkpoint.json"),
        rawWarmStartReportPath: join(out, "warmstart-out", "run-report.json"),
        tau: 0.1,
      },
    },
  };
  const reloadConfig = structuredClone(configs["warmstart-acceptance.runner-config.json"]);
  reloadConfig.outputDir = join(out, "new-process-reload-out");
  configs["reload-acceptance.runner-config.json"] = reloadConfig;

  for (const [name, config] of Object.entries(configs)) {
    await writeJson(join(out, name), config);
  }
  return Object.fromEntries(
    Object.keys(configs).map(name => [name, join(out, name)]),
  );
}

async function writeAdmissions(out, materialized) {
  const familyAdmissions = materialized.map(entry => ({
    sourceGroup: entry.sourceGroup,
    partition: "TRAIN",
    admission: "accepted_train_supervision",
    usableForTrainingSupervision: true,
    usableForIndependentVerification: false,
    evidence: entry.evidencePath,
  }));
  const path = join(out, "corpus-admissions.train-only.json");
  await writeJson(path, {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    scope: "post-projection TS/JS TRAIN-only corpus",
    familyAdmissions,
  });
  return path;
}

async function loadHelperDynamicControl(out) {
  const helperDir = join(out, "corpus-union", "tsjs-train-runtime-helper-selector-r1");
  const episodes = await loadStepwiseEpisodeFamily(helperDir);
  const episode = episodes.find(entry => entry.sampleId === "tr-h01");
  if (episode === undefined) throw new Error("helper control lost tr-h01");
  if (
    episode.currentRelation.binding.state !== "known"
    || episode.currentRelation.binding.value.bindingMode !== "dynamic"
    || episode.currentRelation.binding.value.resolution.status !== "dynamic"
  ) {
    throw new Error("tr-h01 dynamic binding changed");
  }
  const judges = relationStepContext(episode).candidateGroup.candidates.filter(candidate => candidate.optionSemantics.startsWith("judge="));
  if (
    judges.length === 0
    || judges.some(candidate =>
      candidate.bindingProjection === null
      || candidate.bindingProjection.bindingMode !== "dynamic"
      || candidate.bindingProjection.resolution.status !== "dynamic")
  ) {
    throw new Error("tr-h01 dynamic candidate projection changed");
  }
  return {
    sampleId: "tr-h01",
    bindingMode: "dynamic",
    resolutionStatus: "dynamic",
    judgeCandidateCount: judges.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const familyRoot = resolve(requireArg(args, "--family-root"));
  const replaySpecPath = resolve(requireArg(args, "--replay-spec"));
  const out = resolve(requireArg(args, "--out"));

  const replaySpec = await readJson(replaySpecPath, "replay spec");
  if (replaySpec.schema !== TSJS_POST_PROJECTION_REPLAY_SPEC_SCHEMA) {
    throw new Error(`replay spec schema must be ${TSJS_POST_PROJECTION_REPLAY_SPEC_SCHEMA}`);
  }
  if (!Array.isArray(replaySpec.families) || replaySpec.families.length !== 4) {
    throw new Error("replay spec must declare exactly four accepted TRAIN inputs");
  }

  await mkdir(join(out, "corpus-union"), { recursive: true });
  const materialized = [];
  for (const input of replaySpec.families) {
    const role = requireString(input.role, "replay family role");
    const sourceGroup = requireString(input.sourceGroup, "replay family sourceGroup");
    const destDir = join(out, "corpus-union", sourceGroup);
    if (role === "retention-contrast") {
      materialized.push(await materializeRetentionFamily({ input, destDir, out }));
    } else {
      materialized.push(await materializeAcceptedFamily({ input, destDir }));
    }
  }
  materialized.push(
    await materializeLexicalFamily({
      familyRoot,
      destDir: join(out, "corpus-union", NEW_SOURCE_GROUP),
      out,
    }),
  );

  const expectedGroups = new Set(materialized.map(entry => entry.sourceGroup));
  if (expectedGroups.size !== materialized.length) {
    throw new Error("materialized source groups are not unique");
  }
  const admissionsPath = await writeAdmissions(out, materialized);
  const configPaths = await writeRunConfigs(out);
  const helperDynamicControl = await loadHelperDynamicControl(out);
  const groupCount = materialized.reduce((sum, entry) => sum + entry.groupCount, 0);
  const supervisionRowCount = materialized.reduce(
    (sum, entry) => sum + entry.supervisionRowCount,
    0,
  );
  const candidateRowCount = materialized.reduce(
    (sum, entry) => sum + entry.candidateRowCount,
    0,
  );
  if (groupCount !== 22 || supervisionRowCount !== 22) {
    throw new Error(
      `reconciliation requires 22 groups/rows, got ${groupCount}/${supervisionRowCount}`,
    );
  }

  const receipt = {
    schema: TSJS_POST_PROJECTION_MATERIALIZE_SCHEMA,
    familyRoot,
    replaySpecPath,
    out,
    admissionsPath,
    configPaths,
    groupCount,
    supervisionRowCount,
    candidateRowCount,
    families: materialized,
    checks: {
      acceptedSupervisionPreserved: true,
      currentCandidateEnumerationUsedForSg: true,
      sourceReadRequiredForLexicalProjection: true,
      missingSourceReadProjectionCount: 0,
      injectedVerdictCount: 0,
      helperDynamicControl,
      protectedHoldInputCount: 0,
    },
  };
  const receiptPath = join(out, "materialize-receipt.json");
  await writeJson(receiptPath, receipt);
  process.stdout.write(`${JSON.stringify({
    receiptPath,
    admissionsPath,
    configPaths,
    groupCount,
    supervisionRowCount,
    candidateRowCount,
  }, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
