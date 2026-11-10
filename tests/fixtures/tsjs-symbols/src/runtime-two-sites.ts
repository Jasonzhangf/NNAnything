import { chooseAction } from "./runtime-actions.js";
export function runFirst(key: string, value: number) {
  return chooseAction(key)(value);
}
export function runSecond(key: string, value: number) {
  return chooseAction(key)(value + 1);
}
