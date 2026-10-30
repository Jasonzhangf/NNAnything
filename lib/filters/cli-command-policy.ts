import { expectRecord } from "../core/schema.js";
import { extname } from "node:path";
import {
  CWD_PROPERTY,
  ENTRIES_PROPERTY,
  REGISTERED_PREDICATES,
  REGISTERED_PROPERTIES,
  legacyWires,
  predicateOf,
  propertyOf,
  selectorTargetTypeOf,
  isEntrySelectGoal,
  type FilePropertyGoal,
  type PropertyFacts,
  type RegisteredPredicate,
  type RegisteredProperty,
} from "./cli-file-property.js";

export const CLI_COMMANDS = Object.freeze(["pwd", "cd", "ls"] as const);
export type CliCommandName = typeof CLI_COMMANDS[number];
export const CLI_COMMAND_HEADS = Object.freeze([
  "unsupported",
  "DEFER",
  "NOOP",
  "pwd",
  "cd",
  "ls",
  "path.resolve",
  "path.relative",
  "path.parts",
  "path.realpath",
  "entry.inspect",
  "directory.select",
  "file.select",
] as const);
export type CliCommandHead = typeof CLI_COMMAND_HEADS[number];

type PropertySuffix<Property extends string> = Property extends `file.property.${infer Suffix}` ? Suffix : never;
export type CliCommandProperty = `property.${PropertySuffix<RegisteredProperty>}`;
export type CliCommandPredicate = RegisteredPredicate;
export type CliCommandWire =
  | "bias"
  | "goalObserveCwd"
  | "goalSetCwd"
  | "goalListDirectory"
  | CliCommandProperty
  | CliCommandPredicate
  | "predicate.select.entry"
  | "selectorTargetType.unspecified"
  | "selectorTargetType.regular"
  | "selectorTargetType.directory"
  | "state.hasFreshEvidence"
  | "state.knownValue"
  | "state.requiredConditionHolds"
  | "state.hasDestinationRef"
  | "search.nameNeedleSegment"
  | "state.requiredConditionHolds*state.hasFreshEvidence";

export const CLI_COMMAND_PROPERTIES: readonly CliCommandProperty[] = Object.freeze(
  REGISTERED_PROPERTIES.map(property => `property.${property.slice("file.property.".length)}` as CliCommandProperty),
);
export const CLI_COMMAND_PREDICATES: readonly CliCommandPredicate[] = Object.freeze([...REGISTERED_PREDICATES]);
export const CLI_COMMAND_WIRES: readonly CliCommandWire[] = Object.freeze([
  "bias",
  "goalObserveCwd",
  "goalSetCwd",
  "goalListDirectory",
  ...CLI_COMMAND_PROPERTIES,
  ...CLI_COMMAND_PREDICATES,
  "selectorTargetType.unspecified",
  "selectorTargetType.regular",
  "selectorTargetType.directory",
  "state.hasFreshEvidence",
  "state.knownValue",
  "state.requiredConditionHolds",
  "state.hasDestinationRef",
  "search.nameNeedleSegment",
  "state.requiredConditionHolds*state.hasFreshEvidence",
]);

export type CliCommandProfile = Readonly<{
  contract: "cli.command-policy.v1";
  heads: readonly CliCommandHead[];
  properties: readonly typeof CLI_COMMAND_PROPERTIES[number][];
  predicates: readonly typeof CLI_COMMAND_PREDICATES[number][];
  wires: readonly CliCommandWire[];
  weights: readonly (readonly number[])[];
  calibration: "uncalibrated";
  adoption: "not_applied";
}>;

export type CliCommandPrediction = Readonly<{
  features: readonly number[];
  scores: readonly number[];
  probabilities: readonly number[];
  selectedHead: CliCommandHead;
}>;

const PROFILE_KEYS = ["adoption", "calibration", "contract", "heads", "predicates", "properties", "weights", "wires"] as const;
const STAGE2_NEW_HEADS = ["directory.select", "file.select"] as const;
const STAGE0_HEADS = Object.freeze(CLI_COMMAND_HEADS.filter(head =>
  head !== "path.realpath" && head !== "directory.select" && head !== "file.select")) as readonly CliCommandHead[];
const STAGE1_NEW_WIRES = Object.freeze([
  "property.path.physical",
  "predicate.observe.physical",
  "predicate.observe.resolvedTarget",
] as const);
const STAGE2_NEW_WIRES = Object.freeze([
  "predicate.select.entry",
  "selectorTargetType.unspecified",
  "selectorTargetType.regular",
  "selectorTargetType.directory",
] as const);
const CURRENT_10X31_WIRES = Object.freeze(
  CLI_COMMAND_WIRES.filter(wire => !STAGE1_NEW_WIRES.includes(wire as typeof STAGE1_NEW_WIRES[number])
    && !STAGE2_NEW_WIRES.includes(wire as typeof STAGE2_NEW_WIRES[number])),
) as readonly CliCommandWire[];
const LEGACY_10X30_WIRES = Object.freeze(
  CURRENT_10X31_WIRES.filter(wire => wire !== "search.nameNeedleSegment"),
) as readonly CliCommandWire[];
const LEGACY_10X30_PROPERTIES = Object.freeze(
  CLI_COMMAND_PROPERTIES.filter(property => property !== "property.path.physical"),
) as readonly CliCommandProperty[];
const LEGACY_10X30_PREDICATES = Object.freeze(
  CLI_COMMAND_PREDICATES.filter(predicate =>
    predicate !== "predicate.observe.physical" && predicate !== "predicate.observe.resolvedTarget"
    && predicate !== "predicate.select.entry"),
) as readonly CliCommandPredicate[];
const LEGACY_HEADS = ["unsupported", "pwd", "cd", "ls"] as const;
const LEGACY_WIRES = ["bias", "goalObserveCwd", "goalSetCwd", "goalListDirectory"] as const;
const LEGACY_6X14_HEADS = ["unsupported", "DEFER", "NOOP", "pwd", "cd", "ls"] as const;
const LEGACY_6X14_PROPERTIES = ["property.directory.entries", "property.relation.sessionCwd"] as const;
const LEGACY_6X14_PREDICATES = [
  "predicate.observe.sessionCwd",
  "predicate.equals.sessionCwd",
  "predicate.observe.entries",
] as const;
const LEGACY_6X14_WIRES = [
  ...LEGACY_WIRES,
  ...LEGACY_6X14_PROPERTIES,
  ...LEGACY_6X14_PREDICATES,
  "state.hasFreshEvidence",
  "state.knownValue",
  "state.requiredConditionHolds",
  "state.hasDestinationRef",
  "state.requiredConditionHolds*state.hasFreshEvidence",
] as const;
export type CliCommandProfileSchema =
  | "current-11x34"
  | "current-13x38"
  | "legacy-4x4"
  | "legacy-6x14"
  | "current-10x31"
  | "rejected-10x30"
  | "rejected-10x32"
  | "invalid";

const STAGE1_HEADS = Object.freeze(CLI_COMMAND_HEADS.filter(head =>
  head !== "directory.select" && head !== "file.select")) as readonly CliCommandHead[];
const STAGE1_PREDICATES = Object.freeze(CLI_COMMAND_PREDICATES.filter(predicate =>
  predicate !== "predicate.select.entry")) as readonly CliCommandPredicate[];
const STAGE1_WIRES = Object.freeze(CLI_COMMAND_WIRES.filter(wire =>
  !STAGE2_NEW_WIRES.includes(wire as typeof STAGE2_NEW_WIRES[number]))) as readonly CliCommandWire[];

export const STAGE2_PROFILE_DIMENSIONS = Object.freeze({ heads: 13, wires: 38, parameters: 494 });
export type CliCommandStageId = "stage1-11x34" | "stage2-13x38";

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function sameSequence(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new TypeError(`${label} must be exactly ${expected.join(", ")}`);
  }
}

function namedSequence(value: unknown, expected: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value) || value.length !== expected.length || value.some(item => typeof item !== "string")) {
    throw new TypeError(`${label} must contain ${expected.length} named entries`);
  }
  const names = value as string[];
  if (new Set(names).size !== names.length || expected.some(name => !names.includes(name))) {
    throw new TypeError(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return names;
}

function finiteMatrix(value: unknown, rows: number, columns: number): readonly (readonly number[])[] {
  if (!Array.isArray(value) || value.length !== rows) throw new TypeError(`command weights must have ${rows} rows`);
  return Object.freeze(value.map((raw, rowIndex) => {
    if (!Array.isArray(raw) || raw.length !== columns || raw.some(weight => typeof weight !== "number" || !Number.isFinite(weight))) {
      throw new TypeError(`command weight row ${rowIndex} must contain ${columns} finite values`);
    }
    return Object.freeze([...raw] as number[]);
  }));
}

export function detectCliCommandProfileSchema(value: unknown): CliCommandProfileSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.heads) || !Array.isArray(input.wires)) return "invalid";
  const heads: unknown[] = input.heads, wires: unknown[] = input.wires;
  // Stage 2 current shape (13 heads x 38 wires) is the canonical schema.
  if (heads.length === CLI_COMMAND_HEADS.length && wires.length === CLI_COMMAND_WIRES.length
    && CLI_COMMAND_HEADS.every((name, index) => heads[index] === name)
    && CLI_COMMAND_WIRES.every((name, index) => wires[index] === name)) return "current-13x38";
  // Stage 1 shape (11 heads x 34 wires) remains a recognized current schema.
  if (heads.length === 11 && wires.length === 34
    && STAGE1_HEADS.every((name, index) => heads[index] === name)
    && STAGE1_WIRES.every((name, index) => wires[index] === name)) return "current-11x34";
  if (heads.length === 10 && wires.length === 31
    && STAGE0_HEADS.every((name, index) => heads[index] === name)
    && CURRENT_10X31_WIRES.every((name, index) => wires[index] === name)) return "current-10x31";
  if (heads.length === 10 && wires.length === 30
    && STAGE0_HEADS.every((name, index) => heads[index] === name)
    && LEGACY_10X30_WIRES.every((name, index) => wires[index] === name)) return "rejected-10x30";
  if (heads.length === 10 && wires.length === 32
    && STAGE0_HEADS.every((name, index) => heads[index] === name)) return "rejected-10x32";
  if (heads.length === 6 && wires.length === 14
    && LEGACY_6X14_HEADS.every(name => heads.includes(name))
    && LEGACY_6X14_WIRES.every(name => wires.includes(name))) return "legacy-6x14";
  if (heads.length === 4 && wires.length === 4
    && LEGACY_HEADS.every(name => heads.includes(name))
    && LEGACY_WIRES.every(name => wires.includes(name))) return "legacy-4x4";
  return "invalid";
}

export function zeroCliCommandProfile(): CliCommandProfile {
  return validateCliCommandProfile({
    contract: "cli.command-policy.v1",
    heads: [...CLI_COMMAND_HEADS],
    properties: [...CLI_COMMAND_PROPERTIES],
    predicates: [...CLI_COMMAND_PREDICATES],
    wires: [...CLI_COMMAND_WIRES],
    weights: Array.from({ length: CLI_COMMAND_HEADS.length }, () => Array(CLI_COMMAND_WIRES.length).fill(0)),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

function validateStage1Profile(input: Record<string, unknown>): CliCommandProfile {
  exactKeys(input, PROFILE_KEYS, "stage1-11x34 command profile");
  if (input.contract !== "cli.command-policy.v1") throw new TypeError("Invalid command profile contract");
  if (input.calibration !== "uncalibrated" || input.adoption !== "not_applied") throw new TypeError("Invalid command profile status");
  sameSequence(input.heads, STAGE1_HEADS, "stage1-11x34 command heads");
  sameSequence(input.properties, CLI_COMMAND_PROPERTIES, "stage1-11x34 command properties");
  sameSequence(input.predicates, STAGE1_PREDICATES, "stage1-11x34 command predicates");
  sameSequence(input.wires, STAGE1_WIRES, "stage1-11x34 command wires");
  return Object.freeze({
    contract: "cli.command-policy.v1",
    heads: Object.freeze([...STAGE1_HEADS]),
    properties: Object.freeze([...CLI_COMMAND_PROPERTIES]),
    predicates: Object.freeze([...STAGE1_PREDICATES]),
    wires: Object.freeze([...STAGE1_WIRES]),
    weights: finiteMatrix(input.weights, STAGE1_HEADS.length, STAGE1_WIRES.length),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

/** Validate against the schema of the explicitly requested stage. The default stage is the
 *  current Stage 2 `stage2-13x38`; an explicit `stage1-11x34` keeps Stage 1 consumers working
 *  without forcing them onto the Stage 2 matrix. */
export function validateCliCommandProfile(value: unknown, stage: CliCommandStageId = "stage2-13x38"): CliCommandProfile {
  const input = expectRecord(value, "shared command profile");
  if (stage !== "stage1-11x34" && stage !== "stage2-13x38") {
    throw new TypeError("Command profile stage must be stage1-11x34 or stage2-13x38");
  }
  const schema = detectCliCommandProfileSchema(input);
  if (stage === "stage1-11x34") {
    if (schema === "current-11x34") return validateStage1Profile(input);
    if (schema === "current-13x38") throw new TypeError("Profile is the Stage 2 13x38 schema, not the requested stage1-11x34 schema");
    if (schema === "current-10x31") throw new TypeError("10x31 command profile must be migrated to the Stage 1 11x34 schema with migrateCliCommandProfileStage0ToStage1");
    if (schema === "rejected-10x30") throw new TypeError("10x30 command profile must be migrated to the 31-wire schema with migrateCliCommandProfileV10x30");
    if (schema === "rejected-10x32") throw new TypeError("The deprecated 32-wire search profile shape is rejected; the current contract is 13x38");
    if (schema === "legacy-6x14") throw new TypeError("Legacy 6x14 command profile must use migrateCliCommandProfileV6");
    if (schema === "legacy-4x4") throw new TypeError("Legacy 4x4 command profile must use migrateLegacyCliCommandProfile");
    throw new TypeError("Command profile schema is not recognized");
  }
  if (schema === "current-10x31") throw new TypeError("10x31 command profile must be migrated to the Stage 1 11x34 schema with migrateCliCommandProfileStage0ToStage1");
  if (schema === "rejected-10x30") throw new TypeError("10x30 command profile must be migrated to the 31-wire schema with migrateCliCommandProfileV10x30");
  if (schema === "rejected-10x32") throw new TypeError("The deprecated 32-wire search profile shape is rejected; the current contract is 11x34");
  if (schema === "legacy-6x14") throw new TypeError("Legacy 6x14 command profile must use migrateCliCommandProfileV6");
  if (schema === "legacy-4x4") throw new TypeError("Legacy 4x4 command profile must use migrateLegacyCliCommandProfile");
  if (schema === "current-11x34") {
    throw new TypeError("Stage 1 11x34 command profile must be migrated to the Stage 2 13x38 schema with migrateCliCommandProfileStage1ToStage2");
  }
  if (schema === "current-13x38") {
    exactKeys(input, PROFILE_KEYS, "shared command profile");
    if (input.contract !== "cli.command-policy.v1") throw new TypeError("Invalid command profile contract");
    if (input.calibration !== "uncalibrated" || input.adoption !== "not_applied") throw new TypeError("Invalid command profile status");
    sameSequence(input.heads, CLI_COMMAND_HEADS, "command heads");
    sameSequence(input.properties, CLI_COMMAND_PROPERTIES, "command properties");
    sameSequence(input.predicates, CLI_COMMAND_PREDICATES, "command predicates");
    sameSequence(input.wires, CLI_COMMAND_WIRES, "command wires");
    return Object.freeze({
      contract: "cli.command-policy.v1",
      heads: Object.freeze([...CLI_COMMAND_HEADS]),
      properties: Object.freeze([...CLI_COMMAND_PROPERTIES]),
      predicates: Object.freeze([...CLI_COMMAND_PREDICATES]),
      wires: Object.freeze([...CLI_COMMAND_WIRES]),
      weights: finiteMatrix(input.weights, CLI_COMMAND_HEADS.length, CLI_COMMAND_WIRES.length),
      calibration: "uncalibrated",
      adoption: "not_applied",
    });
  }
  exactKeys(input, PROFILE_KEYS, "shared command profile");
  if (input.contract !== "cli.command-policy.v1") throw new TypeError("Invalid command profile contract");
  if (input.calibration !== "uncalibrated" || input.adoption !== "not_applied") throw new TypeError("Invalid command profile status");
  sameSequence(input.heads, CLI_COMMAND_HEADS, "command heads");
  sameSequence(input.properties, CLI_COMMAND_PROPERTIES, "command properties");
  sameSequence(input.predicates, CLI_COMMAND_PREDICATES, "command predicates");
  sameSequence(input.wires, CLI_COMMAND_WIRES, "command wires");
  return Object.freeze({
    contract: "cli.command-policy.v1",
    heads: Object.freeze([...CLI_COMMAND_HEADS]),
    properties: Object.freeze([...CLI_COMMAND_PROPERTIES]),
    predicates: Object.freeze([...CLI_COMMAND_PREDICATES]),
    wires: Object.freeze([...CLI_COMMAND_WIRES]),
    weights: finiteMatrix(input.weights, CLI_COMMAND_HEADS.length, CLI_COMMAND_WIRES.length),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

/** Explicit offline migration from the previous 6x14 shared profile to the current 11x34 schema. */
export function migrateCliCommandProfileV6(value: unknown): CliCommandProfile {
  const legacy = expectRecord(value, "legacy 6x14 command profile");
  exactKeys(legacy, PROFILE_KEYS, "legacy 6x14 command profile");
  if (legacy.contract !== "cli.command-policy.v1" || legacy.calibration !== "uncalibrated" || legacy.adoption !== "not_applied") {
    throw new TypeError("legacy 6x14 command profile contract/status is invalid");
  }
  const heads = namedSequence(legacy.heads, LEGACY_6X14_HEADS, "legacy 6x14 command heads");
  namedSequence(legacy.properties, LEGACY_6X14_PROPERTIES, "legacy 6x14 command properties");
  namedSequence(legacy.predicates, LEGACY_6X14_PREDICATES, "legacy 6x14 command predicates");
  const wires = namedSequence(legacy.wires, LEGACY_6X14_WIRES, "legacy 6x14 command wires");
  const weights = finiteMatrix(legacy.weights, heads.length, wires.length);
  return validateCliCommandProfile({
    contract: "cli.command-policy.v1",
    heads: [...CLI_COMMAND_HEADS],
    properties: [...CLI_COMMAND_PROPERTIES],
    predicates: [...CLI_COMMAND_PREDICATES],
    wires: [...CLI_COMMAND_WIRES],
    weights: CLI_COMMAND_HEADS.map(head => CLI_COMMAND_WIRES.map(wire => {
      const row = heads.indexOf(head), column = wires.indexOf(wire);
      return row < 0 || column < 0 ? 0 : weights[row]![column]!;
    })),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

/** Explicit offline migration from the saved 10x30 profile to the current 11x34 schema.
 *  Existing 30 columns are copied by name; the new search.nameNeedleSegment and Stage 1 columns are zero-filled.
 */
export function migrateCliCommandProfileV10x30(value: unknown): CliCommandProfile {
  const legacy = expectRecord(value, "10x30 command profile");
  exactKeys(legacy, PROFILE_KEYS, "10x30 command profile");
  if (legacy.contract !== "cli.command-policy.v1" || legacy.calibration !== "uncalibrated" || legacy.adoption !== "not_applied") {
    throw new TypeError("10x30 command profile contract/status is invalid");
  }
  const heads = namedSequence(legacy.heads, STAGE0_HEADS, "10x30 command heads");
  namedSequence(legacy.properties, LEGACY_10X30_PROPERTIES, "10x30 command properties");
  namedSequence(legacy.predicates, LEGACY_10X30_PREDICATES, "10x30 command predicates");
  const legacyWires = namedSequence(legacy.wires, LEGACY_10X30_WIRES, "10x30 command wires");
  const weights = finiteMatrix(legacy.weights, heads.length, legacyWires.length);
  const stage0 = {
    contract: "cli.command-policy.v1",
    heads: [...STAGE0_HEADS],
    properties: [...LEGACY_10X30_PROPERTIES],
    predicates: [...LEGACY_10X30_PREDICATES],
    wires: [...CURRENT_10X31_WIRES],
    weights: STAGE0_HEADS.map(head => CURRENT_10X31_WIRES.map(wire => {
      const column = legacyWires.indexOf(wire);
      return column < 0 ? 0 : weights[heads.indexOf(head)]![column]!;
    })),
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  return migrateCliCommandProfileStage0ToStage1(stage0);
}

/** Explicit offline migration from the Stage 0 10x31 profile to the current Stage 1 11x34 schema. */
export function migrateCliCommandProfileStage0ToStage1(value: unknown): CliCommandProfile {
  const legacy = expectRecord(value, "10x31 command profile");
  exactKeys(legacy, PROFILE_KEYS, "10x31 command profile");
  if (legacy.contract !== "cli.command-policy.v1" || legacy.calibration !== "uncalibrated" || legacy.adoption !== "not_applied") {
    throw new TypeError("10x31 command profile contract/status is invalid");
  }
  const heads = namedSequence(legacy.heads, STAGE0_HEADS, "10x31 command heads");
  namedSequence(legacy.properties, LEGACY_10X30_PROPERTIES, "10x31 command properties");
  namedSequence(legacy.predicates, LEGACY_10X30_PREDICATES, "10x31 command predicates");
  const wires = namedSequence(legacy.wires, CURRENT_10X31_WIRES, "10x31 command wires");
  const weights = finiteMatrix(legacy.weights, heads.length, wires.length);
  return validateCliCommandProfile({
    contract: "cli.command-policy.v1",
    heads: [...CLI_COMMAND_HEADS],
    properties: [...CLI_COMMAND_PROPERTIES],
    predicates: [...CLI_COMMAND_PREDICATES],
    wires: [...CLI_COMMAND_WIRES],
    weights: CLI_COMMAND_HEADS.map(head => CLI_COMMAND_WIRES.map(wire => {
      const row = heads.indexOf(head), column = wires.indexOf(wire);
      return row < 0 || column < 0 ? 0 : weights[row]![column]!;
    })),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

/** Unified offline migration entry from any retired or previous shape to the current 11x34 schema. */
export function migrateCliCommandProfileToCurrent(value: unknown): CliCommandProfile {
  const schema = detectCliCommandProfileSchema(value);
  if (schema === "current-13x38") return validateCliCommandProfile(value);
  if (schema === "current-11x34") return migrateCliCommandProfileStage1ToStage2(value);
  if (schema === "current-10x31") return migrateCliCommandProfileStage0ToStage1(value);
  if (schema === "rejected-10x30") return migrateCliCommandProfileV10x30(value);
  if (schema === "legacy-6x14") return migrateCliCommandProfileV6(value);
  if (schema === "legacy-4x4") return migrateLegacyCliCommandProfile(value);
  throw new TypeError("Command profile schema is not a recognized migration source");
}

/** Explicit offline migration from the Stage 1 11x34 profile to the Stage 2 13x38 schema.
 *  All 374 existing (head, wire) positions are copied by exact name; the two new
 *  heads (directory.select, file.select) and four new wires
 *  (predicate.select.entry, selectorTargetType.unspecified/regular/directory) are
  * zero-filled, totaling 494 parameters. */
export function migrateCliCommandProfileStage1ToStage2(value: unknown): CliCommandProfile {
  const legacy = expectRecord(value, "11x34 command profile");
  exactKeys(legacy, PROFILE_KEYS, "11x34 command profile");
  if (legacy.contract !== "cli.command-policy.v1" || legacy.calibration !== "uncalibrated" || legacy.adoption !== "not_applied") {
    throw new TypeError("11x34 command profile contract/status is invalid");
  }
  const heads = namedSequence(legacy.heads, STAGE1_HEADS, "11x34 command heads");
  namedSequence(legacy.properties, CLI_COMMAND_PROPERTIES, "11x34 command properties");
  namedSequence(legacy.predicates, STAGE1_PREDICATES, "11x34 command predicates");
  const legacyWires = namedSequence(legacy.wires, STAGE1_WIRES, "11x34 command wires");
  const legacyWeights = finiteMatrix(legacy.weights, STAGE1_HEADS.length, legacyWires.length);
  let copiedByName = 0, zeroFilledNewSlots = 0;
  const weights = CLI_COMMAND_HEADS.map(head => CLI_COMMAND_WIRES.map(wire => {
    const row = heads.indexOf(head), column = legacyWires.indexOf(wire);
    if (row >= 0 && column >= 0) { copiedByName += 1; return legacyWeights[row]![column]!; }
    zeroFilledNewSlots += 1;
    return 0;
  }));
  if (copiedByName !== 374) throw new TypeError(`Expected 374 named slots copied, got ${copiedByName}`);
  if (zeroFilledNewSlots !== 120) throw new TypeError(`Expected 120 zero-filled slots, got ${zeroFilledNewSlots}`);
  if (weights.flat().length !== 494) throw new TypeError("Stage 2 profile must contain 494 parameters");
  return validateCliCommandProfile({
    contract: "cli.command-policy.v1",
    heads: [...CLI_COMMAND_HEADS],
    properties: [...CLI_COMMAND_PROPERTIES],
    predicates: [...CLI_COMMAND_PREDICATES],
    wires: [...CLI_COMMAND_WIRES],
    weights,
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}


/** Explicit offline migration from the retired 4x4 shared command object. */
export function migrateLegacyCliCommandProfile(value: unknown): CliCommandProfile {
  const legacy = expectRecord(value, "legacy command profile");
  exactKeys(legacy, ["adoption", "calibration", "contract", "heads", "weights", "wires"], "legacy command profile");
  if (legacy.contract !== "cli.command-policy.v1" || legacy.calibration !== "uncalibrated" || legacy.adoption !== "not_applied") {
    throw new TypeError("legacy command profile contract/status is invalid");
  }
  if (!Array.isArray(legacy.heads) || legacy.heads.length !== LEGACY_HEADS.length
    || LEGACY_HEADS.some(name => !(legacy.heads as unknown[]).includes(name))) {
    throw new TypeError("legacy command heads must contain unsupported, pwd, cd, ls");
  }
  if (!Array.isArray(legacy.wires) || legacy.wires.length !== LEGACY_WIRES.length
    || LEGACY_WIRES.some(name => !(legacy.wires as unknown[]).includes(name))) {
    throw new TypeError("legacy command wires must contain the four named legacy wires");
  }
  const legacyWeights = finiteMatrix(legacy.weights, LEGACY_HEADS.length, LEGACY_WIRES.length);
  const expanded = {
    contract: "cli.command-policy.v1",
    heads: [...LEGACY_6X14_HEADS],
    properties: [...LEGACY_6X14_PROPERTIES],
    predicates: [...LEGACY_6X14_PREDICATES],
    wires: [...LEGACY_6X14_WIRES],
    weights: LEGACY_6X14_HEADS.map(head => LEGACY_6X14_WIRES.map(wire => {
      const row = (legacy.heads as readonly string[]).indexOf(head);
      const column = (legacy.wires as readonly string[]).indexOf(wire);
      return row < 0 || column < 0 ? 0 : legacyWeights[row]![column]!;
    })),
    calibration: "uncalibrated",
    adoption: "not_applied",
  };
  return migrateCliCommandProfileV6(expanded);
}

function cliCommandFeatureVector(
  goal: FilePropertyGoal,
  facts: PropertyFacts,
  wires: readonly CliCommandWire[],
): readonly number[] {
  const legacy = legacyWires(goal);
  const property = propertyOf(goal), predicate = predicateOf(goal);
  const propertyWire = property === null ? null : `property.${property.slice("file.property.".length)}`;
  const selectorTargetType = selectorTargetTypeOf(goal);
  return Object.freeze(wires.map(wire => {
    if (wire === "bias") return 1;
    if (wire === "goalObserveCwd") return legacy.goalObserveCwd;
    if (wire === "goalSetCwd") return legacy.goalSetCwd;
    if (wire === "goalListDirectory") return legacy.goalListDirectory;
    if (wire.startsWith("property.")) return propertyWire === wire ? 1 : 0;
    if (wire.startsWith("predicate.")) return predicate === wire ? 1 : 0;
    if (wire === "selectorTargetType.unspecified") return selectorTargetType[0];
    if (wire === "selectorTargetType.regular") return selectorTargetType[1];
    if (wire === "selectorTargetType.directory") return selectorTargetType[2];
    if (wire === "state.hasFreshEvidence") return facts.hasFreshEvidence;
    if (wire === "state.knownValue") return facts.knownValue;
    if (wire === "state.requiredConditionHolds") return facts.requiredConditionHolds;
    if (wire === "state.hasDestinationRef") return facts.hasDestinationRef;
    if (wire === "search.nameNeedleSegment") return 0;
    return facts.requiredConditionHolds * facts.hasFreshEvidence;
  }));
}

export function cliCommandFeatures(goal: FilePropertyGoal, facts: PropertyFacts): readonly number[] {
  return cliCommandFeatureVector(goal, facts, CLI_COMMAND_WIRES);
}

/** Candidate name-relation wire: one basename segment after extension removal equals the needle, case-sensitively. */
export function searchNameNeedleSegment(name: string, needle: string): number {
  const base = name.slice(0, name.length - extname(name).length);
  return base.split("-").some(segment => segment === needle) ? 1 : 0;
}

/** Candidate scoring context: all head-selection wires are zero; only search.nameNeedleSegment is populated. */
export function cliCandidateFeatures(
  name: string,
  needle: string,
  wires: readonly CliCommandWire[] = CLI_COMMAND_WIRES,
): readonly number[] {
  return Object.freeze(wires.map(wire => wire === "search.nameNeedleSegment" ? searchNameNeedleSegment(name, needle) : 0));
}

/** Candidate utility uses only the entry.inspect row and the new name-relation column. */
export function cliCandidateUtility(profile: CliCommandProfile, name: string, needle: string): number {
  const row = profile.heads.indexOf("entry.inspect");
  const column = profile.wires.indexOf("search.nameNeedleSegment");
  if (row < 0 || column < 0) return 0;
  return profile.weights[row]![column]! * searchNameNeedleSegment(name, needle);
}

export function predictCliCommand(
  goal: FilePropertyGoal,
  facts: PropertyFacts,
  value: CliCommandProfile,
  registered = true,
  stage: CliCommandStageId = "stage2-13x38",
): CliCommandPrediction {
  const profile = validateCliCommandProfile(value, stage);
  const features = cliCommandFeatureVector(goal, facts, profile.wires);
  if (!registered) {
    const empty = Object.freeze(Array<number>(profile.heads.length).fill(0));
    return Object.freeze({
      features,
      scores: empty,
      probabilities: empty,
      selectedHead: "unsupported",
    });
  }
  const scores = profile.weights.map(row => row.reduce((sum, weight, index) => sum + weight * features[index]!, 0));
  if (!scores.every(Number.isFinite)) throw new Error("Non-finite shared command logits");
  const maximum = Math.max(...scores), exps = scores.map(score => Math.exp(score - maximum));
  const denominator = exps.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(denominator) || denominator <= 0) throw new Error("Non-finite shared command softmax");
  let selectedIndex = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index]! > scores[selectedIndex]!) selectedIndex = index;
  }
  return Object.freeze({
    features,
    scores: Object.freeze(scores),
    probabilities: Object.freeze(exps.map(value => value / denominator)),
    selectedHead: profile.heads[selectedIndex]!,
  });
}
