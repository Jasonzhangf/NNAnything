import { lstat, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { expectRecord } from "../core/schema.js";
import {
  createCliFilesystemSandbox,
  type DirectoryRef,
  type SandboxRecipe,
  type SessionRef,
} from "../adapters/cli/filesystem-sandbox.js";
import {
  CLI_COMMAND_HEADS,
  CLI_COMMAND_WIRES,
  cliCommandFeatures,
  type CliCommandHead,
  type CliCommandStageId,
  type CliCommandWire,
} from "../filters/cli-command-policy.js";
import {
  CWD_PROPERTY,
  ENTRIES_PROPERTY,
  LINK_TARGET_PROPERTY,
  PATH_ABSOLUTE_PROPERTY,
  PATH_NAME_PROPERTY,
  PATH_PARENT_PROPERTY,
  PATH_PHYSICAL_PROPERTY,
  PATH_RELATIVE_PROPERTY,
  requiredHead,
  validateGoal,
  type EntryRef,
  type FilePropertyGoal,
  type FileRef,
  type InspectProperty,
  type InspectRef,
  type ObservedDirectoryRef,
  type PathRef,
  type PropertyFacts,
} from "../filters/cli-file-property.js";
import type { CliCommandStatus } from "../nodes/cli-command.js";

export type CommandPartition = "train" | "development" | "verification";

export type LegacyCommandCase =
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

export type Batch1CommandCase =
  | "path-resolve"
  | "path-relative"
  | "path-parts-parent"
  | "path-parts-name"
  | "path-realpath"
  | "inspect-exists"
  | "inspect-type"
  | "inspect-size"
  | "inspect-mode"
  | "inspect-owner"
  | "inspect-times"
  | "inspect-link-target"
  | "inspect-entry-identity"
  | "inspect-resolved-target"
  | "inspect-resolved-target-broken"
  | "select-entry-dir-ready"
  | "select-entry-file-ready"
  | "select-entry-dir-not-found"
  | "select-entry-file-not-found"
  | "select-entry-dir-unobserved"
  | "select-entry-file-unobserved"
  | "select-entry-dir-satisfied-noop"
  | "select-entry-file-satisfied-noop";

export type CommandCase = LegacyCommandCase | Batch1CommandCase;

export type EntrySelectListingState =
  | "ready"
  | "unobserved"
  | "stale_listing"
  | "stale_selected"
  | "satisfied";

export type EntrySelectFixture = Readonly<{
  id: string;
  case: Batch1CommandCase;
  targetType: "directory" | "regular";
  selectorName: string;
  listingState: EntrySelectListingState;
}>;

export type Batch1Query =
  | Readonly<{ kind: "path.resolve"; base: PathRef; input: string }>
  | Readonly<{ kind: "path.relative"; from: PathRef; to: PathRef }>
  | Readonly<{ kind: "path.parts"; property: typeof PATH_PARENT_PROPERTY | typeof PATH_NAME_PROPERTY; path: PathRef }>
  | Readonly<{ kind: "path.realpath"; ref: InspectRef }>
  | Readonly<{ kind: "inspect"; property: InspectProperty; ref: InspectRef; followSymlinks: boolean; requirementKind?: "observed" | "resolvedTarget" }>
  | Readonly<{
      kind: "entry.select";
      target: DirectoryRef;
      parent: string;
      targetType: "directory" | "regular";
      selectorName: string;
      listingState: EntrySelectListingState;
    }>;

type PathFixtureBase = Readonly<{
  id: string;
  base: string;
  input: string;
}>;

type PathFixtureRelative = Readonly<{
  id: string;
  from: string;
  to: string;
}>;

type PathFixtureParts = Readonly<{
  id: string;
  property: typeof PATH_PARENT_PROPERTY | typeof PATH_NAME_PROPERTY;
  path: string;
}>;

type InspectRefKind = "cli.path" | "cli.entry" | "cli.file" | "cli.directory";

export type PathFixtureRealpath = Readonly<{
  id: string;
  path: string;
  refKind: InspectRefKind;
}>;

export type InspectFixture = Readonly<{
  id: string;
  property: InspectProperty;
  state: "a" | "b" | "c" | "d";
  path: string;
  refKind: InspectRefKind;
  followSymlinks: boolean;
  requirementKind?: "observed" | "resolvedTarget";
  brokenTarget?: boolean;
}>;

export type Batch1PathFixtures = Readonly<{
  resolve: readonly PathFixtureBase[];
  relative: readonly PathFixtureRelative[];
  parts: readonly PathFixtureParts[];
  realpath?: readonly PathFixtureRealpath[];
  inspect: readonly InspectFixture[];
  entrySelect?: readonly EntrySelectFixture[];
  symlinks: readonly Readonly<{ path: string; target: string }>[];
}>;

export type CommandScenario = Readonly<{
  id: string;
  sourceGroup: string;
  partition: CommandPartition;
  startPath: string;
  targetPath: string;
  recipe: SandboxRecipe;
  expectedEntries: readonly Readonly<{ name: string; type: "file" | "directory" | "symlink" }>[];
  familyKind?: "legacy" | "batch1";
  pathFixtures?: Batch1PathFixtures;
}>;

export type CommandSample = Readonly<{
  id: string;
  scenarioId: string;
  sourceGroup: string;
  partition: CommandPartition;
  case: CommandCase;
  variant?: string;
  query?: Batch1Query;
  expectedHead: CliCommandHead;
  expectedStatus: CliCommandStatus;
  expectedSatisfaction: 0 | 100 | null;
}>;

export type CliCommandDataset = Readonly<{
  version: 2 | 3;
  scenarios: readonly CommandScenario[];
  samples: readonly CommandSample[];
  teacherEvidence?: readonly unknown[];
}>;

const LEGACY_CASES: readonly LegacyCommandCase[] = [
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

const BATCH1_CASES: readonly Batch1CommandCase[] = [
  "path-resolve",
  "path-relative",
  "path-parts-parent",
  "path-parts-name",
  "path-realpath",
  "inspect-exists",
  "inspect-type",
  "inspect-size",
  "inspect-mode",
  "inspect-owner",
  "inspect-times",
  "inspect-link-target",
  "inspect-entry-identity",
  "inspect-resolved-target",
  "inspect-resolved-target-broken",
  "select-entry-dir-ready",
  "select-entry-file-ready",
  "select-entry-dir-not-found",
  "select-entry-file-not-found",
  "select-entry-dir-unobserved",
  "select-entry-file-unobserved",
  "select-entry-dir-satisfied-noop",
  "select-entry-file-satisfied-noop",
];

type CaseExpectation = Readonly<{
  head: CliCommandHead;
  status: CliCommandStatus;
  satisfaction: 0 | 100 | null;
}>;

const LEGACY_CASE_EXPECTATION: Readonly<Record<LegacyCommandCase, CaseExpectation>> = Object.freeze({
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

const BATCH1_CASE_EXPECTATION: Readonly<Record<Batch1CommandCase, CaseExpectation>> = Object.freeze({
  "path-resolve": { head: "path.resolve", status: "achieved", satisfaction: 100 },
  "path-relative": { head: "path.relative", status: "achieved", satisfaction: 100 },
  "path-parts-parent": { head: "path.parts", status: "achieved", satisfaction: 100 },
  "path-parts-name": { head: "path.parts", status: "achieved", satisfaction: 100 },
  "path-realpath": { head: "path.realpath", status: "achieved", satisfaction: 100 },
  "inspect-exists": { head: "entry.inspect", status: "achieved", satisfaction: 100 },
  "inspect-type": { head: "entry.inspect", status: "achieved", satisfaction: 100 },
  "inspect-size": { head: "entry.inspect", status: "achieved", satisfaction: 100 },
  "inspect-mode": { head: "entry.inspect", status: "achieved", satisfaction: 100 },
  "inspect-owner": { head: "entry.inspect", status: "achieved", satisfaction: 100 },
  "inspect-times": { head: "entry.inspect", status: "achieved", satisfaction: 100 },
  "inspect-link-target": { head: "entry.inspect", status: "achieved", satisfaction: 100 },
  "inspect-entry-identity": { head: "entry.inspect", status: "achieved", satisfaction: 100 },
  "inspect-resolved-target": { head: "entry.inspect", status: "achieved", satisfaction: 100 },
  "inspect-resolved-target-broken": { head: "entry.inspect", status: "unmet", satisfaction: 0 },
  "select-entry-dir-ready": { head: "directory.select", status: "achieved", satisfaction: 100 },
  "select-entry-file-ready": { head: "file.select", status: "achieved", satisfaction: 100 },
  "select-entry-dir-not-found": { head: "directory.select", status: "unmet", satisfaction: 0 },
  "select-entry-file-not-found": { head: "file.select", status: "unmet", satisfaction: 0 },
  "select-entry-dir-unobserved": { head: "DEFER", status: "unknown", satisfaction: null },
  "select-entry-file-unobserved": { head: "DEFER", status: "unknown", satisfaction: null },
  "select-entry-dir-satisfied-noop": { head: "NOOP", status: "achieved", satisfaction: 100 },
  "select-entry-file-satisfied-noop": { head: "NOOP", status: "achieved", satisfaction: 100 },
});

const ZERO_FACTS: PropertyFacts = Object.freeze({
  hasFreshEvidence: 0,
  knownValue: 0,
  requiredConditionHolds: 0,
  hasDestinationRef: 0,
});

const grants = ["filesystem.read", "process.exec", "session.write"] as const;

function legacyScenario(id: string, partition: "train" | "development", start: string, target: string,
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
    familyKind: "legacy",
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

type PathFamilyInput = Readonly<{
  id: string;
  partition: "train" | "development";
  start: string;
  target: string;
  token: string;
}>;

function pathFamily(input: PathFamilyInput): CommandScenario {
  const emptyName = `empty-${input.token}.bin`;
  const filledName = `filled-${input.token}.bin`;
  const anchorName = `anchor-${input.token}.txt`;
  const folderName = `folder-${input.token}`;
  const itemLinkName = `item-${input.token}.link`;
  const brokenLinkName = `broken-${input.token}.link`;
  const dirLinkName = `dir-${input.token}.link`;
  const hop1LinkName = `hop1-${input.token}.link`;
  const hop2LinkName = `hop2-${input.token}.link`;
  const nestedName = "nested";
  const targetFolder = join(input.target, folderName);
  const targetNested = join(input.target, nestedName);
  const targetNestedLeaf = join(targetNested, `leaf-${input.token}.txt`);
  const startAnchor = join(input.start, anchorName);
  const startDirLink = join(input.start, dirLinkName);
  const startHop1Link = join(input.start, hop1LinkName);
  const startHop2Link = join(input.start, hop2LinkName);
  const rootPath = "/";
  const trailingTarget = `${input.target}/`;
  const virtual = `/virtual/${input.token.replaceAll("/", "-")}`;
  const directorySet = new Set<string>();
  const add = (path: string): void => {
    if (!path || path === ".") return;
    const normalized = path.replace(/\/+$/, "");
    if (!normalized || normalized === "/") return;
    if (normalized.includes("/")) add(normalized.slice(0, normalized.lastIndexOf("/")));
    directorySet.add(normalized);
  };
  [input.start, input.target, targetFolder, targetNested].forEach(add);

  const realpathFixtures: readonly PathFixtureRealpath[] = [
    { id: "realpath-a", path: startDirLink, refKind: "cli.path" },
    { id: "realpath-b", path: join(input.target, itemLinkName), refKind: "cli.entry" },
    { id: "realpath-c", path: startAnchor, refKind: "cli.file" },
    { id: "realpath-d", path: startHop1Link, refKind: "cli.path" },
  ];

  const inspect: readonly InspectFixture[] = [
    { id: "exists-a", property: "file.property.exists", state: "a", path: join(input.target, filledName), refKind: "cli.path", followSymlinks: false },
    { id: "exists-b", property: "file.property.exists", state: "b", path: join(input.target, `missing-${input.token}.entry`), refKind: "cli.path", followSymlinks: false },
    { id: "type-a", property: "file.property.type", state: "a", path: join(input.target, emptyName), refKind: "cli.file", followSymlinks: false },
    { id: "type-b", property: "file.property.type", state: "b", path: targetFolder, refKind: "cli.directory", followSymlinks: false },
    { id: "size-a", property: "file.property.size", state: "a", path: join(input.target, emptyName), refKind: "cli.path", followSymlinks: false },
    { id: "size-b", property: "file.property.size", state: "b", path: join(input.target, filledName), refKind: "cli.entry", followSymlinks: false },
    { id: "mode-a", property: "file.property.mode", state: "a", path: join(input.target, filledName), refKind: "cli.file", followSymlinks: false },
    { id: "mode-b", property: "file.property.mode", state: "b", path: targetFolder, refKind: "cli.directory", followSymlinks: false },
    { id: "owner-a", property: "file.property.owner", state: "a", path: join(input.target, itemLinkName), refKind: "cli.entry", followSymlinks: true },
    { id: "owner-b", property: "file.property.owner", state: "b", path: join(input.target, brokenLinkName), refKind: "cli.path", followSymlinks: false },
    { id: "times-a", property: "file.property.times", state: "a", path: startAnchor, refKind: "cli.file", followSymlinks: false },
    { id: "times-b", property: "file.property.times", state: "b", path: targetFolder, refKind: "cli.directory", followSymlinks: false },
    { id: "link-target-a", property: "file.property.link.target", state: "a", path: join(input.target, itemLinkName), refKind: "cli.path", followSymlinks: false },
    { id: "link-target-b", property: "file.property.link.target", state: "b", path: join(input.target, brokenLinkName), refKind: "cli.path", followSymlinks: false },
    { id: "identity-a", property: "file.property.entry.identity", state: "a", path: join(input.target, filledName), refKind: "cli.file", followSymlinks: false },
    { id: "identity-b", property: "file.property.entry.identity", state: "b", path: targetFolder, refKind: "cli.directory", followSymlinks: false },
    { id: "resolved-target-a", property: "file.property.link.target", state: "a", path: join(input.target, itemLinkName), refKind: "cli.path", followSymlinks: true, requirementKind: "resolvedTarget" },
    { id: "resolved-target-b", property: "file.property.link.target", state: "b", path: startDirLink, refKind: "cli.entry", followSymlinks: true, requirementKind: "resolvedTarget" },
    { id: "link-target-c", property: "file.property.link.target", state: "c", path: startDirLink, refKind: "cli.entry", followSymlinks: false, requirementKind: "observed" },
    { id: "resolved-target-d", property: "file.property.link.target", state: "d", path: join(input.target, brokenLinkName), refKind: "cli.path", followSymlinks: true, requirementKind: "resolvedTarget", brokenTarget: true },
  ];

  const dirUnobservedState: EntrySelectListingState =
    input.id === "train-path-flat" || input.id === "development-path-siblings"
      ? "unobserved"
      : input.id === "train-path-deep"
        ? "stale_listing"
        : "stale_selected";
  const fileUnobservedState: EntrySelectListingState =
    input.id === "train-path-flat"
      ? "unobserved"
      : input.id === "train-path-deep" || input.id === "development-path-siblings"
        ? "stale_listing"
        : "stale_selected";
  const dirComplementaryStaleState: EntrySelectListingState =
    dirUnobservedState === "stale_listing" ? "stale_selected" : "stale_listing";
  const fileComplementaryStaleState: EntrySelectListingState =
    input.id === "development-path-siblings"
      ? "unobserved"
      : fileUnobservedState === "stale_listing"
        ? "stale_selected"
        : "stale_listing";

  const entrySelect: readonly EntrySelectFixture[] = [
    { id: "select-entry-dir-ready", case: "select-entry-dir-ready", targetType: "directory", selectorName: folderName, listingState: "ready" },
    { id: "select-entry-file-ready", case: "select-entry-file-ready", targetType: "regular", selectorName: filledName, listingState: "ready" },
    { id: "select-entry-dir-not-found", case: "select-entry-dir-not-found", targetType: "directory", selectorName: `absent-dir-${input.token}`, listingState: "ready" },
    { id: "select-entry-file-not-found", case: "select-entry-file-not-found", targetType: "regular", selectorName: `absent-file-${input.token}.txt`, listingState: "ready" },
    { id: "select-entry-dir-unobserved", case: "select-entry-dir-unobserved", targetType: "directory", selectorName: folderName, listingState: dirUnobservedState },
    { id: "select-entry-file-unobserved", case: "select-entry-file-unobserved", targetType: "regular", selectorName: filledName, listingState: fileUnobservedState },
    { id: "select-entry-dir-satisfied-noop", case: "select-entry-dir-satisfied-noop", targetType: "directory", selectorName: folderName, listingState: "satisfied" },
    { id: "select-entry-file-satisfied-noop", case: "select-entry-file-satisfied-noop", targetType: "regular", selectorName: filledName, listingState: "satisfied" },
    { id: "select-entry-dir-unobserved-stale", case: "select-entry-dir-unobserved", targetType: "directory", selectorName: folderName, listingState: dirComplementaryStaleState },
    { id: "select-entry-file-unobserved-stale", case: "select-entry-file-unobserved", targetType: "regular", selectorName: filledName, listingState: fileComplementaryStaleState },
  ];

  return {
    id: input.id,
    sourceGroup: input.id,
    partition: input.partition,
    startPath: input.start,
    targetPath: input.target,
    familyKind: "batch1",
    recipe: {
      scenarioId: input.id,
      sessions: [
        { id: "s", cwd: input.start, grantedEffects: grants },
        { id: "other", cwd: input.start, grantedEffects: grants },
      ],
      entries: [
        ...[...directorySet].sort().map(path => ({ path, kind: "directory" as const })),
        { path: startAnchor, kind: "file" as const, contents: `anchor ${input.token}\n` },
        { path: join(input.target, emptyName), kind: "file" as const, contents: "" },
        { path: join(input.target, filledName), kind: "file" as const, contents: `payload ${input.token}\n` },
        { path: targetNestedLeaf, kind: "file" as const, contents: `nested ${input.token}\n` },
      ],
    },
    expectedEntries: [
      { name: filledName, type: "file" },
      { name: emptyName, type: "file" },
      { name: folderName, type: "directory" },
      { name: nestedName, type: "directory" },
      { name: itemLinkName, type: "symlink" },
      { name: brokenLinkName, type: "symlink" },
    ],
    pathFixtures: {
      resolve: [
        { id: "resolve-a", base: input.start, input: "." },
        { id: "resolve-b", base: input.start, input: "../output/../entry" },
        { id: "resolve-c", base: input.target, input: "./nested/../nested" },
        { id: "resolve-d", base: input.start, input: `${virtual}/../ghost` },
        { id: "resolve-e", base: input.target, input: `~/$HOME/${input.token}/*` },
        { id: "resolve-f", base: input.start, input: `missing/../${input.token}` },
      ],
      relative: [
        { id: "relative-a", from: input.start, to: input.target },
        { id: "relative-b", from: input.target, to: input.start },
        { id: "relative-c", from: input.target, to: input.target },
        { id: "relative-d", from: input.start, to: dirname(input.target) },
        { id: "relative-e", from: targetNested, to: targetNestedLeaf },
        { id: "relative-f", from: startAnchor, to: join(input.target, folderName) },
      ],
      parts: [
        { id: "parts-parent-a", property: PATH_PARENT_PROPERTY, path: input.start },
        { id: "parts-parent-b", property: PATH_PARENT_PROPERTY, path: input.target },
        { id: "parts-parent-c", property: PATH_PARENT_PROPERTY, path: rootPath },
        { id: "parts-name-a", property: PATH_NAME_PROPERTY, path: input.target },
        { id: "parts-name-b", property: PATH_NAME_PROPERTY, path: trailingTarget },
        { id: "parts-name-c", property: PATH_NAME_PROPERTY, path: rootPath },
      ],
      realpath: realpathFixtures,
      inspect,
      entrySelect,
      symlinks: [
        { path: join(input.target, itemLinkName), target: filledName },
        { path: join(input.target, brokenLinkName), target: `missing-${input.token}-target` },
        { path: startDirLink, target: relative(input.start, targetFolder) },
        { path: startHop2Link, target: anchorName },
        { path: startHop1Link, target: hop2LinkName },
      ],
    },
  };
}

const legacyScenarios: readonly CommandScenario[] = [
  legacyScenario("train-empty-same-directory", "train", "empty", "empty", [], []),
  legacyScenario("train-sibling-mixed", "train", "branches/left", "branches/right", ["one.txt"], ["empty-child"]),
  legacyScenario("train-child-dot-files", "train", "parent", "parent/child", [".hidden", "visible", "notes.txt"], []),
  legacyScenario("train-parent-with-descendants", "train", "outer/inner", "outer", [], ["inner"]),
  legacyScenario("development-multibranch-space", "development", "begin/deep/a", "work space/target", ["alpha space", "beta", "gamma"], ["left", "right"]),
  legacyScenario("development-extension-types", "development", "source/start", "ending/root", ["a", "b", "c", "d", "looks-like-folder"], ["folder.txt"]),
];

const batch1Scenarios: readonly CommandScenario[] = [
  pathFamily({ id: "train-path-flat", partition: "train", start: "families/one/alpha/current", target: "families/one/alpha/output", token: "alpha" }),
  pathFamily({ id: "train-path-deep", partition: "train", start: "families/two/level-a/level-b/深度/current", target: "families/two/level-a/level-b/深度/result", token: "深度" }),
  pathFamily({ id: "train-path-spaces", partition: "train", start: "families/three/space base/quote'name/start", target: "families/three/space base/quote'name/finish", token: "quote'name" }),
  pathFamily({ id: "train-path-controls", partition: "train", start: "families/four/line\nname/begin", target: "families/four/line\nname/end", token: "line\nname" }),
  pathFamily({ id: "development-path-siblings", partition: "development", start: "families/dev/sibling/left/entry", target: "families/dev/sibling/right/exit", token: "dev-left" }),
  pathFamily({ id: "development-path-deep-edge", partition: "development", start: "families/dev/deep/a/b/c/d/current", target: "families/dev/deep/a/b/c/d/target", token: "dev-edge" }),
];

function legacySamplesFor(scene: CommandScenario): readonly CommandSample[] {
  const effective = LEGACY_CASES.filter(name => scene.startPath !== scene.targetPath
    || (name !== "cwd-equals-fresh-unequal" && name !== "cwd-equals-unknown"));
  return effective.map(name => {
    const expectation = LEGACY_CASE_EXPECTATION[name];
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

function inspectFixtureCase(item: InspectFixture): Batch1CommandCase {
  if (item.requirementKind === "resolvedTarget") {
    return item.brokenTarget ? "inspect-resolved-target-broken" : "inspect-resolved-target";
  }
  return inspectCase(item.property);
}

function batch1SamplesFor(
  scene: CommandScenario,
  queries: ReadonlyMap<string, Batch1Query>,
  stage: CliCommandStageId = "stage2-13x38",
): readonly CommandSample[] {
  const fixtures = scene.pathFixtures;
  if (!fixtures) throw new TypeError(`Batch1 scenario ${scene.id} is missing path fixtures`);
  const grouped = [
    ...fixtures.resolve.map(item => ({ case: "path-resolve" as const, fixture: item, query: queries.get(item.id) })),
    ...fixtures.relative.map(item => ({ case: "path-relative" as const, fixture: item, query: queries.get(item.id) })),
    ...fixtures.parts.map(item => ({
      case: item.property === PATH_PARENT_PROPERTY ? "path-parts-parent" as const : "path-parts-name" as const,
      fixture: item,
      query: queries.get(item.id),
    })),
    ...(fixtures.realpath ?? []).map(item => ({
      case: "path-realpath" as const,
      fixture: item,
      query: queries.get(item.id),
    })),
    ...fixtures.inspect.map(item => ({
      case: inspectFixtureCase(item),
      fixture: item,
      query: queries.get(item.id),
    })),
    ...(stage === "stage1-11x34" ? [] : (fixtures.entrySelect ?? []).map(item => ({
      case: item.case,
      fixture: item,
      query: queries.get(item.id),
    }))),
  ];
  return grouped.map(({ case: name, fixture, query }) => {
    if (!query) throw new TypeError(`Missing bound query for ${scene.id}/${fixture.id}`);
    const expectation = BATCH1_CASE_EXPECTATION[name];
    return Object.freeze({
      id: `${scene.id}-${fixture.id}`,
      scenarioId: scene.id,
      sourceGroup: scene.sourceGroup,
      partition: scene.partition,
      case: name,
      variant: fixture.id,
      query,
      expectedHead: expectation.head,
      expectedStatus: expectation.status,
      expectedSatisfaction: expectation.satisfaction,
    });
  });
}

function inspectCase(property: InspectProperty): Batch1CommandCase {
  const name = property.slice("file.property.".length).replaceAll(".", "-");
  const value = `inspect-${name}`;
  if (!BATCH1_CASES.includes(value as Batch1CommandCase)) throw new TypeError(`Unsupported inspect property ${property}`);
  return value as Batch1CommandCase;
}

function isLegacyCase(value: unknown): value is LegacyCommandCase {
  return typeof value === "string" && LEGACY_CASES.includes(value as LegacyCommandCase);
}

export function isBatch1CommandCase(value: unknown): value is Batch1CommandCase {
  return typeof value === "string" && BATCH1_CASES.includes(value as Batch1CommandCase);
}

const STAGE2_ONLY_WIRES = new Set<CliCommandWire>([
  "predicate.select.entry",
  "selectorTargetType.unspecified",
  "selectorTargetType.regular",
  "selectorTargetType.directory",
]);
const STAGE1_COMMAND_WIRES: readonly CliCommandWire[] = Object.freeze(
  CLI_COMMAND_WIRES.filter(wire => !STAGE2_ONLY_WIRES.has(wire)),
);

export function prepareCliCommandDataset(
  value: unknown,
  partitions: readonly CommandPartition[] = ["train", "development"],
  stage: CliCommandStageId = "stage2-13x38",
) {
  if (stage !== "stage1-11x34" && stage !== "stage2-13x38") {
    throw new TypeError("Command dataset stage must be stage1-11x34 or stage2-13x38");
  }
  const expectedWires = stage === "stage1-11x34" ? STAGE1_COMMAND_WIRES : CLI_COMMAND_WIRES;
  const dataset = expectRecord(value, "command dataset");
  if ((dataset.version !== 2 && dataset.version !== 3) || !Array.isArray(dataset.scenarios) || !Array.isArray(dataset.samples)) {
    throw new TypeError("Invalid command dataset");
  }
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
  const featureGoldByKey = new Map<string, CliCommandHead>();
  const samples = dataset.samples.map(raw => {
    const item = expectRecord(raw, "command sample") as unknown as CommandSample;
    const scene = sceneMap.get(item.scenarioId);
    if (!scene || scene.partition !== item.partition || scene.sourceGroup !== item.sourceGroup || typeof item.id !== "string" || ids.has(item.id)) {
      throw new TypeError("Invalid sample source/identity");
    }
    const batch1 = isBatch1CommandCase(item.case);
    if (!isLegacyCase(item.case) && !batch1) throw new TypeError("Unknown command sample case");
    if (dataset.version === 2 && batch1) throw new TypeError("Batch1 samples require command dataset version 3");
    const expectation = batch1
      ? BATCH1_CASE_EXPECTATION[item.case as Batch1CommandCase]
      : LEGACY_CASE_EXPECTATION[item.case as LegacyCommandCase];
    if (item.expectedHead !== expectation.head || item.expectedStatus !== expectation.status || item.expectedSatisfaction !== expectation.satisfaction) {
      throw new TypeError("Sample expectation conflicts with the registered case");
    }
    if (batch1) {
      if (item.query === undefined) throw new TypeError("Batch1 sample requires a typed query");
      if (stage === "stage1-11x34" && item.query.kind === "entry.select") {
        throw new TypeError("Stage 1 dataset must not contain Stage 2 entry.select samples");
      }
    } else if (item.query !== undefined) {
      throw new TypeError("Legacy command sample must not contain a Batch1 query");
    }
    const validated = validateGoal(sampleGoal(item, scene));
    const facts = sampleFacts(item);
    const required = requiredHead({
      registered: validated.registered,
      unboundDirectory: validated.unboundDirectory,
      goal: validated.goal,
      facts,
    });
    if (item.expectedHead !== required) {
      throw new TypeError("Sample expectation conflicts with requiredHead");
    }
    const features = sampleFeatures(item, scene, stage);
    if (features.length !== expectedWires.length || features.some(value => value !== 0 && value !== 1)) {
      throw new TypeError(`Sample feature vector must contain ${expectedWires.length} binary values`);
    }
    const featureKey = features.join(",");
    const previousHead = featureGoldByKey.get(featureKey);
    if (previousHead !== undefined && previousHead !== item.expectedHead) {
      throw new TypeError("Conflicting gold heads for identical feature vector");
    }
    featureGoldByKey.set(featureKey, item.expectedHead);
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

function directoryQuery(name: string) {
  return Object.freeze({
    kind: "cli.file-query" as const,
    relation: "entrySelector" as const,
    scopes: Object.freeze([]),
    selector: Object.freeze({ type: "directory" as const, ...(name ? { name } : {}) }),
    cardinality: "one" as const,
  });
}

export function sampleFacts(sample: CommandSample): PropertyFacts {
  if (sample.query?.kind === "entry.select") {
    switch (sample.query.listingState) {
      case "unobserved":
        return Object.freeze({ hasFreshEvidence: 0, knownValue: 0, requiredConditionHolds: 0, hasDestinationRef: 1 });
      case "stale_listing":
        return Object.freeze({ hasFreshEvidence: 0, knownValue: 1, requiredConditionHolds: 0, hasDestinationRef: 1 });
      case "stale_selected":
        return Object.freeze({ hasFreshEvidence: 0, knownValue: 1, requiredConditionHolds: 1, hasDestinationRef: 1 });
      case "ready":
        return Object.freeze({ hasFreshEvidence: 1, knownValue: 1, requiredConditionHolds: 0, hasDestinationRef: 1 });
      case "satisfied":
        return Object.freeze({ hasFreshEvidence: 1, knownValue: 1, requiredConditionHolds: 1, hasDestinationRef: 1 });
    }
  }
  if (!isLegacyCase(sample.case)) return ZERO_FACTS;
  const facts: Record<LegacyCommandCase, PropertyFacts> = {
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
  if (sample.query !== undefined) {
    if (sample.query.kind === "entry.select") {
      return Object.freeze({
        kind: "file.property",
        property: ENTRIES_PROPERTY,
        target: sample.query.target,
        requirement: Object.freeze({
          kind: "matches",
          predicate: Object.freeze({
            kind: "entrySelector",
            selector: Object.freeze({
              name: sample.query.selectorName,
              parent: sample.query.parent,
              type: sample.query.targetType,
            }),
            cardinality: "one",
          }),
        }),
      });
    }
    if (sample.query.kind === "path.resolve") {
      return Object.freeze({
        kind: "file.property",
        property: PATH_ABSOLUTE_PROPERTY,
        target: Object.freeze({ kind: "cli.path-query", base: sample.query.base, input: sample.query.input }),
        requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
      });
    }
    if (sample.query.kind === "path.relative") {
      return Object.freeze({
        kind: "file.property",
        property: PATH_RELATIVE_PROPERTY,
        target: Object.freeze({ kind: "cli.path-query", from: sample.query.from, to: sample.query.to }),
        requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
      });
    }
    if (sample.query.kind === "path.parts") {
      return Object.freeze({
        kind: "file.property",
        property: sample.query.property,
        target: sample.query.path,
        requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
      });
    }
    if (sample.query.kind === "path.realpath") {
      return Object.freeze({
        kind: "file.property",
        property: PATH_PHYSICAL_PROPERTY,
        target: sample.query.ref,
        requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
      });
    }
    if (sample.query.requirementKind === "resolvedTarget"
      || sample.case === "inspect-resolved-target"
      || sample.case === "inspect-resolved-target-broken") {
      return Object.freeze({
        kind: "file.property",
        property: LINK_TARGET_PROPERTY,
        target: Object.freeze({ kind: "cli.entry-query", ref: sample.query.ref, followSymlinks: sample.query.followSymlinks }),
        requirement: Object.freeze({ kind: "matches", predicate: Object.freeze({ kind: "resolvedTarget" }) }),
      });
    }
    return Object.freeze({
      kind: "file.property",
      property: sample.query.property,
      target: Object.freeze({ kind: "cli.entry-query", ref: sample.query.ref, followSymlinks: sample.query.followSymlinks }),
      requirement: Object.freeze({ kind: "observed", freshness: "this_run" }),
    });
  }

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
  const requirement = sample.case === "cwd-observed"
    ? Object.freeze({ kind: "observed" as const, freshness: "this_run" as const })
    : sample.case === "cwd-equals-unbound"
      ? Object.freeze({ kind: "equals" as const, expected: directoryQuery(scene.targetPath) })
      : Object.freeze({ kind: "equals" as const, expected: directory });
  return Object.freeze({
    kind: "file.property",
    property: CWD_PROPERTY,
    target: Object.freeze({ kind: "cli.file-query", relation: "sessionCwd", session }),
    requirement,
  });
}

export function sampleFeatures(
  sample: CommandSample,
  scene: CommandScenario,
  stage: CliCommandStageId = "stage2-13x38",
): readonly number[] {
  const full = cliCommandFeatures(sampleGoal(sample, scene), sampleFacts(sample));
  if (stage === "stage1-11x34") {
    return Object.freeze(
      CLI_COMMAND_WIRES.flatMap((wire, index) => (STAGE2_ONLY_WIRES.has(wire) ? [] : [full[index]!])),
    );
  }
  return full;
}

function sceneAbsolute(sceneRoot: string, path: string): string {
  return isAbsolute(path) ? path : join(sceneRoot, path);
}

async function bindPathFixtures(
  sandbox: Awaited<ReturnType<typeof createCliFilesystemSandbox>>,
  scene: CommandScenario,
): Promise<ReadonlyMap<string, Batch1Query>> {
  const fixtures = scene.pathFixtures;
  if (!fixtures) return new Map();
  const session = sandbox.bindSession("s"), queries = new Map<string, Batch1Query>();
  for (const item of fixtures.resolve) {
    queries.set(item.id, Object.freeze({
      kind: "path.resolve",
      base: sandbox.bindPath(session, sceneAbsolute(sandbox.scenarioRoot, item.base)),
      input: item.input,
    }));
  }
  for (const item of fixtures.relative) {
    queries.set(item.id, Object.freeze({
      kind: "path.relative",
      from: sandbox.bindPath(session, sceneAbsolute(sandbox.scenarioRoot, item.from)),
      to: sandbox.bindPath(session, sceneAbsolute(sandbox.scenarioRoot, item.to)),
    }));
  }
  for (const item of fixtures.parts) {
    queries.set(item.id, Object.freeze({
      kind: "path.parts",
      property: item.property,
      path: sandbox.bindPath(session, sceneAbsolute(sandbox.scenarioRoot, item.path)),
    }));
  }
  for (const item of fixtures.realpath ?? []) {
    const absolute = sceneAbsolute(sandbox.scenarioRoot, item.path);
    const ref: InspectRef = item.refKind === "cli.path"
      ? sandbox.bindPath(session, absolute)
      : item.refKind === "cli.entry"
        ? await sandbox.bindEntry(session, absolute) as EntryRef
        : item.refKind === "cli.file"
          ? await sandbox.bindFile(session, absolute) as FileRef
          : await sandbox.bindDirectoryObject(session, absolute) as ObservedDirectoryRef;
    queries.set(item.id, Object.freeze({
      kind: "path.realpath",
      ref,
    }));
  }
  for (const item of fixtures.inspect) {
    const absolute = sceneAbsolute(sandbox.scenarioRoot, item.path);
    const ref: InspectRef = item.refKind === "cli.path"
      ? sandbox.bindPath(session, absolute)
      : item.refKind === "cli.entry"
        ? await sandbox.bindEntry(session, absolute) as EntryRef
        : item.refKind === "cli.file"
          ? await sandbox.bindFile(session, absolute) as FileRef
          : await sandbox.bindDirectoryObject(session, absolute) as ObservedDirectoryRef;
    queries.set(item.id, Object.freeze({
      kind: "inspect",
      property: item.property,
      ref,
      followSymlinks: item.followSymlinks,
      ...(item.requirementKind === "resolvedTarget" ? { requirementKind: "resolvedTarget" as const } : {}),
    }));
  }
  if ((fixtures.entrySelect ?? []).length > 0) {
    const targetAbsolute = join(sandbox.scenarioRoot, scene.targetPath);
    const targetDirectory = await sandbox.bindDirectory(
      session,
      relative(sandbox.getSession(session).cwd, targetAbsolute) || ".",
    );
    const targetPhysical = await realpath(targetAbsolute);
    for (const item of fixtures.entrySelect ?? []) {
      queries.set(item.id, Object.freeze({
        kind: "entry.select",
        target: targetDirectory,
        parent: targetPhysical,
        targetType: item.targetType,
        selectorName: item.selectorName,
        listingState: item.listingState,
      }));
    }
  }
  return queries;
}

export async function makeCliCommandFixture(options: Readonly<{
  root: string;
  partitions?: readonly ("train" | "development")[];
  extended?: boolean;
  stage?: CliCommandStageId;
}>) {
  const stage: CliCommandStageId = options.stage ?? "stage2-13x38";
  const partitions = options.partitions ?? ["train", "development"];
  const selectedLegacy = legacyScenarios.filter(scene => (partitions as readonly CommandPartition[]).includes(scene.partition));
  const selectedBatch1 = options.extended === true
    ? batch1Scenarios.filter(scene => (partitions as readonly CommandPartition[]).includes(scene.partition))
    : [];
  const selected = [...selectedLegacy, ...selectedBatch1];
  const teacherEvidence = [], datasetScenes: CommandScenario[] = [], datasetSamples: CommandSample[] = [];
  for (const scene of selected) {
    const sandbox = await createCliFilesystemSandbox({ root: options.root, recipe: scene.recipe, ownerGrantedEffects: ["filesystem.write"] });
    try {
      if (scene.pathFixtures) {
        for (const item of scene.pathFixtures.symlinks) {
          const path = sceneAbsolute(sandbox.scenarioRoot, item.path);
          await symlink(item.target, path);
        }
      }
      const target = join(sandbox.scenarioRoot, scene.targetPath), evidence = [];
      for (const entry of scene.expectedEntries) {
        const info = await lstat(join(target, entry.name));
        const observedType = info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other";
        if (observedType !== entry.type) throw new Error("Fixture teacher type differs from actual OS type");
        evidence.push({ ...entry, observedType });
      }
      const queries = await bindPathFixtures(sandbox, scene);
      datasetScenes.push(scene);
      if (scene.familyKind === "batch1") datasetSamples.push(...batch1SamplesFor(scene, queries, stage));
      else datasetSamples.push(...legacySamplesFor(scene));
      teacherEvidence.push({
        scenarioId: scene.id,
        physicalStart: await realpath(join(sandbox.scenarioRoot, scene.startPath)),
        physicalTarget: await realpath(target),
        entries: evidence,
        pathFixtures: scene.pathFixtures === undefined ? null : {
          resolve: scene.pathFixtures.resolve.length,
          relative: scene.pathFixtures.relative.length,
          parts: scene.pathFixtures.parts.length,
          realpath: (scene.pathFixtures.realpath ?? []).length,
          inspect: scene.pathFixtures.inspect.length,
          entrySelect: stage === "stage1-11x34" ? 0 : (scene.pathFixtures.entrySelect ?? []).length,
        },
      });
    } finally { await sandbox.cleanup(); }
  }
  const dataset: CliCommandDataset = {
    version: options.extended === true ? 3 : 2,
    scenarios: datasetScenes,
    teacherEvidence,
    samples: datasetSamples,
  };
  prepareCliCommandDataset(dataset, partitions, stage);
  return { dataset, teacherEvidence };
}
