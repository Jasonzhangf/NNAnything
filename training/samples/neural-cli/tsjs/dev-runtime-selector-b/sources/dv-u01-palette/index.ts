type Swatch = "warm" | "cool";

const paletteOperations = {
  warm: (value: number) => value + 2,
  cool: (value: number) => value * 5,
} satisfies Record<Swatch, (value: number) => number>;

export function paintSwatch(swatch: Swatch, value: number): number {
  return paletteOperations[swatch](value);
}
