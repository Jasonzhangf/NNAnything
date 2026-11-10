import { chooseAction } from "./runtime-actions.js";
export function narrowed(key: string, value: number) {
  key = "left";
  return chooseAction(key)(value);
}
export function reassigned(key: string, value: number) {
  let alias = key;
  alias = "right";
  return chooseAction(alias)(value);
}
