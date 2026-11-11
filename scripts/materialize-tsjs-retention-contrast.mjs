// Non-fitting pre-fit materialization entry for the accepted rc-p01 retention
// contrast. Runs the accepted public producer -> bridge -> loader -> encoder
// path for both arms, converts the episodes into unified student rows, and
// writes the fixed config plus an unchanged package copy. No fit, no scoring,
// no candidate selection/adoption, no DEV/VERIFICATION access.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { runTsJsSymbolTable } from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  convertEpisodeToStudentGroup,
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
  STEPWISE_STUDENT_OBSERVATIONS_FILE,
} from "../dist/training/unified-student-converter.js";

export const TSJS_RETENTION_CONTRAST_CONFIG_SCHEMA =
  "nnanything.tsjs.retention-contrast-config.v1";
export const TSJS_RETENTION_CONTRAST_MATERIALIZE_SCHEMA =
  "nnanything.tsjs.retention-contrast-materialize.v1";

const PAIR_REF = "rc-p01";
const SOURCE_GROUP = "tsjs-train-retention-contrast-r1";
const DERIVATION_FAMILY = "rc-r1";
const STEP_ID = "step:0";

// Supervision authority values reuse the accepted TS/JS supervision
// convention: the static false arm matches the static module-relation rows and
// the runtime arm matches the accepted runtime-helper-selector rows.
const ARMS = [
  {
    sampleId: "rc-p01-false",
    entryFile: "sources/rc-p01-false/entry.ts",
    requestedMemberName: "email",
    observationKind: "static_selected",
    allowedCandidateRef: "c:judge:false",
    unknownReason: null,
    labelAuthority: "researcher_structural_proof+typescript_compiler_api",
    oracleKind: "independent_tsc+typescript_compiler_api",
  },
  {
    sampleId: "rc-p01-unknown",
    entryFile: "sources/rc-p01-unknown/entry.ts",
    requestedMemberName: "email",
    observationKind: "runtime_dynamic",
    allowedCandidateRef: "c:judge:unknown",
    unknownReason: "runtime_dynamic_selector",
    labelAuthority: "researcher_semantic_proof",
    oracleKind: "runtime_selector_structural_proof",
  },
];

const UNSUPPORTED_CONTROLS = [
  {
    pairRef: "rc-p02",
    controlSampleId: "control-static-alias",
    reason: "static_alias_unsupported",
  },
  {
    pairRef: "rc-p03",
    controlSampleId: "control-static-nested",
    reason: "static_alias_unsupported",
  },
];

const ACCEPTANCE_GATES = {
  existingTrainRetention: "baseline_18_groups_unchanged",
  helperCompletion: "helper_completion_required_before_fit",
  exposedOldDevRegression: "exposed_old_dev_regression_external_not_read",
  correctnessAndMargin: "authorized_fit_acceptance_only",
  staticSelectedCompletion: "unsupported_separate_prerequisite_before_fit",
};

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requireArg(args, name) {
  const value = valueAfter(args, name);
  if (value === undefined) throw new Error(`missing required ${name}`);
  return value;
}

function declarationForMember(member) {
  return {
    declarationRef: member.callableIdentity.declarationRef,
    moduleRef: `module:${member.callableIdentity.moduleRef}`,
    name: member.name,
    role: "member",
    kind: "function",
    evidenceRefs: [],
  };
}

function bridgeInput({ request, observation, arm, requestedDeclaration }) {
  const requestRef = `request:${arm.sampleId}`;
  const pendingRelationRef = `pending:${arm.sampleId}`;
  return {
    sourceGroup: SOURCE_GROUP,
    language: "typescript",
    semanticStratum: "module_export",
    partition: "TRAIN",
    derivationFamily: DERIVATION_FAMILY,
    sampleId: arm.sampleId,
    entryFile: arm.entryFile,
    request: {
      requestRef,
      requestedDeclaration,
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef: observation.callSiteRef,
        calleeName: "selectDelivery",
      },
    },
    stepId: STEP_ID,
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

function studentRowsForGroup(group) {
  return group.candidates.map(candidate => ({
    schema: "nnanything.unified.student-row.v1",
    group_id: group.group_id,
    sampleId: group.sampleId,
    requestRef: group.requestRef,
    stepId: group.stepId,
    targetRef: group.targetRef,
    pendingRelationRef: group.pendingRelationRef,
    sourceGroup: group.sourceGroup,
    language: group.language,
    adapterRef: group.adapterRef,
    derivationFamily: group.derivationFamily,
    semanticStratum: group.semanticStratum,
    stepContextRef: group.stepContextRef,
    candidateGroupRef: group.candidateGroupRef,
    featureSchemaVersion: group.featureSchemaVersion,
    encoderVersion: group.encoderVersion,
    partition: group.partition,
    candidateEnumeration: group.candidateEnumeration,
    coverageCursorRef: group.coverageCursorRef,
    evidenceRefs: group.evidenceRefs,
    failureMode: group.failureMode,
    candidateRef: candidate.candidateRef,
    optionSemantics: candidate.optionSemantics,
    candidateKind: candidate.candidateKind,
    x: candidate.input,
    missingMode: candidate.missingMode,
  }));
}

function supervisionRowForArm(group, arm) {
  const present = group.candidates.some(
    candidate => candidate.candidateRef === arm.allowedCandidateRef,
  );
  if (!present) {
    throw new Error(
      `${arm.sampleId} group ${group.group_id} does not contain ${arm.allowedCandidateRef}`,
    );
  }
  return {
    schema: "nnanything.unified.supervision-row.v1",
    group_id: group.group_id,
    sampleId: group.sampleId,
    sourceGroup: group.sourceGroup,
    partition: group.partition,
    goldAllowedCandidateRefs: [arm.allowedCandidateRef],
    labelMissing: false,
    unknownReason: arm.unknownReason,
    labelAuthority: arm.labelAuthority,
    oracleKind: arm.oracleKind,
    teacherResolutionRef: null,
    requestRef: group.requestRef,
    stepId: group.stepId,
    trainingEligible: true,
    notReadyReason: null,
    agSubsetOfSg: true,
  };
}

async function materializeArm({ repo, out, arm }) {
  const helperFile = arm.entryFile.replace(/entry\.ts$/, "lookup.ts");
  const request = {
    repo,
    language: "typescript",
    scope: ["."],
    files: [arm.entryFile, helperFile],
  };
  const producer = await runTsJsSymbolTable(request);
  if (producer.status !== "ok") {
    throw new Error(
      `producer failed for ${arm.sampleId}: ${JSON.stringify(producer)}`,
    );
  }
  const staticObs = producer.result.staticSelectedSelectorObservations ?? [];
  const dynamicObs = producer.result.runtimeSelectorObservations ?? [];
  const observation = staticObs[0] ?? dynamicObs[0];
  if (observation === undefined) {
    throw new Error(`no producer observation for ${arm.sampleId}`);
  }
  const observedKind = staticObs.length > 0 ? "static_selected" : "runtime_dynamic";
  if (observedKind !== arm.observationKind) {
    throw new Error(
      `${arm.sampleId} produced ${observedKind}, expected ${arm.observationKind}`,
    );
  }
  const requested = observation.callableTable.members.find(
    member => member.name === arm.requestedMemberName,
  );
  if (requested === undefined) {
    throw new Error(
      `${arm.sampleId} has no requested member ${arm.requestedMemberName}`,
    );
  }
  const bridge = await observeTsJsStepwiseRequest(
    bridgeInput({
      request,
      observation,
      arm,
      requestedDeclaration: declarationForMember(requested),
    }),
  );
  if (bridge.record === null || bridge.reasons.length > 0) {
    throw new Error(
      `${arm.sampleId} bridge failed: ${JSON.stringify(bridge.reasons)}`,
    );
  }
  const record = bridge.record;
  const armDir = join(out, "samples", arm.sampleId);
  await mkdir(armDir, { recursive: true });
  await writeFile(
    join(armDir, "manifest.json"),
    `${JSON.stringify(
      {
        sourceGroup: record.sourceGroup,
        language: record.language,
        semanticStratum: record.semanticStratum,
        partition: record.partition,
        derivationFamily: { familyId: record.family },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(armDir, STEPWISE_STUDENT_OBSERVATIONS_FILE),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
  const episodes = await loadStepwiseEpisodeFamily(armDir);
  if (episodes.length !== 1) {
    throw new Error(
      `${arm.sampleId} materialized ${episodes.length} episodes, expected 1`,
    );
  }
  const group = convertEpisodeToStudentGroup(episodes[0]);
  const studentRows = studentRowsForGroup(group);
  const supervisionRow = supervisionRowForArm(group, arm);
  const producerSource =
    record.steps[0]?.receipts?.[0]?.producerSource?.kind ?? null;
  return {
    sampleId: arm.sampleId,
    observationKind: observedKind,
    observationRef: observation.observationRef,
    producerSourceKind: producerSource,
    groupId: group.group_id,
    allowedCandidateRef: arm.allowedCandidateRef,
    unknownReason: arm.unknownReason,
    candidateCount: group.candidates.length,
    studentRows,
    supervisionRow,
  };
}

async function readBaselineText(path) {
  const text = await readFile(path, "utf8");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

async function main() {
  const args = process.argv.slice(2);
  const repo = resolve(requireArg(args, "--repo"));
  const initializationSourcePackagePath = resolve(
    requireArg(args, "--initialization-source"),
  );
  const baselineStudentRowsPath = resolve(
    requireArg(args, "--baseline-student"),
  );
  const baselineSupervisionRowsPath = resolve(
    requireArg(args, "--baseline-supervision"),
  );
  const out = resolve(requireArg(args, "--out"));

  await mkdir(out, { recursive: true });

  const arms = [];
  for (const arm of ARMS) {
    arms.push(await materializeArm({ repo, out, arm }));
  }

  const studentRowsPath = join(out, "student-rows.jsonl");
  const supervisionRowsPath = join(out, "supervision-rows.jsonl");
  const baselineStudentText = await readBaselineText(baselineStudentRowsPath);
  const baselineSupervisionText = await readBaselineText(
    baselineSupervisionRowsPath,
  );
  const armStudentLines = arms.flatMap(arm =>
    arm.studentRows.map(row => JSON.stringify(row)),
  );
  const armSupervisionLines = arms.map(arm =>
    JSON.stringify(arm.supervisionRow),
  );
  await writeFile(
    studentRowsPath,
    `${baselineStudentText}\n${armStudentLines.join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    supervisionRowsPath,
    `${baselineSupervisionText}\n${armSupervisionLines.join("\n")}\n`,
    "utf8",
  );

  const packagePath = join(out, "model-package.json");
  await copyFile(initializationSourcePackagePath, packagePath);

  const config = {
    schema: TSJS_RETENTION_CONTRAST_CONFIG_SCHEMA,
    initializationSourcePackagePath,
    packagePath,
    baselineStudentRowsPath,
    baselineSupervisionRowsPath,
    studentRowsPath,
    supervisionRowsPath,
    expectedBaselineGroupCount: 18,
    expectedFinalGroupCount: 20,
    contrastPairs: [
      {
        pairRef: PAIR_REF,
        falseArm: {
          sampleId: ARMS[0].sampleId,
          observationKind: ARMS[0].observationKind,
          allowedCandidateRef: ARMS[0].allowedCandidateRef,
          unknownReason: ARMS[0].unknownReason,
        },
        unknownArm: {
          sampleId: ARMS[1].sampleId,
          observationKind: ARMS[1].observationKind,
          allowedCandidateRef: ARMS[1].allowedCandidateRef,
          unknownReason: ARMS[1].unknownReason,
        },
      },
    ],
    unsupportedControls: UNSUPPORTED_CONTROLS,
    acceptanceGates: ACCEPTANCE_GATES,
  };
  const configPath = join(out, "config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const receipt = {
    schema: TSJS_RETENTION_CONTRAST_MATERIALIZE_SCHEMA,
    repo,
    out,
    configPath,
    packagePath,
    studentRowsPath,
    supervisionRowsPath,
    initializationSourcePackagePath,
    baselineStudentRowsPath,
    baselineSupervisionRowsPath,
    expectedFinalGroupCount: 20,
    arms: arms.map(arm => ({
      sampleId: arm.sampleId,
      observationKind: arm.observationKind,
      observationRef: arm.observationRef,
      producerSourceKind: arm.producerSourceKind,
      groupId: arm.groupId,
      allowedCandidateRef: arm.allowedCandidateRef,
      unknownReason: arm.unknownReason,
      candidateCount: arm.candidateCount,
      studentRowCount: arm.studentRows.length,
    })),
  };
  const receiptPath = join(out, "materialize-receipt.json");
  await writeFile(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
