type Suffix = "unit" | "percent";

const suffixes = {
  unit: (value: string) => `${value}u`,
  percent: (value: string) => `${value}%`,
};

export function renderSuffix(kind: Suffix, value: string): string {
  return suffixes[kind](value);
}
