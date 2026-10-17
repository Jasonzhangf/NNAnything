import { isSafeRuleAttribute, type Rect } from "../adapters/browser/observation.js";

export type ScopeMode = "owned" | "subtree";

export interface NodeCondition {
  readonly nodeRef?: string;
  readonly tag?: string;
  readonly role?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface FocusSpec {
  readonly viewportOnly: true;
  readonly within?: string;
  readonly scopeMode?: ScopeMode;
  readonly region?: Rect;
  readonly allow?: readonly NodeCondition[];
  readonly deny?: readonly NodeCondition[];
  readonly excludeSubtrees?: readonly NodeCondition[];
}

export class FocusSpecContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FocusSpecContractError";
  }
}

const CONDITION_FIELDS = new Set(["nodeRef", "tag", "role", "attributes"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FocusSpecContractError("focus spec must be an object");
  }
  return value as Record<string, unknown>;
}

function readConditions(value: unknown, field: string): readonly NodeCondition[] {
  if (!Array.isArray(value)) {
    throw new FocusSpecContractError(`${field} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new FocusSpecContractError(`${field}[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) {
      throw new FocusSpecContractError(`empty condition in ${field}[${index}]`);
    }
    for (const key of keys) {
      if (!CONDITION_FIELDS.has(key)) {
        throw new FocusSpecContractError(`unsupported condition field ${key}`);
      }
    }
    if (record.nodeRef !== undefined && typeof record.nodeRef !== "string") {
      throw new FocusSpecContractError(`${field}[${index}].nodeRef must be a string`);
    }
    if (record.tag !== undefined && typeof record.tag !== "string") {
      throw new FocusSpecContractError(`${field}[${index}].tag must be a string`);
    }
    if (record.role !== undefined && typeof record.role !== "string") {
      throw new FocusSpecContractError(`${field}[${index}].role must be a string`);
    }
    if (record.attributes !== undefined) {
      const attributes = record.attributes;
      if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
        throw new FocusSpecContractError(`${field}[${index}].attributes must be an object`);
      }
      if (Object.keys(attributes).length === 0) throw new FocusSpecContractError(`empty attributes in ${field}[${index}]`);
      for (const [name, state] of Object.entries(attributes)) {
        if (!isSafeRuleAttribute(name)) {
          throw new FocusSpecContractError(`unsafe attribute ${name}`);
        }
        if (typeof state === "number" && !Number.isFinite(state)) throw new FocusSpecContractError(`attribute ${name} must be finite`);
        if (
          state !== null &&
          typeof state !== "string" &&
          typeof state !== "number" &&
          typeof state !== "boolean"
        ) {
          throw new FocusSpecContractError(`${field}[${index}].attributes.${name} must be a primitive`);
        }
      }
    }
    return entry as NodeCondition;
  });
}

function readRegion(value: unknown): Rect {
  const record = asRecord(value);
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "height,width,x,y") {
    throw new FocusSpecContractError("region must contain only x, y, width, and height");
  }
  for (const key of keys) {
    const numeric = record[key];
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
      throw new FocusSpecContractError(`region.${key} must be a finite number`);
    }
  }
  if (Number(record.width) <= 0 || Number(record.height) <= 0) {
    throw new FocusSpecContractError("region must have positive area");
  }
  return { x: Number(record.x), y: Number(record.y), width: Number(record.width), height: Number(record.height) };
}

export function createFocusSpec(value?: unknown): FocusSpec {
  if (value === undefined || value === null) {
    return { viewportOnly: true };
  }
  const record = asRecord(value);
  for (const key of Object.keys(record)) {
    if (!["viewportOnly", "within", "scopeMode", "region", "allow", "deny", "excludeSubtrees"].includes(key)) {
      throw new FocusSpecContractError(`unsupported focus field ${key}`);
    }
  }
  if (record.viewportOnly !== undefined && record.viewportOnly !== true) {
    throw new FocusSpecContractError("viewportOnly must be true");
  }
  if (record.within !== undefined && typeof record.within !== "string") {
    throw new FocusSpecContractError("within must be a string");
  }
  if (
    record.scopeMode !== undefined &&
    record.scopeMode !== "owned" &&
    record.scopeMode !== "subtree"
  ) {
    throw new FocusSpecContractError("scopeMode must be owned or subtree");
  }
  return {
    viewportOnly: true,
    ...(record.within === undefined ? {} : { within: record.within as string }),
    ...(record.scopeMode === undefined ? {} : { scopeMode: record.scopeMode as ScopeMode }),
    ...(record.region === undefined ? {} : { region: readRegion(record.region) }),
    ...(record.allow === undefined ? {} : { allow: readConditions(record.allow, "allow") }),
    ...(record.deny === undefined ? {} : { deny: readConditions(record.deny, "deny") }),
    ...(record.excludeSubtrees === undefined
      ? {}
      : { excludeSubtrees: readConditions(record.excludeSubtrees, "excludeSubtrees") }),
  };
}

