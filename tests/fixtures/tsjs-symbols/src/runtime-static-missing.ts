import { chooseAction } from "./runtime-actions.js";
export function runStaticMissing(value: number) {
  return chooseAction("middle")(value);
}
