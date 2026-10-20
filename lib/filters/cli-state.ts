import { expectRecord } from "../core/schema.js";
import { validateDirectoryListing, type DirectoryListObservation } from "../adapters/cli/directory-listing.js";
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

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label);
  if (path.includes("\0") || !path.startsWith("/")) throw new TypeError(`${label} must be an absolute path without NUL`);
  return path;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function sameEntries(
  left: readonly DirectoryListObservation["entries"][number][],
  right: readonly DirectoryListObservation["entries"][number][],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return other !== undefined
      && entry.name === other.name
      && entry.path === other.path
      && entry.type === other.type;
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameErrors(
  left: readonly DirectoryListObservation["errors"][number][],
  right: readonly DirectoryListObservation["errors"][number][],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((error, index) => {
    const other = right[index];
    return other !== undefined
      && error.name === other.name
      && error.code === other.code
      && error.message === other.message;
  });
}

function samePwdObservation(left: PwdObservation, right: PwdObservation): boolean {
  return left.kind === right.kind
    && left.configuredCwd === right.configuredCwd
    && left.physicalCwd === right.physicalCwd
    && left.executable === right.executable
    && sameStrings(left.argv, right.argv)
    && left.stdout === right.stdout
    && left.stderr === right.stderr
    && left.exitCode === right.exitCode;
}

function sameDirectoryObservation(left: DirectoryListObservation, right: DirectoryListObservation): boolean {
  return left.kind === right.kind
    && left.configuredDirectory === right.configuredDirectory
    && left.physicalDirectory === right.physicalDirectory
    && left.executable === right.executable
    && left.helperPath === right.helperPath
    && sameStrings(left.argv, right.argv)
    && left.stdout === right.stdout
    && left.stderr === right.stderr
    && left.exitCode === right.exitCode
    && left.coverage === right.coverage
    && sameEntries(left.entries, right.entries)
    && sameErrors(left.errors, right.errors);
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
  const physicalCwd = absolutePath(knowledge.physicalCwd, "state.cwdObservation.physicalCwd");
  const evidence = validatePwdObservation(knowledge.evidence);
  if (physicalCwd !== evidence.physicalCwd) {
    throw new TypeError("state.cwdObservation.physicalCwd must equal its embedded evidence");
  }
  return Object.freeze({
    physicalCwd,
    evidence,
    revision: knowledge.revision as number,
    sourceRun: nonEmpty(knowledge.sourceRun, "state.cwdObservation.sourceRun"),
  });
}

function validateListingEvidence(value: unknown): DirectoryListObservation {
  const evidence = expectRecord(value, "directoryListing.evidence");
  exactKeys(evidence, ["kind", "configuredDirectory", "physicalDirectory", "executable", "helperPath", "argv", "stdout", "stderr", "exitCode", "entries", "coverage", "errors"], "directory listing evidence");
  if (evidence.kind !== "directory.list" || evidence.coverage !== "complete" || evidence.exitCode !== 0) throw new TypeError("directoryListing.evidence must be a complete successful listing");
  if (!Array.isArray(evidence.entries) || !Array.isArray(evidence.errors)) throw new TypeError("directory listing evidence arrays required");
  if (!Array.isArray(evidence.argv) || evidence.argv.length !== 2 || evidence.argv.some(argument => typeof argument !== "string")) {
    throw new TypeError("directory listing evidence argv must contain two strings");
  }
  const physicalDirectory = absolutePath(evidence.physicalDirectory, "listing physicalDirectory");
  const argv = Object.freeze([evidence.argv[0] as string, evidence.argv[1] as string] as const);
  const listing = validateDirectoryListing({
    directory: physicalDirectory,
    entries: evidence.entries,
    coverage: evidence.coverage,
    errors: evidence.errors,
  });
  if (typeof evidence.stderr !== "string") throw new TypeError("directory listing evidence stderr must be a string");
  return Object.freeze({
    kind: "directory.list",
    configuredDirectory: absolutePath(evidence.configuredDirectory, "listing configuredDirectory"),
    physicalDirectory,
    executable: nonEmpty(evidence.executable, "listing executable"),
    helperPath: nonEmpty(evidence.helperPath, "listing helperPath"),
    argv,
    stdout: nonEmpty(evidence.stdout, "listing stdout"),
    stderr: evidence.stderr,
    exitCode: 0,
    entries: listing.entries,
    coverage: "complete",
    errors: listing.errors,
  });
}

export function validateDirectoryKnowledge(value: unknown): DirectoryKnowledge {
  const knowledge = expectRecord(value, "state.directoryListing");
  exactKeys(knowledge, ["physicalDirectory", "entries", "coverage", "errors", "evidence", "revision", "sourceRun"], "state.directoryListing");
  if (knowledge.coverage !== "complete") throw new TypeError("state.directoryListing must be complete");
  if (!Array.isArray(knowledge.errors) || knowledge.errors.length !== 0) throw new TypeError("state.directoryListing.errors must be empty");
  if (!Array.isArray(knowledge.entries)) throw new TypeError("state.directoryListing.entries must be an array");
  if (!Number.isInteger(knowledge.revision) || (knowledge.revision as number) < 0) throw new TypeError("state.directoryListing.revision must be a nonnegative integer");
  const physicalDirectory = absolutePath(knowledge.physicalDirectory, "state.directoryListing.physicalDirectory");
  const evidence = validateListingEvidence(knowledge.evidence);
  if (physicalDirectory !== evidence.physicalDirectory) {
    throw new TypeError("state.directoryListing.physicalDirectory must equal its embedded evidence");
  }
  if (!sameEntries(knowledge.entries, evidence.entries)) {
    throw new TypeError("state.directoryListing.entries must equal its embedded evidence entries");
  }
  return Object.freeze({
    physicalDirectory,
    entries: evidence.entries,
    coverage: "complete",
    errors: evidence.errors,
    evidence,
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

export type EvidenceRecord =
  | Readonly<{
      kind: "pwd";
      session: string;
      revision: number;
      runId: string;
      observation: PwdObservation;
    }>
  | Readonly<{
      kind: "directory.list";
      session: string;
      revision: number;
      runId: string;
      observation: DirectoryListObservation;
    }>;

export type EvidenceAuthority = Readonly<{
  record(value: EvidenceRecord): void;
  known(value: EvidenceRecord): boolean;
  trusted(value: EvidenceRecord): boolean;
}>;

function sameObservation(left: EvidenceRecord, right: EvidenceRecord): boolean {
  if (left.kind === "pwd" && right.kind === "pwd") return samePwdObservation(left.observation, right.observation);
  if (left.kind === "directory.list" && right.kind === "directory.list") {
    return sameDirectoryObservation(left.observation, right.observation);
  }
  return false;
}

/** Local, non-persistent authority. It only maps this policy's receipts to immutable observations. */
export function createEvidenceAuthority(): EvidenceAuthority {
  const records = new Map<string, EvidenceRecord>();
  return Object.freeze({
    record(value: EvidenceRecord) {
      const key = `${value.session}\u0000${value.runId}`;
      if (records.has(key)) throw new TypeError("Evidence run identity was already recorded");
      if (value.kind === "pwd") {
        records.set(key, Object.freeze({ ...value, observation: validatePwdObservation(value.observation) }));
        return;
      }
      records.set(key, Object.freeze({ ...value, observation: validateListingEvidence(value.observation) }));
    },
    known(value: EvidenceRecord) {
      const record = records.get(`${value.session}\u0000${value.runId}`);
      return record !== undefined && sameObservation(record, value);
    },
    trusted(value: EvidenceRecord) {
      const record = records.get(`${value.session}\u0000${value.runId}`);
      return record !== undefined
        && record.revision === value.revision
        && sameObservation(record, value);
    },
  });
}
