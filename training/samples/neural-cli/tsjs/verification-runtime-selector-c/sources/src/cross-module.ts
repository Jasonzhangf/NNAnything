import { toCelsius } from "./other-units";

export function normalise(valueDegrees: number): number {
  return toCelsius(valueDegrees);
}
