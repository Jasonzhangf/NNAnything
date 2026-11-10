export type ValueFormat = "hex" | "fixed";

const valueFormatters = {
  hex: (value: number) => value.toString(16),
  fixed: (value: number) => value.toFixed(2),
} satisfies Record<ValueFormat, (value: number) => string>;

export function formatValue(kind: ValueFormat) {
  return valueFormatters[kind];
}
