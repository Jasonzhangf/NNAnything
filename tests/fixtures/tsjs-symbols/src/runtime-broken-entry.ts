import { chooseBroken } from "./runtime-broken-actions.js";
export function runBroken(key: string, value: number) {
  return chooseBroken(key)(value);
}
