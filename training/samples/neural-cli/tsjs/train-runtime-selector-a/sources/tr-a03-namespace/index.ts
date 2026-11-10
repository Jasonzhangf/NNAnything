import * as measurements from "./measurements";

export function scaleEntry(value: number): number {
  return measurements.scale(value);
}
