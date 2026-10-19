export const PATH_ACTIONS = Object.freeze([
  "START_FROM_ROOT",
  "START_FROM_CWD",
  "PUSH_NAME",
  "POP_PARENT",
  "STAY",
] as const);

export type PathAction = (typeof PATH_ACTIONS)[number];

export const PATH_WIRES = Object.freeze([
  "bias",
  "phaseStart",
  "phaseSegment",
  "absoluteInput",
  "kindCurrent",
  "kindParent",
  "kindName",
  "stackEmpty",
  "parentEmpty",
] as const);

export type PathWire = (typeof PATH_WIRES)[number];
export type PathRequest = Readonly<{ cwd: string; input: string }>;
export type PathFeatures = readonly number[];

export type PathProfile = Readonly<{
  contract: "cli.path-controller.v1";
  actions: readonly PathAction[];
  wires: readonly string[];
  weights: readonly (readonly number[])[];
  calibration: "uncalibrated";
  adoption: "not_applied";
}>;

export type PathStep = Readonly<{
  index: number;
  phase: "start" | "segment";
  features: PathFeatures;
  scores: readonly number[];
  action: PathAction;
  before: readonly string[];
  after: readonly string[];
}>;

export type PathRollout =
  | { ok: true; absolute: string; trace: readonly PathStep[] }
  | { ok: false; code: string; message: string; trace: readonly PathStep[] };

export type PathFitRow = Readonly<{
  features: PathFeatures;
  expected: PathAction;
}>;

export type PathSegmentKind = "current" | "parent" | "name";

export type PathFeatureContext = Readonly<{
  phase: "start" | "segment";
  absoluteInput: boolean;
  kind: PathSegmentKind | null;
  stackEmpty: boolean;
}>;

const PATH_CONTRACT = "cli.path-controller.v1" as const;
const PATH_CALIBRATION = "uncalibrated" as const;
const PATH_ADOPTION = "not_applied" as const;
const MAX_COMPONENTS = 256;

type InputSegment = Readonly<{ text: string; kind: PathSegmentKind }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCanonicalCwd(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("cwd must be a string");
  if (value.includes("\0")) throw new TypeError("cwd cannot contain NUL");
  if (value === "/") return value;
  if (!value.startsWith("/")) throw new TypeError("cwd must be absolute");
  if (value.endsWith("/")) throw new TypeError("cwd cannot have a trailing slash");
  for (const part of value.slice(1).split("/")) {
    if (part === "") throw new TypeError("cwd cannot contain empty components");
    if (part === "." || part === "..") throw new TypeError("cwd cannot contain . or .. components");
  }
  return value;
}

function splitCwd(cwd: string): string[] {
  return cwd === "/" ? [] : cwd.slice(1).split("/");
}

function classifyInput(input: string): InputSegment[] {
  const segments: InputSegment[] = [];
  for (const text of input.split("/")) {
    if (text === "") continue;
    const kind: PathSegmentKind = text === "." ? "current" : text === ".." ? "parent" : "name";
    segments.push({ text, kind });
  }
  return segments;
}

export function validatePathRequest(value: unknown): PathRequest {
  if (!isRecord(value)) throw new TypeError("path request must be an object");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, "cwd") || !Object.hasOwn(value, "input")) {
    throw new TypeError("path request must contain exactly cwd and input");
  }
  const cwd = validateCanonicalCwd(value.cwd);
  if (typeof value.input !== "string") throw new TypeError("input must be a string");
  if (value.input.includes("\0")) throw new TypeError("input cannot contain NUL");
  if (value.input.length === 0) throw new TypeError("input cannot be empty");
  const componentCount = splitCwd(cwd).length + classifyInput(value.input).length;
  if (componentCount > MAX_COMPONENTS) {
    throw new TypeError(`path request cannot exceed ${MAX_COMPONENTS} components`);
  }
  return { cwd, input: value.input };
}

export function pathFeatures(context: PathFeatureContext): PathFeatures {
  if (context.phase !== "start" && context.phase !== "segment") {
    throw new TypeError("feature phase must be start or segment");
  }
  const start = context.phase === "start";
  const kind = start ? null : context.kind;
  if (!start && kind !== "current" && kind !== "parent" && kind !== "name") {
    throw new TypeError("segment features require a current, parent or name kind");
  }
  const stackEmpty = context.stackEmpty ? 1 : 0;
  const kindParent = kind === "parent" ? 1 : 0;
  return [
    1,
    start ? 1 : 0,
    start ? 0 : 1,
    context.absoluteInput ? 1 : 0,
    kind === "current" ? 1 : 0,
    kindParent,
    kind === "name" ? 1 : 0,
    stackEmpty,
    kindParent * stackEmpty,
  ];
}

export function zeroPathProfile(): PathProfile {
  return {
    contract: PATH_CONTRACT,
    actions: [...PATH_ACTIONS],
    wires: [...PATH_WIRES],
    weights: PATH_ACTIONS.map(() => PATH_WIRES.map(() => 0)),
    calibration: PATH_CALIBRATION,
    adoption: PATH_ADOPTION,
  };
}

export function validatePathProfile(value: unknown): PathProfile {
  if (!isRecord(value)) throw new TypeError("profile must be an object");
  if (value.contract !== PATH_CONTRACT) throw new TypeError("profile contract must be cli.path-controller.v1");
  if (!Array.isArray(value.actions) || value.actions.length !== PATH_ACTIONS.length) {
    throw new TypeError(`profile actions must contain ${PATH_ACTIONS.length} entries`);
  }
  for (let index = 0; index < PATH_ACTIONS.length; index += 1) {
    if (value.actions[index] !== PATH_ACTIONS[index]) {
      throw new TypeError(`profile action ${index} must be ${PATH_ACTIONS[index]}`);
    }
  }
  if (!Array.isArray(value.wires) || value.wires.length !== PATH_WIRES.length) {
    throw new TypeError(`profile wires must contain ${PATH_WIRES.length} entries`);
  }
  for (let index = 0; index < PATH_WIRES.length; index += 1) {
    if (value.wires[index] !== PATH_WIRES[index]) {
      throw new TypeError(`profile wire ${index} must be ${PATH_WIRES[index]}`);
    }
  }
  if (!Array.isArray(value.weights) || value.weights.length !== PATH_ACTIONS.length) {
    throw new TypeError(`profile weights must contain ${PATH_ACTIONS.length} action rows`);
  }
  const weights = value.weights.map((row, actionIndex) => {
    if (!Array.isArray(row) || row.length !== PATH_WIRES.length) {
      throw new TypeError(`profile weight row ${actionIndex} must contain ${PATH_WIRES.length} values`);
    }
    return row.map((weight, wireIndex) => {
      if (typeof weight !== "number" || !Number.isFinite(weight)) {
        throw new TypeError(`profile weight ${actionIndex}:${wireIndex} must be finite`);
      }
      return weight;
    });
  });
  if (value.calibration !== PATH_CALIBRATION) throw new TypeError("profile calibration must be uncalibrated");
  if (value.adoption !== PATH_ADOPTION) throw new TypeError("profile adoption must be not_applied");
  return {
    contract: PATH_CONTRACT,
    actions: [...PATH_ACTIONS],
    wires: [...PATH_WIRES],
    weights,
    calibration: PATH_CALIBRATION,
    adoption: PATH_ADOPTION,
  };
}

function readFeatureVector(features: PathFeatures): number[] {
  if (!Array.isArray(features) || features.length !== PATH_WIRES.length) {
    throw new TypeError(`features must contain ${PATH_WIRES.length} values`);
  }
  const vector: number[] = [];
  for (let index = 0; index < features.length; index += 1) {
    const value = features[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`feature ${index} must be finite`);
    }
    vector.push(value);
  }
  return vector;
}

function readWeights(profile: PathProfile): readonly (readonly number[])[] {
  if (!Array.isArray(profile.weights) || profile.weights.length !== PATH_ACTIONS.length) {
    throw new TypeError(`profile weights must contain ${PATH_ACTIONS.length} action rows`);
  }
  for (let actionIndex = 0; actionIndex < PATH_ACTIONS.length; actionIndex += 1) {
    const row = profile.weights[actionIndex];
    if (!Array.isArray(row) || row.length !== PATH_WIRES.length) {
      throw new TypeError(`profile weight row ${actionIndex} must contain ${PATH_WIRES.length} values`);
    }
    for (let wireIndex = 0; wireIndex < PATH_WIRES.length; wireIndex += 1) {
      const weight = row[wireIndex];
      if (typeof weight !== "number" || !Number.isFinite(weight)) {
        throw new TypeError(`profile weight ${actionIndex}:${wireIndex} must be finite`);
      }
    }
  }
  return profile.weights;
}

export function scorePathActions(features: PathFeatures, profile: PathProfile): readonly number[] {
  const vector = readFeatureVector(features);
  const weights = readWeights(profile);
  return PATH_ACTIONS.map((_, actionIndex) => {
    const row = weights[actionIndex]!;
    let score = 0;
    for (let wireIndex = 0; wireIndex < PATH_WIRES.length; wireIndex += 1) {
      score += row[wireIndex]! * vector[wireIndex]!;
    }
    return score;
  });
}

function chooseAction(scores: readonly number[]): PathAction {
  let bestIndex = 0;
  for (let index = 1; index < PATH_ACTIONS.length; index += 1) {
    if (scores[index]! > scores[bestIndex]!) bestIndex = index;
  }
  return PATH_ACTIONS[bestIndex]!;
}

function formatStack(stack: readonly string[]): string {
  return stack.length === 0 ? "/" : `/${stack.join("/")}`;
}

export function rolloutPath(request: PathRequest, profile: PathProfile): PathRollout {
  const validatedRequest = validatePathRequest(request);
  const validatedProfile = validatePathProfile(profile);
  const cwdComponents = splitCwd(validatedRequest.cwd);
  const segments = classifyInput(validatedRequest.input);
  const absoluteInput = validatedRequest.input.startsWith("/");
  const trace: PathStep[] = [];

  const startFeatures = pathFeatures({
    phase: "start",
    absoluteInput,
    kind: null,
    stackEmpty: true,
  });
  const startScores = scorePathActions(startFeatures, validatedProfile);
  const startAction = chooseAction(startScores);
  let stack: string[];
  if (startAction === "START_FROM_ROOT") {
    stack = [];
  } else if (startAction === "START_FROM_CWD") {
    stack = [...cwdComponents];
  } else {
    trace.push({
      index: 0,
      phase: "start",
      features: startFeatures,
      scores: startScores,
      action: startAction,
      before: [],
      after: [],
    });
    return {
      ok: false,
      code: "INVALID_ACTION",
      message: `${startAction} is not valid during the start phase`,
      trace,
    };
  }
  trace.push({
    index: 0,
    phase: "start",
    features: startFeatures,
    scores: startScores,
    action: startAction,
    before: [],
    after: [...stack],
  });

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]!;
    const before = [...stack];
    const features = pathFeatures({
      phase: "segment",
      absoluteInput,
      kind: segment.kind,
      stackEmpty: stack.length === 0,
    });
    const scores = scorePathActions(features, validatedProfile);
    const action = chooseAction(scores);
    let after: string[] | null = null;
    let message: string | null = null;

    if (action === "START_FROM_ROOT" || action === "START_FROM_CWD") {
      message = `${action} is not valid during the segment phase`;
    } else if (action === "PUSH_NAME") {
      if (segment.kind !== "name") {
        message = "PUSH_NAME requires a name segment";
      } else {
        stack.push(segment.text);
        after = [...stack];
      }
    } else if (action === "POP_PARENT") {
      if (before.length === 0) {
        message = "POP_PARENT cannot pop an empty stack";
      } else {
        stack.pop();
        after = [...stack];
      }
    } else {
      after = [...stack];
    }

    trace.push({
      index: segmentIndex + 1,
      phase: "segment",
      features,
      scores,
      action,
      before,
      after: after ?? [...before],
    });
    if (message !== null) {
      return { ok: false, code: "INVALID_ACTION", message, trace };
    }
  }

  return { ok: true, absolute: formatStack(stack), trace };
}
