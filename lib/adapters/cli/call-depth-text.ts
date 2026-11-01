// Text-hit expansion for Slice CD-1. This module performs no AST work and no
// hidden state: it expands one content-search hit into the text candidates
// used for the first-round language routing and reports secondary read
// failures to the caller instead of silently degrading to a single fallback.
import { relative } from "node:path";
import type { CliFilesystemSandbox } from "./filesystem-sandbox.js";
import type { CallDepthTextCandidate } from "./call-depth-contract.js";
import type { ContentSearchHitFact } from "./content-search-contract.js";

export type TextExpansionFailure = Readonly<{
  filePath: string;
  message: string;
}>;

export type TextExpansion = Readonly<{
  candidates: readonly CallDepthTextCandidate[];
  failure: TextExpansionFailure | null;
}>;

function positionAt(bytes: Buffer, offset: number): Readonly<{ line: number; column: number }> {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (bytes[index] === 0x0a) line += 1;
  }
  const previousNewline = offset === 0 ? -1 : bytes.lastIndexOf(0x0a, offset - 1);
  const lineStart = previousNewline + 1;
  return Object.freeze({
    line,
    column: bytes.subarray(lineStart, offset).toString("utf8").length + 1,
  });
}

function previewAt(bytes: Buffer, offset: number, needleLength: number): string {
  const lineStart = bytes.lastIndexOf(0x0a, Math.max(0, offset - 1)) + 1;
  const nextNewline = bytes.indexOf(0x0a, offset + needleLength);
  const lineEnd = nextNewline === -1 ? bytes.length : nextNewline;
  const line = bytes.subarray(lineStart, lineEnd).toString("utf8");
  if (line.length <= 200) return line;
  const column = bytes.subarray(lineStart, offset).toString("utf8").length;
  const start = Math.max(0, column - 80);
  return `${start > 0 ? "..." : ""}${line.slice(start, start + 200)}${start + 200 < line.length ? "..." : ""}`;
}

function textCandidate(
  repoRoot: string,
  hit: ContentSearchHitFact,
  bytes: Buffer,
  start: number,
  needle: string,
): CallDepthTextCandidate {
  const absolutePath = hit.path;
  const filePath = relative(repoRoot, absolutePath);
  const matchedText = bytes.subarray(start, start + Buffer.byteLength(needle, "utf8")).toString("utf8");
  const startPosition = positionAt(bytes, start);
  const endPosition = positionAt(bytes, start + Buffer.byteLength(needle, "utf8"));
  return Object.freeze({
    candidateId: `text:${filePath}:${start}:${needle}`,
    filePath,
    line: startPosition.line,
    column: startPosition.column,
    span: Object.freeze({
      startLine: startPosition.line,
      startColumn: startPosition.column,
      endLine: endPosition.line,
      endColumn: endPosition.column,
    }),
    byteSpan: Object.freeze({ start, end: start + Buffer.byteLength(needle, "utf8") }),
    matchedText,
    preview: previewAt(bytes, start, Buffer.byteLength(needle, "utf8")),
    matchedNeedle: needle,
    disposition: "unclassified" as const,
    evidenceRefs: Object.freeze([
      `content-search:${hit.fileRef.sourceRun}`,
      `file:${filePath}`,
    ]),
  });
}

function fallbackTextCandidate(
  repoRoot: string,
  hit: ContentSearchHitFact,
): CallDepthTextCandidate {
  const filePath = relative(repoRoot, hit.path);
  const startColumn = hit.column;
  return Object.freeze({
    candidateId: `text:${filePath}:${hit.byteSpan.start}:${hit.needle}`,
    filePath,
    line: hit.line,
    column: hit.column,
    span: Object.freeze({
      startLine: hit.line,
      startColumn,
      endLine: hit.line,
      endColumn: startColumn + hit.needle.length,
    }),
    byteSpan: hit.byteSpan,
    matchedText: hit.needle,
    preview: "",
    matchedNeedle: hit.needle,
    disposition: "unclassified" as const,
    evidenceRefs: Object.freeze([
      `content-search:${hit.fileRef.sourceRun}`,
      `file:${filePath}`,
    ]),
  });
}

export async function expandTextHit(
  repoRoot: string,
  hit: ContentSearchHitFact,
  sandbox: CliFilesystemSandbox,
): Promise<TextExpansion> {
  const filePath = relative(repoRoot, hit.path);
  if (!hit.scanComplete || hit.size <= 0) {
    return Object.freeze({
      candidates: Object.freeze([fallbackTextCandidate(repoRoot, hit)]),
      failure: null,
    });
  }
  const receipt = await sandbox.execute({
    operation: "file.read",
    parameters: {
      ref: hit.fileRef,
      offset: 0,
      length: hit.size,
    },
  });
  if (receipt.execution.status !== "succeeded" || receipt.execution.observation.kind !== "file.read") {
    const code = receipt.execution.status === "failed"
      ? receipt.execution.error.code
      : "UNEXPECTED_OBSERVATION";
    return Object.freeze({
      candidates: Object.freeze([fallbackTextCandidate(repoRoot, hit)]),
      failure: Object.freeze({ filePath, message: `${filePath}:${code}` }),
    });
  }
  const bytes = Buffer.from(receipt.execution.observation.bytes, "base64");
  const needleBytes = Buffer.from(hit.needle, "utf8");
  const found: CallDepthTextCandidate[] = [];
  let offset = 0;
  while (offset <= bytes.length - needleBytes.length) {
    const start = bytes.indexOf(needleBytes, offset);
    if (start === -1) break;
    found.push(textCandidate(repoRoot, hit, bytes, start, hit.needle));
    offset = start + Math.max(1, needleBytes.length);
  }
  return Object.freeze({
    candidates: Object.freeze(found.length > 0 ? found : [fallbackTextCandidate(repoRoot, hit)]),
    failure: null,
  });
}

export function recordTextExpansionFailure(
  complete: boolean,
  errors: string[],
  unreadFiles: string[],
  failure: TextExpansionFailure | null,
): boolean {
  if (failure === null) return complete;
  errors.push(failure.message);
  unreadFiles.push(failure.filePath);
  return false;
}

export function textCoverageStatus(
  complete: boolean,
  searched: boolean,
): "complete" | "partial" | "failed" {
  return complete ? "complete" : searched ? "partial" : "failed";
}
