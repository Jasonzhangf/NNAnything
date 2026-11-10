type ArithmeticMode = "sum" | "gap";

const arithmeticModes = {
  sum: (left: number, right: number) => left + right,
  gap: (left: number, right: number) => left - right,
} satisfies Record<ArithmeticMode, (left: number, right: number) => number>;

export function evaluate(mode: ArithmeticMode, left: number, right: number): number {
  return arithmeticModes[mode](left, right);
}
