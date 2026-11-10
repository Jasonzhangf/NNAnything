import { chooseOne } from "./runtime-one-actions.js";
export function runOne(key: string, value: number) {
  return chooseOne(key)(value);
}
