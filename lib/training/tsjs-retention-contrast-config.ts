import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildEncodedGroups,
  loadStudentRowsFile,
  loadSupervisionRowsFile,
} from "./unified-train-config.js";
import {
  loadUnifiedModelPackageFromFile,
  type UnifiedModelPackage,
} from "./unified-model-package.js";
import {
  convertEpisodeToStudentGroup,
  loadStepwiseEpisodeFamily,
  type StudentGroup,
} from "./unified-student-converter.js";
import type { SupervisionRow } from "./unified-supervision-converter.js";

export const TSJS_RETENTION_CONTRAST_CONFIG_SCHEMA =
  "nnanything.tsjs.retention-contrast-config.v1" as const;
export const TSJS_RETENTION_CONTRAST_REPORT_SCHEMA =
  "nnanything.tsjs.retention-contrast-config-report.v1" as const;

export type TsjsRetentionContrastObservationKind =
  | "static_selected"
  | "runtime_dynamic";

export interface TsjsRetentionContrastArm {
  readonly sampleId: string;
  readonly observationKind: TsjsRetentionContrastObservationKind;
  readonly allowedCandidateRef: string;
  readonly unknownReason: string | null;
}

export interface TsjsRetentionContrastPair {
  readonly pairRef: string;
  readonly falseArm: TsjsRetentionContrastArm;
  readonly unknownArm: TsjsRetentionContrastArm;
}

export interface TsjsRetentionContrastUnsupportedControl {
  readonly pairRef: string;
  readonly controlSampleId: string;
  readonly reason: "static_alias_unsupported";
}

export interface TsjsRetentionContrastAcceptanceGates {
  readonly existingTrainRetention: "baseline_18_groups_unchanged";
  readonly helperCompletion: "helper_completion_required_before_fit";
  readonly exposedOldDevRegression: "exposed_old_dev_regression_external_not_read";
  readonly correctnessAndMargin: "authorized_fit_acceptance_only";
  readonly staticSelectedCompletion: "unsupported_separate_prerequisite_before_fit";
}

export interface TsjsRetentionContrastConfig {
  readonly schema: typeof TSJS_RETENTION_CONTRAST_CONFIG_SCHEMA;
  readonly initializationSourcePackagePath: string;
  readonly packagePath: string;
  readonly baselineStudentRowsPath: string;
  readonly baselineSupervisionRowsPath: string;
  readonly studentRowsPath: string;
  readonly supervisionRowsPath: string;
  readonly expectedBaselineGroupCount: 18;
  readonly expectedFinalGroupCount: 20;
  readonly contrastPairs: readonly TsjsRetentionContrastPair[];
  readonly unsupportedControls: readonly TsjsRetentionContrastUnsupportedControl[];
  readonly acceptanceGates: TsjsRetentionContrastAcceptanceGates;
}

export interface TsjsRetentionContrastPairReport {
  readonly pairRef: string;
  readonly falseArm: {
    readonly groupId: string;
    readonly sampleId: string;
    readonly observationKind: TsjsRetentionContrastObservationKind;
    readonly allowedCandidateRef: string;
    readonly unknownReason: string | null;
  };
  readonly unknownArm: {
    readonly groupId: string;
    readonly sampleId: string;
    readonly observationKind: TsjsRetentionContrastObservationKind;
    readonly allowedCandidateRef: string;
    readonly unknownReason: string | null;
  };
}

export interface TsjsRetentionContrastConfigReport {
  readonly schema: typeof TSJS_RETENTION_CONTRAST_REPORT_SCHEMA;
  readonly status: "READY" | "FAILED";
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: Readonly<Record<string, unknown>> | null;
  } | null;
  readonly initializationSourcePackagePath: string | null;
  readonly packagePath: string | null;
  readonly package: {
    readonly modelId: string;
    readonly version: string;
    readonly route: UnifiedModelPackage["route"];
    readonly inputSchema: UnifiedModelPackage["inputSchema"];
    readonly encoderVersion: string;
  } | null;
  readonly counts: {
    readonly baselineGroups: number;
    readonly finalGroups: number;
    readonly baselineSupervisionRows: number;
    readonly finalSupervisionRows: number;
    readonly contrastGroups: number;
    readonly studentRows: number;
    readonly unsupportedControls: number;
    readonly denominator: number;
  } | null;
  readonly pairs: readonly TsjsRetentionContrastPairReport[];
  readonly unsupportedControls: readonly TsjsRetentionContrastUnsupportedControl[];
  readonly acceptanceGates: TsjsRetentionContrastAcceptanceGates | null;
}

export interface TsjsRetentionContrastValidationResult {
  readonly exitCode: 0 | 1;
  readonly report: TsjsRetentionContrastConfigReport;
}

class RetentionContrastConfigFailure extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>> | null;

  constructor(
    code: string,
    message: string,
    detail: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "RetentionContrastConfigFailure";
    this.code = code;
    this.detail = detail;
  }
}

const CONFIG_KEYS = new Set([
  "schema",
  "initializationSourcePackagePath",
  "packagePath",
  "baselineStudentRowsPath",
  "baselineSupervisionRowsPath",
  "studentRowsPath",
  "supervisionRowsPath",
  "expectedBaselineGroupCount",
  "expectedFinalGroupCount",
  "contrastPairs",
  "unsupportedControls",
  "acceptanceGates",
]);

const ARM_KEYS = new Set([
  "sampleId",
  "observationKind",
  "allowedCandidateRef",
  "unknownReason",
]);

const PAIR_KEYS = new Set(["pairRef", "falseArm", "unknownArm"]);

const UNSUPPORTED_CONTROL_KEYS = new Set([
  "pairRef",
  "controlSampleId",
  "reason",
]);

const ACCEPTANCE_GATE_KEYS = new Set([
  "existingTrainRetention",
  "helperCompletion",
  "exposedOldDevRegression",
  "correctnessAndMargin",
  "staticSelectedCompletion",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function requireObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      `${field} must be an object`,
    );
  }
  return value;
}

function rejectExtraKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const extra = Object.keys(value).filter(key => !allowed.has(key));
  if (extra.length > 0) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      `${field} has unexpected field(s): ${extra.join(", ")}`,
      { extra },
    );
  }
}

function parseArm(value: unknown, field: string): TsjsRetentionContrastArm {
  const raw = requireObject(value, field);
  rejectExtraKeys(raw, ARM_KEYS, field);
  const observationKind = requireString(
    raw.observationKind,
    `${field}.observationKind`,
  );
  if (
    observationKind !== "static_selected"
    && observationKind !== "runtime_dynamic"
  ) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      `${field}.observationKind must be static_selected or runtime_dynamic`,
    );
  }
  if (raw.unknownReason !== null && typeof raw.unknownReason !== "string") {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      `${field}.unknownReason must be a string or null`,
    );
  }
  return {
    sampleId: requireString(raw.sampleId, `${field}.sampleId`),
    observationKind,
    allowedCandidateRef: requireString(
      raw.allowedCandidateRef,
      `${field}.allowedCandidateRef`,
    ),
    unknownReason: raw.unknownReason,
  };
}

function parsePair(
  value: unknown,
  index: number,
): TsjsRetentionContrastPair {
  const field = `config.contrastPairs[${index}]`;
  const raw = requireObject(value, field);
  rejectExtraKeys(raw, PAIR_KEYS, field);
  return {
    pairRef: requireString(raw.pairRef, `${field}.pairRef`),
    falseArm: parseArm(raw.falseArm, `${field}.falseArm`),
    unknownArm: parseArm(raw.unknownArm, `${field}.unknownArm`),
  };
}

function parseUnsupportedControl(
  value: unknown,
  index: number,
): TsjsRetentionContrastUnsupportedControl {
  const field = `config.unsupportedControls[${index}]`;
  const raw = requireObject(value, field);
  rejectExtraKeys(raw, UNSUPPORTED_CONTROL_KEYS, field);
  if (raw.reason !== "static_alias_unsupported") {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      `${field}.reason must be static_alias_unsupported`,
    );
  }
  return {
    pairRef: requireString(raw.pairRef, `${field}.pairRef`),
    controlSampleId: requireString(
      raw.controlSampleId,
      `${field}.controlSampleId`,
    ),
    reason: "static_alias_unsupported",
  };
}

function requireLiteral(
  value: unknown,
  expected: string,
  field: string,
): string {
  if (value !== expected) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      `${field} must be ${expected}`,
    );
  }
  return expected;
}

function parseAcceptanceGates(
  value: unknown,
): TsjsRetentionContrastAcceptanceGates {
  const field = "config.acceptanceGates";
  const raw = requireObject(value, field);
  rejectExtraKeys(raw, ACCEPTANCE_GATE_KEYS, field);
  return {
    existingTrainRetention: requireLiteral(
      raw.existingTrainRetention,
      "baseline_18_groups_unchanged",
      `${field}.existingTrainRetention`,
    ) as TsjsRetentionContrastAcceptanceGates["existingTrainRetention"],
    helperCompletion: requireLiteral(
      raw.helperCompletion,
      "helper_completion_required_before_fit",
      `${field}.helperCompletion`,
    ) as TsjsRetentionContrastAcceptanceGates["helperCompletion"],
    exposedOldDevRegression: requireLiteral(
      raw.exposedOldDevRegression,
      "exposed_old_dev_regression_external_not_read",
      `${field}.exposedOldDevRegression`,
    ) as TsjsRetentionContrastAcceptanceGates["exposedOldDevRegression"],
    correctnessAndMargin: requireLiteral(
      raw.correctnessAndMargin,
      "authorized_fit_acceptance_only",
      `${field}.correctnessAndMargin`,
    ) as TsjsRetentionContrastAcceptanceGates["correctnessAndMargin"],
    staticSelectedCompletion: requireLiteral(
      raw.staticSelectedCompletion,
      "unsupported_separate_prerequisite_before_fit",
      `${field}.staticSelectedCompletion`,
    ) as TsjsRetentionContrastAcceptanceGates["staticSelectedCompletion"],
  };
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  code: string,
  field: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const current = key(value);
    if (seen.has(current)) {
      throw new RetentionContrastConfigFailure(
        code,
        `${field} contains duplicate ${current}`,
        { value: current },
      );
    }
    seen.add(current);
  }
}

function parseConfig(value: unknown): TsjsRetentionContrastConfig {
  const raw = requireObject(value, "config");
  rejectExtraKeys(raw, CONFIG_KEYS, "config");
  if (raw.schema !== TSJS_RETENTION_CONTRAST_CONFIG_SCHEMA) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      `config.schema must be ${TSJS_RETENTION_CONTRAST_CONFIG_SCHEMA}`,
    );
  }
  if (raw.expectedBaselineGroupCount !== 18) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      "config.expectedBaselineGroupCount must be 18",
    );
  }
  if (raw.expectedFinalGroupCount !== 20) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      "config.expectedFinalGroupCount must be 20",
    );
  }
  if (!Array.isArray(raw.contrastPairs)) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      "config.contrastPairs must be an array",
    );
  }
  if (!Array.isArray(raw.unsupportedControls)) {
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      "config.unsupportedControls must be an array",
    );
  }
  const contrastPairs = raw.contrastPairs.map(parsePair);
  const unsupportedControls = raw.unsupportedControls.map(
    parseUnsupportedControl,
  );
  uniqueBy(
    contrastPairs,
    pair => pair.pairRef,
    "CONFIG_INVALID",
    "contrastPairs",
  );
  uniqueBy(
    unsupportedControls,
    control => control.pairRef,
    "CONFIG_INVALID",
    "unsupportedControls",
  );
  const pairRefs = new Set(contrastPairs.map(pair => pair.pairRef));
  for (const control of unsupportedControls) {
    if (pairRefs.has(control.pairRef)) {
      throw new RetentionContrastConfigFailure(
        "CONFIG_INVALID",
        `pairRef ${control.pairRef} cannot be supported and unsupported`,
      );
    }
  }
  const arms = contrastPairs.flatMap(pair => [pair.falseArm, pair.unknownArm]);
  uniqueBy(
    arms,
    arm => arm.sampleId,
    "CONFIG_INVALID",
    "contrast arm sampleId",
  );
  return {
    schema: TSJS_RETENTION_CONTRAST_CONFIG_SCHEMA,
    initializationSourcePackagePath: requireString(
      raw.initializationSourcePackagePath,
      "config.initializationSourcePackagePath",
    ),
    packagePath: requireString(raw.packagePath, "config.packagePath"),
    baselineStudentRowsPath: requireString(
      raw.baselineStudentRowsPath,
      "config.baselineStudentRowsPath",
    ),
    baselineSupervisionRowsPath: requireString(
      raw.baselineSupervisionRowsPath,
      "config.baselineSupervisionRowsPath",
    ),
    studentRowsPath: requireString(
      raw.studentRowsPath,
      "config.studentRowsPath",
    ),
    supervisionRowsPath: requireString(
      raw.supervisionRowsPath,
      "config.supervisionRowsPath",
    ),
    expectedBaselineGroupCount: 18,
    expectedFinalGroupCount: 20,
    contrastPairs,
    unsupportedControls,
    acceptanceGates: parseAcceptanceGates(raw.acceptanceGates),
  };
}

export async function loadTsjsRetentionContrastConfig(
  configPath: string,
): Promise<TsjsRetentionContrastConfig> {
  const resolvedPath = resolve(configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new RetentionContrastConfigFailure(
      "CONFIG_INVALID",
      `cannot load config ${resolvedPath}: ${message}`,
    );
  }
  return parseConfig(parsed);
}

async function assertUniqueJsonlGroups(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new RetentionContrastConfigFailure(
      "ROWS_INVALID",
      `cannot read ${path}: ${message}`,
    );
  }
  const seen = new Set<string>();
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new RetentionContrastConfigFailure(
        "ROWS_INVALID",
        `${path}:${index + 1} is not valid JSON: ${message}`,
      );
    }
    const row = requireObject(parsed, `${path}:${index + 1}`);
    const groupId = requireString(
      row.group_id,
      `${path}:${index + 1}.group_id`,
    );
    if (seen.has(groupId)) {
      throw new RetentionContrastConfigFailure(
        "GROUP_DUPLICATE",
        `${path} repeats group_id ${groupId}`,
        { groupId },
      );
    }
    seen.add(groupId);
  }
}

function groupMap(
  groups: readonly StudentGroup[],
): ReadonlyMap<string, StudentGroup> {
  const byId = new Map<string, StudentGroup>();
  for (const group of groups) {
    const duplicate = group.candidates.filter(
      (candidate, index, values) =>
        values.findIndex(
          entry => entry.candidateRef === candidate.candidateRef,
        ) !== index,
    );
    if (duplicate.length > 0) {
      throw new RetentionContrastConfigFailure(
        "CANDIDATE_DUPLICATE",
        `group ${group.group_id} repeats candidate ${duplicate[0]!.candidateRef}`,
        { groupId: group.group_id },
      );
    }
    byId.set(group.group_id, group);
  }
  return byId;
}

function supervisionMap(
  rows: readonly SupervisionRow[],
): ReadonlyMap<string, SupervisionRow> {
  const byId = new Map<string, SupervisionRow>();
  for (const row of rows) {
    if (byId.has(row.group_id)) {
      throw new RetentionContrastConfigFailure(
        "GROUP_DUPLICATE",
        `duplicate supervision group ${row.group_id}`,
        { groupId: row.group_id },
      );
    }
    byId.set(row.group_id, row);
  }
  return byId;
}

function assertPackageEqual(
  packageValue: UnifiedModelPackage,
  initializationSource: UnifiedModelPackage,
): void {
  if (!isDeepStrictEqual(packageValue, initializationSource)) {
    throw new RetentionContrastConfigFailure(
      "INITIALIZATION_SOURCE_MISMATCH",
      "fixed package does not retain the accepted initialization source",
    );
  }
}

function assertPackageContract(packageValue: UnifiedModelPackage): void {
  if (
    packageValue.route.domain !== "tsjs"
    || packageValue.route.decisionKind !== "R"
  ) {
    throw new RetentionContrastConfigFailure(
      "PACKAGE_INCOMPATIBLE",
      "fixed package route must be tsjs/R",
    );
  }
  if (packageValue.inputSchema !== "nnanything.unified-step.v1") {
    throw new RetentionContrastConfigFailure(
      "PACKAGE_INCOMPATIBLE",
      "fixed package inputSchema must be nnanything.unified-step.v1",
    );
  }
  if (packageValue.encoderVersion !== "nnanything.unified-step.encoder.v2") {
    throw new RetentionContrastConfigFailure(
      "PACKAGE_INCOMPATIBLE",
      "fixed package encoderVersion must be nnanything.unified-step.encoder.v2",
    );
  }
  const architecture = packageValue.architecture;
  if (
    architecture.input !== 64
    || architecture.hidden.length !== 2
    || architecture.hidden[0] !== 64
    || architecture.hidden[1] !== 64
    || architecture.output !== 1
    || architecture.activation !== "relu"
  ) {
    throw new RetentionContrastConfigFailure(
      "PACKAGE_INCOMPATIBLE",
      "fixed package architecture must be 64 -> 64 -> 64 -> 1 (ReLU)",
    );
  }
}

function assertBaselineRetained(
  baselineStudent: ReadonlyMap<string, StudentGroup>,
  baselineSupervision: ReadonlyMap<string, SupervisionRow>,
  finalStudent: ReadonlyMap<string, StudentGroup>,
  finalSupervision: ReadonlyMap<string, SupervisionRow>,
): void {
  for (const [groupId, baseline] of baselineStudent) {
    const current = finalStudent.get(groupId);
    if (current === undefined) {
      throw new RetentionContrastConfigFailure(
        "BASELINE_GROUP_MISSING",
        `baseline student group ${groupId} is missing`,
        { groupId },
      );
    }
    if (!isDeepStrictEqual(current, baseline)) {
      throw new RetentionContrastConfigFailure(
        "BASELINE_GROUP_CHANGED",
        `baseline student group ${groupId} changed`,
        { groupId },
      );
    }
  }
  for (const [groupId, baseline] of baselineSupervision) {
    const current = finalSupervision.get(groupId);
    if (current === undefined) {
      throw new RetentionContrastConfigFailure(
        "BASELINE_GROUP_MISSING",
        `baseline supervision group ${groupId} is missing`,
        { groupId },
      );
    }
    if (!isDeepStrictEqual(current, baseline)) {
      throw new RetentionContrastConfigFailure(
        "BASELINE_GROUP_CHANGED",
        `baseline supervision group ${groupId} changed`,
        { groupId },
      );
    }
  }
}

function groupsForArm(
  groups: readonly StudentGroup[],
  sampleId: string,
): readonly StudentGroup[] {
  return groups.filter(group => group.sampleId === sampleId);
}

function validateArm(input: {
  readonly arm: TsjsRetentionContrastArm;
  readonly groups: readonly StudentGroup[];
  readonly supervision: ReadonlyMap<string, SupervisionRow>;
}): TsjsRetentionContrastPairReport["falseArm"] {
  const candidates = groupsForArm(input.groups, input.arm.sampleId);
  if (candidates.length === 0) {
    throw new RetentionContrastConfigFailure(
      "PAIR_ARM_MISSING",
      `contrast arm ${input.arm.sampleId} is missing`,
      { sampleId: input.arm.sampleId },
    );
  }
  if (candidates.length > 1) {
    throw new RetentionContrastConfigFailure(
      "PAIR_ARM_DUPLICATE",
      `contrast arm ${input.arm.sampleId} has ${candidates.length} groups`,
      { sampleId: input.arm.sampleId },
    );
  }
  const group = candidates[0]!;
  const supervision = input.supervision.get(group.group_id);
  if (supervision === undefined) {
    throw new RetentionContrastConfigFailure(
      "PAIR_ARM_MISSING",
      `contrast arm ${input.arm.sampleId} has no supervision row`,
      { sampleId: input.arm.sampleId },
    );
  }
  if (group.partition !== "TRAIN" || supervision.partition !== "TRAIN") {
    throw new RetentionContrastConfigFailure(
      "PARTITION_VIOLATION",
      `contrast arm ${input.arm.sampleId} must remain TRAIN-only`,
      { sampleId: input.arm.sampleId },
    );
  }
  if (supervision.labelMissing || supervision.trainingEligible !== true) {
    throw new RetentionContrastConfigFailure(
      "ARM_SUPERVISION_INVALID",
      `contrast arm ${input.arm.sampleId} must be labelled and training-eligible`,
      { sampleId: input.arm.sampleId },
    );
  }
  if (
    supervision.goldAllowedCandidateRefs.length !== 1
    || supervision.goldAllowedCandidateRefs[0] !== input.arm.allowedCandidateRef
  ) {
    throw new RetentionContrastConfigFailure(
      "ARM_SUPERVISION_INVALID",
      `contrast arm ${input.arm.sampleId} must allow exactly ${input.arm.allowedCandidateRef}`,
      { sampleId: input.arm.sampleId },
    );
  }
  if (!group.candidates.some(
    candidate => candidate.candidateRef === input.arm.allowedCandidateRef,
  )) {
    throw new RetentionContrastConfigFailure(
      "ARM_SEMANTICS_INVALID",
      `contrast arm ${input.arm.sampleId} does not contain ${input.arm.allowedCandidateRef}`,
      { sampleId: input.arm.sampleId },
    );
  }
  if (supervision.unknownReason !== input.arm.unknownReason) {
    throw new RetentionContrastConfigFailure(
      "ARM_SEMANTICS_INVALID",
      `contrast arm ${input.arm.sampleId} unknownReason must be ${String(
        input.arm.unknownReason,
      )}`,
      { sampleId: input.arm.sampleId },
    );
  }
  if (
    input.arm.observationKind === "runtime_dynamic"
    && input.arm.unknownReason !== "runtime_dynamic_selector"
  ) {
    throw new RetentionContrastConfigFailure(
      "ARM_SEMANTICS_INVALID",
      `runtime arm ${input.arm.sampleId} must retain runtime_dynamic_selector`,
      { sampleId: input.arm.sampleId },
    );
  }
  return {
    groupId: group.group_id,
    sampleId: group.sampleId,
    observationKind: input.arm.observationKind,
    allowedCandidateRef: input.arm.allowedCandidateRef,
    unknownReason: supervision.unknownReason,
  };
}

async function assertArmSourceFidelity(input: {
  readonly studentRowsPath: string;
  readonly arm: TsjsRetentionContrastArm;
  readonly finalGroup: StudentGroup;
}): Promise<void> {
  const sampleDir = join(
    dirname(resolve(input.studentRowsPath)),
    "samples",
    input.arm.sampleId,
  );
  let episodes;
  try {
    episodes = await loadStepwiseEpisodeFamily(sampleDir);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new RetentionContrastConfigFailure(
      "ARM_SOURCE_INVALID",
      `cannot load persisted source observations for ${input.arm.sampleId}: ${message}`,
      { sampleId: input.arm.sampleId, sampleDir },
    );
  }
  if (episodes.length !== 1) {
    throw new RetentionContrastConfigFailure(
      "ARM_SOURCE_INVALID",
      `contrast arm ${input.arm.sampleId} has ${episodes.length} source episodes, expected 1`,
      { sampleId: input.arm.sampleId, sampleDir },
    );
  }
  const sourceGroup = convertEpisodeToStudentGroup(episodes[0]!);
  if (!isDeepStrictEqual(sourceGroup, input.finalGroup)) {
    throw new RetentionContrastConfigFailure(
      "ARM_SOURCE_FIDELITY_MISMATCH",
      `contrast arm ${input.arm.sampleId} rows do not match their persisted source observations`,
      { sampleId: input.arm.sampleId, sampleDir },
    );
  }
}

function errorFromCaught(caught: unknown): {
  readonly code: string;
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
} {
  if (caught instanceof RetentionContrastConfigFailure) {
    return {
      code: caught.code,
      message: caught.message,
      detail: caught.detail,
    };
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  const detail = isRecord(caught) && isRecord(caught.detail)
    ? caught.detail
    : null;
  const code = isRecord(caught) && typeof caught.code === "string"
    ? caught.code
    : "VALIDATION_FAILED";
  return { code, message, detail };
}

export async function runTsjsRetentionContrastConfigValidation(
  rawConfig: unknown,
): Promise<TsjsRetentionContrastValidationResult> {
  let initializationSourcePackagePath: string | null = null;
  let packagePath: string | null = null;
  let packageReport: TsjsRetentionContrastConfigReport["package"] = null;
  let counts: TsjsRetentionContrastConfigReport["counts"] = null;
  let pairs: readonly TsjsRetentionContrastPairReport[] = [];
  let unsupportedControls: readonly TsjsRetentionContrastUnsupportedControl[] =
    [];
  let acceptanceGates: TsjsRetentionContrastAcceptanceGates | null = null;
  try {
    const config = parseConfig(rawConfig);
    initializationSourcePackagePath = resolve(
      config.initializationSourcePackagePath,
    );
    packagePath = resolve(config.packagePath);
    acceptanceGates = config.acceptanceGates;

    const [loadedPackage, loadedInitializationSource] = await Promise.all([
      loadUnifiedModelPackageFromFile(packagePath),
      loadUnifiedModelPackageFromFile(initializationSourcePackagePath),
    ]);
    assertPackageEqual(
      loadedPackage.package,
      loadedInitializationSource.package,
    );
    assertPackageContract(loadedPackage.package);
    packageReport = {
      modelId: loadedPackage.package.modelId,
      version: loadedPackage.package.version,
      route: loadedPackage.package.route,
      inputSchema: loadedPackage.package.inputSchema,
      encoderVersion: loadedPackage.package.encoderVersion,
    };

    // Student candidate rows legitimately repeat group_id once per candidate.
    await assertUniqueJsonlGroups(config.supervisionRowsPath);
    const [baselineStudentGroups, baselineSupervisionRows, finalStudentGroups, finalSupervisionRows] =
      await Promise.all([
        loadStudentRowsFile(config.baselineStudentRowsPath),
        loadSupervisionRowsFile(config.baselineSupervisionRowsPath),
        loadStudentRowsFile(config.studentRowsPath),
        loadSupervisionRowsFile(config.supervisionRowsPath),
      ]);
    const baselineStudent = groupMap(baselineStudentGroups);
    const baselineSupervision = supervisionMap(baselineSupervisionRows);
    const finalStudent = groupMap(finalStudentGroups);
    const finalSupervision = supervisionMap(finalSupervisionRows);
    if (baselineStudent.size !== config.expectedBaselineGroupCount) {
      throw new RetentionContrastConfigFailure(
        "BASELINE_COUNT_MISMATCH",
        `baseline student group count is ${baselineStudent.size}, expected ${config.expectedBaselineGroupCount}`,
      );
    }
    if (baselineSupervision.size !== config.expectedBaselineGroupCount) {
      throw new RetentionContrastConfigFailure(
        "BASELINE_COUNT_MISMATCH",
        `baseline supervision group count is ${baselineSupervision.size}, expected ${config.expectedBaselineGroupCount}`,
      );
    }
    assertBaselineRetained(
      baselineStudent,
      baselineSupervision,
      finalStudent,
      finalSupervision,
    );

    const expectedArmGroupIds = new Set<string>();
    const pairReports: TsjsRetentionContrastPairReport[] = [];
    for (const pair of config.contrastPairs) {
      const falseArm = validateArm({
        arm: pair.falseArm,
        groups: finalStudentGroups,
        supervision: finalSupervision,
      });
      const unknownArm = validateArm({
        arm: pair.unknownArm,
        groups: finalStudentGroups,
        supervision: finalSupervision,
      });
      expectedArmGroupIds.add(falseArm.groupId);
      expectedArmGroupIds.add(unknownArm.groupId);
      await assertArmSourceFidelity({
        studentRowsPath: config.studentRowsPath,
        arm: pair.falseArm,
        finalGroup: finalStudent.get(falseArm.groupId)!,
      });
      await assertArmSourceFidelity({
        studentRowsPath: config.studentRowsPath,
        arm: pair.unknownArm,
        finalGroup: finalStudent.get(unknownArm.groupId)!,
      });
      pairReports.push({ pairRef: pair.pairRef, falseArm, unknownArm });
    }
    pairs = pairReports;

    // Run the unsupported-control scan before the generic unexpected-group
    // scan so an admitted alias/nested control reports the specific
    // zero-contribution violation instead of a generic extra group.
    for (const control of config.unsupportedControls) {
      if (
        finalStudentGroups.some(
          group => group.sampleId === control.controlSampleId,
        )
        || finalSupervisionRows.some(
          row => row.sampleId === control.controlSampleId,
        )
      ) {
        throw new RetentionContrastConfigFailure(
          "UNSUPPORTED_CONTROL_PRESENT",
          `${control.pairRef} control ${control.controlSampleId} must contribute zero groups`,
          {
            pairRef: control.pairRef,
            controlSampleId: control.controlSampleId,
          },
        );
      }
    }

    const unexpectedGroups = finalStudentGroups.filter(
      group =>
        !baselineStudent.has(group.group_id)
        && !expectedArmGroupIds.has(group.group_id),
    );
    if (unexpectedGroups.length > 0) {
      throw new RetentionContrastConfigFailure(
        "GROUP_UNEXPECTED",
        `fixed package contains unexpected group ${unexpectedGroups[0]!.group_id}`,
        { groupIds: unexpectedGroups.map(group => group.group_id) },
      );
    }
    const unexpectedSupervision = finalSupervisionRows.filter(
      row =>
        !baselineSupervision.has(row.group_id)
        && !expectedArmGroupIds.has(row.group_id),
    );
    if (unexpectedSupervision.length > 0) {
      throw new RetentionContrastConfigFailure(
        "GROUP_UNEXPECTED",
        `fixed package contains unexpected supervision group ${unexpectedSupervision[0]!.group_id}`,
        { groupIds: unexpectedSupervision.map(row => row.group_id) },
      );
    }
    const expectedArmSampleIds = new Set(
      config.contrastPairs.flatMap(pair => [
        pair.falseArm.sampleId,
        pair.unknownArm.sampleId,
      ]),
    );
    const finalArmSampleIds = new Set(
      finalStudentGroups
        .filter(
          group =>
            !baselineStudent.has(group.group_id)
            && expectedArmGroupIds.has(group.group_id),
        )
        .map(group => group.sampleId),
    );
    for (const sampleId of expectedArmSampleIds) {
      if (!finalArmSampleIds.has(sampleId)) {
        throw new RetentionContrastConfigFailure(
          "PAIR_ARM_MISSING",
          `contrast arm ${sampleId} is missing`,
          { sampleId },
        );
      }
    }
    if (
      finalStudent.size !== config.expectedFinalGroupCount
      || finalSupervision.size !== config.expectedFinalGroupCount
    ) {
      throw new RetentionContrastConfigFailure(
        "GROUP_COUNT_MISMATCH",
        `final group count is student=${finalStudent.size}, supervision=${finalSupervision.size}; expected ${config.expectedFinalGroupCount}`,
      );
    }
    if (
      config.expectedFinalGroupCount - config.expectedBaselineGroupCount
        !== config.contrastPairs.length * 2
    ) {
      throw new RetentionContrastConfigFailure(
        "DENOMINATOR_INVALID",
        "final denominator must equal baseline plus two groups per supported pair",
      );
    }
    const encodedGroups = buildEncodedGroups(
      finalStudentGroups,
      finalSupervisionRows,
    );
    if (encodedGroups.length !== config.expectedFinalGroupCount) {
      throw new RetentionContrastConfigFailure(
        "GROUP_COUNT_MISMATCH",
        `encoded denominator is ${encodedGroups.length}, expected ${config.expectedFinalGroupCount}`,
      );
    }
    counts = {
      baselineGroups: baselineStudent.size,
      finalGroups: finalStudent.size,
      baselineSupervisionRows: baselineSupervision.size,
      finalSupervisionRows: finalSupervision.size,
      contrastGroups: expectedArmGroupIds.size,
      studentRows: finalStudentGroups.reduce(
        (sum, group) => sum + group.candidates.length,
        0,
      ),
      unsupportedControls: config.unsupportedControls.length,
      denominator: encodedGroups.length,
    };
    unsupportedControls = config.unsupportedControls.map(control => ({
      ...control,
    }));
  } catch (caught) {
    return {
      exitCode: 1,
      report: {
        schema: TSJS_RETENTION_CONTRAST_REPORT_SCHEMA,
        status: "FAILED",
        error: errorFromCaught(caught),
        initializationSourcePackagePath,
        packagePath,
        package: packageReport,
        counts,
        pairs,
        unsupportedControls,
        acceptanceGates,
      },
    };
  }
  return {
    exitCode: 0,
    report: {
      schema: TSJS_RETENTION_CONTRAST_REPORT_SCHEMA,
      status: "READY",
      error: null,
      initializationSourcePackagePath,
      packagePath,
      package: packageReport,
      counts,
      pairs,
      unsupportedControls,
      acceptanceGates,
    },
  };
}
