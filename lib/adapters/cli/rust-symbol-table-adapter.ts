// Single-file Rust symbol-table adapter. Backend is exactly
// `rustc -Z unpretty=ast-tree`: stdout is consumed through `child_process.spawn`
// one line at a time, so the full AST dump is never retained. File discovery and
// public CLI wiring are owned by the public entry; this module processes an
// explicit list of repo-relative `.rs` files.

import { spawn } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

import {
  projectRustSymbolTableResult,
  symbolIdFor,
  validateRustSymbolRequest,
  type RustCoverageRecord,
  type RustEdition,
  type RustMacroBoundary,
  type RustParserRecord,
  type RustSpan,
  type RustSymbolKind,
  type RustSymbolRecord,
  type RustSymbolTableOutcome,
  type RustVisibility,
} from "../../filters/rust-symbol-table-policy.js";

const RUSTC_BOOTSTRAP_ENV = "1";
const DEFAULT_RUSTC = "rustc";
const AST_DUMP_ARGS = ["-Z", "unpretty=ast-tree"] as const;

/** Mutable span used internally before projection. */
type MutableSpan = {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
};

function asSpan(span: MutableSpan): RustSpan {
  return Object.freeze({
    startLine: span.startLine,
    startCol: span.startCol,
    endLine: span.endLine,
    endCol: span.endCol,
  });
}

const SPAN_RE = /:(\d+):(\d+):\s*(\d+):(\d+)\s*\(#\d+\)\s*,?\s*$/;

function parseSpanTrimming(text: string): MutableSpan | null {
  const match = SPAN_RE.exec(text);
  if (match === null) return null;
  return {
    startLine: Number(match[1]),
    startCol: Number(match[2]),
    endLine: Number(match[3]),
    endCol: Number(match[4]),
  };
}

function parseSpanLine(trimmed: string): MutableSpan | null {
  if (!trimmed.startsWith("span: ")) return null;
  return parseSpanTrimming(trimmed);
}

/** Code-point sliced source text indexed by 1-based line, code-point column. */
class SourceText {
  private readonly lines: readonly string[];
  private readonly points: (readonly string[] | undefined)[];

  constructor(content: string) {
    this.lines = content.split(/\r?\n/);
    this.points = new Array(this.lines.length).fill(undefined);
  }

  private codePoints(lineIndex: number): readonly string[] {
    const cached = this.points[lineIndex];
    if (cached !== undefined) return cached;
    const line = this.lines[lineIndex] ?? "";
    const points = Array.from(line);
    this.points[lineIndex] = points;
    return points;
  }

  slice(span: MutableSpan): string {
    const startLine = span.startLine;
    const endLine = span.endLine;
    if (startLine === endLine) {
      const points = this.codePoints(startLine - 1);
      return points.slice(span.startCol - 1, span.endCol - 1).join("");
    }
    const first = this.codePoints(startLine - 1).slice(span.startCol - 1).join("");
    const parts: string[] = [first];
    for (let line = startLine; line < endLine - 1; line += 1) {
      parts.push(this.lines[line] ?? "");
    }
    const last = this.codePoints(endLine - 1).slice(0, span.endCol - 1).join("");
    parts.push(last);
    return parts.join("\n");
  }

  collapse(span: MutableSpan): string {
    return this.slice(span).replace(/\s+/g, " ").trim();
  }
}

type AttrMode = "none" | "attrs" | "attribute";
type CaptureKind = "implTrait" | "ownerType" | "macroPath";

type Frame = {
  indent: number;
  lexicalScope: string[];
  inheritedCfgTexts: string[];
  enclosingIsMethod: boolean;
  enclosingType: string | null;
  enclosingTrait: string | null;
  attrMode: AttrMode;
  attributeCfg: boolean;
  attributeSpan: MutableSpan | null;
  cfgSpans: MutableSpan[];
  declSpan: MutableSpan | null;
  inVis: boolean;
  visKind: RustVisibility;
  kindType: string | null;
  capture: CaptureKind | null;
  implTraitText: string | null;
  ownerTypeText: string | null;
  macroPathText: string | null;
  name: string | null;
  modPositional: number;
  nestedIndent: number | null;
};

const NAME_TOKEN_RE = /^(.+?)#\d+,$/;
const IDENT_FIELD_RE = /^ident: (.+?)#\d+,$/;
const KIND_RE = /^kind: ([A-Za-z0-9_]+)\(/;

/**
 * Incremental line parser for `rustc -Z unpretty=ast-tree` output.
 *
 * It keeps only small per-open-item state. Nested items of `impl`, `trait` and
 * inline `mod` bodies are parsed as their own frames, so an enclosing inline
 * module is never buffered as whole-file text.
 */
class RustAstTreeStreamParser {
  readonly symbols: RustSymbolRecord[] = [];
  readonly macroBoundaries: RustMacroBoundary[] = [];
  private readonly stack: Frame[] = [];
  private readonly source: SourceText;
  private readonly relFile: string;

  constructor(source: SourceText, relFile: string) {
    this.source = source;
    this.relFile = relFile;
  }

  pushLine(rawLine: string): void {
    const text = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const indent = text.length - text.trimStart().length;

    if (trimmed === "Item {") {
      const parent = this.stack.length === 0 ? null : this.stack[this.stack.length - 1] ?? null;
      if (parent === null) {
        if (indent === 8) this.stack.push(this.newFrame(indent, null));
        return;
      }
      if (parent.nestedIndent !== null && indent === parent.nestedIndent) {
        this.stack.push(this.newFrame(indent, parent));
      }
      return;
    }

    if (this.stack.length === 0) return;
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) return;
    if (trimmed === "}," && indent === top.indent) {
      this.finalize(top);
      this.stack.pop();
      return;
    }
    this.onField(top, indent, trimmed);
  }

  private newFrame(indent: number, parent: Frame | null): Frame {
    const lexicalScope = parent === null ? ["crate"] : parent.lexicalScope.slice();
    if (parent !== null) {
      const label = this.containerLabel(parent);
      if (label !== null) lexicalScope.push(label);
    }
    const inheritedCfgTexts = parent === null ? [] : this.effectiveCfgTexts(parent);
    const enclosingIsMethod =
      parent !== null && (parent.kindType === "Impl" || parent.kindType === "Trait");
    let enclosingType: string | null = null;
    let enclosingTrait: string | null = null;
    if (parent !== null) {
      if (parent.kindType === "Impl") {
        enclosingType = parent.ownerTypeText;
        enclosingTrait = parent.implTraitText;
      } else if (parent.kindType === "Trait") {
        enclosingTrait = parent.name;
      }
    }
    return {
      indent,
      lexicalScope,
      inheritedCfgTexts,
      enclosingIsMethod,
      enclosingType,
      enclosingTrait,
      attrMode: "none",
      attributeCfg: false,
      attributeSpan: null,
      cfgSpans: [],
      declSpan: null,
      inVis: false,
      visKind: "private",
      kindType: null,
      capture: null,
      implTraitText: null,
      ownerTypeText: null,
      macroPathText: null,
      name: null,
      modPositional: 0,
      nestedIndent: null,
    };
  }

  private effectiveCfgTexts(frame: Frame): string[] {
    const own = frame.cfgSpans.map(span => this.source.collapse(span));
    return [...frame.inheritedCfgTexts, ...own];
  }

  private containerLabel(frame: Frame): string | null {
    if (frame.kindType === "Impl") {
      const typeName = frame.ownerTypeText ?? "?";
      if (frame.implTraitText !== null) {
        return `impl:${frame.implTraitText} for ${typeName}`;
      }
      return `impl:${typeName}`;
    }
    if (frame.kindType === "Trait") {
      return `trait:${frame.name ?? "?"}`;
    }
    if (frame.kindType === "Mod") {
      return `mod:${frame.name ?? "?"}`;
    }
    return null;
  }

  private onField(frame: Frame, indent: number, trimmed: string): void {
    const fieldIndent = frame.indent + 4;

    if (frame.attrMode === "attrs") {
      if (indent === fieldIndent + 4 && trimmed === "Attribute {") {
        frame.attrMode = "attribute";
        frame.attributeCfg = false;
        frame.attributeSpan = null;
      } else if (indent === fieldIndent && trimmed === "],") {
        frame.attrMode = "none";
      }
      return;
    }

    if (frame.attrMode === "attribute") {
      if (trimmed === "ident: cfg#0," || trimmed === "ident: cfg_attr#0,") {
        frame.attributeCfg = true;
        return;
      }
      if (indent === fieldIndent + 8) {
        const span = parseSpanLine(trimmed);
        if (span !== null) {
          frame.attributeSpan = span;
        }
        return;
      }
      if (indent === fieldIndent + 4 && trimmed === "},") {
        if (frame.attributeCfg && frame.attributeSpan !== null) {
          frame.cfgSpans.push(frame.attributeSpan);
        }
        frame.attributeSpan = null;
        frame.attributeCfg = false;
        frame.attrMode = "attrs";
      }
      return;
    }

    if (frame.inVis) {
      if (indent === fieldIndent + 4 && trimmed.startsWith("kind: ")) {
        if (trimmed.startsWith("kind: Public")) {
          frame.visKind = "pub";
        } else if (trimmed.startsWith("kind: Restricted")) {
          frame.visKind = "pub(restricted)";
        } else {
          frame.visKind = "private";
        }
        return;
      }
      if (indent === fieldIndent && trimmed === "},") {
        frame.inVis = false;
      }
      return;
    }

    if (indent === fieldIndent) {
      if (trimmed === "attrs: [") {
        frame.attrMode = "attrs";
        return;
      }
      if (trimmed === "attrs: [],") {
        return;
      }
      const span = parseSpanLine(trimmed);
      if (span !== null) {
        if (frame.declSpan === null) {
          frame.declSpan = span;
        }
        return;
      }
      if (trimmed === "vis: Visibility {") {
        frame.inVis = true;
        return;
      }
      const kindMatch = KIND_RE.exec(trimmed);
      if (kindMatch !== null && frame.kindType === null) {
        frame.kindType = kindMatch[1] ?? null;
      }
      return;
    }

    this.onKindField(frame, indent, trimmed);
  }

  private onKindField(frame: Frame, indent: number, trimmed: string): void {
    if (frame.kindType === null) return;

    if (frame.capture !== null) {
      const span = parseSpanLine(trimmed);
      if (span !== null) {
        if (frame.capture === "implTrait") {
          frame.implTraitText = this.source.collapse(span);
        } else if (frame.capture === "ownerType") {
          frame.ownerTypeText = this.source.collapse(span);
        } else {
          frame.macroPathText = this.source.collapse(span);
        }
        frame.capture = null;
      }
      return;
    }

    const base = frame.indent;
    switch (frame.kindType) {
      case "Fn":
        if (frame.name === null && indent === base + 12) {
          const match = IDENT_FIELD_RE.exec(trimmed);
          if (match !== null) frame.name = match[1] ?? null;
        }
        return;
      case "Struct":
      case "Enum":
        if (frame.name === null && indent === base + 8) {
          const match = NAME_TOKEN_RE.exec(trimmed);
          if (match !== null) frame.name = match[1] ?? null;
        }
        return;
      case "Trait":
        if (frame.name === null && indent === base + 12) {
          const match = IDENT_FIELD_RE.exec(trimmed);
          if (match !== null) frame.name = match[1] ?? null;
        }
        if (frame.nestedIndent === null && indent === base + 12 && trimmed === "items: [") {
          frame.nestedIndent = base + 16;
        }
        return;
      case "Impl":
        if (indent === base + 12 && trimmed === "of_trait: Some(") {
          frame.capture = "implTrait";
          return;
        }
        if (indent === base + 12 && trimmed === "self_ty: Ty {") {
          frame.capture = "ownerType";
          return;
        }
        if (frame.nestedIndent === null && indent === base + 12 && trimmed === "items: [") {
          frame.nestedIndent = base + 16;
        }
        return;
      case "Mod":
        if (indent === base + 8) {
          if (frame.modPositional === 0) {
            frame.modPositional = 1;
            return;
          }
          if (frame.modPositional === 1) {
            const match = NAME_TOKEN_RE.exec(trimmed);
            if (match !== null) frame.name = match[1] ?? null;
            frame.modPositional = 2;
            return;
          }
          if (frame.modPositional === 2) {
            if (trimmed.startsWith("Loaded(")) frame.nestedIndent = base + 16;
            frame.modPositional = 3;
            return;
          }
        }
        return;
      case "MacroDef":
        if (frame.name === null && indent === base + 8) {
          const match = NAME_TOKEN_RE.exec(trimmed);
          if (match !== null) frame.name = match[1] ?? null;
        }
        return;
      case "MacCall":
        if (trimmed === "path: Path {") {
          frame.capture = "macroPath";
        }
        return;
      default:
        return;
    }
  }

  private makeSymbol(
    frame: Frame,
    name: string,
    kind: RustSymbolKind,
    declSpan: RustSpan,
    cfgAttributes: string[],
    cfgConditional: boolean,
  ): RustSymbolRecord {
    const isMethod = kind === "method";
    const ownerType = isMethod ? frame.enclosingType : null;
    const implTrait = isMethod ? frame.enclosingTrait : null;
    return Object.freeze({
      symbolId: symbolIdFor(this.relFile, name, declSpan),
      name,
      kind,
      file: this.relFile,
      declSpan,
      nameSpan: null,
      nameSpanSource: "null_reason: parser_ident_span_unavailable",
      lexicalScope: Object.freeze(frame.lexicalScope.slice()),
      projectModulePath: "unknown",
      ownerType,
      implTrait,
      visibility: frame.visKind,
      cfgConditional,
      cfgAttributes: Object.freeze(cfgAttributes.slice()),
      parseStatus: "complete",
    });
  }

  private finalize(frame: Frame): void {
    if (frame.declSpan === null) return;
    const declSpan = asSpan(frame.declSpan);
    const cfgAttributes = this.effectiveCfgTexts(frame);
    const cfgConditional = cfgAttributes.length > 0;

    switch (frame.kindType) {
      case "Fn": {
        if (frame.name === null) return;
        const kind: RustSymbolKind = frame.enclosingIsMethod ? "method" : "function";
        this.symbols.push(this.makeSymbol(frame, frame.name, kind, declSpan, cfgAttributes, cfgConditional));
        return;
      }
      case "Struct":
      case "Enum":
      case "Trait":
      case "Mod": {
        if (frame.name === null) return;
        const kind: RustSymbolKind =
          frame.kindType === "Struct"
            ? "struct"
            : frame.kindType === "Enum"
              ? "enum"
              : frame.kindType === "Trait"
                ? "trait"
                : "module";
        this.symbols.push(this.makeSymbol(frame, frame.name, kind, declSpan, cfgAttributes, cfgConditional));
        return;
      }
      case "MacroDef": {
        if (frame.name === null) return;
        this.macroBoundaries.push(Object.freeze({
          boundaryKind: "macro_rules_definition",
          macroName: frame.name,
          file: this.relFile,
          declSpan,
        }));
        return;
      }
      case "MacCall": {
        const pathText = frame.macroPathText ?? "unknown_macro";
        const segments = pathText.split("::");
        const macroName = segments[segments.length - 1]?.trim() || "unknown_macro";
        const rawInvocationPreview = this.source.collapse(frame.declSpan).slice(0, 120);
        this.macroBoundaries.push(Object.freeze({
          boundaryKind: "unexpanded_item_macro_call",
          macroName,
          file: this.relFile,
          declSpan,
          rawInvocationPreview,
        }));
        return;
      }
      default:
        return;
    }
  }
}

export type RustSymbolTableAdapterOptions = Readonly<{
  /** rustc binary to invoke. Defaults to `rustc` resolved from PATH. */
  rustcBin?: string;
  /** Optional hard timeout for one file parse. */
  timeoutMs?: number;
  /** Optional override of the recorded toolchain label (tests / callers). */
  toolchainLabel?: string;
}>;

type FileProcessResult =
  | Readonly<{ kind: "parsed"; symbols: RustSymbolRecord[]; boundaries: RustMacroBoundary[]; invocations: number }>
  | Readonly<{ kind: "skipped"; reason: string; invocations: number }>
  | Readonly<{ kind: "failed"; reason: string; invocations: number }>;

type RustcRun = Readonly<{
  exitCode: number | null;
  stderr: string;
  spawnError: string | null;
}>;

function runRustcAst(
  rustcBin: string,
  absFile: string,
  edition: RustEdition,
  parser: RustAstTreeStreamParser,
  timeoutMs: number | undefined,
): Promise<RustcRun> {
  return new Promise<RustcRun>(resolve => {
    let settled = false;
    const finish = (run: RustcRun): void => {
      if (settled) return;
      settled = true;
      resolve(run);
    };

    const args = [
      ...AST_DUMP_ARGS,
      `--edition=${edition}`,
      "--error-format=short",
      absFile,
    ];
    const child = spawn(rustcBin, args, {
      env: { ...process.env, RUSTC_BOOTSTRAP: RUSTC_BOOTSTRAP_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ exitCode: null, stderr: `${stderr}\nrustc parse timed out after ${timeoutMs}ms`, spawnError: null });
      }, timeoutMs);
    }

    child.on("error", error => {
      if (timer !== null) clearTimeout(timer);
      finish({ exitCode: null, stderr, spawnError: error.message });
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stderr.length > 1_000_000) stderr = stderr.slice(0, 1_000_000);
    });

    if (child.stdout !== null) {
      const reader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      reader.on("line", line => parser.pushLine(line));
      reader.on("close", () => {
        // stdout fully drained.
      });
    }

    child.on("close", code => {
      if (timer !== null) clearTimeout(timer);
      finish({ exitCode: code, stderr, spawnError: null });
    });
  });
}

export async function runRustSymbolTable(
  rawRequest: unknown,
  options: RustSymbolTableAdapterOptions = {},
): Promise<RustSymbolTableOutcome> {
  const validation = validateRustSymbolRequest(rawRequest);
  if (!validation.ok) {
    return validation.error;
  }
  const request = validation.request;
  const repoAbs = path.resolve(request.repo);
  const rustcBin = options.rustcBin ?? DEFAULT_RUSTC;
  const toolchain = options.toolchainLabel ?? (await detectToolchain(rustcBin));

  const parserRecord: RustParserRecord = Object.freeze({
    backend: "rustc_ast_unpretty",
    toolchain,
    edition: request.edition,
    editionSource: request.editionSource,
    invocation: `RUSTC_BOOTSTRAP=1 rustc -Z unpretty=ast-tree --edition=${request.edition} <file>`,
    semanticBinding: false,
  });

  const uniqueFiles: string[] = [];
  const seenFiles = new Set<string>();
  for (const file of request.files) {
    if (!seenFiles.has(file)) {
      seenFiles.add(file);
      uniqueFiles.push(file);
    }
  }

  const symbols: RustSymbolRecord[] = [];
  const boundaries: RustMacroBoundary[] = [];
  const failed: { file: string; reason: string }[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const partialReasons: string[] = [];
  let parsedCount = 0;
  let invocations = 0;

  for (const relFile of uniqueFiles) {
    const outcome = await processOneFile(repoAbs, relFile, request.edition, rustcBin, options.timeoutMs);
    invocations += outcome.invocations;
    if (outcome.kind === "parsed") {
      parsedCount += 1;
      symbols.push(...outcome.symbols);
      boundaries.push(...outcome.boundaries);
    } else if (outcome.kind === "skipped") {
      skipped.push({ file: relFile, reason: outcome.reason });
    } else {
      failed.push({ file: relFile, reason: outcome.reason });
      partialReasons.push(`${relFile}: ${outcome.reason}`);
    }
  }

  const notes = [
    `edition derived from ${request.editionSource}; Cargo.toml is not read`,
    "rustc -Z unpretty=ast-tree does not emit identifier spans; nameSpan is null",
  ];

  const coverage: RustCoverageRecord = Object.freeze({
    scopeFilesDiscovered: uniqueFiles.length,
    scopeFilesParsed: parsedCount,
    scopeFilesFailed: Object.freeze(failed),
    skipped: Object.freeze(skipped),
    partial: failed.length > 0,
    partialReasons: Object.freeze(partialReasons),
    truncated: false,
    parserInvocations: invocations,
    notes: Object.freeze(notes),
  });

  const result = projectRustSymbolTableResult(
    request,
    parserRecord,
    symbols,
    boundaries,
    coverage,
  );
  return Object.freeze({ status: "ok", result });
}

export function createRustSymbolTableAdapter(
  options: RustSymbolTableAdapterOptions = {},
): Readonly<{
  symbols: (request: unknown) => Promise<RustSymbolTableOutcome>;
}> {
  return Object.freeze({
    symbols: (request: unknown) => runRustSymbolTable(request, options),
  });
}

function resolveInRepo(repoAbs: string, relFile: string): string {
  return path.resolve(repoAbs, relFile);
}

function isInside(repoAbs: string, absFile: string): boolean {
  const relative = path.relative(repoAbs, absFile);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function processOneFile(
  repoAbs: string,
  relFile: string,
  edition: RustEdition,
  rustcBin: string,
  timeoutMs: number | undefined,
): Promise<FileProcessResult> {
  const absFile = resolveInRepo(repoAbs, relFile);
  if (!isInside(repoAbs, absFile)) {
    return { kind: "failed", reason: "path_escape", invocations: 0 };
  }
  let stats;
  try {
    stats = await lstat(absFile);
  } catch (error) {
    return { kind: "failed", reason: `stat_failed: ${(error as Error).message}`, invocations: 0 };
  }
  if (stats.isSymbolicLink()) {
    return { kind: "skipped", reason: "symlink_not_followed", invocations: 0 };
  }
  if (!stats.isFile()) {
    return { kind: "failed", reason: "not_a_regular_file", invocations: 0 };
  }

  let sourceContent: string;
  try {
    sourceContent = await readFile(absFile, "utf8");
  } catch (error) {
    return { kind: "failed", reason: `read_failed: ${(error as Error).message}`, invocations: 0 };
  }

  const parser = new RustAstTreeStreamParser(new SourceText(sourceContent), relFile);
  const run = await runRustcAst(rustcBin, absFile, edition, parser, timeoutMs);
  if (run.spawnError !== null) {
    return { kind: "failed", reason: `spawn_failed: ${run.spawnError}`, invocations: 1 };
  }
  if (run.exitCode !== 0) {
    const reason = run.stderr.trim().split("\n")[0] ?? `rustc exited ${String(run.exitCode)}`;
    return { kind: "failed", reason: `syntax_error: ${reason}`, invocations: 1 };
  }
  return { kind: "parsed", symbols: parser.symbols, boundaries: parser.macroBoundaries, invocations: 1 };
}

async function detectToolchain(rustcBin: string): Promise<string> {
  return new Promise<string>(resolve => {
    const child = spawn(rustcBin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", () => resolve("unknown"));
    child.on("close", () => {
      const text = output.trim();
      const match = /rustc ([^\s(]+)/.exec(text);
      const version = match?.[1] ?? "unknown";
      if (text.includes("nightly")) {
        resolve(`nightly-${version}`);
      } else if (text.includes("beta")) {
        resolve(`beta-${version}`);
      } else {
        resolve(`stable-${version}`);
      }
    });
  });
}
