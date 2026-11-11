import { chooseControlledAction } from "./runtime-static-helper-control.js";
export function runStaticHelperControl(value: number) {
  return chooseControlledAction("right")(value);
}
