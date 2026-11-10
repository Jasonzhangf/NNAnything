import { toCelsius, toFahrenheit } from "./units";

export type Direction = "to_c" | "to_f";

export const unitTable: Record<Direction, (valueDegrees: number) => number> = {
  to_c: toCelsius,
  to_f: toFahrenheit,
};

export function convertWithTable(direction: Direction, valueDegrees: number): number {
  return unitTable[direction](valueDegrees);
}
