import { isAbsolute, join } from "node:path";
import { expectArray, expectNonEmptyString, expectRecord } from "../core/schema.js";
import {
  expectedGoalAction,
  goalFeatures,
  validateCliGoal,
  validateCliGoalSession,
  validateCliGoalState,
  type CliGoalAction,
  type CliGoalFitRow,
  type CliGoalFeatures,
  type CliGoalSession,
  type CliGoalState,
  type StructuredCliGoal,
} from "../filters/cli-goal-policy.js";

export type CliGoalPartition = "train" | "development";
export type CliGoalExpectedStatus = "achieved" | "unmet";

export interface CliGoalSample {
  readonly id: string;
  readonly sourceGroup: string;
  readonly partition: CliGoalPartition;
  readonly goal: StructuredCliGoal;
  readonly state: CliGoalState;
  readonly session: CliGoalSession;
  readonly expectedAction: CliGoalAction;
  readonly expectedGoalStatus: CliGoalExpectedStatus;
}

export interface CliGoalDataset {
  readonly version: 1;
  readonly samples: readonly CliGoalSample[];
}

export interface PreparedCliGoalDataset {
  readonly dataset: CliGoalDataset;
  readonly train: readonly CliGoalSample[];
  readonly development: readonly CliGoalSample[];
  readonly rows: readonly CliGoalFitRow[];
}

function evidence(cwd: string, sourceRun: string) {
  return {
    kind: "pwd" as const,
    configuredCwd: cwd,
    physicalCwd: cwd,
    executable: "/bin/pwd" as const,
    argv: ["-P"] as const,
    stdout: `${cwd}\n`,
    stderr: "",
    exitCode: 0 as const,
  };
}

function stateFor(session: CliGoalSession, knowledge: "absent" | "correct" | "stale", id: string): CliGoalState {
  if (knowledge === "absent") return { session: session.id, cwdObservation: null };
  const physicalCwd = knowledge === "correct" ? session.cwd : join("/stale", id);
  return {
    session: session.id,
    cwdObservation: {
      physicalCwd,
      evidence: evidence(physicalCwd, `${id}-prior`),
      sourceRun: `${id}-prior-run`,
    },
  };
}

function sample(
  cwd: string,
  partition: CliGoalPartition,
  index: number,
  kind: "observe_cwd" | "set_cwd" | "other",
  knowledge: "absent" | "correct" | "stale",
): CliGoalSample {
  const id = `${partition}-${kind}-${index}`;
  const sessionCwd = kind === "observe_cwd" ? cwd : join(cwd, `missing-contrast-${id}`);
  const session = validateCliGoalSession({
    id: `session-${id}`,
    cwd: sessionCwd,
    grantedEffects: kind === "observe_cwd" ? ["filesystem.read", "process.exec"] : [],
  });
  const goal = kind === "set_cwd"
    ? { kind, session: session.id, target: join(cwd, `goal-target-${id}`) }
    : kind === "other"
      ? { kind, session: session.id, detail: "unsupported structured contrast" }
      : { kind, session: session.id };
  const state = stateFor(session, knowledge, id);
  const validatedGoal = validateCliGoal(goal);
  const validatedState = validateCliGoalState(state);
  return Object.freeze({
    id,
    sourceGroup: `group-${id}`,
    partition,
    goal: validatedGoal,
    state: validatedState,
    session,
    expectedAction: expectedGoalAction(validatedGoal),
    expectedGoalStatus: kind === "observe_cwd" ? "achieved" : "unmet",
  });
}

export function makeCliGoalFixture(options: { readonly cwd: string }): CliGoalDataset {
  const cwd = expectNonEmptyString(options.cwd, "cwd");
  if (!isAbsolute(cwd)) throw new TypeError("cwd must be an absolute existing directory for executable observe samples");
  const train: CliGoalSample[] = [
    sample(cwd, "train", 0, "observe_cwd", "absent"),
    sample(cwd, "train", 1, "observe_cwd", "correct"),
    sample(cwd, "train", 2, "observe_cwd", "stale"),
    sample(cwd, "train", 3, "observe_cwd", "absent"),
    sample(cwd, "train", 0, "set_cwd", "absent"),
    sample(cwd, "train", 1, "set_cwd", "correct"),
    sample(cwd, "train", 2, "set_cwd", "stale"),
    sample(cwd, "train", 3, "set_cwd", "absent"),
    sample(cwd, "train", 0, "other", "absent"),
    sample(cwd, "train", 1, "other", "correct"),
    sample(cwd, "train", 2, "other", "stale"),
    sample(cwd, "train", 3, "other", "absent"),
  ];
  const development: CliGoalSample[] = [
    sample(cwd, "development", 0, "observe_cwd", "correct"),
    sample(cwd, "development", 1, "observe_cwd", "absent"),
    sample(cwd, "development", 0, "set_cwd", "stale"),
    sample(cwd, "development", 1, "set_cwd", "absent"),
    sample(cwd, "development", 0, "other", "correct"),
    sample(cwd, "development", 1, "other", "absent"),
  ];
  return Object.freeze({ version: 1, samples: Object.freeze([...train, ...development]) });
}

export function cliGoalRows(samples: readonly CliGoalSample[]): readonly CliGoalFitRow[] {
  return samples.map(row => Object.freeze({
    features: Object.freeze(goalFeatures(row.goal)) as CliGoalFeatures,
    expected: row.expectedAction,
  }));
}

export function prepareCliGoalDataset(value: unknown): PreparedCliGoalDataset {
  const dataset = expectRecord(value, "cli goal dataset");
  if (dataset.version !== 1 || Object.keys(dataset).some(key => key !== "version" && key !== "samples")) {
    throw new TypeError("Expected cli goal dataset version 1");
  }
  const ids = new Set<string>();
  const sourceGroups = new Map<string, CliGoalPartition>();
  const sessionIds = new Set<string>();
  const samples = expectArray(dataset.samples, "samples").map((raw, index): CliGoalSample => {
    const row = expectRecord(raw, `sample ${index}`);
    const allowed = ["id", "sourceGroup", "partition", "goal", "state", "session", "expectedAction", "expectedGoalStatus"];
    if (Object.keys(row).some(key => !allowed.includes(key))) throw new TypeError("Unknown cli goal sample field");
    const id = expectNonEmptyString(row.id, "id");
    if (ids.has(id)) throw new TypeError("Duplicate cli goal sample id");
    ids.add(id);
    const partition = row.partition;
    if (partition !== "train" && partition !== "development") throw new TypeError("Training request cannot contain holdout or unknown partitions");
    const sourceGroup = expectNonEmptyString(row.sourceGroup, "sourceGroup");
    if (sourceGroups.has(sourceGroup) && sourceGroups.get(sourceGroup) !== partition) throw new TypeError("Source group crosses cli goal partitions");
    sourceGroups.set(sourceGroup, partition);
    const session = validateCliGoalSession(row.session);
    if (sessionIds.has(session.id)) throw new TypeError("Duplicate cli goal session id");
    sessionIds.add(session.id);
    const goal = validateCliGoal(row.goal);
    const state = validateCliGoalState(row.state);
    if (goal.session !== session.id || state.session !== session.id) throw new TypeError("Sample goal, state and session references must match");
    const expectedAction = expectNonEmptyString(row.expectedAction, "expectedAction");
    if (expectedAction !== expectedGoalAction(goal)) throw new TypeError("expectedAction disagrees with the structured goal contract");
    const expectedGoalStatus = row.expectedGoalStatus;
    const contractStatus: CliGoalExpectedStatus = goal.kind === "observe_cwd" ? "achieved" : "unmet";
    if (expectedGoalStatus !== contractStatus) throw new TypeError("expectedGoalStatus disagrees with the structured goal contract");
    return Object.freeze({
      id,
      sourceGroup,
      partition,
      goal,
      state,
      session,
      expectedAction: expectedAction as CliGoalAction,
      expectedGoalStatus: expectedGoalStatus as CliGoalExpectedStatus,
    });
  });
  const train = samples.filter(row => row.partition === "train");
  const development = samples.filter(row => row.partition === "development");
  if (!train.length || !development.length) throw new TypeError("Both train and development partitions must be nonempty");
  return Object.freeze({ dataset: Object.freeze({ version: 1, samples: Object.freeze(samples) }), train, development, rows: cliGoalRows(train) });
}
