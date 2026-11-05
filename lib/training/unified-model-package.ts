import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  UNIFIED_PARAMETER_COUNTS,
  type UnifiedTensors,
} from "./unified-forward.js";
import { UNIFIED_INPUT_SCHEMA, UNIFIED_ENCODER_VERSION } from "./unified-encoder.js";

export const UNIFIED_MODEL_PACKAGE_SCHEMA = "nnanything.unified.model-package.v1";
export const MODEL_NOT_FOUND = "MODEL_NOT_FOUND" as const;
export const MODEL_INCOMPATIBLE = "MODEL_INCOMPATIBLE" as const;

export type ModelRouteDecisionKind = "R" | "D" | "E" | "A";

export interface ModelRoute {
  readonly domain: string;
  readonly decisionKind: ModelRouteDecisionKind;
}

export interface UnifiedModelPackageResources {
  readonly thresholdsRef: string;
  readonly thresholdsSchema: string;
  readonly missingModeTableRef: string;
  readonly missingModeSchema: string;
}

export interface UnifiedModelPackage {
  readonly schema: typeof UNIFIED_MODEL_PACKAGE_SCHEMA;
  readonly modelId: string;
  readonly version: string;
  readonly route: ModelRoute;
  readonly inputSchema: typeof UNIFIED_INPUT_SCHEMA;
  readonly encoderVersion: typeof UNIFIED_ENCODER_VERSION;
  readonly architecture: {
    readonly input: 64;
    readonly hidden: readonly [64, 64];
    readonly output: 1;
    readonly activation: "relu";
  };
  readonly tensors: UnifiedTensors;
  readonly outputContract: {
    readonly kind: "scalar-score";
    readonly groupNormalization: "outside-model";
  };
  readonly resources: UnifiedModelPackageResources;
  readonly fixedStages: readonly string[];
}

export interface ResolvedPackageResources {
  readonly thresholdsPath: string;
  readonly missingModeTablePath: string;
}

export interface UnifiedModelPackageBinding {
  readonly packageRef: string;
  readonly modelId: string;
  readonly version: string;
  readonly route: ModelRoute;
  readonly tensors: UnifiedTensors;
  readonly resources: ResolvedPackageResources;
}

export interface UnifiedModelPackageResource {
  readonly packagePath: string;
  readonly package: UnifiedModelPackage;
  readonly resolvedResources: ResolvedPackageResources;
  bind(): UnifiedModelPackageBinding;
}

export class UnifiedModelPackageError extends Error {
  readonly code: typeof MODEL_NOT_FOUND | typeof MODEL_INCOMPATIBLE;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: typeof MODEL_NOT_FOUND | typeof MODEL_INCOMPATIBLE,
    message: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "UnifiedModelPackageError";
    this.code = code;
    this.detail = { ...detail, code };
  }
}

function incompatible(message: string, detail: Readonly<Record<string, unknown>> = {}): UnifiedModelPackageError {
  return new UnifiedModelPackageError(MODEL_INCOMPATIBLE, message, detail);
}

function notFound(message: string, detail: Readonly<Record<string, unknown>> = {}): UnifiedModelPackageError {
  return new UnifiedModelPackageError(MODEL_NOT_FOUND, message, detail);
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw incompatible(`${label} must be an object`, { label });
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw incompatible(`${label} must be a non-empty string`, { label });
  }
  return value;
}

function assertExactNumber(value: unknown, expected: number, label: string): void {
  if (value !== expected) {
    throw incompatible(`${label} must be ${expected}`, { label, expected, actual: value });
  }
}

function assertFiniteArray(value: unknown, label: string, expectedLength: number): number[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw incompatible(`${label} must have ${expectedLength} entries`, {
      label,
      expectedLength,
      actualLength: Array.isArray(value) ? value.length : null,
    });
  }
  return value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw incompatible(`${label}[${index}] must be finite`, { label });
    }
    return entry;
  });
}

function validateTensors(raw: unknown): UnifiedTensors {
  const tensors = assertObject(raw, "tensors");
  return {
    W1: assertFiniteArray(tensors.W1, "tensors.W1", UNIFIED_PARAMETER_COUNTS.W1),
    b1: assertFiniteArray(tensors.b1, "tensors.b1", UNIFIED_PARAMETER_COUNTS.b1),
    W2: assertFiniteArray(tensors.W2, "tensors.W2", UNIFIED_PARAMETER_COUNTS.W2),
    b2: assertFiniteArray(tensors.b2, "tensors.b2", UNIFIED_PARAMETER_COUNTS.b2),
    W3: assertFiniteArray(tensors.W3, "tensors.W3", UNIFIED_PARAMETER_COUNTS.W3),
    b3: assertFiniteArray(tensors.b3, "tensors.b3", UNIFIED_PARAMETER_COUNTS.b3),
  };
}

function validateArchitecture(raw: unknown): UnifiedModelPackage["architecture"] {
  const architecture = assertObject(raw, "architecture");
  assertExactNumber(architecture.input, 64, "architecture.input");
  assertExactNumber(architecture.output, 1, "architecture.output");
  if (architecture.activation !== "relu") {
    throw incompatible("architecture.activation must be relu", { actual: architecture.activation });
  }
  if (!Array.isArray(architecture.hidden) || architecture.hidden.length !== 2) {
    throw incompatible("architecture.hidden must have two entries", { actual: architecture.hidden });
  }
  assertExactNumber(architecture.hidden[0], 64, "architecture.hidden[0]");
  assertExactNumber(architecture.hidden[1], 64, "architecture.hidden[1]");
  return { input: 64, hidden: [64, 64], output: 1, activation: "relu" };
}

function validateRoute(raw: unknown): ModelRoute {
  const route = assertObject(raw, "route");
  const domain = assertString(route.domain, "route.domain");
  const decisionKind = route.decisionKind;
  if (decisionKind !== "R" && decisionKind !== "D" && decisionKind !== "E" && decisionKind !== "A") {
    throw incompatible("route.decisionKind must be one of R/D/E/A", { actual: decisionKind });
  }
  return { domain, decisionKind };
}

function validateOutputContract(raw: unknown): UnifiedModelPackage["outputContract"] {
  const contract = assertObject(raw, "outputContract");
  if (contract.kind !== "scalar-score") {
    throw incompatible("outputContract.kind must be scalar-score", { actual: contract.kind });
  }
  if (contract.groupNormalization !== "outside-model") {
    throw incompatible("outputContract.groupNormalization must be outside-model", {
      actual: contract.groupNormalization,
    });
  }
  return { kind: "scalar-score", groupNormalization: "outside-model" };
}

function validateResources(raw: unknown): UnifiedModelPackageResources {
  const resources = assertObject(raw, "resources");
  return {
    thresholdsRef: assertString(resources.thresholdsRef, "resources.thresholdsRef"),
    thresholdsSchema: assertString(resources.thresholdsSchema, "resources.thresholdsSchema"),
    missingModeTableRef: assertString(resources.missingModeTableRef, "resources.missingModeTableRef"),
    missingModeSchema: assertString(resources.missingModeSchema, "resources.missingModeSchema"),
  };
}

function validateFixedStages(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    throw incompatible("fixedStages must be an array", { actual: raw });
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "string") {
      throw incompatible(`fixedStages[${index}] must be a string`, { index });
    }
    return entry;
  });
}

export function validateUnifiedModelPackage(raw: unknown): UnifiedModelPackage {
  const pkg = assertObject(raw, "modelPackage");
  if (pkg.schema !== UNIFIED_MODEL_PACKAGE_SCHEMA) {
    throw incompatible("model package schema mismatch", {
      expected: UNIFIED_MODEL_PACKAGE_SCHEMA,
      actual: pkg.schema,
    });
  }
  if (pkg.inputSchema !== UNIFIED_INPUT_SCHEMA) {
    throw incompatible("model package inputSchema mismatch", {
      expected: UNIFIED_INPUT_SCHEMA,
      actual: pkg.inputSchema,
    });
  }
  if (pkg.encoderVersion !== UNIFIED_ENCODER_VERSION) {
    throw incompatible("model package encoderVersion mismatch", {
      expected: UNIFIED_ENCODER_VERSION,
      actual: pkg.encoderVersion,
    });
  }
  return {
    schema: UNIFIED_MODEL_PACKAGE_SCHEMA,
    modelId: assertString(pkg.modelId, "modelId"),
    version: assertString(pkg.version, "version"),
    route: validateRoute(pkg.route),
    inputSchema: UNIFIED_INPUT_SCHEMA,
    encoderVersion: UNIFIED_ENCODER_VERSION,
    architecture: validateArchitecture(pkg.architecture),
    tensors: validateTensors(pkg.tensors),
    outputContract: validateOutputContract(pkg.outputContract),
    resources: validateResources(pkg.resources),
    fixedStages: validateFixedStages(pkg.fixedStages),
  };
}

export function createUnifiedModelPackage(input: {
  readonly modelId: string;
  readonly version: string;
  readonly route: ModelRoute;
  readonly tensors: UnifiedTensors;
  readonly resources: UnifiedModelPackageResources;
  readonly fixedStages?: readonly string[];
}): UnifiedModelPackage {
  return validateUnifiedModelPackage({
    schema: UNIFIED_MODEL_PACKAGE_SCHEMA,
    modelId: input.modelId,
    version: input.version,
    route: input.route,
    inputSchema: UNIFIED_INPUT_SCHEMA,
    encoderVersion: UNIFIED_ENCODER_VERSION,
    architecture: { input: 64, hidden: [64, 64], output: 1, activation: "relu" },
    tensors: input.tensors,
    outputContract: { kind: "scalar-score", groupNormalization: "outside-model" },
    resources: input.resources,
    fixedStages: input.fixedStages ?? [],
  });
}

export async function saveUnifiedModelPackageAtomic(
  packagePath: string,
  pkg: UnifiedModelPackage,
): Promise<string> {
  const validated = validateUnifiedModelPackage(pkg);
  const resolved = resolve(packagePath);
  await mkdir(dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, resolved);
  return resolved;
}

function resolveResourcePath(packagePath: string, ref: string): string {
  return isAbsolute(ref) ? ref : resolve(dirname(packagePath), ref);
}

async function assertResourceExists(path: string, kind: "thresholds" | "missingModeTable"): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    throw notFound(`model package ${kind} resource is missing`, {
      resource: kind,
      path,
      cause: (error as NodeJS.ErrnoException).code ?? String(error),
    });
  }
}

export async function loadUnifiedModelPackageFromFile(
  packagePath: string,
  options: { readonly verifyResources?: boolean } = {},
): Promise<UnifiedModelPackageResource> {
  const resolvedPath = resolve(packagePath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  } catch (error) {
    const cause = (error as NodeJS.ErrnoException).code ?? String(error);
    throw notFound("model package file is missing or unreadable", { path: resolvedPath, cause });
  }
  const pkg = validateUnifiedModelPackage(raw);
  const resolvedResources: ResolvedPackageResources = {
    thresholdsPath: resolveResourcePath(resolvedPath, pkg.resources.thresholdsRef),
    missingModeTablePath: resolveResourcePath(resolvedPath, pkg.resources.missingModeTableRef),
  };
  if (options.verifyResources !== false) {
    await assertResourceExists(resolvedResources.thresholdsPath, "thresholds");
    await assertResourceExists(resolvedResources.missingModeTablePath, "missingModeTable");
  }
  const bind = (): UnifiedModelPackageBinding => Object.freeze({
    packageRef: resolvedPath,
    modelId: pkg.modelId,
    version: pkg.version,
    route: Object.freeze({ ...pkg.route }),
    tensors: deepFreezeTensors(pkg.tensors),
    resources: Object.freeze({ ...resolvedResources }),
  });
  return { packagePath: resolvedPath, package: pkg, resolvedResources, bind };
}

function deepFreezeTensors(tensors: UnifiedTensors): UnifiedTensors {
  const freeze = (values: readonly number[]): readonly number[] => Object.freeze([...values]);
  return Object.freeze({
    W1: freeze(tensors.W1),
    b1: freeze(tensors.b1),
    W2: freeze(tensors.W2),
    b2: freeze(tensors.b2),
    W3: freeze(tensors.W3),
    b3: freeze(tensors.b3),
  });
}
