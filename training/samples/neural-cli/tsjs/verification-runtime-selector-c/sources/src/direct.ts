import { toCelsius } from "./units";

export function freezePoint(valueDegrees: number): number {
  return toCelsius(valueDegrees);
}
