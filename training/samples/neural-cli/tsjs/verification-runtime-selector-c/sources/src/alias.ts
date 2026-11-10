import { toFahrenheit as toF } from "./units";

export function boilPoint(valueDegrees: number): number {
  return toF(valueDegrees);
}
