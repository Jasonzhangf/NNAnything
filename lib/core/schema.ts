export type JsonRecord = { readonly [key: string]: unknown };

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

export function expectArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

export function expectNonEmptyString(value: unknown, label: string): string {
  const text = expectString(value, label);
  if (text.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return text;
}

export function expectFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

export function expectStringArray(value: unknown, label: string): string[] {
  return expectArray(value, label).map((entry, index) =>
    expectNonEmptyString(entry, `${label}[${index}]`),
  );
}
