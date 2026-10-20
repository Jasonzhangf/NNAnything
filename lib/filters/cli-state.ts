import { expectRecord } from "../core/schema.js";
import type { DirectoryListObservation } from "../adapters/cli/directory-listing.js";
import type { PwdObservation } from "../adapters/cli/observation.js";
import { validateCliCwd } from "./cli-path.js";

export type CwdKnowledge = Readonly<{
  physicalCwd: string;
  evidence: PwdObservation;
  revision: number;
  sourceRun: string;
}>;

export type DirectoryKnowledge = Readonly<{
  physicalDirectory: string;
  entries: DirectoryListObservation["entries"];
  coverage: "complete";
  errors: readonly DirectoryListObservation["errors"][number][];
  evidence: DirectoryListObservation;
  revision: number;
  sourceRun: string;
}>;

export type ExplicitFileState = Readonly<{
  session: string;
  cwdObservation: CwdKnowledge | null;
  directoryListing: DirectoryKnowledge | null;
}>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (path.includes("\0") || !path.startsWith("/")) throw new TypeError(`${label} must be an absolute path without NUL`);
  return path;
}

export function validatePwdObservation(value: unknown): PwdObservation {
  const observation = expectRecord(value, "cwdObservation.evidence");
  exactKeys(observation, ["kind", "configuredCwd", "physicalCwd", "executable", "argv", "stdout", "stderr", "exitCode"], "pwd observation");
  if (observation.kind !== "pwd" || observation.executable !== "/bin/pwd") throw new TypeError("cwdObservation.evidence is not a native pwd observation");
  if (!Array.isArray(observation.argv) || observation.argv.length !== 1 || observation.argv[0] !== "-P") throw new TypeError("pwd observation argv must be [-P]");
  const configuredCwd = validateCliCwd(observation.configuredCwd);
  const physicalCwd = absolutePath(observation.physicalCwd, "pwd observation physicalCwd");
  if (typeof observation.stdout !== "string" || observation.stdout !== `${physicalCwd}\n`) throw new TypeError("pwd observation stdout must end with one newline");
  if (typeof observation.stderr !== "string" || observation.exitCode !== 0) throw new TypeError("pwd observation must have string stderr and exitCode 0");
  return Object.freeze({
    kind: "pwd",
    configuredCwd,
    physicalCwd,
    executable: "/bin/pwd",
    argv: Object.freeze(["-P"] as const),
    stdout: observation.stdout,
    stderr: observation.stderr,
    exitCode: 0,
  });
}

export function validateCwdKnowledge(value: unknown): CwdKnowledge {
  const knowledge = expectRecord(value, "state.cwdObservation");
  exactKeys(knowledge, ["physicalCwd", "evidence", "revision", "sourceRun"], "state.cwdObservation");
  if (!Number.isInteger(knowledge.revision) || (knowledge.revision as number) < 0) throw new TypeError("state.cwdObservation.revision must be a nonnegative integer");
  return Object.freeze({
    physicalCwd: absolutePath(knowledge.physicalCwd, "state.cwdObservation.physicalCwd"),
    evidence: validatePwdObservation(knowledge.evidence),
    revision: knowledge.revision as number,
    sourceRun: nonEmpty(knowledge.sourceRun, "state.cwdObservation.sourceRun"),
  });
}

function validateListingEvidence(value: unknown): DirectoryListObservation {
  const evidence = expectRecord(value, "directoryListing.evidence");
  exactKeys(evidence, ["kind", "configuredDirectory", "physicalDirectory", "executable", "helperPath", "argv", "stdout", "stderr", "exitCode", "entries", "coverage", "errors"], "directory listing evidence");
  if (evidence.kind !== "directory.list" || evidence.coverage !== "complete" || evidence.exitCode !== 0) throw new TypeError("directoryListing.evidence must be a complete successful listing");
  if (!Array.isArray(evidence.entries) || !Array.isArray(evidence.errors)) throw new TypeError("directory listing evidence arrays required");
  return Object.freeze({
    kind: "directory.list",
    configuredDirectory: nonEmpty(evidence.configuredDirectory, "listing configuredDirectory"),
    physicalDirectory: absolutePath(evidence.physicalDirectory, "listing physicalDirectory"),
    executable: nonEmpty(evidence.executable, "listing executable"),
    helperPath: nonEmpty(evidence.helperPath, "listing helperPath"),
    argv: Object.freeze(evidence.argv as readonly [string, string]),
    stdout: nonEmpty(evidence.stdout, "listing stdout"),
    stderr: typeof evidence.stderr === "string" ? evidence.stderr : "",
    exitCode: 0,
    entries: Object.freeze(evidence.entries as DirectoryListObservation["entries"]),
    coverage: "complete",
    errors: Object.freeze([]),
  });
}

export function validateDirectoryKnowledge(value: unknown): DirectoryKnowledge {
  const knowledge = expectRecord(value, "state.directoryListing");
  exactKeys(knowledge, ["physicalDirectory", "entries", "coverage", "errors", "evidence", "revision", "sourceRun"], "state.directoryListing");
  if (knowledge.coverage !== "complete") throw new TypeError("state.directoryListing must be complete");
  if (!Array.isArray(knowledge.errors) || knowledge.errors.length !== 0) throw new TypeError("state.directoryListing.errors must be empty");
  if (!Array.isArray(knowledge.entries)) throw new TypeError("state.directoryListing.entries must be an array");
  if (!Number.isInteger(knowledge.revision) || (knowledge.revision as number) < 0) throw new TypeError("state.directoryListing.revision must be a nonnegative integer");
  return Object.freeze({
    physicalDirectory: absolutePath(knowledge.physicalDirectory, "state.directoryListing.physicalDirectory"),
    entries: Object.freeze(knowledge.entries as DirectoryListObservation["entries"]),
    coverage: "complete",
    errors: Object.freeze([]),
    evidence: validateListingEvidence(knowledge.evidence),
    revision: knowledge.revision as number,
    sourceRun: nonEmpty(knowledge.sourceRun, "state.directoryListing.sourceRun"),
  });
}

export function validateExplicitFileState(value: unknown): ExplicitFileState {
  const state = expectRecord(value, "property state");
  exactKeys(state, ["session", "cwdObservation", "directoryListing"], "property state");
  return Object.freeze({
    session: nonEmpty(state.session, "state.session"),
    cwdObservation: state.cwdObservation === null ? null : validateCwdKnowledge(state.cwdObservation),
    directoryListing: state.directoryListing === null ? null : validateDirectoryKnowledge(state.directoryListing),
  });
}

export type EvidenceRecord = Readonly<{
  session: string;
  revision: number;
  runId: string;
  physicalCwd: string | null;
  physicalDirectory: string | null;
}>;

export type EvidenceAuthority = Readonly<{
  record(value: EvidenceRecord): void;
  known(value: EvidenceRecord): boolean;
  trusted(value: EvidenceRecord): boolean;
}>;

/** Local, non-persistent authority. It only maps this policy's receipts to immutable observations. */
export function createEvidenceAuthority(): EvidenceAuthority {
  const records = new Map<string, EvidenceRecord>();
  return Object.freeze({
    record(value: EvidenceRecord) {
      const key = `${value.session}\u0000${value.runId}`;
      if (records.has(key)) throw new TypeError("Evidence run identity was already recorded");
      records.set(key, Object.freeze({ ...value }));
    },
    known(value: EvidenceRecord) {
      const record = records.get(`${value.session}\u0000${value.runId}`);
      return record !== undefined
        && record.physicalCwd === value.physicalCwd
        && record.physicalDirectory === value.physicalDirectory;
    },
    trusted(value: EvidenceRecord) {
      const record = records.get(`${value.session}\u0000${value.runId}`);
      return record !== undefined
        && record.revision === value.revision
        && record.physicalCwd === value.physicalCwd
        && record.physicalDirectory === value.physicalDirectory;
    },
  });
}
