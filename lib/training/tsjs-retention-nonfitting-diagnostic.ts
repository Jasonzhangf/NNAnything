import { resolve } from "node:path";
import {
  UNIFIED_ENCODER_VERSION,
  UNIFIED_INPUT_SCHEMA,
} from "./unified-encoder.js";
import {
  validateEncodedGroup,
  type EncodedGroup,
} from "./group-loss.js";
import {
  type ModelRoute,
  loadUnifiedModelPackageFromFile,
  type UnifiedModelPackage,
  type UnifiedModelPackageResource,
} from "./unified-model-package.js";
import {
  type UnifiedTensors,
} from "./unified-forward.js";
import {
  buildEncodedGroups,
  loadStudentRowsFile,
  loadSupervisionRowsFile,
} from "./unified-train-config.js";
import {
  scoresOf,
  selectedCandidate,
} from "./unified-warmstart-acceptance.js";
import {
  type StudentGroup,
} from "./unified-student-converter.js";
import {
  type SupervisionRow,
} from "./unified-supervision-converter.js";

export const TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA =
  "nnanything.tsjs.retention-nonfitting-diagnostic.config.v1" as const;
export const TSJS_RETENTION_NONFITTING_DIAGNOSTIC_REPORT_SCHEMA =
  "nnanything.tsjs.retention-nonfitting-diagnostic.report.v1" as const;

export interface TsjsRetentionNonfittingComparison {
  readonly comparisonRef: string;
  readonly pairRef: string;
  readonly leftGroupId: string;
  readonly leftCandidateRef: string;
  readonly rightGroupId: string;
  readonly rightCandidateRef: string;
}

export interface TsjsRetentionNonfittingDiagnosticConfig {
  readonly schema: typeof TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA;
  readonly sourcePackagePath: string;
  readonly renewedPackagePath: string;
  readonly studentRowsPath: string;
  readonly supervisionRowsPath: string;
  readonly tau: 0.1;
  readonly comparisons?: readonly TsjsRetentionNonfittingComparison[];
}

export interface TsjsRetentionNonfittingDiagnosticError {
  readonly code: string;
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

export interface TsjsRetentionNonfittingPackageMetadata {
  readonly packagePath: string;
  readonly modelId: string;
  readonly version: string;
  readonly route: ModelRoute;
  readonly inputSchema: UnifiedModelPackage["inputSchema"];
  readonly encoderVersion: string;
  readonly architecture: UnifiedModelPackage["architecture"];
}

export interface TsjsRetentionNonfittingLabelMissingRow {
  readonly groupId: string;
  readonly sampleId: string;
  readonly sourceGroup: string;
  readonly partition: SupervisionRow["partition"];
  readonly unknownReason: string | null;
  readonly teacherResolutionRef: string | null;
}

export interface TsjsRetentionNonfittingCandidateResult {
  readonly candidateRef: string;
  readonly optionSemantics: string;
  readonly candidateKind: string;
  readonly vector: readonly number[];
  readonly sourceScore: number;
  readonly renewedScore: number;
  readonly scoreDelta: number;
  readonly sourceSelected: boolean;
  readonly renewedSelected: boolean;
}

export interface TsjsRetentionNonfittingPackageDecision {
  readonly selectedCandidateRef: string;
  readonly goldAllowedScore: number;
  readonly nonGoldMaximum: number;
  readonly margin: number;
  readonly marginOk: boolean;
}

export interface TsjsRetentionNonfittingScore {
  readonly candidateRef: string;
  readonly score: number;
}

export interface TsjsRetentionNonfittingGroupClassification {
  readonly featureCollision: boolean | null;
  readonly scoreChange: boolean;
  readonly candidatePolicySelection: boolean;
}

export interface TsjsRetentionNonfittingGroupResult {
  readonly groupId: string;
  readonly sampleId: string;
  readonly sourceGroup: string;
  readonly partition: StudentGroup["partition"];
  readonly allowedCandidateRefs: readonly string[];
  readonly sourceScores: readonly TsjsRetentionNonfittingScore[];
  readonly renewedScores: readonly TsjsRetentionNonfittingScore[];
  readonly candidates: readonly TsjsRetentionNonfittingCandidateResult[];
  readonly source: TsjsRetentionNonfittingPackageDecision;
  readonly renewed: TsjsRetentionNonfittingPackageDecision;
  readonly marginDelta: number;
  readonly classification: TsjsRetentionNonfittingGroupClassification;
}

export interface TsjsRetentionNonfittingComparisonResult {
  readonly comparisonRef: string;
  readonly pairRef: string;
  readonly leftGroupId: string;
  readonly leftCandidateRef: string;
  readonly rightGroupId: string;
  readonly rightCandidateRef: string;
  readonly featureCollision: boolean;
  readonly differingSlotsOutsideOptionIdentity: readonly number[];
  readonly optionIdentityDifferences: readonly number[];
}

export interface TsjsRetentionNonfittingDiagnosticSummary {
  readonly groups: number;
  readonly candidates: number;
  readonly labelMissingExclusions: number;
  readonly comparisons: number;
  readonly collisions: number;
  readonly scoreChanges: number;
  readonly policySelectionChanges: number;
}

export interface TsjsRetentionNonfittingDiagnosticReport {
  readonly schema: typeof TSJS_RETENTION_NONFITTING_DIAGNOSTIC_REPORT_SCHEMA;
  readonly status: "completed" | "failed";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly error: TsjsRetentionNonfittingDiagnosticError | null;
  readonly inputs: {
    readonly sourcePackagePath: string | null;
    readonly renewedPackagePath: string | null;
    readonly studentRowsPath: string | null;
    readonly supervisionRowsPath: string | null;
    readonly tau: 0.1 | null;
  };
  readonly sourcePackage: TsjsRetentionNonfittingPackageMetadata | null;
  readonly renewedPackage: TsjsRetentionNonfittingPackageMetadata | null;
  readonly labelMissing: {
    readonly rows: readonly TsjsRetentionNonfittingLabelMissingRow[];
    readonly count: number;
  };
  readonly groups: readonly TsjsRetentionNonfittingGroupResult[];
  readonly comparisons:
    | "not_requested"
    | readonly TsjsRetentionNonfittingComparisonResult[];
  readonly summary: TsjsRetentionNonfittingDiagnosticSummary;
}

export interface TsjsRetentionNonfittingDiagnosticRunResult {
  readonly exitCode: 0 | 1;
  readonly report: TsjsRetentionNonfittingDiagnosticReport;
}

class RetentionDiagnosticFailure extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>> | null;

  constructor(
    code: string,
    message: string,
    detail: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "RetentionDiagnosticFailure";
    this.code = code;
    this.detail = detail;
  }
}

const CONFIG_KEYS = new Set([
  "schema",
  "sourcePackagePath",
  "renewedPackagePath",
  "studentRowsPath",
  "supervisionRowsPath",
  "tau",
  "comparisons",
]);

const COMPARISON_KEYS = new Set([
  "comparisonRef",
  "pairRef",
  "leftGroupId",
  "leftCandidateRef",
  "rightGroupId",
  "rightCandidateRef",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RetentionDiagnosticFailure("CONFIG_INVALID", `${field} must be a non-empty string`);
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RetentionDiagnosticFailure("CONFIG_INVALID", `${field} must be an object`);
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
    throw new RetentionDiagnosticFailure(
      "CONFIG_INVALID",
      `${field} has unexpected field(s): ${extra.join(", ")}`,
      { extra },
    );
  }
}

function parseComparison(value: unknown, index: number): TsjsRetentionNonfittingComparison {
  const raw = requireObject(value, `config.comparisons[${index}]`);
  rejectExtraKeys(raw, COMPARISON_KEYS, `config.comparisons[${index}]`);
  return {
    comparisonRef: requireString(raw.comparisonRef, `config.comparisons[${index}].comparisonRef`),
    pairRef: requireString(raw.pairRef, `config.comparisons[${index}].pairRef`),
    leftGroupId: requireString(raw.leftGroupId, `config.comparisons[${index}].leftGroupId`),
    leftCandidateRef: requireString(raw.leftCandidateRef, `config.comparisons[${index}].leftCandidateRef`),
    rightGroupId: requireString(raw.rightGroupId, `config.comparisons[${index}].rightGroupId`),
    rightCandidateRef: requireString(raw.rightCandidateRef, `config.comparisons[${index}].rightCandidateRef`),
  };
}

function parseConfig(value: unknown): TsjsRetentionNonfittingDiagnosticConfig {
  const raw = requireObject(value, "config");
  rejectExtraKeys(raw, CONFIG_KEYS, "config");
  if (raw.schema !== TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA) {
    throw new RetentionDiagnosticFailure(
      "CONFIG_INVALID",
      `config.schema must be ${TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA}`,
    );
  }
  if (raw.tau !== 0.1) {
    throw new RetentionDiagnosticFailure("CONFIG_INVALID", `config.tau must be the fixed 0.1, got ${String(raw.tau)}`);
  }
  const comparisons = raw.comparisons === undefined
    ? undefined
    : Array.isArray(raw.comparisons)
      ? raw.comparisons.map(parseComparison)
      : (() => {
          throw new RetentionDiagnosticFailure("CONFIG_INVALID", "config.comparisons must be an array");
        })();
  return {
    schema: TSJS_RETENTION_NONFITTING_DIAGNOSTIC_CONFIG_SCHEMA,
    sourcePackagePath: requireString(raw.sourcePackagePath, "config.sourcePackagePath"),
    renewedPackagePath: requireString(raw.renewedPackagePath, "config.renewedPackagePath"),
    studentRowsPath: requireString(raw.studentRowsPath, "config.studentRowsPath"),
    supervisionRowsPath: requireString(raw.supervisionRowsPath, "config.supervisionRowsPath"),
    tau: 0.1,
    ...(comparisons === undefined ? {} : { comparisons }),
  };
}

function resolvedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? resolve(value) : null;
}

function packageMetadata(loaded: UnifiedModelPackageResource): TsjsRetentionNonfittingPackageMetadata {
  const pkg = loaded.package;
  return {
    packagePath: loaded.packagePath,
    modelId: pkg.modelId,
    version: pkg.version,
    route: { ...pkg.route },
    inputSchema: pkg.inputSchema,
    encoderVersion: pkg.encoderVersion,
    architecture: {
      ...pkg.architecture,
      hidden: [pkg.architecture.hidden[0], pkg.architecture.hidden[1]],
    },
  };
}

function assertPackageCompatibility(
  source: TsjsRetentionNonfittingPackageMetadata,
  renewed: TsjsRetentionNonfittingPackageMetadata,
): void {
  const mismatches: string[] = [];
  if (source.route.domain !== renewed.route.domain || source.route.decisionKind !== renewed.route.decisionKind) {
    mismatches.push("route");
  }
  if (source.encoderVersion !== renewed.encoderVersion) {
    mismatches.push("encoderVersion");
  }
  if (source.inputSchema !== renewed.inputSchema) {
    mismatches.push("inputSchema");
  }
  if (JSON.stringify(source.architecture) !== JSON.stringify(renewed.architecture)) {
    mismatches.push("architecture");
  }
  if (source.encoderVersion !== UNIFIED_ENCODER_VERSION) {
    mismatches.push("source encoderVersion");
  }
  if (renewed.encoderVersion !== UNIFIED_ENCODER_VERSION) {
    mismatches.push("renewed encoderVersion");
  }
  if (source.inputSchema !== UNIFIED_INPUT_SCHEMA) {
    mismatches.push("source inputSchema");
  }
  if (renewed.inputSchema !== UNIFIED_INPUT_SCHEMA) {
    mismatches.push("renewed inputSchema");
  }
  if (mismatches.length > 0) {
    throw new RetentionDiagnosticFailure(
      "PACKAGE_INCOMPATIBLE",
      `source and renewed packages are incompatible: ${[...new Set(mismatches)].join(", ")}`,
      { mismatches: [...new Set(mismatches)] },
    );
  }
}

function rethrowWithFallback(caught: unknown, fallbackCode: string): never {
  if (caught instanceof RetentionDiagnosticFailure) throw caught;
  const message = caught instanceof Error ? caught.message : String(caught);
  const detail = isRecord(caught) && isRecord(caught.detail) ? caught.detail : null;
  const code = isRecord(caught) && typeof caught.code === "string" ? caught.code : fallbackCode;
  throw new RetentionDiagnosticFailure(code, message, detail);
}

function errorFromCaught(caught: unknown): TsjsRetentionNonfittingDiagnosticError {
  if (caught instanceof RetentionDiagnosticFailure) {
    return {
      code: caught.code,
      message: caught.message,
      detail: caught.detail,
    };
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  const detail = isRecord(caught) && isRecord(caught.detail) ? caught.detail : null;
  const code = isRecord(caught) && typeof caught.code === "string" ? caught.code : "DIAGNOSTIC_FAILED";
  return { code, message, detail };
}

async function loadStudentRows(path: string): Promise<readonly StudentGroup[]> {
  try {
    return await loadStudentRowsFile(path);
  } catch (caught) {
    rethrowWithFallback(caught, "ROWS_INVALID");
  }
}

async function loadSupervisionRows(path: string): Promise<readonly SupervisionRow[]> {
  try {
    return await loadSupervisionRowsFile(path);
  } catch (caught) {
    rethrowWithFallback(caught, "ROWS_INVALID");
  }
}

function assertUniqueSupervisionRows(rows: readonly SupervisionRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.group_id)) {
      throw new RetentionDiagnosticFailure(
        "ROWS_INVALID",
        `duplicate supervision row for group_id ${row.group_id}`,
        { groupId: row.group_id },
      );
    }
    seen.add(row.group_id);
  }
}

function toLabelMissingRow(row: SupervisionRow): TsjsRetentionNonfittingLabelMissingRow {
  return {
    groupId: row.group_id,
    sampleId: row.sampleId,
    sourceGroup: row.sourceGroup,
    partition: row.partition,
    unknownReason: row.unknownReason,
    teacherResolutionRef: row.teacherResolutionRef,
  };
}

function scoresFor(
  group: EncodedGroup,
  tensors: UnifiedTensors,
): readonly TsjsRetentionNonfittingScore[] {
  try {
    return scoresOf(group, tensors);
  } catch (caught) {
    rethrowWithFallback(caught, "SCORING_FAILED");
  }
}

function decideGroup(
  scores: readonly TsjsRetentionNonfittingScore[],
  allowedCandidateRefs: readonly string[],
  tau: 0.1,
): TsjsRetentionNonfittingPackageDecision {
  let selected: string;
  try {
    selected = selectedCandidate(scores);
  } catch (caught) {
    rethrowWithFallback(caught, "SCORING_FAILED");
  }
  const allowed = new Set(allowedCandidateRefs);
  const allowedScores = scores.filter(entry => allowed.has(entry.candidateRef));
  if (allowedScores.length === 0) {
    throw new RetentionDiagnosticFailure(
      "SCORING_FAILED",
      "allowed candidate set has no scored candidates",
    );
  }
  const nonGold = scores.filter(entry => !allowed.has(entry.candidateRef));
  if (nonGold.length === 0) {
    throw new RetentionDiagnosticFailure(
      "SCORING_FAILED",
      "group has no non-gold candidate",
    );
  }
  const goldAllowedScore = Math.max(...allowedScores.map(entry => entry.score));
  const nonGoldMaximum = Math.max(...nonGold.map(entry => entry.score));
  const margin = goldAllowedScore - nonGoldMaximum;
  return {
    selectedCandidateRef: selected,
    goldAllowedScore,
    nonGoldMaximum,
    margin,
    marginOk: allowed.has(selected) && margin >= tau,
  };
}

function evaluateGroup(
  group: EncodedGroup,
  student: StudentGroup,
  sourceTensors: UnifiedTensors,
  renewedTensors: UnifiedTensors,
  tau: 0.1,
  featureCollision: boolean | null,
): TsjsRetentionNonfittingGroupResult {
  const sourceScores = scoresFor(group, sourceTensors);
  const renewedScores = scoresFor(group, renewedTensors);
  const source = decideGroup(sourceScores, group.allowedCandidateRefs, tau);
  const renewed = decideGroup(renewedScores, group.allowedCandidateRefs, tau);
  const sourceByRef = new Map(sourceScores.map(entry => [entry.candidateRef, entry.score]));
  const renewedByRef = new Map(renewedScores.map(entry => [entry.candidateRef, entry.score]));
  const candidates = group.candidates.map(candidate => {
    const sourceScore = sourceByRef.get(candidate.candidateRef);
    const renewedScore = renewedByRef.get(candidate.candidateRef);
    if (sourceScore === undefined || renewedScore === undefined) {
      throw new RetentionDiagnosticFailure(
        "SCORING_FAILED",
        `candidate ${candidate.candidateRef} is missing from a score set`,
        { groupId: group.groupRef, candidateRef: candidate.candidateRef },
      );
    }
    return {
      candidateRef: candidate.candidateRef,
      optionSemantics: candidate.optionSemantics,
      candidateKind: candidate.candidateKind,
      vector: [...candidate.input],
      sourceScore,
      renewedScore,
      scoreDelta: renewedScore - sourceScore,
      sourceSelected: source.selectedCandidateRef === candidate.candidateRef,
      renewedSelected: renewed.selectedCandidateRef === candidate.candidateRef,
    };
  });
  const scoreChange = candidates.some(candidate => candidate.sourceScore !== candidate.renewedScore);
  const candidatePolicySelection =
    source.selectedCandidateRef !== renewed.selectedCandidateRef
    || source.margin !== renewed.margin;
  return {
    groupId: group.groupRef,
    sampleId: student.sampleId,
    sourceGroup: student.sourceGroup,
    partition: student.partition,
    allowedCandidateRefs: [...group.allowedCandidateRefs],
    sourceScores: sourceScores.map(entry => ({ ...entry })),
    renewedScores: renewedScores.map(entry => ({ ...entry })),
    candidates,
    source,
    renewed,
    marginDelta: renewed.margin - source.margin,
    classification: {
      featureCollision,
      scoreChange,
      candidatePolicySelection,
    },
  };
}

function evaluateComparisons(
  comparisons: readonly TsjsRetentionNonfittingComparison[],
  groups: ReadonlyMap<string, EncodedGroup>,
): readonly TsjsRetentionNonfittingComparisonResult[] {
  return comparisons.map(comparison => {
    const leftGroup = groups.get(comparison.leftGroupId);
    if (leftGroup === undefined) {
      throw new RetentionDiagnosticFailure(
        "COMPARISON_TARGET_MISSING",
        `comparison ${comparison.comparisonRef} left group ${comparison.leftGroupId} is missing`,
      );
    }
    const rightGroup = groups.get(comparison.rightGroupId);
    if (rightGroup === undefined) {
      throw new RetentionDiagnosticFailure(
        "COMPARISON_TARGET_MISSING",
        `comparison ${comparison.comparisonRef} right group ${comparison.rightGroupId} is missing`,
      );
    }
    const left = leftGroup.candidates.find(candidate => candidate.candidateRef === comparison.leftCandidateRef);
    if (left === undefined) {
      throw new RetentionDiagnosticFailure(
        "COMPARISON_TARGET_MISSING",
        `comparison ${comparison.comparisonRef} left candidate ${comparison.leftCandidateRef} is missing`,
      );
    }
    const right = rightGroup.candidates.find(candidate => candidate.candidateRef === comparison.rightCandidateRef);
    if (right === undefined) {
      throw new RetentionDiagnosticFailure(
        "COMPARISON_TARGET_MISSING",
        `comparison ${comparison.comparisonRef} right candidate ${comparison.rightCandidateRef} is missing`,
      );
    }
    const differingSlotsOutsideOptionIdentity: number[] = [];
    const optionIdentityDifferences: number[] = [];
    for (let slot = 0; slot < 64; slot += 1) {
      if (left.input[slot] === right.input[slot]) continue;
      if (slot === 36 || slot === 37 || slot === 38) {
        optionIdentityDifferences.push(slot);
      } else {
        differingSlotsOutsideOptionIdentity.push(slot);
      }
    }
    return {
      ...comparison,
      featureCollision: differingSlotsOutsideOptionIdentity.length === 0,
      differingSlotsOutsideOptionIdentity,
      optionIdentityDifferences,
    };
  });
}

function featureCollisionForGroup(
  groupId: string,
  comparisons: "not_requested" | readonly TsjsRetentionNonfittingComparisonResult[],
): boolean | null {
  if (comparisons === "not_requested") return null;
  const groupComparisons = comparisons.filter(
    comparison => comparison.leftGroupId === groupId || comparison.rightGroupId === groupId,
  );
  if (groupComparisons.length === 0) return null;
  return groupComparisons.some(comparison => comparison.featureCollision);
}

function summaryOf(
  groups: readonly TsjsRetentionNonfittingGroupResult[],
  labelMissingRows: readonly TsjsRetentionNonfittingLabelMissingRow[],
  comparisons: "not_requested" | readonly TsjsRetentionNonfittingComparisonResult[],
): TsjsRetentionNonfittingDiagnosticSummary {
  const comparisonEntries = comparisons === "not_requested" ? [] : comparisons;
  return {
    groups: groups.length,
    candidates: groups.reduce((sum, group) => sum + group.candidates.length, 0),
    labelMissingExclusions: labelMissingRows.length,
    comparisons: comparisonEntries.length,
    collisions: comparisonEntries.filter(comparison => comparison.featureCollision).length,
    scoreChanges: groups.filter(group => group.classification.scoreChange).length,
    policySelectionChanges: groups.filter(group => group.classification.candidatePolicySelection).length,
  };
}

function buildReport(input: {
  readonly status: "completed" | "failed";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly error: TsjsRetentionNonfittingDiagnosticError | null;
  readonly inputs: TsjsRetentionNonfittingDiagnosticReport["inputs"];
  readonly sourcePackage: TsjsRetentionNonfittingPackageMetadata | null;
  readonly renewedPackage: TsjsRetentionNonfittingPackageMetadata | null;
  readonly labelMissingRows: readonly TsjsRetentionNonfittingLabelMissingRow[];
  readonly groups: readonly TsjsRetentionNonfittingGroupResult[];
  readonly comparisons: "not_requested" | readonly TsjsRetentionNonfittingComparisonResult[];
}): TsjsRetentionNonfittingDiagnosticReport {
  return {
    schema: TSJS_RETENTION_NONFITTING_DIAGNOSTIC_REPORT_SCHEMA,
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    error: input.error,
    inputs: input.inputs,
    sourcePackage: input.sourcePackage,
    renewedPackage: input.renewedPackage,
    labelMissing: {
      rows: input.labelMissingRows,
      count: input.labelMissingRows.length,
    },
    groups: input.groups,
    comparisons: input.comparisons,
    summary: summaryOf(input.groups, input.labelMissingRows, input.comparisons),
  };
}

export async function runTsjsRetentionNonfittingDiagnostic(
  rawConfig: unknown,
): Promise<TsjsRetentionNonfittingDiagnosticRunResult> {
  const startedAt = new Date().toISOString();
  let inputs: TsjsRetentionNonfittingDiagnosticReport["inputs"] = {
    sourcePackagePath: null,
    renewedPackagePath: null,
    studentRowsPath: null,
    supervisionRowsPath: null,
    tau: null,
  };
  let sourcePackage: TsjsRetentionNonfittingPackageMetadata | null = null;
  let renewedPackage: TsjsRetentionNonfittingPackageMetadata | null = null;
  let labelMissingRows: readonly TsjsRetentionNonfittingLabelMissingRow[] = [];
  let groups: readonly TsjsRetentionNonfittingGroupResult[] = [];
  let comparisons: "not_requested" | readonly TsjsRetentionNonfittingComparisonResult[] = "not_requested";

  try {
    const config = parseConfig(rawConfig);
    inputs = {
      sourcePackagePath: resolve(config.sourcePackagePath),
      renewedPackagePath: resolve(config.renewedPackagePath),
      studentRowsPath: resolve(config.studentRowsPath),
      supervisionRowsPath: resolve(config.supervisionRowsPath),
      tau: config.tau,
    };

    const loadedSource = await loadUnifiedModelPackageFromFile(config.sourcePackagePath);
    const loadedRenewed = await loadUnifiedModelPackageFromFile(config.renewedPackagePath);
    sourcePackage = packageMetadata(loadedSource);
    renewedPackage = packageMetadata(loadedRenewed);
    assertPackageCompatibility(sourcePackage, renewedPackage);

    const studentGroups = await loadStudentRows(config.studentRowsPath);
    const supervisionRows = await loadSupervisionRows(config.supervisionRowsPath);
    assertUniqueSupervisionRows(supervisionRows);
    labelMissingRows = supervisionRows
      .filter(row => row.labelMissing)
      .map(toLabelMissingRow);

    const encodedGroups = buildEncodedGroups(studentGroups, supervisionRows);
    for (const group of encodedGroups) {
      try {
        validateEncodedGroup(group);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        throw new RetentionDiagnosticFailure(
          "ROWS_INVALID",
          `encoded group ${group.groupRef} is invalid: ${message}`,
        );
      }
    }

    const encodedByGroup = new Map(encodedGroups.map(group => [group.groupRef, group]));
    comparisons = config.comparisons === undefined
      ? "not_requested"
      : evaluateComparisons(config.comparisons, encodedByGroup);

    const studentByGroup = new Map(studentGroups.map(group => [group.group_id, group]));
    groups = encodedGroups.map(group => {
      const student = studentByGroup.get(group.groupRef);
      if (student === undefined) {
        throw new RetentionDiagnosticFailure(
          "ROWS_INVALID",
          `student metadata for assessed group ${group.groupRef} is missing`,
        );
      }
      return evaluateGroup(
        group,
        student,
        loadedSource.package.tensors,
        loadedRenewed.package.tensors,
        config.tau,
        featureCollisionForGroup(group.groupRef, comparisons),
      );
    });

    return {
      exitCode: 0,
      report: buildReport({
        status: "completed",
        startedAt,
        endedAt: new Date().toISOString(),
        error: null,
        inputs,
        sourcePackage,
        renewedPackage,
        labelMissingRows,
        groups,
        comparisons,
      }),
    };
  } catch (caught) {
    return {
      exitCode: 1,
      report: buildReport({
        status: "failed",
        startedAt,
        endedAt: new Date().toISOString(),
        error: errorFromCaught(caught),
        inputs,
        sourcePackage,
        renewedPackage,
        labelMissingRows,
        groups,
        comparisons,
      }),
    };
  }
}
