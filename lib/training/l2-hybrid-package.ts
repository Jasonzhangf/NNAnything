/**
 * Standard loader, validator, and stage-driven executor for `cli.hybrid-package.v1`
 * (Handwired pre -> shared E19 MLP -> Handwired post).
 *
 * Relationship to external prototype:
 * - External `handwired-sandwich-mvp/hybrid-executor.mjs` remains a candidate under
 *   parent verification. This module provides the typed standard library owner for
 *   hybrid package validation, stage circuit construction (`loadHandwired`), raw vs
 *   final inference, and trainable head parameter extraction/update without touching
 *   fixed Handwired stage declarations.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { L2_HEADS } from "../adapters/l2/contracts.js";
import type {
  L2Head,
  L2HeadSpec,
  L2MlpHeadProfile,
  L2MlpProfile,
  L2Prediction,
  L2Specs,
} from "../adapters/l2/contracts.js";
import { loadHandwired, type HandwiredCircuit, type HandwiredWire } from "./handwired.js";
import { inferHead } from "./l2-mlp-backend.js";

export const CLI_HYBRID_PACKAGE_SCHEMA = "cli.hybrid-package.v1" as const;
export const HYBRID_CONTRACT_ERROR = "HYBRID_CONTRACT_ERROR" as const;

export const READ_GOAL_KINDS = [
  "gcm.read",
  "gcm.observe-lines",
  "g2.read",
  "g2.observe-lines",
] as const;

export const LITERAL_GOAL_KINDS = [
  "g3.search",
  "g3.literal-search",
] as const;

export const E19_FEATURES = [
  "goal.head",
  "goal.tail",
  "goal.N/16",
  "receipt.present",
  "actual.head",
  "actual.tail",
  "execution.succeeded",
  "execution.failed",
  "execution.unknown",
  "output.linesKnown",
  "output.logicalLines/16",
  "actual.N/16",
  "goal.isLiteral",
  "grep.present",
  "grep.normalCompleted",
  "grep.execFailed",
  "grep.queryMatches",
  "grep.rawHitValid",
  "grep.rawCompleteNoMatch",
] as const;

export const E_LABELS = ["unsatisfied", "satisfied", "unknown"] as const;

export type HybridGoalFamily = "read" | "literal";

export interface HybridReceiptFact {
  readonly known: boolean;
  readonly present: boolean | null;
}

export interface HybridEInferRequest {
  readonly goal: { readonly kind: string; readonly [key: string]: unknown };
  readonly features19: readonly number[];
  readonly receiptFact: HybridReceiptFact;
}

export interface HybridEInferResult {
  readonly label: string;
  readonly logits: readonly number[];
  readonly rawLabel: string;
  readonly rawLogits: readonly number[];
  readonly readGate: number;
  readonly literalGate: number;
  readonly family: HybridGoalFamily;
  readonly kind: string;
  readonly fixed: boolean;
}

export type HandwiredStageOperation =
  | { readonly id: string; readonly op: "source"; readonly source: string }
  | { readonly id: string; readonly op: "constant"; readonly value: number }
  | {
      readonly id: string;
      readonly op: "affine";
      readonly terms: readonly { readonly ref: string; readonly coefficient: number }[];
      readonly bias?: number;
    }
  | { readonly id: string; readonly op: "multiply"; readonly left: string; readonly right: string }
  | {
      readonly id: string;
      readonly op: "select";
      readonly gate: string;
      readonly off: string;
      readonly on: string;
    };

export interface HandwiredStageDeclaration {
  readonly kind: "handwired";
  readonly trainable: false;
  readonly name: "pre" | "post";
  readonly sourceNames: readonly string[];
  readonly operations: readonly HandwiredStageOperation[];
  readonly outputNames: Readonly<Record<string, string>>;
}

export interface MlpStageDeclaration {
  readonly kind: "mlp";
  readonly trainable: true;
  readonly name: "core";
  readonly head: "E";
  readonly featureSourcePassThrough: readonly string[];
  readonly rawOutputNames: readonly string[];
}

export type HybridStageDeclaration = HandwiredStageDeclaration | MlpStageDeclaration;

export interface CliHybridPackageHead {
  readonly features: readonly string[];
  readonly labels: readonly string[];
  readonly hidden: readonly [number, number];
  readonly parameters: readonly number[];
}

export interface CliHybridPackageAnnotations {
  readonly goal_family_feature_map: {
    readonly read_kinds: readonly string[];
    readonly literal_kinds: readonly string[];
    readonly read_family_index?: number;
    readonly literal_family_index?: number;
  };
  readonly receipt_feature_map: {
    readonly read_receipt_index: number;
    readonly literal_receipt_index: number;
  };
  readonly fixed_rule_scores: {
    readonly read_no_receipt: readonly [number, number, number];
    readonly literal_no_receipt: readonly [number, number, number];
  };
  readonly e19_label_order?: readonly string[];
  readonly source_provenance?: Readonly<Record<string, unknown>>;
  readonly note?: string;
}

export interface CliHybridPackageV1 {
  readonly schema: typeof CLI_HYBRID_PACKAGE_SCHEMA;
  readonly heads: Readonly<Record<L2Head, CliHybridPackageHead>>;
  readonly annotations: CliHybridPackageAnnotations;
  readonly stages: readonly [
    HandwiredStageDeclaration,
    MlpStageDeclaration,
    HandwiredStageDeclaration,
  ];
}

export interface HybridPackageResource {
  readonly packagePath: string | null;
  readonly handwiredRoot: string;
  readonly package: CliHybridPackageV1;
  readonly profile: L2MlpProfile;
  inferE(request: HybridEInferRequest): HybridEInferResult;
  inferHead(head: L2Head, features: readonly number[]): L2Prediction;
  readonly contributions: {
    readonly preOperations: number;
    readonly postOperations: number;
  };
}

interface SelectableCircuit extends HandwiredCircuit {
  select(gate: HandwiredWire, off: HandwiredWire, on: HandwiredWire): HandwiredWire;
}

export class HybridContractError extends Error {
  readonly code = HYBRID_CONTRACT_ERROR;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "HybridContractError";
    this.detail = { ...detail, code: HYBRID_CONTRACT_ERROR };
  }
}

function contractError(message: string, detail: Readonly<Record<string, unknown>> = {}): HybridContractError {
  return new HybridContractError(message, detail);
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(`${label} must be an object`, { label });
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw contractError(`${label} must be a non-empty string`, { label });
  }
  return value;
}

function assertFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw contractError(`${label} must be finite`, { label, value });
  }
  return value;
}

function assertFiniteArray(
  value: unknown,
  label: string,
  expectedLength: number | null = null,
): number[] {
  if (!Array.isArray(value)) {
    throw contractError(`${label} must be an array`, { label });
  }
  if (expectedLength !== null && value.length !== expectedLength) {
    throw contractError(`${label} must have length ${expectedLength}`, {
      label,
      expectedLength,
      actualLength: value.length,
    });
  }
  return value.map((item, index) => assertFinite(item, `${label}[${index}]`));
}

export function expectedHeadParameterCount(head: Pick<L2HeadSpec, "features" | "labels" | "hidden">): number {
  const [hiddenOne, hiddenTwo] = head.hidden;
  return (
    hiddenOne * head.features.length
    + hiddenOne
    + hiddenTwo * hiddenOne
    + hiddenTwo
    + head.labels.length * hiddenTwo
    + head.labels.length
  );
}

function validateHead(name: L2Head, rawHead: unknown): L2MlpHeadProfile {
  const head = assertObject(rawHead, `heads.${name}`);
  if (!Array.isArray(head.features) || head.features.length === 0) {
    throw contractError(`heads.${name}.features must be a non-empty array`, { head: name });
  }
  const features = head.features.map((entry, idx) =>
    assertString(entry, `heads.${name}.features[${idx}]`),
  );
  if (new Set(features).size !== features.length) {
    throw contractError(`heads.${name}.features contains duplicate feature names`, { head: name });
  }
  if (!Array.isArray(head.labels) || head.labels.length === 0) {
    throw contractError(`heads.${name}.labels must be a non-empty array`, { head: name });
  }
  const labels = head.labels.map((entry, idx) =>
    assertString(entry, `heads.${name}.labels[${idx}]`),
  );
  if (new Set(labels).size !== labels.length) {
    throw contractError(`heads.${name}.labels contains duplicate label names`, { head: name });
  }
  if (!Array.isArray(head.hidden) || head.hidden.length !== 2) {
    throw contractError(`heads.${name}.hidden must contain two dimensions`, { head: name });
  }
  const h0 = assertFinite(head.hidden[0], `heads.${name}.hidden[0]`);
  const h1 = assertFinite(head.hidden[1], `heads.${name}.hidden[1]`);
  if (!Number.isInteger(h0) || h0 <= 0 || !Number.isInteger(h1) || h1 <= 0) {
    throw contractError(`heads.${name}.hidden must contain positive integers`, { head: name });
  }
  const spec: L2HeadSpec = {
    features,
    labels,
    hidden: [h0, h1],
  };
  const expected = expectedHeadParameterCount(spec);
  const parameters = assertFiniteArray(head.parameters, `heads.${name}.parameters`, expected);
  return { spec, parameters };
}

function validateStageShape(pkg: Record<string, unknown>): readonly [
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
] {
  if (!Array.isArray(pkg.stages) || pkg.stages.length !== 3) {
    throw contractError("package must contain exactly three stages", {
      actual: Array.isArray(pkg.stages) ? pkg.stages.length : null,
    });
  }
  const expected = [
    ["handwired", "pre", false],
    ["mlp", "core", true],
    ["handwired", "post", false],
  ] as const;
  const stages: Record<string, unknown>[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const stage = assertObject(pkg.stages[index], `stages[${index}]`);
    const [kind, name, trainable] = expected[index]!;
    if (stage.kind !== kind || stage.name !== name) {
      throw contractError(`stage ${index} must be ${kind}/${name}`, {
        index,
        actualKind: stage.kind,
        actualName: stage.name,
      });
    }
    if (stage.trainable !== trainable) {
      throw contractError(`stage ${index} (${name}) trainable must be ${trainable}`, {
        index,
        actualTrainable: stage.trainable,
      });
    }
    stages.push(stage);
  }
  return [stages[0]!, stages[1]!, stages[2]!];
}

function operationMap(stage: Record<string, unknown>, stageName: string): Map<string, Record<string, unknown>> {
  if (!Array.isArray(stage.operations) || stage.operations.length === 0) {
    throw contractError(`stage ${stageName} must declare operations`, { stage: stageName });
  }
  const map = new Map<string, Record<string, unknown>>();
  for (const [index, rawOp] of stage.operations.entries()) {
    const operation = assertObject(rawOp, `stage ${stageName} operation ${index}`);
    const id = assertString(operation.id, `stage ${stageName} operation id`);
    if (map.has(id)) {
      throw contractError(`stage ${stageName} has duplicate operation id ${id}`, {
        stage: stageName,
        id,
      });
    }
    map.set(id, operation);
  }
  return map;
}

function resolveWire(
  stageName: string,
  wires: ReadonlyMap<string, HandwiredWire>,
  id: string,
  context: string,
): HandwiredWire {
  const value = wires.get(id);
  if (value === undefined) {
    throw contractError(`stage ${stageName} has disconnected wire ${id}`, {
      stage: stageName,
      wire: id,
      context,
    });
  }
  return value;
}

function readSourceNames(stage: Record<string, unknown>, stageName: string): string[] {
  if (!Array.isArray(stage.sourceNames) || stage.sourceNames.length === 0) {
    throw contractError(`stage ${stageName} must declare sourceNames`, { stage: stageName });
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const rawName of stage.sourceNames) {
    const name = assertString(rawName, `stage ${stageName} sourceName`);
    if (seen.has(name)) {
      throw contractError(`stage ${stageName} has duplicate source ${name}`, {
        stage: stageName,
        source: name,
      });
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function validateOutputNames(
  stage: Record<string, unknown>,
  stageName: string,
  operationIds: ReadonlySet<string>,
  required: readonly string[],
): Record<string, string> {
  const outputs = assertObject(stage.outputNames, `stage ${stageName}.outputNames`);
  const result: Record<string, string> = {};
  for (const name of required) {
    const id = assertString(outputs[name], `stage ${stageName}.outputNames.${name}`);
    if (!operationIds.has(id)) {
      throw contractError(`stage ${stageName} output ${name} references missing wire ${id}`, {
        stage: stageName,
        output: name,
        wire: id,
      });
    }
    result[name] = id;
  }
  return result;
}

function buildHandwiredStage(
  CircuitCtor: new (sourceSize: number) => HandwiredCircuit,
  stage: Record<string, unknown>,
) {
  const stageName = assertString(stage.name, "stage.name");
  const sourceNames = readSourceNames(stage, stageName);
  const sourceIndex = new Map<string, number>(sourceNames.map((name, index) => [name, index]));
  const operations = operationMap(stage, stageName);
  const wires = new Map<string, HandwiredWire>();
  const circuit = new CircuitCtor(sourceNames.length) as SelectableCircuit;
  if (typeof circuit.select !== "function") {
    throw contractError("Handwired Circuit instance does not provide select(gate, off, on)");
  }

  for (const [name, index] of sourceIndex) {
    wires.set(`source:${name}`, circuit.source(index));
  }

  for (const [id, operation] of operations) {
    if (operation.op === "source") {
      const source = assertString(operation.source, `operation ${id}.source`);
      const index = sourceIndex.get(source);
      if (index === undefined) {
        throw contractError(`stage ${stageName} source operation ${id} references unknown source ${source}`, {
          stage: stageName,
          id,
          source,
        });
      }
      wires.set(id, circuit.source(index));
      continue;
    }
    if (operation.op === "constant") {
      wires.set(id, circuit.constant(assertFinite(operation.value, `operation ${id}.value`)));
      continue;
    }
    if (operation.op === "affine") {
      if (!Array.isArray(operation.terms)) {
        throw contractError(`operation ${id}.terms must be an array`, { stage: stageName, id });
      }
      const terms = operation.terms.map((rawTerm, index) => {
        const term = assertObject(rawTerm, `operation ${id}.terms[${index}]`);
        const ref = assertString(term.ref, `operation ${id}.terms[${index}].ref`);
        return [
          resolveWire(stageName, wires, ref, `operation ${id}`),
          assertFinite(term.coefficient, `operation ${id}.terms[${index}].coefficient`),
        ] as const;
      });
      wires.set(id, circuit.affine(terms, assertFinite(operation.bias ?? 0, `operation ${id}.bias`)));
      continue;
    }
    if (operation.op === "multiply") {
      const left = resolveWire(stageName, wires, assertString(operation.left, `operation ${id}.left`), `operation ${id}`);
      const right = resolveWire(stageName, wires, assertString(operation.right, `operation ${id}.right`), `operation ${id}`);
      wires.set(id, circuit.multiply(left, right));
      continue;
    }
    if (operation.op === "select") {
      const gate = resolveWire(stageName, wires, assertString(operation.gate, `operation ${id}.gate`), `operation ${id}`);
      const off = resolveWire(stageName, wires, assertString(operation.off, `operation ${id}.off`), `operation ${id}`);
      const on = resolveWire(stageName, wires, assertString(operation.on, `operation ${id}.on`), `operation ${id}`);
      wires.set(id, circuit.select(gate, off, on));
      continue;
    }
    throw contractError(`stage ${stageName} operation ${id} has unsupported op ${String(operation.op)}`, {
      stage: stageName,
      id,
      op: operation.op,
    });
  }

  const requiredOutputs =
    stageName === "pre"
      ? ["readGate", "literalGate", ...Array.from({ length: 19 }, (_, index) => `feature${index}`)]
      : ["final0", "final1", "final2"];
  const outputNames = validateOutputNames(stage, stageName, new Set(operations.keys()), requiredOutputs);
  const outputs = new Map<string, HandwiredWire>();
  for (const [name, id] of Object.entries(outputNames)) {
    outputs.set(name, resolveWire(stageName, wires, id, "output"));
  }
  return {
    circuit,
    sourceNames,
    sourceIndex,
    outputs,
  };
}

export function familyForGoalKind(kind: string): HybridGoalFamily {
  if ((READ_GOAL_KINDS as readonly string[]).includes(kind)) return "read";
  if ((LITERAL_GOAL_KINDS as readonly string[]).includes(kind)) return "literal";
  throw contractError("unsupported typed goal kind", { kind });
}

export function validateCliHybridPackage(rawValue: unknown): {
  readonly pkg: CliHybridPackageV1;
  readonly profile: L2MlpProfile;
} {
  const pkg = assertObject(rawValue, "package");
  if (pkg.schema !== CLI_HYBRID_PACKAGE_SCHEMA) {
    throw contractError("unsupported hybrid package schema", { schema: pkg.schema });
  }
  const rawHeads = assertObject(pkg.heads, "heads");
  const heads = {} as Record<L2Head, L2MlpHeadProfile>;
  for (const name of L2_HEADS) {
    heads[name] = validateHead(name, rawHeads[name]);
  }
  if (heads.E.spec.features.length !== 19) {
    throw contractError("E head must contain 19 features", {
      actual: heads.E.spec.features.length,
    });
  }
  if (heads.E.spec.features.some((name, index) => name !== E19_FEATURES[index])) {
    throw contractError("E head feature order does not match the fixed G3 E19 profile");
  }
  if (
    heads.E.spec.labels.length !== 3
    || heads.E.spec.labels.some((label, index) => label !== E_LABELS[index])
  ) {
    throw contractError("E label order must be unsatisfied/satisfied/unknown");
  }

  const annotations = assertObject(pkg.annotations, "annotations");
  const familyMap = assertObject(
    annotations.goal_family_feature_map,
    "annotations.goal_family_feature_map",
  );
  const readKinds = familyMap.read_kinds;
  const literalKinds = familyMap.literal_kinds;
  if (!Array.isArray(readKinds) || !Array.isArray(literalKinds)) {
    throw contractError("goal family annotation must declare read and literal kinds");
  }
  for (const kind of READ_GOAL_KINDS) {
    if (!readKinds.includes(kind)) {
      throw contractError(`annotation is missing read kind ${kind}`, { kind });
    }
  }
  for (const kind of LITERAL_GOAL_KINDS) {
    if (!literalKinds.includes(kind)) {
      throw contractError(`annotation is missing literal kind ${kind}`, { kind });
    }
  }
  if (new Set([...readKinds, ...literalKinds]).size !== readKinds.length + literalKinds.length) {
    throw contractError("goal family annotation has conflicting kind membership");
  }
  const receiptMap = assertObject(
    annotations.receipt_feature_map,
    "annotations.receipt_feature_map",
  );
  const readReceiptIndex = assertFinite(
    receiptMap.read_receipt_index,
    "annotations.receipt_feature_map.read_receipt_index",
  );
  const literalReceiptIndex = assertFinite(
    receiptMap.literal_receipt_index,
    "annotations.receipt_feature_map.literal_receipt_index",
  );
  if (readReceiptIndex !== 3 || literalReceiptIndex !== 13) {
    throw contractError("receipt_feature_map must bind read_receipt_index=3 and literal_receipt_index=13", {
      readReceiptIndex,
      literalReceiptIndex,
    });
  }

  const fixed = assertObject(annotations.fixed_rule_scores, "annotations.fixed_rule_scores");
  assertFiniteArray(fixed.read_no_receipt, "annotations.fixed_rule_scores.read_no_receipt", 3);
  assertFiniteArray(fixed.literal_no_receipt, "annotations.fixed_rule_scores.literal_no_receipt", 3);

  const [ , mlpStage ] = validateStageShape(pkg);
  if (mlpStage.head !== "E") {
    throw contractError("MLP stage must declare head E");
  }
  if (
    !Array.isArray(mlpStage.featureSourcePassThrough)
    || mlpStage.featureSourcePassThrough.length !== 19
    || mlpStage.featureSourcePassThrough.some((name, idx) => name !== `feature${idx}`)
  ) {
    throw contractError("MLP stage must pass through feature0..feature18 in exact order");
  }
  if (
    !Array.isArray(mlpStage.rawOutputNames)
    || mlpStage.rawOutputNames.length !== 3
    || mlpStage.rawOutputNames.some((name, idx) => name !== `raw${idx}`)
  ) {
    throw contractError("MLP raw output names must be raw0/raw1/raw2");
  }

  const profile: L2MlpProfile = {
    schema: "nnanything.l2.mlp.v1",
    heads,
    calibration: "uncalibrated",
    adoption: "not_applied",
  };

  return {
    pkg: pkg as unknown as CliHybridPackageV1,
    profile,
  };
}

function argmaxLabel(values: readonly number[], labels: readonly string[]): string {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! > values[best]!) best = index;
  }
  return labels[best]!;
}

export async function createHybridPackageResource(
  rawPackage: unknown,
  handwiredRoot: string,
  packagePath: string | null = null,
): Promise<HybridPackageResource> {
  assertString(handwiredRoot, "handwired root");
  const { pkg, profile } = validateCliHybridPackage(rawPackage);
  const resolvedRoot = resolve(handwiredRoot);
  const handwired = await loadHandwired(resolvedRoot);
  if (typeof handwired.Circuit !== "function") {
    throw contractError("Handwired loader did not return a Circuit constructor");
  }

  const pre = buildHandwiredStage(handwired.Circuit, pkg.stages[0] as unknown as Record<string, unknown>);
  const mlpStage = pkg.stages[1];
  const post = buildHandwiredStage(handwired.Circuit, pkg.stages[2] as unknown as Record<string, unknown>);
  const fixedScores = pkg.annotations.fixed_rule_scores;

  const inferE = (request: HybridEInferRequest): HybridEInferResult => {
    const reqObj = assertObject(request, "request");
    const goalObj = assertObject(reqObj.goal, "request.goal");
    const kind = assertString(goalObj.kind, "request.goal.kind");
    const family = familyForGoalKind(kind);
    const features = assertFiniteArray(reqObj.features19, "request.features19", 19);
    const receiptFact = assertObject(reqObj.receiptFact, "request.receiptFact");
    if (typeof receiptFact.known !== "boolean") {
      throw contractError("request.receiptFact.known must be boolean");
    }
    if (receiptFact.present !== null && typeof receiptFact.present !== "boolean") {
      throw contractError("request.receiptFact.present must be boolean or null");
    }
    if (receiptFact.present === null && receiptFact.known !== false) {
      throw contractError("known receipt requires a boolean present value");
    }
    if (receiptFact.known === false && receiptFact.present !== null) {
      throw contractError("unknown receipt knownness requires present: null");
    }

    const receiptIndex =
      family === "read"
        ? pkg.annotations.receipt_feature_map.read_receipt_index
        : pkg.annotations.receipt_feature_map.literal_receipt_index;
    if (receiptFact.known) {
      const expectedPresent = receiptFact.present ? 1 : 0;
      if (features[receiptIndex] !== expectedPresent) {
        throw contractError("receipt fact conflicts with receipt-presence feature", {
          family,
          index: receiptIndex,
          expectedPresent,
          featureValue: features[receiptIndex],
        });
      }
    }

    const familySource =
      family === "read"
        ? { readFamily: 1, literalFamily: 0 }
        : { readFamily: 0, literalFamily: 1 };
    const receiptPresent = receiptFact.known && receiptFact.present ? 1 : 0;
    const receiptKnown = receiptFact.known ? 1 : 0;

    const preSource = new Float32Array(pre.sourceNames.length);
    const preValues: Record<string, number> = {
      ...familySource,
      receiptKnown,
      receiptPresent,
    };
    for (let index = 0; index < 19; index += 1) {
      preValues[`feature${index}`] = features[index]!;
    }
    for (const [name, index] of pre.sourceIndex) {
      preSource[index] = preValues[name]!;
    }
    const preValuesAll = pre.circuit.evaluateReference(preSource);
    const preOutput: Record<string, number> = {};
    for (const [name, wire] of pre.outputs) {
      preOutput[name] = preValuesAll[wire]!;
    }
    const readGate = assertFinite(preOutput.readGate, "pre.readGate");
    const literalGate = assertFinite(preOutput.literalGate, "pre.literalGate");
    if (!(readGate === 0 || readGate === 1)) {
      throw contractError("readGate must be 0 or 1", { value: readGate });
    }
    if (!(literalGate === 0 || literalGate === 1)) {
      throw contractError("literalGate must be 0 or 1", { value: literalGate });
    }
    if (readGate === 1 && literalGate === 1) {
      throw contractError("read and literal gates cannot both be active");
    }
    if (readGate === 1 && family !== "read") {
      throw contractError("read gate conflicts with typed goal family");
    }
    if (literalGate === 1 && family !== "literal") {
      throw contractError("literal gate conflicts with typed goal family");
    }

    const mlpFeatures = mlpStage.featureSourcePassThrough.map(name => preOutput[name]!);
    assertFiniteArray(mlpFeatures, "pass-through features", 19);
    const raw = inferHead(profile, mlpStage.head, mlpFeatures);
    const rawLogits = assertFiniteArray(raw.logits, "raw MLP output", 3);

    const postSource = new Float32Array(post.sourceNames.length);
    const postValues: Record<string, number> = {
      raw0: rawLogits[0]!,
      raw1: rawLogits[1]!,
      raw2: rawLogits[2]!,
      readGate,
      literalGate,
    };
    for (const [name, index] of post.sourceIndex) {
      postSource[index] = postValues[name]!;
    }
    const postEvaluated = post.circuit.evaluateReference(postSource);
    const finalLogits = [0, 1, 2].map(index => postEvaluated[post.outputs.get(`final${index}`)!]!);
    assertFiniteArray(finalLogits, "final logits", 3);

    const declaredRead = fixedScores.read_no_receipt;
    const declaredLiteral = fixedScores.literal_no_receipt;
    if (readGate === 1 && finalLogits.some((value, index) => value !== Math.fround(declaredRead[index]!))) {
      throw contractError("read gate output does not match declared fixed scores", {
        finalLogits,
        declared: declaredRead,
      });
    }
    if (literalGate === 1 && finalLogits.some((value, index) => value !== Math.fround(declaredLiteral[index]!))) {
      throw contractError("literal gate output does not match declared fixed scores", {
        finalLogits,
        declared: declaredLiteral,
      });
    }
    if (
      readGate === 0
      && literalGate === 0
      && finalLogits.some((value, index) => value !== rawLogits[index]!)
    ) {
      throw contractError("ungated output does not numerically equal raw MLP logits", {
        rawLogits,
        finalLogits,
      });
    }

    return {
      label: argmaxLabel(finalLogits, E_LABELS),
      logits: finalLogits,
      rawLabel: raw.label,
      rawLogits,
      readGate,
      literalGate,
      family,
      kind,
      fixed: readGate > 0 || literalGate > 0,
    };
  };

  return {
    packagePath: packagePath !== null ? resolve(packagePath) : null,
    handwiredRoot: resolvedRoot,
    package: pkg,
    profile,
    inferE,
    inferHead: (head: L2Head, features: readonly number[]) => inferHead(profile, head, features),
    contributions: {
      preOperations: pre.circuit.operations.length,
      postOperations: post.circuit.operations.length,
    },
  };
}

export async function loadHybridPackageFromFile(
  packagePath: string,
  handwiredRoot: string,
): Promise<HybridPackageResource> {
  assertString(packagePath, "package path");
  const resolvedPath = resolve(packagePath);
  const raw = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  return createHybridPackageResource(raw, handwiredRoot, resolvedPath);
}

/**
 * Return a new `CliHybridPackageV1` with only the specified trainable head's
 * parameters replaced. All other heads, annotations, and Handwired pre/post
 * stages remain bit-identical.
 */
export function withUpdatedHeadParameters(
  pkg: CliHybridPackageV1,
  head: L2Head,
  parameters: readonly number[],
): CliHybridPackageV1 {
  const targetHead = pkg.heads[head];
  const expected = expectedHeadParameterCount(targetHead);
  const validated = assertFiniteArray(parameters, `updated parameters for ${head}`, expected);
  const nextHeads = {} as Record<L2Head, CliHybridPackageHead>;
  for (const name of L2_HEADS) {
    const current = pkg.heads[name];
    nextHeads[name] = {
      features: [...current.features],
      labels: [...current.labels],
      hidden: [current.hidden[0], current.hidden[1]],
      parameters: name === head ? [...validated] : [...current.parameters],
    };
  }
  return {
    schema: CLI_HYBRID_PACKAGE_SCHEMA,
    heads: nextHeads,
    annotations: structuredClone(pkg.annotations),
    stages: structuredClone(pkg.stages),
  };
}

export async function saveHybridPackageAtomic(
  packagePath: string,
  pkg: CliHybridPackageV1,
): Promise<string> {
  validateCliHybridPackage(pkg);
  const resolved = resolve(packagePath);
  await mkdir(dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, resolved);
  return resolved;
}

/**
 * Construct a valid `CliHybridPackageV1` from an `L2MlpProfile` using the
 * standard pre/core/post stage declaration and fixed rule scores.
 */
export function buildDefaultCliHybridPackage(
  profile: L2MlpProfile,
  options: {
    readonly readNoReceiptScores?: readonly [number, number, number];
    readonly literalNoReceiptScores?: readonly [number, number, number];
    readonly sourceProvenance?: Readonly<Record<string, unknown>>;
  } = {},
): CliHybridPackageV1 {
  const readScores = options.readNoReceiptScores ?? [1, 0, 0];
  const literalScores = options.literalNoReceiptScores ?? [0, 0, 1];
  const heads = {} as Record<L2Head, CliHybridPackageHead>;
  for (const name of L2_HEADS) {
    const h = profile.heads[name];
    heads[name] = {
      features: [...h.spec.features],
      labels: [...h.spec.labels],
      hidden: [h.spec.hidden[0], h.spec.hidden[1]],
      parameters: [...h.parameters],
    };
  }
  const featureNames = Array.from({ length: 19 }, (_, idx) => `feature${idx}`);
  const preStage: HandwiredStageDeclaration = {
    kind: "handwired",
    trainable: false,
    name: "pre",
    sourceNames: ["readFamily", "literalFamily", "receiptKnown", "receiptPresent", ...featureNames],
    operations: [
      { id: "source_readFamily", op: "source", source: "readFamily" },
      { id: "source_literalFamily", op: "source", source: "literalFamily" },
      { id: "source_receiptKnown", op: "source", source: "receiptKnown" },
      { id: "source_receiptPresent", op: "source", source: "receiptPresent" },
      ...featureNames.map(name => ({
        id: `source_${name}`,
        op: "source" as const,
        source: name,
      })),
      { id: "one", op: "constant", value: 1 },
      {
        id: "presentComplement",
        op: "affine",
        terms: [{ ref: "source_receiptPresent", coefficient: -1 }],
        bias: 1,
      },
      { id: "readKnown", op: "multiply", left: "source_readFamily", right: "source_receiptKnown" },
      { id: "readGate", op: "multiply", left: "readKnown", right: "presentComplement" },
      { id: "literalKnown", op: "multiply", left: "source_literalFamily", right: "source_receiptKnown" },
      { id: "literalGate", op: "multiply", left: "literalKnown", right: "presentComplement" },
    ],
    outputNames: {
      readGate: "readGate",
      literalGate: "literalGate",
      ...Object.fromEntries(featureNames.map(name => [name, `source_${name}`])),
    },
  };
  const coreStage: MlpStageDeclaration = {
    kind: "mlp",
    trainable: true,
    name: "core",
    head: "E",
    featureSourcePassThrough: featureNames,
    rawOutputNames: ["raw0", "raw1", "raw2"],
  };
  const postStage: HandwiredStageDeclaration = {
    kind: "handwired",
    trainable: false,
    name: "post",
    sourceNames: ["raw0", "raw1", "raw2", "readGate", "literalGate"],
    operations: [
      { id: "source_raw0", op: "source", source: "raw0" },
      { id: "source_raw1", op: "source", source: "raw1" },
      { id: "source_raw2", op: "source", source: "raw2" },
      { id: "source_readGate", op: "source", source: "readGate" },
      { id: "source_literalGate", op: "source", source: "literalGate" },
      { id: "readNoReceipt0", op: "constant", value: readScores[0] },
      { id: "readNoReceipt1", op: "constant", value: readScores[1] },
      { id: "readNoReceipt2", op: "constant", value: readScores[2] },
      { id: "literalNoReceipt0", op: "constant", value: literalScores[0] },
      { id: "literalNoReceipt1", op: "constant", value: literalScores[1] },
      { id: "literalNoReceipt2", op: "constant", value: literalScores[2] },
      { id: "readSelected0", op: "select", gate: "source_readGate", off: "source_raw0", on: "readNoReceipt0" },
      { id: "readSelected1", op: "select", gate: "source_readGate", off: "source_raw1", on: "readNoReceipt1" },
      { id: "readSelected2", op: "select", gate: "source_readGate", off: "source_raw2", on: "readNoReceipt2" },
      { id: "final0", op: "select", gate: "source_literalGate", off: "readSelected0", on: "literalNoReceipt0" },
      { id: "final1", op: "select", gate: "source_literalGate", off: "readSelected1", on: "literalNoReceipt1" },
      { id: "final2", op: "select", gate: "source_literalGate", off: "readSelected2", on: "literalNoReceipt2" },
    ],
    outputNames: {
      final0: "final0",
      final1: "final1",
      final2: "final2",
    },
  };
  const pkg: CliHybridPackageV1 = {
    schema: CLI_HYBRID_PACKAGE_SCHEMA,
    heads,
    annotations: {
      goal_family_feature_map: {
        read_kinds: [...READ_GOAL_KINDS],
        literal_kinds: [...LITERAL_GOAL_KINDS],
        read_family_index: 0,
        literal_family_index: 1,
      },
      receipt_feature_map: {
        read_receipt_index: 3,
        literal_receipt_index: 13,
      },
      fixed_rule_scores: {
        read_no_receipt: [readScores[0], readScores[1], readScores[2]],
        literal_no_receipt: [literalScores[0], literalScores[1], literalScores[2]],
      },
      e19_label_order: [...E_LABELS],
      ...(options.sourceProvenance !== undefined ? { source_provenance: options.sourceProvenance } : {}),
      note: "Runtime reads only this package. Source provenance is descriptive.",
    },
    stages: [preStage, coreStage, postStage],
  };
  validateCliHybridPackage(pkg);
  return pkg;
}
