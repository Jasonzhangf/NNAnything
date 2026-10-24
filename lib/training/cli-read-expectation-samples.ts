/**
 * Sample preparation for the CLI read expectation experiment.
 *
 * Twelve families fixed by the experiment contract. Each instance is a real
 * sandbox scenario: the receipt is produced by the real reader, the supervision
 * comes from the independent oracle in `filters/cli-read-expectation.ts`.
 * Nothing here derives gold from a model prediction.
 */

import { chmod, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCliFilesystemSandbox,
  type CliFilesystemSandbox,
} from "../adapters/cli/filesystem-sandbox.js";
import {
  BASE_LABELS,
  REASONING_LABELS,
  type BaseLabel,
  type CoverageInterval,
  type ReadAttempt,
  type ReadContext,
  type ReadRequest,
  type ReasoningLabel,
} from "../adapters/cli/read-expectation-contract.js";
import {
  attemptCoverage,
  mergeCoverage,
  measureBase,
  measureQuantity,
  measureReasoning,
  superviseBase,
  superviseReasoning,
} from "../filters/cli-read-expectation.js";
import type { BaseEpisode, ReasoningEpisode } from "./cli-read-expectation-numeric.js";

export type Partition = "train" | "dev" | "verification";

export type CaseAction =
  | Readonly<{ kind: "read"; path: string; readLength?: number }>
  | Readonly<{ kind: "read-then-noop"; path: string }>
  | Readonly<{ kind: "no-receipt" }>
  | Readonly<{ kind: "read-then-unlink"; path: string }>
  | Readonly<{ kind: "read-then-replace"; path: string; replacement: string }>
  | Readonly<{ kind: "read-denied"; path: string }>
  | Readonly<{ kind: "injected-transient"; code: string }>;

export type CaseSpec = Readonly<{
  id: string;
  family: number;
  partition: Partition;
  provenance: "real" | "injected";
  directory: string;
  files: readonly Readonly<{ path: string; contents: string }>[];
  request: ReadRequest;
  context: ReadContext;
  action: CaseAction;
  prior?: readonly Readonly<{ offset: number; length: number }>[];
}>;

const SKILLS_ALL = ["read", "inspect", "observe"] as const;

function context(overrides: Partial<ReadContext> = {}): ReadContext {
  return Object.freeze({
    target: "current",
    bindingReissuable: true,
    retryEligible: false,
    retryBudgetLeft: 0,
    retryExhausted: false,
    skills: SKILLS_ALL,
    ...overrides,
  });
}

function headRequest(quantity: number, mode: "up_to" | "exact" = "exact"): ReadRequest {
  return Object.freeze({ shape: "head", mode, quantity, offset: 0, length: quantity });
}

function rangeRequest(offset: number, length: number, mode: "up_to" | "exact" = "exact"): ReadRequest {
  return Object.freeze({ shape: "range", mode, quantity: length, offset, length });
}

function tailRequest(quantity: number, mode: "up_to" | "exact" = "exact"): ReadRequest {
  return Object.freeze({ shape: "tail", mode, quantity, offset: 0, length: quantity });
}

const BODY = "abcdefghijklmnopqrstuvwxyz0123456789";

function text(length: number, seed: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) out += BODY[(index + seed) % BODY.length];
  return out;
}

const PARTITIONS: readonly Partition[] = ["train", "dev", "verification"];

/**
 * Family counts. Family 2 is wider than the original 2/1/1 because the contract
 * requires the "no receipt" vs "legal zero-byte success" pair, and the
 * no-receipt state has no other real source. Total 76 instances.
 */
function partitionCounts(family: number): Readonly<{ train: number; dev: number; verification: number }> {
  if (family === 2) return Object.freeze({ train: 4, dev: 2, verification: 2 });
  const wide = family === 1 || family === 4 || family === 5 || family === 8 || family === 11 || family === 12;
  return wide
    ? Object.freeze({ train: 4, dev: 2, verification: 2 })
    : Object.freeze({ train: 2, dev: 1, verification: 1 });
}

type FamilyBuilder = (index: number, ordinal: number) => Readonly<{
  files: readonly Readonly<{ path: string; contents: string }>[];
  request: ReadRequest;
  context: ReadContext;
  action: CaseAction;
  prior?: readonly Readonly<{ offset: number; length: number }>[];
  provenance?: "real" | "injected";
}>;

function file(name: string, contents: string): Readonly<{ path: string; contents: string }> {
  return Object.freeze({ path: name, contents });
}

const FAMILY_BUILDERS: readonly FamilyBuilder[] = [
  // 1 普通非空读取：前/中/尾偏移与分段请求；其中 3 条分段未覆盖 → need_remaining_data
  (index, ordinal) => {
    const size = 16 + ordinal;
    const name = `plain-${ordinal}.txt`;
    const files = [file(name, text(size, ordinal))];
    if (index === 0) {
      // partial attempt: asks for 8, reads only 3, more data remains
      return { files, action: { kind: "read", path: name, readLength: 3 }, request: headRequest(8), context: context() };
    }
    if (index === 1) {
      return { files, action: { kind: "read", path: name }, request: headRequest(3), context: context() };
    }
    if (index === 2) {
      // partial tail-shaped request that still leaves a gap
      return { files, action: { kind: "read", path: name, readLength: 3 }, request: rangeRequest(1, 8), context: context() };
    }
    return { files, action: { kind: "read", path: name }, request: tailRequest(4), context: context() };
  },
  // 2 零字节与无回执配对：train 三条无回执 + 一条合法零长度读
  (index, ordinal) => {
    if (index !== 3) {
      const name = `empty-${ordinal}.txt`;
      return { files: [file(name, "")], action: { kind: "no-receipt" }, request: headRequest(4),
        context: context(), provenance: "injected" };
    }
    const name = `empty-legal-${ordinal}.txt`;
    return { files: [file(name, "")], action: { kind: "read-then-noop", path: name }, request: rangeRequest(0, 0), context: context() };
  },
  // 3 零长度请求（合法且满足）
  (_index, ordinal) => {
    const size = 9 + ordinal;
    const name = `zerolen-${ordinal}.txt`;
    return { files: [file(name, text(size, ordinal))], action: { kind: "read", path: name }, request: rangeRequest(1, 0), context: context() };
  },
  // 4 exact 恰好到边界
  (_index, ordinal) => {
    const size = 8 + ordinal;
    const name = `boundary-${ordinal}.txt`;
    return { files: [file(name, text(size, ordinal))], action: { kind: "read", path: name }, request: rangeRequest(0, size), context: context() };
  },
  // 5 越过 EOF：up_to 允许少于 N，exact 确认端点后仍不足
  (index, ordinal) => {
    const size = 5 + ordinal;
    const name = `past-${ordinal}.txt`;
    return { files: [file(name, text(size, ordinal))], action: { kind: "read", path: name },
      request: index % 2 === 0 ? headRequest(size + 5, "up_to") : headRequest(size + 5, "exact"), context: context() };
  },
  // 6 跨块：先读后段，再读前段，合并后覆盖
  (_index, ordinal) => {
    const size = 12 + ordinal;
    const name = `cross-${ordinal}.txt`;
    return { files: [file(name, text(size, ordinal))], action: { kind: "read", path: name },
      request: rangeRequest(0, 4), prior: [{ offset: 4, length: 4 }], context: context() };
  },
  // 7 无换行结尾
  (_index, ordinal) => {
    const name = `nonl-${ordinal}.txt`;
    return { files: [file(name, "line1\nline2")], action: { kind: "read", path: name }, request: headRequest(11), context: context() };
  },
  // 8 UTF-8 在码点内切分：覆盖不足
  (_index, ordinal) => {
    const name = `utf8-${ordinal}.txt`;
    return { files: [file(name, "中文内容测试")], action: { kind: "read", path: name, readLength: 4 }, request: rangeRequest(0, 8), context: context() };
  },
  // 9 缺失文件：真实 ENOENT
  (_index, ordinal) => {
    const name = `missing-${ordinal}.txt`;
    return { files: [file(name, "abc")], action: { kind: "read-then-unlink", path: name }, request: headRequest(3), context: context() };
  },
  // 10 真实拒权
  (_index, ordinal) => {
    const name = `denied-${ordinal}.txt`;
    return { files: [file(name, "abc")], action: { kind: "read-denied", path: name }, request: headRequest(3), context: context() };
  },
  // 11 当前引用失效：身份在读取前改变
  (_index, ordinal) => {
    const size = 10 + ordinal;
    const name = `stale-${ordinal}.txt`;
    return { files: [file(name, text(size, ordinal))], action: { kind: "read-then-replace", path: name, replacement: text(size + 1, ordinal + 3) },
      request: headRequest(3), context: context({ target: "stale" }) };
  },
  // 12 注入瞬时错误、重试耗尽与无回执
  (index, ordinal) => {
    const name = `transient-${ordinal}.txt`;
    if (index === 0) {
      return { files: [file(name, "abcd")], action: { kind: "injected-transient", code: "EINTR" }, request: headRequest(3),
        context: context({ retryEligible: true, retryBudgetLeft: 1 }), provenance: "injected" };
    }
    if (index === 1) {
      return { files: [file(name, "abcd")], action: { kind: "injected-transient", code: "EAGAIN" }, request: headRequest(3),
        context: context({ retryEligible: true, retryBudgetLeft: 1 }), provenance: "injected" };
    }
    if (index === 2) {
      return { files: [file(name, "abcd")], action: { kind: "injected-transient", code: "EINTR" }, request: headRequest(3),
        context: context({ retryEligible: true, retryBudgetLeft: 2 }), provenance: "injected" };
    }
    return { files: [file(name, "abcd")], action: { kind: "injected-transient", code: "EINTR" }, request: headRequest(3),
      context: context({ retryEligible: false, retryBudgetLeft: 0, retryExhausted: true }), provenance: "injected" };
  },
];

/** Deterministic case list; sizes and offsets differ per instance. */
export function buildCases(): readonly CaseSpec[] {
  const cases: CaseSpec[] = [];
  for (let family = 1; family <= FAMILY_BUILDERS.length; family += 1) {
    const counts = partitionCounts(family);
    const builder = FAMILY_BUILDERS[family - 1]!;
    let ordinal = 0;
    for (const partition of PARTITIONS) {
      for (let index = 0; index < counts[partition]; index += 1) {
        ordinal += 1;
        const built = builder(index, ordinal);
        cases.push(Object.freeze({
          id: `f${family}-${partition}-${index + 1}`,
          family,
          partition,
          provenance: built.provenance ?? "real",
          directory: `scenario-f${family}-${partition}-${index + 1}`,
          files: built.files,
          request: built.request,
          context: built.context,
          action: built.action,
          ...(built.prior === undefined ? {} : { prior: built.prior }),
        }));
      }
    }
  }
  return Object.freeze(cases);
}

export type CaseMeasurement = Readonly<{
  spec: CaseSpec;
  attempt: ReadAttempt;
  injected: boolean;
}>;

/** Run one case against a fresh real sandbox and return the receipt-backed attempt. */
export async function measureCase(spec: CaseSpec): Promise<CaseMeasurement> {
  if (spec.action.kind === "injected-transient") {
    const attempt: ReadAttempt = Object.freeze({
      request: spec.request,
      observation: null,
      failure: Object.freeze({ stage: "observe", code: spec.action.code, message: "injected transient error", executorInvoked: true }),
      priorCoverage: [],
    });
    return Object.freeze({ spec, attempt, injected: true });
  }

  if (spec.action.kind === "no-receipt") {
    const attempt: ReadAttempt = Object.freeze({
      request: spec.request,
      observation: null,
      failure: null,
      priorCoverage: [],
    });
    return Object.freeze({ spec, attempt, injected: true });
  }

  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-read-expectation-")));
  const sandbox = await createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.read", "filesystem.write"],
    recipe: {
      scenarioId: spec.directory,
      entries: [
        ...spec.files.map(file => ({ path: file.path, kind: "file" as const, contents: file.contents })),
      ],
      sessions: [{ id: "session", cwd: ".", grantedEffects: ["filesystem.read"] }],
    },
  });
  try {
    const session = sandbox.bindSession("session");
    const action = spec.action as Readonly<{ kind: "read" | "read-then-noop" | "read-then-unlink" | "read-then-replace" | "read-denied"; path: string }>;
    const targetPath = action.path;
    const ref = await sandbox.bindFile(session, targetPath);
    const priorCoverage: CoverageInterval[] = [];
    for (const prior of spec.prior ?? []) {
      const receipt = await sandbox.execute({
        operation: "file.read",
        parameters: { ref, offset: prior.offset, length: prior.length },
      });
      const observation = readObservation(receipt);
      if (observation !== null) {
        priorCoverage.push(...[[observation.offset, observation.offset + observation.bytesRead]] as CoverageInterval[]);
      }
    }
    const physical = join(root, spec.directory, targetPath);
    // Tail offsets are harness-computed from the real size; the model never
    // chooses an offset.
    const sizeBytes = spec.files.find(entry => entry.path === targetPath)?.contents.length ?? 0;
    const effectiveOffset = spec.request.shape === "tail"
      ? Math.max(0, sizeBytes - spec.request.quantity)
      : spec.request.offset;
    if (spec.action.kind === "read-then-unlink") await unlink(physical);
    if (spec.action.kind === "read-then-replace") {
      await unlink(physical);
      await writeFile(physical, spec.action.replacement, "utf8");
    }
    if (spec.action.kind === "read-denied") await chmod(physical, 0o000);
    const readLength = spec.action.kind === "read" && spec.action.readLength !== undefined
      ? spec.action.readLength
      : spec.request.length;
    const receipt = await sandbox.execute({
      operation: "file.read",
      parameters: { ref, offset: effectiveOffset, length: readLength },
    });
    const attempt: ReadAttempt = Object.freeze({
      request: spec.request,
      observation: readObservation(receipt),
      failure: readFailure(receipt),
      priorCoverage: Object.freeze(mergeCoverage(priorCoverage)),
    });
    if (spec.action.kind === "read-denied") await chmod(physical, 0o600);
    return Object.freeze({ spec, attempt, injected: false });
  } finally {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

function readObservation(receipt: unknown): ReadAttempt["observation"] {
  const record = receipt as { status?: string; execution?: { observation?: Record<string, unknown> } };
  if (record.status !== "succeeded") return null;
  const observation = record.execution?.observation;
  if (observation === undefined || observation.kind !== "file.read") return null;
  const identity = (observation.identity ?? {}) as Record<string, unknown>;
  return Object.freeze({
    offset: Number(observation.offset),
    length: Number(observation.length),
    size: Number(observation.size),
    bytes: String(observation.bytes),
    bytesRead: Number(observation.bytesRead),
    eof: observation.eof === true,
    dev: identity.dev as number | string,
    ino: identity.ino as number | string,
  });
}

function readFailure(receipt: unknown): ReadAttempt["failure"] {
  const record = receipt as { status?: string; execution?: { executorInvoked?: boolean; error?: { stage?: string; code?: string; message?: string } } };
  if (record.status !== "failed") return null;
  const error = record.execution?.error;
  if (error === undefined) return null;
  return Object.freeze({
    stage: error.stage === "validate" ? "validate" : "observe",
    code: String(error.code),
    message: String(error.message),
    executorInvoked: record.execution?.executorInvoked === true,
  });
}

export type PreparedSamples = Readonly<{
  base: readonly BaseEpisode[];
  counts: Readonly<{
    families: number;
    perPartition: Readonly<Record<Partition, number>>;
    baseLabels: Readonly<Record<BaseLabel, Readonly<Record<Partition, number>>>>;
  }>;
  measurements: readonly CaseMeasurement[];
}>;

/** Measure every case and derive the base unit's episodes plus real per-label counts. */
export async function prepareSamples(cases: readonly CaseSpec[] = buildCases()): Promise<PreparedSamples> {
  const measurements: CaseMeasurement[] = [];
  for (const spec of cases) measurements.push(await measureCase(spec));

  const base: BaseEpisode[] = [];
  const baseCounts = {} as Record<BaseLabel, Record<Partition, number>>;
  for (const label of BASE_LABELS) baseCounts[label] = { train: 0, dev: 0, verification: 0 };

  for (const measurement of measurements) {
    const supervision = superviseBase(measurement.attempt);
    base.push(Object.freeze({
      partition: measurement.spec.partition,
      input: measureBase(measurement.attempt),
      label: Object.freeze({ ...supervision.label }),
      mask: Object.freeze({ ...supervision.mask }),
    }));
    for (const label of BASE_LABELS) {
      if (supervision.mask[label] === 1 && supervision.label[label] === 1) {
        baseCounts[label][measurement.spec.partition] += 1;
      }
    }
  }

  const perPartition: Record<Partition, number> = { train: 0, dev: 0, verification: 0 };
  for (const measurement of measurements) perPartition[measurement.spec.partition] += 1;

  return Object.freeze({
    base: Object.freeze(base),
    counts: Object.freeze({
      families: 12,
      perPartition: Object.freeze(perPartition),
      baseLabels: Object.freeze(baseCounts),
    }),
    measurements: Object.freeze(measurements),
  });
}

/**
 * Build the reasoning unit's episodes from the base unit's infer output.
 *
 * Inputs use predictions (`fb_*`), never gold. The supervision comes from the
 * independent oracle and is unaffected by a wrong prediction.
 */
export function buildReasoningEpisodes(
  measurements: readonly CaseMeasurement[],
  predict: (attempt: ReadAttempt) => Readonly<Record<BaseLabel, 0 | 1>>,
): Readonly<{ episodes: readonly ReasoningEpisode[]; counts: Readonly<Record<ReasoningLabel, Readonly<Record<Partition, number>>>> }> {
  const episodes: ReasoningEpisode[] = [];
  const counts = {} as Record<ReasoningLabel, Record<Partition, number>>;
  for (const label of REASONING_LABELS) counts[label] = { train: 0, dev: 0, verification: 0 };
  for (const measurement of measurements) {
    const prediction = predict(measurement.attempt);
    const supervision = superviseReasoning(measurement.attempt, measurement.spec.context);
    episodes.push(Object.freeze({
      partition: measurement.spec.partition,
      input: measureReasoning(prediction, measurement.attempt, measurement.spec.context),
      allowed: supervision.allowed,
      soft: supervision.soft,
    }));
    for (const label of supervision.allowed) counts[label][measurement.spec.partition] += 1;
  }
  return Object.freeze({ episodes: Object.freeze(episodes), counts: Object.freeze(counts) });
}

/** Coverage of the whole file for one measurement, used by diagnostics. */
export function measurementCoverage(attempt: ReadAttempt): readonly CoverageInterval[] {
  return mergeCoverage([...attempt.priorCoverage, ...attemptCoverage(attempt)]);
}

export { measureQuantity };
