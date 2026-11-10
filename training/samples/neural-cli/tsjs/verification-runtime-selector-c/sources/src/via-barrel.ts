import { toCelsius } from "./barrel";

export function viaBarrel(valueDegrees: number): number {
  return toCelsius(valueDegrees);
}
