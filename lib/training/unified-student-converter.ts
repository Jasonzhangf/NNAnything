// Student-side converter: source observation + legal skills -> complete S_g and x[64].
//
// Path A of the launch contract (§4.4.2). It must never read `labels/gold.jsonl`
// or any teacher resolution. The complete candidate group is the finite typed
// judge vocabulary generated from the observation (not gold), so removing gold
// leaves every student row byte-identical.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate } from "./unified-encoder.js";
import {
  encodeUnifiedCandidateGroup,
  type EncoderMissingMode,
  type FeatureThresholds,
  defaultThresholds,
  UNIFIED_ENCODER_VERSION,
} from "./unified-encoder.js";
import {
  DEFAULT_RELATION_STEP_ID,
  relationStepContext,
  type RelationStepEpisode,
} from "./unified-step-context-builder.js";

export const UNIFIED_STUDENT_ROW_SCHEMA = "nnanything.unified.student-row.v1" as const;
export const UNIFIED_STUDENT_GROUP_SCHEMA = "nnanything.unified.student-group.v1" as const;

export type StudentCandidateRejection =
  | "candidateEnumeration"
  | "candidateGroupRef"
  | "goldPresent";

export interface StudentCandidateRow {
  readonly candidateRef: string;
  readonly optionSemantics: string;
  readonly candidateKind: Candidate["candidateKind"];
  readonly input: readonly number[];
  readonly missingMode: readonly EncoderMissingMode[];
}

export interface StudentGroup {
  readonly schema: typeof UNIFIED_STUDENT_GROUP_SCHEMA;
  readonly group_id: string;
  readonly sampleId: string;
  readonly requestRef: string;
  readonly sourceGroup: string;
  readonly language: string;
  readonly adapterRef: string;
  readonly derivationFamily: string;
  readonly semanticStratum: string;
  readonly stepContextRef: string;
  readonly candidateGroupRef: string;
  readonly featureSchemaVersion: string;
  readonly encoderVersion: string;
  readonly partition: "TRAIN" | "DEV" | "VERIFICATION";
  readonly candidateEnumeration: "complete";
  readonly coverageCursorRef: string;
  readonly evidenceRefs: readonly string[];
  readonly failureMode: string | null;
  readonly candidates: readonly StudentCandidateRow[];
}

export interface StudentConversionResult {
  readonly groups: readonly StudentGroup[];
  readonly rejection: readonly StudentCandidateRejection[];
}

export function studentGroupId(input: {
  readonly sourceGroup: string;
  readonly sampleId: string;
  readonly stepContextRef: string;
  readonly candidateGroupRef: string;
}): string {
  return [input.sourceGroup, input.sampleId, input.stepContextRef, input.candidateGroupRef].join("|");
}

export function partitionOf(raw: string): "TRAIN" | "DEV" | "VERIFICATION" {
  if (raw === "train") return "TRAIN";
  if (raw === "dev") return "DEV";
  if (raw === "verification") return "VERIFICATION";
  throw new TypeError(`unknown partition: ${raw}`);
}

function blockForSlot(slotIndex: number): EncoderMissingMode["block"] {
  return `G${Math.floor(slotIndex / 8)}` as EncoderMissingMode["block"];
}

function deriveMissingMode(
  candidateRef: string,
  vector: readonly number[],
  encodedMissingMode: readonly EncoderMissingMode[],
): readonly EncoderMissingMode[] {
  if (encodedMissingMode.length > 0) return encodedMissingMode;
  return vector.flatMap((value, slotIndex) =>
    value === -1
      ? [{
          block: blockForSlot(slotIndex),
          fieldRef: `${candidateRef}:slot${slotIndex}`,
          reason: "not_requested" as const,
          slotIndex,
          fill: -1 as const,
        }]
      : []
  );
}

export function convertEpisodeToStudentGroup(
  episode: RelationStepEpisode,
  thresholds: FeatureThresholds = defaultThresholds(),
): StudentGroup {
  const context = relationStepContext(episode);
  const encoded = encodeUnifiedCandidateGroup(context, thresholds);
  const candidates = context.candidateGroup.candidates.map((candidate, index) => {
    const result = encoded[index];
    if (result === undefined) throw new TypeError(`encoder missing candidate ${candidate.candidateRef}`);
    return {
      candidateRef: candidate.candidateRef,
      optionSemantics: candidate.optionSemantics,
      candidateKind: candidate.candidateKind,
      input: result.vector,
      missingMode: deriveMissingMode(candidate.candidateRef, result.vector, result.missingMode),
    };
  });
  return {
    schema: UNIFIED_STUDENT_GROUP_SCHEMA,
    group_id: studentGroupId({
      sourceGroup: episode.sourceGroup,
      sampleId: episode.sampleId,
      stepContextRef: context.contextId,
      candidateGroupRef: context.candidateGroup.candidateGroupRef,
    }),
    sampleId: episode.sampleId,
    requestRef: episode.requestId,
    sourceGroup: episode.sourceGroup,
    language: episode.language,
    adapterRef: episode.adapterRef,
    derivationFamily: episode.derivationFamily,
    semanticStratum: episode.semanticStratum,
    stepContextRef: context.contextId,
    candidateGroupRef: context.candidateGroup.candidateGroupRef,
    featureSchemaVersion: "nnanything.unified.feature.v1",
    encoderVersion: UNIFIED_ENCODER_VERSION,
    partition: partitionOf(episode.partition),
    candidateEnumeration: "complete",
    coverageCursorRef: `coverage:${episode.sampleId}`,
    evidenceRefs: episode.evidenceRefs,
    failureMode: episode.failureMode,
    candidates,
  };
}

export async function loadEpisodeFamily(familyDir: string): Promise<readonly RelationStepEpisode[]> {
  const manifestText = await readFile(join(familyDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as {
    readonly sourceGroup: string;
    readonly language: string;
    readonly semanticStratum: string;
    readonly partition: string;
    readonly derivationFamily?: { readonly familyId: string };
  };
  const preStateLines = (await readFile(join(familyDir, "evidence", "pre-state.jsonl"), "utf8"))
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as {
      readonly sampleId: string;
      readonly stepId?: string;
      readonly observedFacts: readonly string[];
    });
  const preState = new Map(
    preStateLines.map(record => [
      `${record.sampleId}|${record.stepId ?? DEFAULT_RELATION_STEP_ID}`,
      record,
    ]),
  );
  const files = (await readdir(familyDir)).filter(name => name.startsWith("episode-") && name.endsWith(".jsonl"));
  files.sort();
  const episodes: RelationStepEpisode[] = [];
  const seenSteps = new Set<string>();
  for (const file of files) {
    for (const line of (await readFile(join(familyDir, file), "utf8")).split("\n")) {
      if (line.trim().length === 0) continue;
      const raw = JSON.parse(line) as {
        readonly sampleId: string;
        readonly stepId?: string;
        readonly requestId: string;
        readonly sourceGroup: string;
        readonly language: string;
        readonly semanticStratum: string;
        readonly partition: string;
        readonly entryFile: string;
        readonly goal: { readonly targetRef: string };
        readonly failureMode: string | null;
        readonly evidenceRefs: readonly string[];
      };
      const stepId = raw.stepId ?? DEFAULT_RELATION_STEP_ID;
      const stepKey = `${raw.sampleId}|${stepId}`;
      if (seenSteps.has(stepKey)) throw new TypeError(`duplicate episode step ${stepKey}`);
      seenSteps.add(stepKey);
      const state = preState.get(stepKey);
      if (!state) throw new TypeError(`missing pre-state for ${stepKey}`);
      episodes.push({
        sampleId: raw.sampleId,
        stepId,
        requestId: raw.requestId,
        sourceGroup: raw.sourceGroup,
        language: raw.language,
        semanticStratum: raw.semanticStratum,
        partition: raw.partition,
        entryFile: raw.entryFile,
        targetRef: raw.goal.targetRef,
        observedFacts: state.observedFacts,
        evidenceRefs: raw.evidenceRefs,
        failureMode: raw.failureMode,
        derivationFamily: manifest.derivationFamily?.familyId ?? manifest.sourceGroup,
        adapterRef: `tsjs-unified-adapter:${manifest.language}`,
      });
    }
  }
  return episodes;
}
