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
import { studentGroupId, partitionOf } from "./unified-student-converter.js";

export const UNIFIED_SUPERVISION_ROW_SCHEMA = "nnanything.unified.supervision-row.v1" as const;

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
