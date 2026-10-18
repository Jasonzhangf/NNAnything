export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type RuleAttributeValue = string | number | boolean | null;
export type ForegroundState = "visible" | "occluded" | "unassessed";

export interface ObservationNode {
  readonly nodeRef: string;
  readonly parentRef: string | null;
  readonly tag: string | null;
  readonly role: string | null;
  readonly rect: Rect | null;
  readonly fragments: readonly Rect[] | null;
  readonly clippedRect: Rect | null;
  readonly foreground?: ForegroundState;
  readonly exposedRects?: readonly Rect[] | null;
  readonly attributes: Readonly<Record<string, RuleAttributeValue>>;
}

export type CoverageState = "assessed" | "unassessed" | "mixed";

export interface ObservationCoverage {
  readonly geometry: CoverageState;
  readonly fragments: CoverageState;
  readonly clipping: CoverageState;
  readonly foreground?: CoverageState;
}

export interface PageObservation {
  readonly viewport: Rect;
  readonly nodes: readonly ObservationNode[];
  readonly coverage: ObservationCoverage;
}

export class ObservationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationContractError";
  }
}

const SAFE_ATTRIBUTE_NAMES = new Set([
  "aria-disabled",
  "aria-expanded",
  "aria-hidden",
  "aria-selected",
  "contenteditable",
  "disabled",
  "hidden",
  "tabindex",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ObservationContractError(`${field} must be a finite number`);
  }
  return value;
}

function readRect(value: unknown, field: string): Rect {
  if (!isRecord(value)) {
    throw new ObservationContractError(`${field} must be an object`);
  }
  return {
    x: value.x === undefined ? 0 : readFiniteNumber(value.x, `${field}.x`),
    y: value.y === undefined ? 0 : readFiniteNumber(value.y, `${field}.y`),
    width: readFiniteNumber(value.width, `${field}.width`),
    height: readFiniteNumber(value.height, `${field}.height`),
  };
}

function readOptionalRect(value: unknown, field: string): Rect | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (isRecord(value) && ["x", "y", "width", "height"].some(key => value[key] === undefined || value[key] === null)) {
    return null;
  }
  return readRect(value, field);
}

function readFragments(value: unknown, field: string): readonly Rect[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new ObservationContractError(`${field} must be an array`);
  }
  const fragments = value.map((item, index) => readOptionalRect(item, `${field}[${index}]`));
  return fragments.some(fragment => fragment === null) ? null : fragments as Rect[];
}

function readSafeAttributes(
  value: unknown,
  field: string,
): Readonly<Record<string, RuleAttributeValue>> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new ObservationContractError(`${field} must be an object`);
  }
  const attributes: Record<string, RuleAttributeValue> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!SAFE_ATTRIBUTE_NAMES.has(name)) {
      continue;
    }
    if (
      raw !== null &&
      typeof raw !== "string" &&
      typeof raw !== "number" &&
      typeof raw !== "boolean"
    ) {
      throw new ObservationContractError(`${field}.${name} must be a primitive`);
    }
    attributes[name] = raw;
  }
  return attributes;
}

function readNodeRef(value: unknown, fallbackIndex: number, field: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (value === undefined) {
    return String(fallbackIndex);
  }
  throw new ObservationContractError(`${field} must be a string or finite number`);
}

function readOptionalRef(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  throw new ObservationContractError(`${field} must be a string, finite number, or null`);
}

function readOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ObservationContractError(`${field} must be a string or null`);
  }
  return value;
}

function readForeground(value: unknown, field: string): ForegroundState | undefined {
  if (value === undefined) return undefined;
  if (value === "visible" || value === "occluded" || value === "unassessed") return value;
  throw new ObservationContractError(`${field} must be visible, occluded, unassessed, or undefined`);
}

function combineCoverage(assessed: number, total: number): CoverageState {
  if (total === 0 || assessed === 0) {
    return "unassessed";
  }
  return assessed === total ? "assessed" : "mixed";
}

export function loadSavedObservation(value: unknown): PageObservation {
  if (!isRecord(value)) {
    throw new ObservationContractError("observation must be an object");
  }
  if (!isRecord(value.viewport)) {
    throw new ObservationContractError("observation.viewport must be an object");
  }
  const viewport = readRect(value.viewport, "observation.viewport");
  if (viewport.width <= 0 || viewport.height <= 0) {
    throw new ObservationContractError(
      "observation.viewport must have positive width and height",
    );
  }
  if (!Array.isArray(value.nodes)) {
    throw new ObservationContractError("observation.nodes must be an array");
  }

  const indexed = value.nodes.map((raw, position) => {
    if (!isRecord(raw)) {
      throw new ObservationContractError(`observation.nodes[${position}] must be an object`);
    }
    const index =
      raw.index === undefined
        ? undefined
        : readFiniteNumber(raw.index, `observation.nodes[${position}].index`);
    return { raw, position, index };
  });

  const canSortByIndex =
    indexed.length > 0 &&
    indexed.every((entry) => entry.index !== undefined) &&
    new Set(indexed.map((entry) => entry.index)).size === indexed.length;
  if (canSortByIndex) {
    indexed.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  }

  const indexRefs = new Map<number, string>();
  const records: Array<{
    readonly nodeRef: string;
    readonly parentRef: string | null;
    readonly tag: string | null;
    readonly role: string | null;
    readonly rect: Rect | null;
    readonly fragments: readonly Rect[] | null;
    readonly clippedRect: Rect | null;
    readonly foreground?: ForegroundState;
    readonly exposedRects?: readonly Rect[] | null;
    readonly attributes: Readonly<Record<string, RuleAttributeValue>>;
  }> = [];

  indexed.forEach((entry) => {
    const nodeRef = readNodeRef(
      entry.raw.nodeRef,
      entry.index ?? entry.position,
      `observation.nodes[${entry.position}].nodeRef`,
    );
    if (entry.index !== undefined) {
      indexRefs.set(entry.index, nodeRef);
    }
    const parentRef =
      entry.raw.parentRef !== undefined
        ? readOptionalRef(entry.raw.parentRef, `observation.nodes[${entry.position}].parentRef`)
        : entry.raw.parent === undefined
          ? null
          : typeof entry.raw.parent === "number" && indexRefs.has(entry.raw.parent)
            ? indexRefs.get(entry.raw.parent) ?? null
            : readOptionalRef(entry.raw.parent, `observation.nodes[${entry.position}].parent`);
    const fragmentsValue =
      entry.raw.fragments !== undefined ? entry.raw.fragments : entry.raw.clientRects;
    const clippedRectValue =
      entry.raw.clippedRect !== undefined ? entry.raw.clippedRect : entry.raw.visibleRect;
    const foreground = readForeground(entry.raw.foreground, `observation.nodes[${entry.position}].foreground`);
    const exposedRects = readFragments(entry.raw.exposedRects, `observation.nodes[${entry.position}].exposedRects`);
    records.push({
      nodeRef,
      parentRef,
      tag: readOptionalText(entry.raw.tag, `observation.nodes[${entry.position}].tag`),
      role: readOptionalText(entry.raw.role, `observation.nodes[${entry.position}].role`),
      rect: readOptionalRect(entry.raw.rect, `observation.nodes[${entry.position}].rect`),
      fragments: readFragments(
        fragmentsValue,
        `observation.nodes[${entry.position}].fragments`,
      ),
      clippedRect: readOptionalRect(
        clippedRectValue,
        `observation.nodes[${entry.position}].clippedRect`,
      ),
      ...(foreground === undefined ? {} : { foreground }),
      ...(entry.raw.exposedRects === undefined ? {} : { exposedRects }),
      attributes: readSafeAttributes(
        entry.raw.attributes,
        `observation.nodes[${entry.position}].attributes`,
      ),
    });
  });

  const nodeRefs = new Set<string>();
  for (const record of records) {
    if (nodeRefs.has(record.nodeRef)) {
      throw new ObservationContractError(`duplicate observation nodeRef ${record.nodeRef}`);
    }
    nodeRefs.add(record.nodeRef);
  }

  for (let index = 0; index < records.length; index += 1) {
    const current = records[index];
    if (current === undefined) {
      continue;
    }
    const rawParent = indexed[index]?.raw.parent;
    if (indexed[index]?.raw.parentRef === undefined && typeof rawParent === "number" && indexRefs.has(rawParent)) {
      records[index] = { ...current, parentRef: indexRefs.get(rawParent)! };
    }
    if (
      current.parentRef === null &&
      rawParent !== undefined &&
      rawParent !== null &&
      typeof rawParent === "number" &&
      !indexRefs.has(rawParent)
    ) {
      throw new ObservationContractError(
        `observation.nodes[${index}].parent references unknown index ${rawParent}`,
      );
    }
    if (records[index]!.parentRef !== null && !nodeRefs.has(records[index]!.parentRef!)) {
      throw new ObservationContractError(
        `observation.nodes[${index}].parentRef references unknown nodeRef ${current.parentRef}`,
      );
    }
  }

  const recordsByRef = new Map(records.map((record) => [record.nodeRef, record]));
  for (const record of records) {
    const seen = new Set([record.nodeRef]);
    let parentRef = record.parentRef;
    while (parentRef !== null) {
      if (seen.has(parentRef)) {
        throw new ObservationContractError(`observation parent cycle at ${record.nodeRef}`);
      }
      seen.add(parentRef);
      parentRef = recordsByRef.get(parentRef)?.parentRef ?? null;
    }
  }

  const geometryAssessed = records.filter((record) => record.rect !== null).length;
  const fragmentsAssessed = records.filter((record) => record.fragments !== null).length;
  const clippingAssessed = records.filter((record) => record.clippedRect !== null).length;
  const foregroundAssessed = records.filter((record) => record.foreground === "visible" || record.foreground === "occluded").length;
  const foregroundTotal = records.filter((record) => record.foreground !== undefined).length;

  return {
    viewport,
    nodes: records,
    coverage: {
      geometry: combineCoverage(geometryAssessed, records.length),
      fragments: combineCoverage(fragmentsAssessed, records.length),
      clipping: combineCoverage(clippingAssessed, records.length),
      ...(foregroundTotal === 0 ? {} : {
        foreground: foregroundAssessed === foregroundTotal ? "assessed" : foregroundAssessed === 0 ? "unassessed" : "mixed",
      }),
    },
  };
}

export function intersectsPositive(left: Rect, right: Rect): boolean {
  const leftEdge = Math.max(left.x, right.x);
  const topEdge = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  return rightEdge > leftEdge && bottomEdge > topEdge;
}

export function hasPositiveArea(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function isSafeRuleAttribute(name: string): boolean {
  return SAFE_ATTRIBUTE_NAMES.has(name);
}
