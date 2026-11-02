// Swift declaration-table adapter. The backend is exactly
// `swiftc -dump-parse <file>`; stdout is consumed one line at a time so the
// complete S-expression tree is never retained. Public entry discovery and
// wiring remain outside this module.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

import {
  projectSwiftSymbolTableResult,
  symbolIdFor,
  validateSwiftSymbolRequest,
  type SwiftCoverageRecord,
  type SwiftDeclaredIn,
  type SwiftOwnerKind,
  type SwiftParserRecord,
  type SwiftSpan,
  type SwiftSymbolKind,
  type SwiftSymbolRecord,
  type SwiftSymbolTableOutcome,
  type SwiftSyntaxError,
  type SwiftSyntaxErrorFile,
  type SwiftVisibility,
} from "../../filters/swift-symbol-table-policy.js";

const DEFAULT_SWIFTC = "/usr/bin/swiftc";
const OPERATOR_CHARS = new Set("=-+!*%<>&|^~?.");
const MODIFIER_WORDS = new Set([
  "actor",
  "class",
  "convenience",
  "final",
  "infix",
  "isolated",
  "lazy",
  "let",
  "main",
  "mutating",
  "nonisolated",
  "nonmutating",
  "override",
  "postfix",
  "prefix",
  "required",
  "static",
  "unowned",
  "var",
  "weak",
]);
const TYPE_FRAME_KINDS = new Set([
  "struct",
  "class",
  "actor",
  "enum",
  "protocol",
  "extension",
]);
const LOCAL_BOUNDARY_KINDS = new Set([
  "function",
  "method",
  "initializer",
  "deinitializer",
  "subscript",
  "property",
  "variable",
]);
const UNKNOWN_SPAN: SwiftSpan = Object.freeze({
  startLine: 0,
  startCol: 0,
  endLine: 0,
  endCol: 0,
});

type RawRange = Readonly<{
  startLine: number;
  startByteCol: number;
  endLine: number;
  endByteCol: number;
}>;

type ParsedNodeLine = Readonly<{
  kind: string;
  indent: number;
  range: RawRange | null;
  quotedName: string | null;
  tailAfterName: string;
  declContext: string | null;
}>;

type HeaderToken = Readonly<{
  text: string;
  start: number;
  end: number;
}>;

type NameLocation = Readonly<{
  span: SwiftSpan;
  source: string;
}>;

type Frame = {
  astKind: string;
  symbolKind: SwiftSymbolKind;
  indent: number;
  range: RawRange | null;
  declContext: string | null;
  quotedName: string;
  fullName: string;
  name: string;
  parent: Frame | null;
  lexicalScope: readonly string[];
  ownerType: string | null;
  ownerKind: SwiftOwnerKind | null;
  declaredIn: SwiftDeclaredIn;
  visibility: SwiftVisibility;
  modifiers: Set<string>;
  attributeRanges: RawRange[];
  parameterRange: RawRange | null;
  braceRange: RawRange | null;
  patternRange: RawRange | null;
  hasLocalIssue: boolean;
  activePatternBinding: Readonly<{
    declContext: string | null;
    range: RawRange;
    indent: number;
  }> | null;
};

const NODE_HEAD_RE = /^\s*\(([A-Za-z_][A-Za-z0-9_]*)\b/;
const RANGE_RE = /range=\[(.+?):(\d+):(\d+) - line:(\d+):(\d+)\]/;
const QUOTED_RE = /"((?:\\.|[^"\\])*)"/;
const DECL_CONTEXT_RE = /decl_context=([^\s)]+)/;
const ACCESS_LEVEL_RE = /access_level=(open|public|package|internal|fileprivate|private)\b/;

class SwiftSource {
  readonly bytes: Buffer;
  private readonly lines: readonly Buffer[];
  private readonly lineStarts: readonly number[];

  constructor(bytes: Buffer) {
    this.bytes = bytes;
    const lines: Buffer[] = [];
    const starts: number[] = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      starts.push(start);
      lines.push(bytes.subarray(start, index));
      start = index + 1;
    }
    starts.push(start);
    lines.push(bytes.subarray(start));
    this.lines = lines;
    this.lineStarts = starts;
  }

  offsetFor(line: number, byteCol1: number): number | null {
    if (!Number.isInteger(line) || !Number.isInteger(byteCol1) || line < 1) return null;
    const lineStart = this.lineStarts[line - 1];
    const lineBuffer = this.lines[line - 1];
    if (lineStart === undefined || lineBuffer === undefined) return null;
    const relative = byteCol1 - 1;
    if (relative < 0 || relative > lineBuffer.length) return null;
    if (relative < lineBuffer.length && (lineBuffer[relative]! & 0xc0) === 0x80) return null;
    return lineStart + relative;
  }

  positionAt(offset: number): Readonly<{ line: number; col: number }> | null {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.bytes.length) return null;
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = this.lineStarts[middle];
      if (start === undefined) return null;
      if (start === offset) {
        low = middle;
        break;
      }
      if (start < offset) low = middle + 1;
      else high = middle - 1;
    }
    let lineIndex = Math.max(0, Math.min(this.lineStarts.length - 1, low - 1));
    let lineStart = this.lineStarts[lineIndex];
    while (lineIndex + 1 < this.lineStarts.length) {
      const next = this.lineStarts[lineIndex + 1];
      if (next === undefined || next > offset) break;
      lineIndex += 1;
      lineStart = next;
    }
    if (lineStart === undefined) return null;
    const lineBuffer = this.lines[lineIndex];
    if (lineBuffer === undefined) return null;
    const relative = offset - lineStart;
    if (relative < 0 || relative > lineBuffer.length) return null;
    if (relative < lineBuffer.length && (lineBuffer[relative]! & 0xc0) === 0x80) return null;
    const prefix = lineBuffer.subarray(0, relative).toString("utf8");
    return { line: lineIndex + 1, col: Array.from(prefix).length + 1 };
  }

  rawOffset(range: RawRange, end: boolean): number | null {
    return this.offsetFor(
      end ? range.endLine : range.startLine,
      end ? range.endByteCol : range.startByteCol,
    );
  }

  tokenEndOffset(offset: number): number | null {
    if (offset < 0 || offset > this.bytes.length) return null;
    if (offset === this.bytes.length) return offset;
    const first = this.bytes[offset]!;
    if (first === 0x22) {
      for (let index = offset + 1; index < this.bytes.length; index += 1) {
        if (this.bytes[index] === 0x5c) {
          index += 1;
          continue;
        }
        if (this.bytes[index] === 0x22) return index + 1;
      }
      return null;
    }
    if (first === 0x60) {
      const close = this.bytes.indexOf(0x60, offset + 1);
      return close < 0 ? null : close + 1;
    }
    if (isIdentifierByte(first)) {
      let index = offset + 1;
      while (index < this.bytes.length && isIdentifierByte(this.bytes[index]!)) index += 1;
      return index;
    }
    const char = String.fromCharCode(first);
    if (OPERATOR_CHARS.has(char)) {
      let index = offset + 1;
      while (index < this.bytes.length && OPERATOR_CHARS.has(String.fromCharCode(this.bytes[index]!))) {
        index += 1;
      }
      return index;
    }
    return offset + 1;
  }

  spanFromOffsets(startOffset: number, endOffset: number): SwiftSpan | null {
    if (endOffset < startOffset) return null;
    const start = this.positionAt(startOffset);
    const end = this.positionAt(endOffset);
    if (start === null || end === null) return null;
    return Object.freeze({
      startLine: start.line,
      startCol: start.col,
      endLine: end.line,
      endCol: end.col,
    });
  }

  spanForRange(range: RawRange, endOffset: number | null = null): SwiftSpan | null {
    const startOffset = this.rawOffset(range, false);
    if (startOffset === null) return null;
    if (endOffset !== null) return this.spanFromOffsets(startOffset, endOffset);
    const endStart = this.rawOffset(range, true);
    if (endStart === null) return null;
    const tokenEnd = this.tokenEndOffset(endStart);
    if (tokenEnd === null) return null;
    return this.spanFromOffsets(startOffset, tokenEnd);
  }
}

function isIdentifierByte(byte: number): boolean {
  return (
    byte >= 0x80 ||
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f ||
    byte === 0x24
  );
}

function parseRange(text: string): RawRange | null {
  const match = RANGE_RE.exec(text);
  if (match === null) return null;
  return Object.freeze({
    startLine: Number(match[2]),
    startByteCol: Number(match[3]),
    endLine: Number(match[4]),
    endByteCol: Number(match[5]),
  });
}

function parseNodeLine(text: string): ParsedNodeLine | null {
  const head = NODE_HEAD_RE.exec(text);
  if (head === null) return null;
  const quoted = QUOTED_RE.exec(text);
  const quotedEnd = quoted === null || quoted.index === undefined
    ? 0
    : quoted.index + quoted[0].length;
  const declContext = DECL_CONTEXT_RE.exec(text);
  return Object.freeze({
    kind: head[1] ?? "",
    indent: text.length - text.trimStart().length,
    range: parseRange(text),
    quotedName: quoted === null ? null : quoted[1] ?? null,
    tailAfterName: quoted === null ? "" : text.slice(quotedEnd),
    declContext: declContext === null ? null : declContext[1] ?? null,
  });
}

function comparePosition(
  left: Readonly<{ line: number; col: number }>,
  right: Readonly<{ line: number; col: number }>,
): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.col - right.col;
}

function rawStart(range: RawRange): Readonly<{ line: number; col: number }> {
  return { line: range.startLine, col: range.startByteCol };
}

function earliestRawStart(
  range: RawRange,
  attributes: readonly RawRange[],
  pattern: RawRange | null,
): RawRange {
  let earliest = range;
  for (const candidate of [...attributes, ...(pattern === null ? [] : [pattern])]) {
    if (comparePosition(rawStart(candidate), rawStart(earliest)) < 0) earliest = candidate;
  }
  return earliest;
}

function trimParens(text: string): string {
  return text.replace(/\)+\s*$/, "");
}

function splitWords(text: string): string[] {
  return trimParens(text).split(/[^A-Za-z_]+/).filter(value => value.length > 0);
}

function normalizedBacktickName(value: string): string {
  return value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1) : value;
}

function baseName(fullName: string): string {
  const open = fullName.indexOf("(");
  return open < 0 ? fullName : fullName.slice(0, open);
}

function tokenizeHeader(bytes: Buffer, start: number, end: number): HeaderToken[] {
  if (end < start) return [];
  const text = bytes.subarray(start, end).toString("utf8");
  const byteAt = (index: number): number => start + Buffer.byteLength(text.slice(0, index), "utf8");
  const tokens: HeaderToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index + 2);
      index = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    const tokenStart = index;
    if (char === "`") {
      index += 1;
      while (index < text.length && text[index] !== "`") index += 1;
      if (index < text.length) index += 1;
    } else if (char === "\"") {
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === "\"") {
          index += 1;
          break;
        }
        index += 1;
      }
    } else if (/[\p{L}\p{N}_$]/u.test(char)) {
      index += char.length;
      while (index < text.length) {
        const next = String.fromCodePoint(text.codePointAt(index) ?? 0);
        if (!/[\p{L}\p{N}_$]/u.test(next)) break;
        index += next.length;
      }
    } else if (OPERATOR_CHARS.has(char)) {
      index += 1;
      while (index < text.length && OPERATOR_CHARS.has(text[index]!)) index += 1;
    } else {
      index += char.length;
    }
    tokens.push(Object.freeze({
      text: text.slice(tokenStart, index),
      start: byteAt(tokenStart),
      end: byteAt(index),
    }));
  }
  return tokens;
}

function locateHeaderName(
  source: SwiftSource,
  frame: Frame,
  expectedKeyword: string,
): NameLocation | null {
  if (frame.range === null) return null;
  const start = source.rawOffset(frame.range, false);
  if (start === null) return null;
  const parameterStart = frame.parameterRange === null ? null : source.rawOffset(frame.parameterRange, false);
  const braceStart = frame.braceRange === null ? null : source.rawOffset(frame.braceRange, false);
  const rangeEnd = source.rawOffset(frame.range, true);
  const headerEnd = parameterStart ?? braceStart ?? rangeEnd;
  if (headerEnd === null || headerEnd < start) return null;
  const tokens = tokenizeHeader(source.bytes, start, headerEnd);
  const keywordIndex = tokens.findIndex(token => token.text === expectedKeyword);
  if (keywordIndex < 0) return null;
  const keyword = tokens[keywordIndex];
  if (keyword === undefined) return null;
  if (expectedKeyword === "init" || expectedKeyword === "deinit" || expectedKeyword === "subscript") {
    let end = keyword.end;
    const next = tokens[keywordIndex + 1];
    if (
      expectedKeyword === "init"
      && next !== undefined
      && (next.text === "?" || next.text === "!")
      && next.start === end
    ) {
      end = next.end;
    }
    const span = source.spanFromOffsets(keyword.start, end);
    return span === null ? null : Object.freeze({ span, source: "keyword" });
  }
  const nameToken = tokens[keywordIndex + 1];
  if (nameToken === undefined) return null;
  if (nameToken.text.startsWith("`")) {
    if (normalizedBacktickName(nameToken.text) !== frame.name) return null;
    const span = source.spanFromOffsets(nameToken.start, nameToken.end);
    return span === null ? null : Object.freeze({ span, source: "header_scanner" });
  }
  const byteLength = Buffer.byteLength(frame.name, "utf8");
  const nameEnd = nameToken.start + byteLength;
  if (nameEnd > headerEnd) return null;
  const sourceName = source.bytes.subarray(nameToken.start, nameEnd).toString("utf8");
  if (sourceName !== frame.name) return null;
  const span = source.spanFromOffsets(nameToken.start, nameEnd);
  return span === null ? null : Object.freeze({ span, source: "header_scanner" });
}

function locateIdentifierName(
  source: SwiftSource,
  range: RawRange,
  name: string,
  sourceKind: "identifier" | "keyword" | "extension_target",
): NameLocation | null {
  const start = source.rawOffset(range, false);
  if (start === null) return null;
  if (source.bytes[start] === 0x60) {
    const end = source.tokenEndOffset(start);
    if (end === null) return null;
    const written = source.bytes.subarray(start, end).toString("utf8");
    if (normalizedBacktickName(written) !== name) return null;
    const span = source.spanFromOffsets(start, end);
    return span === null ? null : Object.freeze({ span, source: sourceKind });
  }
  const end = start + Buffer.byteLength(name, "utf8");
  if (end > source.bytes.length) return null;
  if (source.bytes.subarray(start, end).toString("utf8") !== name) return null;
  const span = source.spanFromOffsets(start, end);
  return span === null ? null : Object.freeze({ span, source: sourceKind });
}

function frameLabel(frame: Frame): string {
  switch (frame.symbolKind) {
    case "struct":
    case "class":
    case "actor":
    case "enum":
    case "protocol":
    case "extension":
      return `${frame.symbolKind}:${frame.name}`;
    case "function":
    case "method":
      return `${frame.symbolKind}:${frame.name}`;
    case "initializer":
      return "init";
    case "deinitializer":
      return "deinit";
    case "subscript":
      return "subscript";
    case "property":
    case "variable":
      return `property:${frame.name}`;
    default:
      return `${frame.symbolKind}:${frame.name}`;
  }
}

function nearestType(frame: Frame | null): Frame | null {
  let current = frame;
  while (current !== null) {
    if (TYPE_FRAME_KINDS.has(current.symbolKind)) return current;
    current = current.parent;
  }
  return null;
}

function nearestLocalBoundary(frame: Frame | null): Frame | null {
  let current = frame;
  while (current !== null) {
    if (LOCAL_BOUNDARY_KINDS.has(current.symbolKind)) return current;
    if (TYPE_FRAME_KINDS.has(current.symbolKind)) return null;
    current = current.parent;
  }
  return null;
}

function declaredInFor(parent: Frame | null): SwiftDeclaredIn {
  if (parent === null) return "file";
  if (parent.symbolKind === "struct") return "struct_body";
  if (parent.symbolKind === "class") return "class_body";
  if (parent.symbolKind === "actor") return "actor_body";
  if (parent.symbolKind === "enum") return "enum_body";
  if (parent.symbolKind === "protocol") return "protocol_body";
  if (parent.symbolKind === "extension") return "extension_body";
  return "local_scope";
}

function ownerKindOf(frame: Frame | null): SwiftOwnerKind | null {
  if (frame === null) return null;
  return TYPE_FRAME_KINDS.has(frame.symbolKind)
    ? frame.symbolKind as SwiftOwnerKind
    : null;
}

function resolveSymbolKind(astKind: string, quotedName: string, parent: Frame | null): {
  kind: SwiftSymbolKind;
  fullName: string;
  name: string;
} | null {
  switch (astKind) {
    case "struct_decl":
    case "enum_decl":
      return { kind: astKind === "struct_decl" ? "struct" : "enum", fullName: quotedName, name: quotedName };
    case "class_decl":
      return { kind: "class", fullName: quotedName, name: quotedName };
    case "protocol":
      return { kind: "protocol", fullName: quotedName, name: quotedName };
    case "extension_decl":
      return { kind: "extension", fullName: quotedName, name: quotedName };
    case "typealias":
      return { kind: "typealias", fullName: quotedName, name: quotedName };
    case "enum_element_decl":
      return { kind: "enum_case", fullName: quotedName, name: baseName(quotedName) };
    case "func_decl": {
      const fullName = quotedName;
      const name = baseName(fullName);
      const member = nearestType(parent);
      const local = nearestLocalBoundary(parent);
      const kind: SwiftSymbolKind = member !== null && local === null ? "method" : "function";
      return { kind, fullName, name };
    }
    case "constructor_decl":
      return { kind: "initializer", fullName: quotedName, name: "init" };
    case "destructor_decl":
      return { kind: "deinitializer", fullName: quotedName, name: "deinit" };
    case "subscript_decl":
      return { kind: "subscript", fullName: quotedName, name: "subscript" };
    case "var_decl": {
      const parentType = nearestType(parent);
      const local = nearestLocalBoundary(parent);
      const kind: SwiftSymbolKind | null =
        parentType !== null && local === null
          ? "property"
          : parentType === null && local === null
            ? "variable"
            : null;
      return kind === null ? null : { kind, fullName: quotedName, name: quotedName };
    }
    default:
      return null;
  }
}

class SwiftDumpParseStreamParser {
  readonly symbols: SwiftSymbolRecord[] = [];
  readonly partialReasons = new Set<string>();
  sawSourceFile = false;
  private readonly frames: Frame[] = [];
  private readonly seen = new Set<string>();
  private readonly source: SwiftSource;
  private readonly relFile: string;

  constructor(source: SwiftSource, relFile: string) {
    this.source = source;
    this.relFile = relFile;
  }

  pushLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (trimmed.startsWith("(source_file ")) {
      this.sawSourceFile = true;
      return;
    }
    while (this.frames.length > 0) {
      const top = this.frames[this.frames.length - 1];
      if (top === undefined || line.length - line.trimStart().length > top.indent) break;
      this.frames.pop();
      this.finalize(top);
    }
    const node = parseNodeLine(line);
    if (node === null) return;

    if (node.kind === "pattern_binding_decl") {
      const parent = this.frames[this.frames.length - 1];
      if (parent !== undefined && node.range !== null) {
        const active = Object.freeze({
          declContext: node.declContext,
          range: node.range,
          indent: node.indent,
        });
        parent.activePatternBinding = active;
      }
      return;
    }

    const parent = this.frames.at(-1) ?? null;
    if (node.kind === "access_control_attr") {
      if (parent !== null && node.range !== null && node.indent === parent.indent + 2) {
        parent.attributeRanges.push(node.range);
        const match = ACCESS_LEVEL_RE.exec(trimmed);
        if (match !== null) {
          parent.visibility = match[1] as SwiftVisibility;
        }
      }
      return;
    }
    if (node.kind === "main_type_attr") {
      if (parent !== null && node.range !== null && node.indent === parent.indent + 2) {
        parent.attributeRanges.push(node.range);
        parent.modifiers.add("main");
      }
      return;
    }
    if (node.kind.endsWith("_attr")) {
      if (parent !== null && node.range !== null && node.indent === parent.indent + 2) {
        parent.attributeRanges.push(node.range);
        if (node.kind === "final_attr") parent.modifiers.add("final");
      }
      return;
    }
    if (node.kind === "parameter_list") {
      if (parent !== null && node.range !== null && parent.parameterRange === null) {
        parent.parameterRange = node.range;
      }
      return;
    }
    if (node.kind === "brace_stmt") {
      if (parent !== null && node.range !== null && parent.braceRange === null) {
        parent.braceRange = node.range;
      }
      return;
    }

    if (
      parent !== null
      && parent.activePatternBinding !== null
      && node.indent === parent.activePatternBinding.indent
      && node.kind !== "var_decl"
    ) {
      parent.activePatternBinding = null;
    }

    if (!this.isInterestingNode(node)) return;
    if (parent !== null && parent.activePatternBinding !== null && node.indent === parent.activePatternBinding.indent) {
      parent.activePatternBinding = null;
    }
    if (node.quotedName === null) return;
    const words = new Set(splitWords(node.tailAfterName));
    if (words.has("implicit")) return;
    const resolved = resolveSymbolKind(node.kind, node.quotedName, parent);
    if (resolved === null) return;
    if (node.kind === "enum_element_decl" && nearestType(parent)?.symbolKind !== "enum") return;

    let symbolKind = resolved.kind;
    if (node.kind === "class_decl" && words.has("actor")) symbolKind = "actor";
    const lexicalScope = parent === null
      ? Object.freeze(["file"])
      : Object.freeze([...parent.lexicalScope, frameLabel(parent)]);
    const ownerFrame = symbolKind === "method"
      || symbolKind === "property"
      || symbolKind === "initializer"
      || symbolKind === "deinitializer"
      || symbolKind === "subscript"
      ? nearestType(parent)
      : symbolKind === "extension"
        ? null
        : nearestType(parent);
    const declaredIn = declaredInFor(parent);
    const modifiers = new Set<string>();
    for (const word of words) {
      if (MODIFIER_WORDS.has(word)) modifiers.add(word);
    }
    if (symbolKind === "actor") modifiers.add("actor");
    const patternRange =
      node.kind === "var_decl"
      && parent !== null
      && parent.activePatternBinding !== null
      && this.patternContains(parent.activePatternBinding.range, node.range, parent.activePatternBinding.declContext, node.declContext)
        ? parent.activePatternBinding.range
        : null;
    const frame: Frame = {
      astKind: node.kind,
      symbolKind,
      indent: node.indent,
      range: node.range,
      declContext: node.declContext,
      quotedName: node.quotedName,
      fullName: symbolKind === "extension" ? resolved.name : resolved.fullName,
      name: symbolKind === "extension" ? resolved.name : resolved.name,
      parent,
      lexicalScope,
      ownerType: symbolKind === "extension"
        ? resolved.name
        : ownerFrame === null
          ? null
          : ownerFrame.name,
      ownerKind: symbolKind === "extension"
        ? "extension"
        : ownerKindOf(ownerFrame),
      declaredIn,
      visibility: declaredIn === "local_scope" ? "local" : "internal",
      modifiers,
      attributeRanges: [],
      parameterRange: null,
      braceRange: null,
      patternRange,
      hasLocalIssue: false,
      activePatternBinding: null,
    };
    this.frames.push(frame);
  }

  finalizeAll(): void {
    while (this.frames.length > 0) {
      const frame = this.frames.pop();
      if (frame !== undefined) this.finalize(frame);
    }
  }

  private isInterestingNode(node: ParsedNodeLine): boolean {
    return (
      node.kind === "struct_decl"
      || node.kind === "class_decl"
      || node.kind === "enum_decl"
      || node.kind === "protocol"
      || node.kind === "extension_decl"
      || node.kind === "typealias"
      || node.kind === "enum_element_decl"
      || node.kind === "func_decl"
      || node.kind === "constructor_decl"
      || node.kind === "destructor_decl"
      || node.kind === "subscript_decl"
      || node.kind === "var_decl"
    );
  }

  private patternContains(
    pattern: RawRange,
    node: RawRange | null,
    patternContext: string | null,
    nodeContext: string | null,
  ): boolean {
    if (node === null || patternContext !== nodeContext) return false;
    return (
      comparePosition(rawStart(pattern), rawStart(node)) <= 0
      && comparePosition(
        { line: node.endLine, col: node.endByteCol },
        { line: pattern.endLine, col: pattern.endByteCol },
      ) <= 0
    );
  }

  private finalize(frame: Frame): void {
    const declRange = frame.range === null
      ? null
      : earliestRawStart(frame.range, frame.attributeRanges, frame.patternRange);
    let declSpan: SwiftSpan | null = null;
    if (declRange !== null) {
      const start = this.source.rawOffset(declRange, false);
      const endStart = this.source.rawOffset((frame.patternRange ?? frame.range)!, true);
      if (start !== null && endStart !== null) {
        const end = this.source.tokenEndOffset(endStart);
        if (end !== null) declSpan = this.source.spanFromOffsets(start, end);
      }
    }
    if (declSpan === null) {
      frame.hasLocalIssue = true;
      this.partialReasons.add(`${this.relFile}: unconfirmed_decl_span:${frame.fullName}`);
      declSpan = UNKNOWN_SPAN;
    }

    let nameLocation: NameLocation | null;
    switch (frame.symbolKind) {
      case "variable":
      case "property":
      case "enum_case":
        nameLocation = frame.range === null
          ? null
          : locateIdentifierName(
              this.source,
              frame.range,
              frame.name,
              frame.symbolKind === "enum_case" ? "identifier" : "identifier",
            );
        break;
      case "initializer":
      case "deinitializer":
      case "subscript":
        nameLocation = locateHeaderName(this.source, frame, frame.name);
        break;
      case "extension":
        nameLocation = locateHeaderName(this.source, frame, "extension");
        if (nameLocation === null && frame.range !== null) {
          nameLocation = locateIdentifierName(this.source, frame.range, frame.name, "extension_target");
        }
        break;
      case "class":
      case "actor":
        nameLocation = locateHeaderName(this.source, frame, frame.symbolKind === "actor" ? "actor" : "class");
        break;
      case "struct":
      case "enum":
      case "protocol":
      case "typealias":
      case "function":
      case "method":
        nameLocation = locateHeaderName(this.source, frame, this.expectedKeyword(frame));
        break;
      default:
        nameLocation = null;
        break;
    }
    if (nameLocation === null) {
      frame.hasLocalIssue = true;
      this.partialReasons.add(`${this.relFile}: unconfirmed_name_span:${frame.fullName}`);
    }
    if (frame.range !== null) {
      this.addHeaderModifiers(frame);
    }

    const symbol: SwiftSymbolRecord = Object.freeze({
      symbolId: symbolIdFor(this.relFile, frame.fullName, declSpan),
      name: frame.name,
      fullName: frame.fullName,
      kind: frame.symbolKind,
      file: this.relFile,
      declSpan,
      nameSpan: nameLocation?.span ?? null,
      nameSpanSource: nameLocation?.source ?? "unknown",
      lexicalScope: frame.lexicalScope,
      ownerType: frame.ownerType,
      ownerKind: frame.ownerKind,
      modifiers: Object.freeze([...frame.modifiers]),
      visibility: frame.visibility,
      declaredIn: frame.declaredIn,
      parseStatus: frame.hasLocalIssue ? "partial_syntax_error" : "complete",
    });
    const key = [
      this.relFile,
      symbol.ownerType ?? "",
      symbol.kind,
      symbol.fullName,
      symbol.declSpan.startLine,
      symbol.declSpan.startCol,
      symbol.declSpan.endLine,
      symbol.declSpan.endCol,
    ].join("\u0000");
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.symbols.push(symbol);
    }
  }

  private expectedKeyword(frame: Frame): string {
    switch (frame.symbolKind) {
      case "struct":
        return "struct";
      case "enum":
        return "enum";
      case "protocol":
        return "protocol";
      case "typealias":
        return "typealias";
      case "function":
      case "method":
        return "func";
      default:
        return "";
    }
  }

  private addHeaderModifiers(frame: Frame): void {
    if (frame.range === null) return;
    const start = this.source.rawOffset(frame.range, false);
    const parameter = frame.parameterRange === null ? null : this.source.rawOffset(frame.parameterRange, false);
    const brace = frame.braceRange === null ? null : this.source.rawOffset(frame.braceRange, false);
    const end = parameter ?? brace ?? this.source.rawOffset(frame.range, true);
    if (start === null || end === null || end < start) return;
    const tokens = tokenizeHeader(this.source.bytes, start, end);
    const expected = frame.symbolKind === "actor"
      ? "actor"
      : frame.symbolKind === "initializer"
        ? "init"
        : frame.symbolKind === "deinitializer"
          ? "deinit"
          : frame.symbolKind === "subscript"
            ? "subscript"
            : this.expectedKeyword(frame);
    let stop = tokens.length;
    if (expected.length > 0) {
      const index = tokens.findIndex(token => token.text === expected);
      if (index >= 0) stop = index;
    }
    for (let index = 0; index < stop; index += 1) {
      const word = tokens[index]?.text;
      if (word !== undefined && MODIFIER_WORDS.has(word)) frame.modifiers.add(word);
    }
  }
}

function parseSyntaxErrors(stderr: string): SwiftSyntaxError[] {
  const errors: SwiftSyntaxError[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const withLocation = /^(.*?):(\d+):(\d+): error: (.*)$/.exec(line);
    if (withLocation !== null) {
      errors.push(Object.freeze({
        line: Number(withLocation[2]),
        column: Number(withLocation[3]),
        message: withLocation[4] ?? "",
      }));
      continue;
    }
    const generic = /^\s*error: (.*)$/.exec(line);
    if (generic !== null) {
      errors.push(Object.freeze({ line: 0, column: 0, message: generic[1] ?? "" }));
    }
  }
  return errors;
}

function findOnPath(name: string): string | null {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function executable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveSwiftc(explicit: string | undefined): string | null {
  const requested = explicit ?? process.env.NN_CODE_SWIFTC_BIN;
  if (requested !== undefined && requested.length > 0) {
    const candidate = requested.includes("/") ? requested : findOnPath(requested);
    return candidate !== null && executable(candidate) ? candidate : null;
  }
  if (executable(DEFAULT_SWIFTC)) return DEFAULT_SWIFTC;
  const fromPath = findOnPath("swiftc");
  return fromPath !== null && executable(fromPath) ? fromPath : null;
}

function detectCompilerVersion(swiftcBin: string, label: string | undefined): string {
  if (label !== undefined) return label;
  const run = spawnSync(swiftcBin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (run.error !== undefined || typeof run.stdout !== "string") return "unknown";
  const first = run.stdout.split(/\r?\n/).find(line => line.trim().length > 0);
  return first?.trim() ?? "unknown";
}

type FileFailure = Readonly<{ file: string; reason: string }>;

type SelectedFiles = Readonly<{
  files: readonly string[];
  skipped: readonly FileFailure[];
  failed: readonly FileFailure[];
}>;

type SwiftRun = Readonly<{
  exitCode: number | null;
  stderr: string;
  spawnError: string | null;
  timedOut: boolean;
}>;

type FileProcessResult = Readonly<{
  kind: "parsed" | "failed";
  symbols: readonly SwiftSymbolRecord[];
  parserReasons: readonly string[];
  errors: readonly SwiftSyntaxError[];
  reason?: string;
  hadSourceFile: boolean;
}>;

function contained(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function selectFiles(repoAbs: string, entries: readonly string[]): Promise<SelectedFiles> {
  const files: string[] = [];
  const skipped: FileFailure[] = [];
  const failed: FileFailure[] = [];
  const seen = new Set<string>();
  let repoReal: string | null = null;
  try {
    repoReal = await realpath(repoAbs);
  } catch (error) {
    return {
      files: Object.freeze([]),
      skipped: Object.freeze([]),
      failed: Object.freeze(entries.map(file => ({ file, reason: `repo_realpath_failed: ${(error as Error).message}` }))),
    };
  }

  for (const file of entries) {
    const abs = path.resolve(repoAbs, file);
    if (!contained(repoAbs, abs) || seen.has(abs)) continue;
    seen.add(abs);
    const components = file.split("/");
    let current = repoAbs;
    let rejected = false;
    let regular = false;
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index] ?? "");
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        failed.push({ file, reason: `stat_failed: ${(error as Error).message}` });
        rejected = true;
        break;
      }
      if (stats.isSymbolicLink()) {
        skipped.push({ file, reason: "SYMLINK_PATH_COMPONENT" });
        rejected = true;
        break;
      }
      if (index < components.length - 1 && !stats.isDirectory()) {
        failed.push({ file, reason: "not_a_directory" });
        rejected = true;
        break;
      }
      if (index === components.length - 1) regular = stats.isFile();
    }
    if (rejected) continue;
    if (!regular) {
      skipped.push({ file, reason: "not_a_regular_file" });
      continue;
    }
    try {
      const physical = await realpath(current);
      if (!contained(repoReal, physical)) {
        skipped.push({ file, reason: "PATH_ESCAPES_REPO_ROOT" });
        continue;
      }
    } catch (error) {
      failed.push({ file, reason: `realpath_failed: ${(error as Error).message}` });
      continue;
    }
    files.push(file);
  }
  files.sort();
  return Object.freeze({
    files: Object.freeze(files),
    skipped: Object.freeze(skipped),
    failed: Object.freeze(failed),
  });
}

function runSwiftDumpParse(
  swiftcBin: string,
  absFile: string,
  parser: SwiftDumpParseStreamParser,
  timeoutMs: number | undefined,
): Promise<SwiftRun> {
  return new Promise<SwiftRun>(resolve => {
    let settled = false;
    let timedOut = false;
    let stderr = "";
    const finish = (run: SwiftRun): void => {
      if (settled) return;
      settled = true;
      parser.finalizeAll();
      resolve(run);
    };
    const child = spawn(swiftcBin, ["-dump-parse", absFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    child.on("error", error => {
      if (timer !== null) clearTimeout(timer);
      finish({ exitCode: null, stderr, spawnError: error.message, timedOut });
    });
    if (child.stdout !== null) {
      const reader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      reader.on("line", line => parser.pushLine(line));
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string | Buffer) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
    }
    child.on("close", code => {
      if (timer !== null) clearTimeout(timer);
      finish({ exitCode: code, stderr, spawnError: null, timedOut });
    });
  });
}

async function processOneFile(
  repoAbs: string,
  relFile: string,
  swiftcBin: string,
  timeoutMs: number | undefined,
): Promise<FileProcessResult> {
  const absFile = path.resolve(repoAbs, relFile);
  let bytes: Buffer;
  try {
    bytes = await readFile(absFile);
  } catch (error) {
    return {
      kind: "failed",
      symbols: Object.freeze([]),
      parserReasons: Object.freeze([]),
      errors: Object.freeze([]),
      reason: `read_failed: ${(error as Error).message}`,
      hadSourceFile: false,
    };
  }
  const parser = new SwiftDumpParseStreamParser(new SwiftSource(bytes), relFile);
  const run = await runSwiftDumpParse(swiftcBin, absFile, parser, timeoutMs);
  const errors = parseSyntaxErrors(run.stderr);
  if (run.spawnError !== null) {
    return {
      kind: "failed",
      symbols: Object.freeze([]),
      parserReasons: Object.freeze([]),
      errors: Object.freeze(errors),
      reason: `spawn_failed: ${run.spawnError}`,
      hadSourceFile: false,
    };
  }
  if (!parser.sawSourceFile) {
    return {
      kind: "failed",
      symbols: Object.freeze([]),
      parserReasons: Object.freeze([...parser.partialReasons]),
      errors: Object.freeze(errors),
      reason: run.timedOut
        ? `swiftc timed out after ${String(timeoutMs)}ms`
        : `swiftc output missing source_file (exit ${String(run.exitCode)})`,
      hadSourceFile: false,
    };
  }
  const syntaxPartial = run.exitCode !== 0 || run.timedOut || errors.length > 0;
  const symbols = syntaxPartial
    ? Object.freeze(parser.symbols.map(entry => Object.freeze({ ...entry, parseStatus: "partial_syntax_error" as const })))
    : Object.freeze(parser.symbols);
  return {
    kind: "parsed",
    symbols,
    parserReasons: Object.freeze([...parser.partialReasons]),
    errors: Object.freeze(errors),
    hadSourceFile: true,
  };
}

export type SwiftSymbolTableAdapterOptions = Readonly<{
  swiftcBin?: string;
  timeoutMs?: number;
  compilerVersionLabel?: string;
}>;

function rejectedOutcome(reasonCode: string, message: string): SwiftSymbolTableOutcome {
  return Object.freeze({ status: "rejected", reasonCode, message });
}

export async function runSwiftSymbolTable(
  rawRequest: unknown,
  options: SwiftSymbolTableAdapterOptions = {},
): Promise<SwiftSymbolTableOutcome> {
  const validation = validateSwiftSymbolRequest(rawRequest);
  if (!validation.ok) return validation.error;
  const request = validation.request;
  const swiftcBin = resolveSwiftc(options.swiftcBin);
  if (swiftcBin === null) {
    return rejectedOutcome(
      "SWIFTC_UNAVAILABLE",
      `swiftc is unavailable; checked options.swiftcBin, NN_CODE_SWIFTC_BIN, ${DEFAULT_SWIFTC}, and PATH`,
    );
  }

  const repoAbs = path.resolve(request.repo);
  const selected = await selectFiles(repoAbs, request.files);
  const failed: FileFailure[] = [...selected.failed];
  const skipped: FileFailure[] = [...selected.skipped];
  const syntaxErrorFiles: SwiftSyntaxErrorFile[] = [];
  const symbols: SwiftSymbolRecord[] = [];
  const partialReasons = new Set<string>();
  for (const entry of [...selected.failed, ...selected.skipped]) {
    partialReasons.add(`${entry.file}: ${entry.reason}`);
  }

  let parsedCount = 0;
  let invocations = 0;
  for (const relFile of selected.files) {
    const outcome = await processOneFile(repoAbs, relFile, swiftcBin, options.timeoutMs);
    invocations += 1;
    symbols.push(...outcome.symbols);
    for (const reason of outcome.parserReasons) partialReasons.add(reason);
    if (outcome.errors.length > 0) {
      syntaxErrorFiles.push(Object.freeze({ file: relFile, errors: outcome.errors }));
      partialReasons.add(`${relFile}: ${outcome.errors.length} syntax error(s)`);
    }
    if (outcome.kind === "parsed" && outcome.hadSourceFile) {
      parsedCount += 1;
    } else {
      const reason = outcome.reason ?? "parse_failed";
      failed.push({ file: relFile, reason });
      partialReasons.add(`${relFile}: ${reason}`);
    }
  }

  const parser: SwiftParserRecord = Object.freeze({
    backend: "swiftc_dump_parse",
    compilerVersion: detectCompilerVersion(swiftcBin, options.compilerVersionLabel),
    invocation: "swiftc -dump-parse <file>",
    semanticBinding: false,
  });
  const coverage: SwiftCoverageRecord = Object.freeze({
    scopeFilesDiscovered: selected.files.length,
    scopeFilesParsed: parsedCount,
    scopeFilesFailed: Object.freeze(failed),
    skipped: Object.freeze(skipped),
    syntaxErrorFiles: Object.freeze(syntaxErrorFiles),
    partial: failed.length > 0 || skipped.length > 0 || syntaxErrorFiles.length > 0 || partialReasons.size > 0,
    partialReasons: Object.freeze([...partialReasons]),
    truncated: false,
    parserInvocations: invocations,
    notes: Object.freeze([
      "Swift columns are 1-based Unicode code-point columns converted from swiftc UTF-8 byte columns",
      "symlinks are never followed; non-regular entries are skipped",
      "semanticBinding=false; declarations only",
    ]),
  });
  return Object.freeze({
    status: "ok",
    result: projectSwiftSymbolTableResult(request, parser, Object.freeze(symbols), coverage),
  });
}

export function createSwiftSymbolTableAdapter(
  options: SwiftSymbolTableAdapterOptions = {},
): Readonly<{
  symbols: (request: unknown) => Promise<SwiftSymbolTableOutcome>;
}> {
  return Object.freeze({
    symbols: (request: unknown) => runSwiftSymbolTable(request, options),
  });
}

