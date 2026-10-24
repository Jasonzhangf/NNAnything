import {
  CWD_PROPERTY,
  ENTRIES_PROPERTY,
  validateGoal,
  type CwdGoal,
  type FilePropertyGoal,
} from "../../filters/cli-file-property.js";
import type { CliCommandPolicyError } from "../../nodes/cli-command.js";
import type { CliCommandProfile } from "../../filters/cli-command-policy.js";
import type { EvidenceAuthority, ExplicitFileState } from "../../filters/cli-state.js";
import type { RecursiveGoalLimits } from "../../workflow/recursive-goal/contracts.js";
import type { ObservedObjectRef, OsInteger } from "./entry-inspection.js";
import type { CliFilesystemSandbox, DirectoryRef, SessionRef, SessionSnapshot } from "./filesystem-sandbox.js";
import { expectRecord } from "../../core/schema.js";

export const CONTENT_BYTES_PROPERTY = "file.property.content.bytes" as const;

export type ContentBytesScopedFileQuery = Readonly<{
  kind: "cli.file-query";
  relation: "entrySelector";
  selector: Readonly<{ type: "regular" }>;
  cardinality: "one";
}>;

export type ContentBytesEqualsGoal = Readonly<{
  kind: "file.property";
  property: typeof CONTENT_BYTES_PROPERTY;
  target: ContentBytesScopedFileQuery;
  requirement: Readonly<{
    kind: "equals";
    range: Readonly<{ offset: number; length: number }>;
    expectedBase64: string;
  }>;
}>;

export type CliContentReadGoal = Readonly<{
  kind: "cli.content-read";
  property: "file.property.content.bytes";
  entry: Readonly<{ name: string; path: string }>;
  range: Readonly<{ offset: number; length: number }>;
  expectedBase64: string;
}>;

export type CliAutonomousGoal = FilePropertyGoal | ContentBytesEqualsGoal | CliContentReadGoal;

export type CliAutonomousGoalFamily =
  | "session_cwd_observed"
  | "session_cwd_equals"
  | "directory_entries_observed"
  | "atomic_file_property"
  | "content_bytes_equals"
  | "unsupported_property";

export type CliAutonomousResources = Readonly<{
  sandbox: CliFilesystemSandbox;
  session: SessionRef;
  profile: CliCommandProfile;
  scope?: DirectoryRef;
  fileName?: string;
  budget?: Partial<RecursiveGoalLimits>;
  grantedEffects: SessionSnapshot["grantedEffects"];
  enabledSkills?: readonly string[];
  initialState?: ExplicitFileState;
  authority?: EvidenceAuthority;
}>;

export type CliAutonomousRequest = Readonly<{
  goal: CliAutonomousGoal;
  resources: CliAutonomousResources;
}>;

export type CliAutonomousStepStatus = "satisfied" | "progressed" | "rejected" | "failed" | "deferred";

export type CliAutonomousStepRecord = Readonly<{
  stepIndex: number;
  phase: string;
  goalProperty: string;
  decisionMechanism: "trained_policy_v1" | "deterministic_exec";
  expectedHead: string | null;
  selectedHead: string | null;
  operation: string | null;
  executorInvoked: boolean;
  status: CliAutonomousStepStatus;
  reason: string;
  policyError: CliCommandPolicyError | null;
}>;

export type CliReadReceipt = Readonly<{
  operation: "file.read";
  offset: number;
  length: number;
  bytesRead: number;
  eof: boolean;
  observedObject: Readonly<{ dev: OsInteger; ino: OsInteger }>;
}>;

export type CliAutonomousSummary = Readonly<{
  family: CliAutonomousGoalFamily;
  status: "satisfied" | "rejected" | "failed" | "deferred";
  reason: string;
  reasonDetail: string | null;
  /** Whether a caller-supplied initialState was accepted as trusted evidence. */
  initialStateStatus: "absent" | "trusted" | "untrusted";
  noopSatisfied: boolean;
  steps: readonly CliAutonomousStepRecord[];
  executorInvocationCount: number;
  policyStepCount: number;
  cwdObservation: Readonly<{ logicalCwd: string; physicalCwd: string }> | null;
  directoryListing: Readonly<{
    path: string;
    entries: readonly Readonly<{ name: string; path: string; type: string }>[];
    directoryRef: ObservedObjectRef | null;
  }> | null;
  state: ExplicitFileState;
  authority: EvidenceAuthority;
  policyError: CliCommandPolicyError | null;
  readReceipt: CliReadReceipt | null;
}>;

export type CliAutonomousRunResult = Readonly<{
  request: Readonly<{
    goal: CliAutonomousGoal;
    grantedEffects: readonly string[] | undefined;
    enabledSkills: readonly string[];
  }>;
  response: unknown;
  domain: CliAutonomousSummary;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function canonicalBase64(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a base64 string`);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new TypeError(`${label} must be canonical base64`);
  }
  if (Buffer.from(decoded).toString("base64") !== value) {
    throw new TypeError(`${label} must be canonical base64`);
  }
  return value;
}

function readScope(value: unknown): DirectoryRef {
  const ref = expectRecord(value, "resources.scope");
  exactKeys(ref, ["kind", "scenarioId", "sessionId", "path"], "resources.scope");
  if (ref.kind !== "cli.directory") throw new TypeError("resources.scope must be a cli.directory reference");
  const path = nonEmpty(ref.path, "resources.scope.path");
  if (path.startsWith("/")) throw new TypeError("resources.scope.path must be relative");
  return Object.freeze({
    kind: "cli.directory",
    scenarioId: nonEmpty(ref.scenarioId, "resources.scope.scenarioId"),
    sessionId: nonEmpty(ref.sessionId, "resources.scope.sessionId"),
    path,
  });
}

function readFileName(value: unknown): string {
  const name = nonEmpty(value, "resources.fileName");
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new TypeError("resources.fileName must be one local path segment");
  }
  return name;
}

export function validateContentBytesResources(resources: unknown): Readonly<{
  scope: DirectoryRef;
  fileName: string | null;
}> {
  if (!isRecord(resources)) throw new TypeError("content bytes goal requires resources");
  if (!Object.hasOwn(resources, "scope")) {
    throw new TypeError("content bytes goal requires resources.scope");
  }
  const scope = readScope(resources.scope);
  const fileName = resources.fileName === undefined ? null : readFileName(resources.fileName);
  return Object.freeze({ scope, fileName });
}

export function validateContentBytesEqualsGoal(value: unknown): ContentBytesEqualsGoal {
  const goal = expectRecord(value, "content bytes goal");
  exactKeys(goal, ["kind", "property", "target", "requirement"], "content bytes goal");
  if (goal.kind !== "file.property" || goal.property !== CONTENT_BYTES_PROPERTY) {
    throw new TypeError("content bytes goal must be a file.property.content.bytes goal");
  }
  const target = expectRecord(goal.target, "content bytes goal target");
  exactKeys(target, ["kind", "relation", "selector", "cardinality"], "content bytes goal target");
  if (target.kind !== "cli.file-query" || target.relation !== "entrySelector" || target.cardinality !== "one") {
    throw new TypeError("content bytes goal target must be a scoped regular file query");
  }
  const selector = expectRecord(target.selector, "content bytes goal target.selector");
  exactKeys(selector, ["type"], "content bytes goal target.selector");
  if (selector.type !== "regular") {
    throw new TypeError("content bytes goal target.selector.type must be regular");
  }
  const requirement = expectRecord(goal.requirement, "content bytes goal requirement");
  exactKeys(requirement, ["kind", "range", "expectedBase64"], "content bytes goal requirement");
  if (requirement.kind !== "equals") {
    throw new TypeError("content bytes goal requirement.kind must be equals");
  }
  const range = expectRecord(requirement.range, "content bytes goal range");
  exactKeys(range, ["offset", "length"], "content bytes goal range");
  const offset = nonnegativeInteger(range.offset, "content bytes goal range.offset");
  const length = nonnegativeInteger(range.length, "content bytes goal range.length");
  const expectedBase64 = canonicalBase64(requirement.expectedBase64, "content bytes goal expectedBase64");
  if (Buffer.from(expectedBase64, "base64").length !== length) {
    throw new TypeError("content bytes goal expectedBase64 decoded length must equal range.length");
  }
  return Object.freeze({
    kind: "file.property",
    property: CONTENT_BYTES_PROPERTY,
    target: Object.freeze({
      kind: "cli.file-query",
      relation: "entrySelector",
      selector: Object.freeze({ type: "regular" }),
      cardinality: "one",
    }),
    requirement: Object.freeze({
      kind: "equals",
      range: Object.freeze({ offset, length }),
      expectedBase64,
    }),
  });
}

export function contentReadGoal(
  entry: Readonly<{ name: string; path: string }>,
  range: Readonly<{ offset: number; length: number }>,
  expectedBase64: string,
): CliContentReadGoal {
  return Object.freeze({
    kind: "cli.content-read",
    property: CONTENT_BYTES_PROPERTY,
    entry: Object.freeze({ name: nonEmpty(entry.name, "content read entry name"), path: nonEmpty(entry.path, "content read entry path") }),
    range: Object.freeze({
      offset: nonnegativeInteger(range.offset, "content read range offset"),
      length: nonnegativeInteger(range.length, "content read range length"),
    }),
    expectedBase64,
  });
}

function offsetOf(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function isContentBytesEqualsGoal(goal: unknown): boolean {
  if (!isRecord(goal) || goal.property !== CONTENT_BYTES_PROPERTY) return false;
  return isRecord(goal.requirement) && goal.requirement.kind === "equals";
}

/** Structural validation; an illegal file.property shape throws TypeError. */
export function classifyCliAutonomousGoal(goal: unknown): CliAutonomousGoalFamily {
  if (isContentBytesEqualsGoal(goal)) {
    validateContentBytesEqualsGoal(goal);
    return "content_bytes_equals";
  }
  const validated = validateGoal(goal);
  if (!validated.registered) return "unsupported_property";
  const property = validated.goal.property;
  if (property === CWD_PROPERTY) {
    const cwd = validated.goal as CwdGoal;
    return cwd.requirement.kind === "observed" ? "session_cwd_observed" : "session_cwd_equals";
  }
  if (property === ENTRIES_PROPERTY) return "directory_entries_observed";
  return "atomic_file_property";
}
