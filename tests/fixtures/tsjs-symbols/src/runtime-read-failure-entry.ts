import { chooseMissing } from "./runtime-not-present.js";
export function runMissing(key: string, value: number) {
  return chooseMissing(key)(value);
}
