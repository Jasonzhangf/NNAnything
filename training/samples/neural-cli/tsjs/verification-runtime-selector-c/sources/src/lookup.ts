import { toCelsius, toFahrenheit } from "./units";

const lookup = new Map<string, (valueDegrees: number) => number>([
  ["to_c", toCelsius],
  ["to_f", toFahrenheit],
]);

export function convertWithLookup(code: string, valueDegrees: number): number {
  const convert = lookup.get(code)!;
  return convert(valueDegrees);
}
