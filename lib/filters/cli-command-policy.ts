import { expectRecord } from "../core/schema.js";
import {
  CWD_PROPERTY,
  ENTRIES_PROPERTY,
  legacyWires,
  predicateOf,
  type FilePropertyGoal,
  type PropertyFacts,
} from "./cli-file-property.js";

export const CLI_COMMANDS = Object.freeze(["pwd", "cd", "ls"] as const);
export type CliCommandName = typeof CLI_COMMANDS[number];
export const CLI_COMMAND_HEADS = Object.freeze(["unsupported", "DEFER", "NOOP", "pwd", "cd", "ls"] as const);
export type CliCommandHead = typeof CLI_COMMAND_HEADS[number];

export const CLI_COMMAND_PROPERTIES = Object.freeze(["property.directory.entries", "property.relation.sessionCwd"] as const);
export const CLI_COMMAND_PREDICATES = Object.freeze([
  "predicate.observe.sessionCwd",
  "predicate.equals.sessionCwd",
  "predicate.observe.entries",
] as const);
export const CLI_COMMAND_WIRES = Object.freeze([
  "bias",
  "goalObserveCwd",
  "goalSetCwd",
  "goalListDirectory",
  "property.directory.entries",
  "property.relation.sessionCwd",
  "predicate.observe.sessionCwd",
  "predicate.equals.sessionCwd",
  "predicate.observe.entries",
  "state.hasFreshEvidence",
  "state.knownValue",
  "state.requiredConditionHolds",
  "state.hasDestinationRef",
  "state.requiredConditionHolds*state.hasFreshEvidence",
] as const);
export type CliCommandWire = typeof CLI_COMMAND_WIRES[number];

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

function finiteMatrix(value: unknown, rows: number, columns: number): readonly (readonly number[])[] {
  if (!Array.isArray(value) || value.length !== rows) throw new TypeError(`command weights must have ${rows} rows`);
  return Object.freeze(value.map((raw, rowIndex) => {
    if (!Array.isArray(raw) || raw.length !== columns || raw.some(weight => typeof weight !== "number" || !Number.isFinite(weight))) {
      throw new TypeError(`command weight row ${rowIndex} must contain ${columns} finite values`);
    }
    return Object.freeze([...raw] as number[]);
  }));
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
  return validateCliCommandProfile({
    contract: "cli.command-policy.v1",
    heads: [...CLI_COMMAND_HEADS],
    properties: [...CLI_COMMAND_PROPERTIES],
    predicates: [...CLI_COMMAND_PREDICATES],
    wires: [...CLI_COMMAND_WIRES],
    weights: CLI_COMMAND_HEADS.map(head => CLI_COMMAND_WIRES.map(wire => {
      const row = (legacy.heads as readonly string[]).indexOf(head);
      const column = (legacy.wires as readonly string[]).indexOf(wire);
      return row < 0 || column < 0 ? 0 : legacyWeights[row]![column]!;
    })),
    calibration: "uncalibrated",
    adoption: "not_applied",
  });
}

export function cliCommandFeatures(goal: FilePropertyGoal, facts: PropertyFacts): readonly number[] {
  const legacy = legacyWires(goal);
  const predicate = predicateOf(goal);
  return Object.freeze(CLI_COMMAND_WIRES.map(wire => {
    if (wire === "bias") return 1;
    if (wire === "goalObserveCwd") return legacy.goalObserveCwd;
    if (wire === "goalSetCwd") return legacy.goalSetCwd;
    if (wire === "goalListDirectory") return legacy.goalListDirectory;
    if (wire === "property.directory.entries") return goal.property === ENTRIES_PROPERTY ? 1 : 0;
    if (wire === "property.relation.sessionCwd") return goal.property === CWD_PROPERTY ? 1 : 0;
    if (wire === "predicate.observe.sessionCwd") return predicate === "predicate.observe.sessionCwd" ? 1 : 0;
    if (wire === "predicate.equals.sessionCwd") return predicate === "predicate.equals.sessionCwd" ? 1 : 0;
    if (wire === "predicate.observe.entries") return predicate === "predicate.observe.entries" ? 1 : 0;
    if (wire === "state.hasFreshEvidence") return facts.hasFreshEvidence;
    if (wire === "state.knownValue") return facts.knownValue;
    if (wire === "state.requiredConditionHolds") return facts.requiredConditionHolds;
    if (wire === "state.hasDestinationRef") return facts.hasDestinationRef;
    return facts.requiredConditionHolds * facts.hasFreshEvidence;
  }));
}

export function predictCliCommand(goal: FilePropertyGoal, facts: PropertyFacts, value: CliCommandProfile): CliCommandPrediction {
  const profile = validateCliCommandProfile(value), features = cliCommandFeatures(goal, facts);
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
