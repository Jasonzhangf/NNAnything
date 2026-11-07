// Staging-only join for the stepwise converter corpus.
//
// The original source episode row also carries gold and teacher supervision.
// This module reads that row only to extract the whitelisted root `entryFile`
// field and never returns the rest of the episode to student input.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class StepwiseEntryFileMappingError extends Error {
  readonly code = "DATA_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "StepwiseEntryFileMappingError";
  }
}

export interface StepwiseEntryFileMapping {
  readonly entryFile: string;
  readonly sourcePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonl(text: string, field: string): readonly unknown[] {
  return text.split("\n").flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new StepwiseEntryFileMappingError(
        `${field} line ${index + 1} is invalid JSON: ${message}`,
      );
    }
  });
}

export async function resolveEntryFileFromSourceEpisode(
  sourceFamilyDir: string,
  sourceGroup: string,
  sampleId: string,
  existingEntryFile?: unknown,
): Promise<StepwiseEntryFileMapping> {
  const sourcePath = join(sourceFamilyDir, `episode-${sampleId}.jsonl`);
  const records = parseJsonl(await readFile(sourcePath, "utf8"), sourcePath);
  const sameSample = records.filter(
    (record): record is Record<string, unknown> =>
      isRecord(record) && record.sampleId === sampleId,
  );
  if (sameSample.length === 0) {
    throw new StepwiseEntryFileMappingError(
      `source episode ${sourcePath} has no record for sample ${sampleId}`,
    );
  }
  const matches = sameSample.filter(record => record.sourceGroup === sourceGroup);
  if (matches.length === 0) {
    const found = sameSample
      .map(record => String(record.sourceGroup))
      .join(",");
    throw new StepwiseEntryFileMappingError(
      `source episode ${sourcePath} sample ${sampleId} sourceGroup mismatch: expected ${sourceGroup}, found ${found}`,
    );
  }
  if (matches.length > 1) {
    throw new StepwiseEntryFileMappingError(
      `source episode ${sourcePath} has ${matches.length} records for sample ${sampleId} in sourceGroup ${sourceGroup}`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new StepwiseEntryFileMappingError(
      `source episode ${sourcePath} has no record for sample ${sampleId}`,
    );
  }
  const entryFile = match.entryFile;
  if (typeof entryFile !== "string" || entryFile.length === 0) {
    throw new StepwiseEntryFileMappingError(
      `source episode ${sourcePath} sample ${sampleId} entryFile must be an explicit non-empty string`,
    );
  }
  if (existingEntryFile !== undefined && existingEntryFile !== entryFile) {
    throw new StepwiseEntryFileMappingError(
      `sample ${sampleId} entryFile conflict: student=${String(existingEntryFile)} sourceEpisode=${entryFile}`,
    );
  }
  return { entryFile, sourcePath };
}
