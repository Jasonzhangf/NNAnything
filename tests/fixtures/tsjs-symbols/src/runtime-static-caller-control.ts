import { chooseAction } from "./runtime-actions.js";
export function runStaticCallerControl(value: number) {
  if (value > 0) {
    return chooseAction("right")(value);
  }
  return value;
}
