import { expectRecord } from "../core/schema.js";
import {
  CWD_PROPERTY,
  ENTRIES_PROPERTY,
  REGISTERED_PREDICATES,
  REGISTERED_PROPERTIES,
  legacyWires,
  predicateOf,
  propertyOf,
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
  "entry.inspect",
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
  | "state.hasFreshEvidence"
  | "state.knownValue"
  | "state.requiredConditionHolds"
  | "state.hasDestinationRef"
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
  "state.hasFreshEvidence",
  "state.knownValue",
  "state.requiredConditionHolds",
  "state.hasDestinationRef",
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

export type CliCommandProfileSchema = "legacy-4x4" | "legacy-6x14" | "current-10x30" | "invalid";

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
  if (heads.length === 10 && wires.length === 30
    && CLI_COMMAND_HEADS.every((name, index) => heads[index] === name)
    && CLI_COMMAND_WIRES.every((name, index) => wires[index] === name)) return "current-10x30";
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

export function validateCliCommandProfile(value: unknown): CliCommandProfile {
  const input = expectRecord(value, "shared command profile");
  const schema = detectCliCommandProfileSchema(input);
  if (schema === "legacy-6x14") throw new TypeError("Legacy 6x14 command profile must use migrateCliCommandProfileV6");
  if (schema === "legacy-4x4") throw new TypeError("Legacy 4x4 command profile must use migrateLegacyCliCommandProfile");
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

/** Explicit offline migration from the previous 6x14 shared profile to the current 10x30 schema. */
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

export function cliCommandFeatures(goal: FilePropertyGoal, facts: PropertyFacts): readonly number[] {
  const legacy = legacyWires(goal);
  const property = propertyOf(goal), predicate = predicateOf(goal);
  const propertyWire = property === null ? null : `property.${property.slice("file.property.".length)}`;
  return Object.freeze(CLI_COMMAND_WIRES.map(wire => {
    if (wire === "bias") return 1;
    if (wire === "goalObserveCwd") return legacy.goalObserveCwd;
    if (wire === "goalSetCwd") return legacy.goalSetCwd;
    if (wire === "goalListDirectory") return legacy.goalListDirectory;
    if (wire.startsWith("property.")) return propertyWire === wire ? 1 : 0;
    if (wire.startsWith("predicate.")) return predicate === wire ? 1 : 0;
    if (wire === "state.hasFreshEvidence") return facts.hasFreshEvidence;
    if (wire === "state.knownValue") return facts.knownValue;
    if (wire === "state.requiredConditionHolds") return facts.requiredConditionHolds;
    if (wire === "state.hasDestinationRef") return facts.hasDestinationRef;
    return facts.requiredConditionHolds * facts.hasFreshEvidence;
  }));
}

export function predictCliCommand(
  goal: FilePropertyGoal,
  facts: PropertyFacts,
  value: CliCommandProfile,
  registered = true,
): CliCommandPrediction {
  const profile = validateCliCommandProfile(value), features = cliCommandFeatures(goal, facts);
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
