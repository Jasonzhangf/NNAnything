// Supervision-side converter: independent gold -> A_g rows.
//
// Path B of the launch contract (§4.4.2). It reads `labels/gold.jsonl` only and
// emits `group_id -> goldAllowedCandidateRefs`, `labelMissing`, `unknownReason`,
// `labelAuthority`, `oracleKind`, and a teacher-only reference. It never emits
// `x[64]` and never writes into `student-rows/`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_RELATION_STEP_ID,
  relationCandidateGroupRef,
  relationContextId,
} from "./unified-step-context-builder.js";
import {
  loadStepwiseFamilyManifest,
  studentGroupId,
  partitionOf,
} from "./unified-student-converter.js";

export const UNIFIED_SUPERVISION_ROW_SCHEMA = "nnanything.unified.supervision-row.v1" as const;
export const STEPWISE_SUPERVISION_FILE = "independent-supervision.jsonl" as const;
export const STEPWISE_SUPERVISION_SCHEMA = "emma-tsjs-independent-action-supervision-v1" as const;
// Accepted fixed-generator schema kind. Its per-step S_g/A_g and join fields are
// already the v2 shape; the loader only needs to admit the schema kind.
export const FIXED_STEPWISE_SUPERVISION_SCHEMA = "carol-tsjs-fixed-stepwise-supervision-v1" as const;

export interface SupervisionRow {
  readonly schema: typeof UNIFIED_SUPERVISION_ROW_SCHEMA;
  readonly group_id: string;
  readonly sampleId: string;
  readonly sourceGroup: string;
  readonly partition: "TRAIN" | "DEV" | "VERIFICATION";
  readonly goldAllowedCandidateRefs: readonly string[];
  readonly labelMissing: boolean;
  readonly unknownReason: string | null;
  readonly labelAuthority: string;
  readonly oracleKind: string;
  readonly teacherResolutionRef: string | null;
  readonly trainingEligible?: boolean;
}

export interface StepwiseSupervisionStep {
  readonly stepId: string;
  readonly S_g: readonly string[];
  readonly A_g: readonly string[];
  readonly agSubsetOfSg: boolean;
  readonly labelAuthority: string;
  readonly oracleKind: string;
  readonly unknownReason: string | null;
}

export interface StepwiseSupervisionRecord {
  readonly schemaVersion: typeof STEPWISE_SUPERVISION_SCHEMA;
  readonly sampleId: string;
  readonly family: string;
  readonly requestRef: string;
  readonly steps: readonly StepwiseSupervisionStep[];
  readonly trainingEligible: boolean;
  readonly notReadyReason: string | null;
}

export interface StepwiseSupervisionRow extends SupervisionRow {
  readonly requestRef: string;
  readonly stepId: string;
  readonly trainingEligible: boolean;
  readonly notReadyReason: string | null;
  readonly agSubsetOfSg: boolean;
}

export interface GoldRecord {
  readonly sampleId: string;
  readonly stepId?: string;
  readonly sourceGroup: string;
  readonly partition: string;
  readonly labelMissing: boolean;
  readonly unknownReason: string | null;
  readonly goldAction: string;
  readonly labelAuthority: string;
  readonly oracleKind: string;
}

export class SupervisionConverterError extends Error {
  readonly code = "SUPERVISION_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "SupervisionConverterError";
  }
}

export function convertGoldToSupervisionRow(gold: GoldRecord): SupervisionRow {
  if (!gold.labelMissing) {
    if (typeof gold.goldAction !== "string" || !gold.goldAction.startsWith("c:judge:")) {
      throw new SupervisionConverterError(
        `sample ${gold.sampleId} has a non-judge gold action: ${String(gold.goldAction)}`,
      );
    }
  }
  const stepId = gold.stepId ?? DEFAULT_RELATION_STEP_ID;
  return {
    schema: UNIFIED_SUPERVISION_ROW_SCHEMA,
    group_id: studentGroupId({
      sourceGroup: gold.sourceGroup,
      sampleId: gold.sampleId,
      stepContextRef: relationContextId(gold.sampleId, stepId),
      candidateGroupRef: relationCandidateGroupRef(gold.sampleId, stepId),
    }),
    sampleId: gold.sampleId,
    sourceGroup: gold.sourceGroup,
    partition: partitionOf(gold.partition),
    goldAllowedCandidateRefs: gold.labelMissing ? [] : [gold.goldAction],
    labelMissing: gold.labelMissing,
    unknownReason: gold.unknownReason,
    labelAuthority: gold.labelAuthority,
    oracleKind: gold.oracleKind,
    teacherResolutionRef: `teacher:${gold.sampleId}`,
  };
}

export async function loadGoldFamily(familyDir: string): Promise<readonly GoldRecord[]> {
  const text = await readFile(join(familyDir, "labels", "gold.jsonl"), "utf8");
  const records: GoldRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const raw = JSON.parse(line) as GoldRecord;
    records.push(raw);
  }
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

export function convertStepwiseSupervisionStep(input: {
  readonly record: StepwiseSupervisionRecord;
  readonly step: StepwiseSupervisionStep;
  readonly sourceGroup: string;
  readonly partition: string;
}): StepwiseSupervisionRow {
  const { record, step, sourceGroup, partition } = input;
  const candidateSet = new Set(step.S_g);
  const agSubsetOfSg = step.A_g.every(ref => candidateSet.has(ref));
  if (record.trainingEligible && agSubsetOfSg !== step.agSubsetOfSg) {
    throw new SupervisionConverterError(
      `sample ${record.sampleId} ${step.stepId} A_g subset flag disagrees with S_g`,
    );
  }
  if (record.trainingEligible && step.A_g.length === 0) {
    throw new SupervisionConverterError(
      `sample ${record.sampleId} ${step.stepId} is training eligible but has an empty A_g`,
    );
  }
  return {
    schema: UNIFIED_SUPERVISION_ROW_SCHEMA,
    group_id: studentGroupId({
      sourceGroup,
      sampleId: record.sampleId,
      stepContextRef: relationContextId(record.sampleId, step.stepId),
      candidateGroupRef: relationCandidateGroupRef(record.sampleId, step.stepId),
    }),
    sampleId: record.sampleId,
    sourceGroup,
    partition: partitionOf(partition),
    goldAllowedCandidateRefs: step.A_g,
    labelMissing: false,
    unknownReason: step.unknownReason,
    labelAuthority: step.labelAuthority,
    oracleKind: step.oracleKind,
    teacherResolutionRef: null,
    requestRef: record.requestRef,
    stepId: step.stepId,
    trainingEligible: record.trainingEligible,
    notReadyReason: record.notReadyReason,
    agSubsetOfSg,
  };
}

export async function loadStepwiseSupervisionFamily(
  familyDir: string,
): Promise<readonly StepwiseSupervisionRow[]> {
  const manifest = await loadStepwiseFamilyManifest(familyDir);
  const supervisionPath = join(familyDir, STEPWISE_SUPERVISION_FILE);
  const parsed = (await readFile(supervisionPath, "utf8"))
    .split("\n")
    .flatMap((line, index) => {
      if (line.trim().length === 0) return [];
      try {
        return [JSON.parse(line) as unknown];
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        throw new TypeError(`${supervisionPath} line ${index + 1} is invalid JSON: ${message}`);
      }
    });
  const rows: StepwiseSupervisionRow[] = [];
  const seenSamples = new Set<string>();
  const seenSteps = new Set<string>();
  for (const [recordIndex, rawRecord] of parsed.entries()) {
    if (!isRecord(rawRecord)) {
      throw new TypeError(`supervision record ${recordIndex + 1} must be an object`);
    }
    if (
      rawRecord.schemaVersion !== STEPWISE_SUPERVISION_SCHEMA
      && rawRecord.schemaVersion !== FIXED_STEPWISE_SUPERVISION_SCHEMA
    ) {
      throw new TypeError(`supervision record ${recordIndex + 1} has an unsupported schemaVersion`);
    }
    const sampleId = requireString(rawRecord.sampleId, "supervision.sampleId");
    if (seenSamples.has(sampleId)) throw new TypeError(`duplicate supervision sample ${sampleId}`);
    seenSamples.add(sampleId);
    const family = requireString(rawRecord.family, `sample ${sampleId} family`);
    const requestRef = requireString(rawRecord.requestRef, `sample ${sampleId} requestRef`);
    const trainingEligible = rawRecord.trainingEligible === true;
    const notReadyReason = typeof rawRecord.notReadyReason === "string"
      ? rawRecord.notReadyReason
      : null;
    if (!Array.isArray(rawRecord.steps)) throw new TypeError(`sample ${sampleId} steps must be an array`);
    const record: StepwiseSupervisionRecord = {
      schemaVersion: STEPWISE_SUPERVISION_SCHEMA,
      sampleId,
      family,
      requestRef,
      steps: [],
      trainingEligible,
      notReadyReason,
    };
    for (const [stepIndex, rawStep] of rawRecord.steps.entries()) {
      if (!isRecord(rawStep)) {
        throw new TypeError(`sample ${sampleId} supervision step ${stepIndex + 1} must be an object`);
      }
      const stepId = requireString(rawStep.stepId, `sample ${sampleId} supervision stepId`);
      const stepKey = `${sampleId}|${stepId}`;
      if (seenSteps.has(stepKey)) throw new TypeError(`duplicate supervision step ${stepKey}`);
      seenSteps.add(stepKey);
      const step: StepwiseSupervisionStep = {
        stepId,
        S_g: requireStringArray(rawStep.S_g, `sample ${sampleId} ${stepId} S_g`),
        A_g: requireStringArray(rawStep.A_g, `sample ${sampleId} ${stepId} A_g`),
        agSubsetOfSg: rawStep.agSubsetOfSg === true,
        labelAuthority: requireString(
          rawStep.labelAuthority,
          `sample ${sampleId} ${stepId} labelAuthority`,
        ),
        oracleKind: requireString(rawStep.oracleKind, `sample ${sampleId} ${stepId} oracleKind`),
        unknownReason: typeof rawStep.unknownReason === "string" ? rawStep.unknownReason : null,
      };
      rows.push(convertStepwiseSupervisionStep({
        record,
        step,
        sourceGroup: manifest.sourceGroup,
        partition: manifest.partition,
      }));
    }
  }
  if (rows.length === 0) throw new TypeError(`stepwise supervision ${supervisionPath} has no steps`);
  return rows;
}
