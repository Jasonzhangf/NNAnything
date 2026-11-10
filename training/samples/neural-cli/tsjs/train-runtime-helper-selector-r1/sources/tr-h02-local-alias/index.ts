type ScaleMode = "double" | "triple";

const scaleOperations = {
  double: (value: number) => value * 2,
  triple: (value: number) => value * 3,
} satisfies Record<ScaleMode, (value: number) => number>;

function chooseScale(mode: ScaleMode) {
  return scaleOperations[mode];
}

export function scaleValue(mode: ScaleMode, amount: number): number {
  const selectedScale = mode;
  return chooseScale(selectedScale)(amount);
}
