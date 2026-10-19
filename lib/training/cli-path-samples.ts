import { posix } from "node:path";
import { expectArray, expectNonEmptyString, expectRecord } from "../core/schema.js";
import {
  PATH_ACTIONS, pathFeatures, scorePathActions, validatePathRequest,
  type PathAction, type PathFitRow, type PathProfile, type PathRequest, type PathRollout,
} from "../filters/cli-path-controller.js";

export type PathPartition = "train" | "development" | "holdout";
export interface PathSample extends PathRequest {
  readonly id: string;
  readonly sourceGroup: string;
  readonly partition: PathPartition;
  readonly expected: string;
}
export interface PathDataset { readonly version: 1; readonly samples: readonly PathSample[] }
export interface PreparedPathDataset {
  readonly dataset: PathDataset;
  readonly train: readonly PathSample[];
  readonly development: readonly PathSample[];
  readonly holdout: readonly PathSample[];
  readonly rows: readonly PathFitRow[];
}

/** Teacher-only independent state transitions. The student never imports this module. */
export function teacherPathRows(request: PathRequest): readonly PathFitRow[] {
  validatePathRequest({ cwd: request.cwd, input: request.input });
  const absoluteInput = request.input.startsWith("/");
  const rows: PathFitRow[] = [{
    features: pathFeatures({ phase: "start", absoluteInput, kind: null, stackEmpty: true }),
    expected: absoluteInput ? "START_FROM_ROOT" : "START_FROM_CWD",
  }];
  const stack = absoluteInput ? [] : request.cwd.split("/").filter(Boolean);
  for (const part of request.input.split("/").filter(Boolean)) {
    const kind = part === "." ? "current" : part === ".." ? "parent" : "name";
    const expected: PathAction = kind === "current" || (kind === "parent" && stack.length === 0) ? "STAY" : kind === "parent" ? "POP_PARENT" : "PUSH_NAME";
    rows.push({ features: pathFeatures({ phase: "segment", absoluteInput, kind, stackEmpty: stack.length === 0 }), expected });
    if (kind === "parent") stack.pop();
    else if (kind === "name") stack.push(part);
  }
  if (`/${stack.join("/")}` !== posix.resolve(request.cwd, request.input)) throw new Error("Independent teacher and POSIX oracle disagree");
  return rows;
}

export function preparePathDataset(value: unknown): PreparedPathDataset {
  const dataset = expectRecord(value, "path dataset");
  if (dataset.version !== 1 || Object.keys(dataset).some(key => !["version", "samples"].includes(key))) throw new TypeError("Expected path dataset version 1");
  const groups = new Map<string, PathPartition>(), shapes = new Map<string, PathPartition>(), ids = new Set<string>();
  const samples = expectArray(dataset.samples, "samples").map((raw, index): PathSample => {
    const row = expectRecord(raw, `sample ${index}`);
    if (Object.keys(row).some(key => !["id", "sourceGroup", "partition", "cwd", "input", "expected"].includes(key))) throw new TypeError("Unknown path sample field");
    const id = expectNonEmptyString(row.id, "id"), sourceGroup = expectNonEmptyString(row.sourceGroup, "sourceGroup");
    if (ids.has(id)) throw new TypeError("Duplicate sample id");
    ids.add(id);
    if (!["train", "development", "holdout"].includes(String(row.partition))) throw new TypeError("Invalid partition");
    const partition = row.partition as PathPartition;
    const request = validatePathRequest({ cwd: row.cwd, input: row.input });
    const expected = expectNonEmptyString(row.expected, "expected");
    if (expected !== posix.resolve(request.cwd, request.input)) throw new TypeError(`Wrong expected path for ${id}`);
    if (groups.has(sourceGroup) && groups.get(sourceGroup) !== partition) throw new TypeError("Source group crosses partitions");
    groups.set(sourceGroup, partition);
    // Names, repeated separators and optional current segments cannot hide renamed/dotted copies.
    const shape = JSON.stringify([request.cwd.split("/").filter(Boolean).length, request.input.startsWith("/"), request.input.split("/").filter(part => part && part !== ".").map(part => part === ".." ? "parent" : "name")]);
    if (shapes.has(shape) && shapes.get(shape) !== partition) throw new TypeError("Related path structure crosses partitions");
    shapes.set(shape, partition);
    teacherPathRows(request);
    return { id, sourceGroup, partition, ...request, expected };
  });
  const train = samples.filter(row => row.partition === "train");
  const development = samples.filter(row => row.partition === "development");
  const holdout = samples.filter(row => row.partition === "holdout");
  if (!train.length || !development.length || !holdout.length) throw new TypeError("All three sample partitions must be nonempty");
  return { dataset: { version: 1, samples }, train, development, holdout, rows: train.flatMap(teacherPathRows) };
}

/** Reproducible synthetic requests. Related variants share one declared source group. */
export function makePathFixture(): PathDataset {
  const templates: readonly { partition: PathPartition; depth: number; input: (a: string, b: string, c: string) => string }[] = [
    { partition: "train", depth: 0, input: a => `../${a}` },
    { partition: "train", depth: 1, input: a => a },
    { partition: "train", depth: 2, input: a => `../${a}` },
    { partition: "train", depth: 3, input: (a,b) => `./${a}/../${b}` },
    { partition: "train", depth: 2, input: (a,b) => `/${a}/${b}` },
    { partition: "train", depth: 2, input: a => `/../${a}` },
    { partition: "train", depth: 1, input: a => `../.././${a}` },
    { partition: "train", depth: 0, input: () => "/" },
    { partition: "development", depth: 4, input: (a,b) => `../${a}/./../${b}` },
    { partition: "development", depth: 4, input: (a,b,c) => `/${a}/../${b}/./${c}` },
    { partition: "holdout", depth: 5, input: (a,b,c) => `../../../${a}/../${b}/./${c}` },
    { partition: "holdout", depth: 6, input: (a,b,c) => `/${a}//${b}/../${c}/./${a}/` },
    { partition: "holdout", depth: 7, input: a => `../../../../../../../../${a}` },
    { partition: "holdout", depth: 8, input: (a,b,c) => `./${a}/${b}/../../${c}/../${a}/${b}` },
  ];
  const names = ["plain", "代码", "with space", "same", "back\\slash", "$HOME", "*.txt", "$(literal)"];
  const samples: PathSample[] = [];
  templates.forEach((template, group) => {
    for (let variant = 0; variant < 8; variant++) {
      const name = names[variant]!;
      const a = `${name}-${group}`, b = variant === 3 ? a : `next-${name}-${group}`, c = `last-${name}-${group}`;
      const cwd = "/" + Array.from({length: template.depth}, (_, index) => `base-${group}-${variant}-${index}`).join("/");
      const input = template.input(a,b,c);
      samples.push({ id: `g${group}-v${variant}`, sourceGroup: `structure-${group}`, partition: template.partition, cwd, input, expected: posix.resolve(cwd,input) });
    }
  });
  return { version: 1, samples };
}

export interface PathEvaluation {
  readonly sampleCount: number;
  readonly familyCount: number;
  readonly teacherStepCount: number;
  readonly correctTeacherSteps: number;
  readonly exactPaths: number;
  readonly invalidRollouts: number;
  readonly rows: readonly { id: string; expected: string; rollout: PathRollout; firstDivergence: number | null }[];
}

export async function evaluatePathSamples(
  samples: readonly PathSample[], profile: PathProfile,
  resolve: (request: PathRequest) => Promise<PathRollout>,
): Promise<PathEvaluation> {
  let teacherStepCount = 0, correctTeacherSteps = 0, exactPaths = 0, invalidRollouts = 0;
  const rows: { id: string; expected: string; rollout: PathRollout; firstDivergence: number | null }[] = [];
  for (const sample of samples) {
    const teacher = teacherPathRows(sample);
    for (const row of teacher) {
      const scores = scorePathActions(row.features, profile);
      const selected = scores.indexOf(Math.max(...scores));
      teacherStepCount++;
      if (PATH_ACTIONS[selected] === row.expected) correctTeacherSteps++;
    }
    const rollout = await resolve({ cwd: sample.cwd, input: sample.input });
    if (rollout.ok && rollout.absolute === sample.expected) exactPaths++;
    if (!rollout.ok) invalidRollouts++;
    let firstDivergence: number | null = null;
    for (let index = 0; index < Math.max(teacher.length, rollout.trace.length); index++) {
      if (teacher[index]?.expected !== rollout.trace[index]?.action) { firstDivergence = index; break; }
    }
    rows.push({ id: sample.id, expected: sample.expected, rollout, firstDivergence });
  }
  return { sampleCount: samples.length, familyCount: new Set(samples.map(sample => sample.sourceGroup)).size,
    teacherStepCount, correctTeacherSteps, exactPaths, invalidRollouts, rows };
}
