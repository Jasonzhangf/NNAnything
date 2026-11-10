import * as dateTools from "./dates";

export function stampEntry(value: number): string {
  return dateTools.formatDay(value);
}
