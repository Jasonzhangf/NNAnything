import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expectRecord } from "../core/schema.js";
import { createCliFilesystemSandbox, type DirectoryRef, type SandboxRecipe, type SessionRef } from "../adapters/cli/filesystem-sandbox.js";
import { CLI_COMMAND_HEADS, cliCommandFeatures, type CliCommandHead } from "../filters/cli-command-policy.js";
import { CWD_PROPERTY, ENTRIES_PROPERTY, type CwdGoal, type DirectoryQuery, type FilePropertyGoal, type PropertyFacts } from "../filters/cli-file-property.js";
import type { CliCommandStatus } from "../nodes/cli-command.js";

export type CommandPartition = "train" | "development" | "verification";
export type CommandCase =
  | "cwd-observed"
  | "entries-observed"
  | "entries-observed-old-listing"
  | "cwd-equals-fresh-equal"
  | "cwd-equals-fresh-unequal"
  | "cwd-equals-stale-equal"
  | "cwd-equals-unknown"
  | "cwd-equals-unbound"
  | "entries-observed-unbound"
  | "unregistered-property";

export type CommandScenario = Readonly<{
  id: string;
  sourceGroup: string;
  partition: CommandPartition;
  startPath: string;
  targetPath: string;
  recipe: SandboxRecipe;
  expectedEntries: readonly Readonly<{ name: string; type: "file" | "directory" | "symlink" }>[];
}>;

export type CommandSample = Readonly<{
  id: string;
  scenarioId: string;
  sourceGroup: string;
  partition: CommandPartition;
  case: CommandCase;
  expectedHead: CliCommandHead;
  expectedStatus: CliCommandStatus;
  expectedSatisfaction: 0 | 100 | null;
}>;

export type CliCommandDataset = Readonly<{
  version: 2;
  scenarios: readonly CommandScenario[];
  samples: readonly CommandSample[];
  teacherEvidence?: readonly unknown[];
}>;

const CASES: readonly CommandCase[] = [
  "cwd-observed",
  "entries-observed",
  "entries-observed-old-listing",
  "cwd-equals-fresh-equal",
  "cwd-equals-fresh-unequal",
  "cwd-equals-stale-equal",
  "cwd-equals-unknown",
  "cwd-equals-unbound",
  "entries-observed-unbound",
  "unregistered-property",
];

const CASE_EXPECTATION: Readonly<Record<CommandCase, Readonly<{ head: CliCommandHead; status: CliCommandStatus; satisfaction: 0 | 100 | null }>>> = Object.freeze({
  "cwd-observed": { head: "pwd", status: "achieved", satisfaction: 100 },
  "entries-observed": { head: "ls", status: "achieved", satisfaction: 100 },
  "entries-observed-old-listing": { head: "ls", status: "achieved", satisfaction: 100 },
  "cwd-equals-fresh-equal": { head: "NOOP", status: "achieved", satisfaction: 100 },
  "cwd-equals-fresh-unequal": { head: "cd", status: "achieved", satisfaction: 100 },
  "cwd-equals-stale-equal": { head: "cd", status: "achieved", satisfaction: 100 },
  "cwd-equals-unknown": { head: "cd", status: "achieved", satisfaction: 100 },
  "cwd-equals-unbound": { head: "DEFER", status: "unknown", satisfaction: null },
  "entries-observed-unbound": { head: "DEFER", status: "unknown", satisfaction: null },
  "unregistered-property": { head: "unsupported", status: "unknown", satisfaction: null },
});

const grants = ["filesystem.read", "process.exec", "session.write"] as const;

function scenario(id: string, partition: "train" | "development", start: string, target: string,
  files: readonly string[], directories: readonly string[]): CommandScenario {
  const directorySet = new Set<string>();
  const add = (path: string): void => {
    if (path === "." || path === "") return;
    if (path.includes("/")) add(path.slice(0, path.lastIndexOf("/")));
    directorySet.add(path);
  };
  add(start);
  add(target);
  directories.forEach(name => add(join(target, name)));
  return {
    id,
    sourceGroup: id,
    partition,
    startPath: start,
    targetPath: target,
    recipe: {
      scenarioId: id,
      sessions: [
        { id: "s", cwd: start, grantedEffects: grants },
        { id: "other", cwd: start, grantedEffects: grants },
      ],
      entries: [
        ...[...directorySet].map(path => ({ path, kind: "directory" as const })),
        ...files.map(name => ({ path: join(target, name), kind: "file" as const, contents: "opaque fixture bytes" })),
      ],
    },
    expectedEntries: [...files.map(name => ({ name, type: "file" as const })), ...directories.map(name => ({ name, type: "directory" as const }))],
  };
}

const scenarios: readonly CommandScenario[] = [
  scenario("train-empty-same-directory", "train", "empty", "empty", [], []),
  scenario("train-sibling-mixed", "train", "branches/left", "branches/right", ["one.txt"], ["empty-child"]),
  scenario("train-child-dot-files", "train", "parent", "parent/child", [".hidden", "visible", "notes.txt"], []),
  scenario("train-parent-with-descendants", "train", "outer/inner", "outer", [], ["inner"]),
  scenario("development-multibranch-space", "development", "begin/deep/a", "work space/target", ["alpha space", "beta", "gamma"], ["left", "right"]),
  scenario("development-extension-types", "development", "source/start", "ending/root", ["a", "b", "c", "d", "looks-like-folder"], ["folder.txt"]),
];

function samplesFor(scene: CommandScenario): readonly CommandSample[] {
  const effective = CASES.filter(name => scene.startPath !== scene.targetPath
    || (name !== "cwd-equals-fresh-unequal" && name !== "cwd-equals-unknown"));
  return effective.map(name => {
    const expectation = CASE_EXPECTATION[name];
    return Object.freeze({
      id: `${scene.id}-${name}`,
      scenarioId: scene.id,
      sourceGroup: scene.sourceGroup,
      partition: scene.partition,
      case: name,
      expectedHead: expectation.head,
      expectedStatus: expectation.status,
      expectedSatisfaction: expectation.satisfaction,
    });
  });
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

export function prepareCliCommandDataset(value: unknown, partitions: readonly CommandPartition[] = ["train", "development"]) {
  const dataset = expectRecord(value, "command dataset");
  if (dataset.version !== 2 || !Array.isArray(dataset.scenarios) || !Array.isArray(dataset.samples)) throw new TypeError("Invalid command dataset");
  const groups = new Map<string, CommandPartition>(), sceneMap = new Map<string, CommandScenario>();
  for (const raw of dataset.scenarios) {
    const item = expectRecord(raw, "command scenario") as unknown as CommandScenario;
    if (typeof item.id !== "string" || typeof item.sourceGroup !== "string" || !partitions.includes(item.partition)) throw new TypeError("Invalid scenario identity/partition");
    if (sceneMap.has(item.id)) throw new TypeError("Duplicate scenario id");
    if (groups.has(item.sourceGroup) && groups.get(item.sourceGroup) !== item.partition) throw new TypeError("Source group crosses partitions");
    if (typeof item.startPath !== "string" || typeof item.targetPath !== "string" || !item.startPath || !item.targetPath
      || isAbsolute(item.startPath) || isAbsolute(item.targetPath) || item.startPath.includes("\0") || item.targetPath.includes("\0")) {
      throw new TypeError("Invalid scenario start/target path");
    }
    for (const path of [item.startPath, item.targetPath]) {
      const relation = relative("/scene", resolve("/scene", path));
      if (relation === ".." || relation.startsWith("../")) throw new TypeError("Scenario path escapes its recipe");
    }
    if (!Array.isArray(item.expectedEntries)) throw new TypeError("Invalid scenario teacher entries");
    for (const entry of item.expectedEntries) {
      if (typeof entry.name !== "string" || !entry.name || entry.name.includes("/") || entry.name.includes("\0")
        || !["file", "directory", "symlink"].includes(entry.type)) throw new TypeError("Invalid expected entry");
    }
    if (new Set(item.expectedEntries.map(entry => entry.name)).size !== item.expectedEntries.length) throw new TypeError("Duplicate expected direct child");
    if (!item.recipe || item.recipe.scenarioId !== item.id) throw new TypeError("Scenario recipe identity differs");
    groups.set(item.sourceGroup, item.partition);
    sceneMap.set(item.id, item);
  }
  const ids = new Set<string>();
  const samples = dataset.samples.map(raw => {
    const item = expectRecord(raw, "command sample") as unknown as CommandSample;
    const scene = sceneMap.get(item.scenarioId);
    if (!scene || scene.partition !== item.partition || scene.sourceGroup !== item.sourceGroup || typeof item.id !== "string" || ids.has(item.id)) {
      throw new TypeError("Invalid sample source/identity");
    }
    if (!CASES.includes(item.case)) throw new TypeError("Unknown command sample case");
    const expectation = CASE_EXPECTATION[item.case];
    if (item.expectedHead !== expectation.head || item.expectedStatus !== expectation.status || item.expectedSatisfaction !== expectation.satisfaction) {
      throw new TypeError("Sample expectation conflicts with the registered case");
    }
    if (!CLI_COMMAND_HEADS.includes(item.expectedHead)) throw new TypeError("Sample head is outside the shared head table");
    ids.add(item.id);
    return item;
  });
  return {
    dataset: dataset as unknown as CliCommandDataset,
    scenes: sceneMap,
    samples,
    train: samples.filter(row => row.partition === "train"),
    development: samples.filter(row => row.partition === "development"),
    verification: samples.filter(row => row.partition === "verification"),
  };
}

export function placeholderSession(scene: CommandScenario): SessionRef {
  return Object.freeze({ kind: "cli.session", scenarioId: scene.id, sessionId: "s" });
}

function placeholderDirectory(scene: CommandScenario): DirectoryRef {
  return Object.freeze({ kind: "cli.directory", scenarioId: scene.id, sessionId: "s", path: "." });
}

function directoryQuery(name: string): DirectoryQuery {
  return Object.freeze({
    kind: "cli.file-query",
    relation: "entrySelector",
    scopes: Object.freeze([]),
    selector: Object.freeze({ type: "directory", ...(name ? { name } : {}) }),
    cardinality: "one",
  });
}

export function sampleFacts(sample: CommandSample): PropertyFacts {
  const facts: Record<CommandCase, PropertyFacts> = {
    "cwd-observed": { hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 0 },
    "entries-observed": { hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 1 },
    "entries-observed-old-listing": { hasFreshEvidence: 0, knownValue: 1, requiredConditionHolds: 0, hasDestinationRef: 1 },
    "cwd-equals-fresh-equal": { hasFreshEvidence: 1, knownValue: 1, requiredConditionHolds: 1, hasDestinationRef: 1 },
    "cwd-equals-fresh-unequal": { hasFreshEvidence: 1, knownValue: 1, requiredConditionHolds: 0, hasDestinationRef: 1 },
    "cwd-equals-stale-equal": { hasFreshEvidence: 0, knownValue: 1, requiredConditionHolds: 1, hasDestinationRef: 1 },
    "cwd-equals-unknown": { hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 1 },
    "cwd-equals-unbound": { hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 0 },
    "entries-observed-unbound": { hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 0 },
    "unregistered-property": { hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 0 },
  };
  return Object.freeze(facts[sample.case]);
}

export function sampleGoal(sample: CommandSample, scene: CommandScenario): FilePropertyGoal {
  const session = placeholderSession(scene), directory = placeholderDirectory(scene);
  if (sample.case === "unregistered-property") {
    return Object.freeze({
      kind: "file.property",
      property: "file.property.exists",
      target: directory,
      requirement: Object.freeze({ kind: "equals", expected: true }),
    });
  }
  if (sample.case === "entries-observed" || sample.case === "entries-observed-old-listing") {
    return Object.freeze({ kind: "file.property", property: ENTRIES_PROPERTY, target: directory, requirement: Object.freeze({ kind: "observed", freshness: "this_run" }) });
  }
  if (sample.case === "entries-observed-unbound") {
    return Object.freeze({ kind: "file.property", property: ENTRIES_PROPERTY, target: directoryQuery(scene.targetPath), requirement: Object.freeze({ kind: "observed", freshness: "this_run" }) });
  }
  const requirement: CwdGoal["requirement"] = sample.case === "cwd-observed"
    ? Object.freeze({ kind: "observed", freshness: "this_run" })
    : sample.case === "cwd-equals-unbound"
      ? Object.freeze({ kind: "equals", expected: directoryQuery(scene.targetPath) })
      : Object.freeze({ kind: "equals", expected: directory });
  return Object.freeze({
    kind: "file.property",
    property: CWD_PROPERTY,
    target: Object.freeze({ kind: "cli.file-query", relation: "sessionCwd", session }),
    requirement,
  });
}

export function sampleFeatures(sample: CommandSample, scene: CommandScenario): readonly number[] {
  return cliCommandFeatures(sampleGoal(sample, scene), sampleFacts(sample));
}

export async function makeCliCommandFixture(options: Readonly<{ root: string; partitions?: readonly ("train" | "development")[] }>) {
  const partitions = options.partitions ?? ["train", "development"];
  const selected = scenarios.filter(scene => (partitions as readonly CommandPartition[]).includes(scene.partition));
  const teacherEvidence = [];
  for (const scene of selected) {
    const sandbox = await createCliFilesystemSandbox({ root: options.root, recipe: scene.recipe, ownerGrantedEffects: ["filesystem.write"] });
    try {
      const target = join(sandbox.scenarioRoot, scene.targetPath), evidence = [];
      for (const entry of scene.expectedEntries) {
        const info = await lstat(join(target, entry.name));
        const observedType = info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other";
        if (observedType !== entry.type) throw new Error("Fixture teacher type differs from actual OS type");
        evidence.push({ ...entry, observedType });
      }
      teacherEvidence.push({
        scenarioId: scene.id,
        physicalStart: await realpath(join(sandbox.scenarioRoot, scene.startPath)),
        physicalTarget: await realpath(target),
        entries: evidence,
      });
    } finally { await sandbox.cleanup(); }
  }
  const dataset: CliCommandDataset = {
    version: 2,
    scenarios: selected,
    teacherEvidence,
    samples: selected.flatMap(samplesFor),
  };
  prepareCliCommandDataset(dataset, partitions);
  return { dataset, teacherEvidence };
}
