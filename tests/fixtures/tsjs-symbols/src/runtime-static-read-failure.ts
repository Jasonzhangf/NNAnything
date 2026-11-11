import { chooseAction } from "./runtime-not-present.js";
export function runStaticReadFailure(value: number) {
  return chooseAction("right")(value);
}
