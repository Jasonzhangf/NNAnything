import { expectRecord } from "../core/schema.js";
import type { StructuredCliGoal } from "./cli-goal-policy.js";

export const CLI_COMMANDS = ["pwd", "cd", "ls"] as const;
export type CliCommandName = typeof CLI_COMMANDS[number];
export type CliCommandHead = "unsupported" | CliCommandName;
export const CLI_COMMAND_WIRE = { pwd: "goalObserveCwd", cd: "goalSetCwd", ls: "goalListDirectory" } as const;
export type CliCommandProfile = Readonly<{
  contract: "cli.command-policy.v1";
  heads: readonly CliCommandHead[];
  wires: readonly string[];
  weights: readonly (readonly number[])[];
  calibration: "uncalibrated";
  adoption: "not_applied";
}>;

function commands(value: readonly CliCommandName[]): readonly CliCommandName[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(name => !CLI_COMMANDS.includes(name))) {
    throw new TypeError("commands must be distinct registered shell names");
  }
  return value;
}

export function zeroCliCommandProfile(names: readonly CliCommandName[]): CliCommandProfile {
  commands(names);
  return validateCliCommandProfile({ contract: "cli.command-policy.v1", heads: ["unsupported", ...names],
    wires: ["bias", ...names.map(name => CLI_COMMAND_WIRE[name])],
    weights: Array.from({ length: names.length + 1 }, () => Array(names.length + 1).fill(0)),
    calibration: "uncalibrated", adoption: "not_applied" });
}

export function validateCliCommandProfile(value: unknown): CliCommandProfile {
  const input = expectRecord(value, "shared command profile");
  if (Object.keys(input).sort().join() !== ["adoption", "calibration", "contract", "heads", "weights", "wires"].join()) throw new TypeError("Invalid command profile fields");
  if (input.contract !== "cli.command-policy.v1" || input.calibration !== "uncalibrated" || input.adoption !== "not_applied") throw new TypeError("Invalid command profile contract/status");
  if (!Array.isArray(input.heads) || input.heads[0] !== "unsupported") throw new TypeError("unsupported must be the first head");
  const names = commands(input.heads.slice(1) as CliCommandName[]);
  const wires = ["bias", ...names.map(name => CLI_COMMAND_WIRE[name])];
  if (JSON.stringify(input.wires) !== JSON.stringify(wires)) throw new TypeError("Command wire names do not match registered heads");
  if (!Array.isArray(input.weights) || input.weights.length !== input.heads.length) throw new TypeError("Invalid command weight rows");
  const weights = input.weights.map(row => {
    if (!Array.isArray(row) || row.length !== wires.length || row.some(weight => typeof weight !== "number" || !Number.isFinite(weight))) throw new TypeError("Invalid command weight width/value");
    return Object.freeze([...row] as number[]);
  });
  return Object.freeze({ contract: "cli.command-policy.v1", heads: Object.freeze(["unsupported", ...names] as CliCommandHead[]),
    wires: Object.freeze(wires), weights: Object.freeze(weights), calibration: "uncalibrated", adoption: "not_applied" });
}

/** Add named rows/columns. Never reset or reinterpret existing coefficients. */
export function expandCliCommandProfile(value: CliCommandProfile, names: readonly CliCommandName[]): CliCommandProfile {
  const before = validateCliCommandProfile(value), after = zeroCliCommandProfile(names);
  if (before.heads.some(head => !after.heads.includes(head))) throw new TypeError("Incremental expansion cannot remove a command");
  return validateCliCommandProfile({ ...after, weights: after.heads.map(head => after.wires.map(wire => {
    const row = before.heads.indexOf(head), column = before.wires.indexOf(wire);
    return row < 0 || column < 0 ? 0 : before.weights[row]![column]!;
  })) });
}

export function expectedCliCommand(goal: StructuredCliGoal): CliCommandHead {
  return goal.kind === "observe_cwd" ? "pwd" : goal.kind === "set_cwd" ? "cd" : goal.kind === "list_directory" ? "ls" : "unsupported";
}

export function cliCommandFeatures(goal: StructuredCliGoal, profile: CliCommandProfile): readonly number[] {
  const name = expectedCliCommand(goal);
  return Object.freeze(profile.wires.map(wire => wire === "bias" ? 1 : name !== "unsupported" && wire === CLI_COMMAND_WIRE[name] ? 1 : 0));
}

export function predictCliCommand(goal: StructuredCliGoal, value: CliCommandProfile) {
  const profile = validateCliCommandProfile(value), features = cliCommandFeatures(goal, profile);
  const scores = profile.weights.map(row => row.reduce((sum, weight, index) => sum + weight * features[index]!, 0));
  let selectedIndex = 0;
  for (let index = 1; index < scores.length; index++) if (scores[index]! > scores[selectedIndex]!) selectedIndex = index;
  return Object.freeze({ features, scores: Object.freeze(scores), selectedHead: profile.heads[selectedIndex]! });
}
