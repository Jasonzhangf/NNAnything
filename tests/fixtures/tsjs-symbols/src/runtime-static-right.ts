import { chooseAction } from "./runtime-actions.js";
export function runStaticRight(value: number) {
  return chooseAction("right")(value);
}
