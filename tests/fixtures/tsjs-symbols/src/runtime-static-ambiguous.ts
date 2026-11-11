import { chooseAction } from "./runtime-actions.js";
import { chooseAction } from "./runtime-actions.js";
export function runStaticAmbiguous(value: number) {
  return chooseAction("right")(value);
}
