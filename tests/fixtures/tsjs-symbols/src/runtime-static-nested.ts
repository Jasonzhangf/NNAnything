import { chooseAction } from "./runtime-actions.js";
export function runStaticNested(flag: boolean, value: number) {
  if (flag) {
    const selected = "right";
    return chooseAction(selected)(value);
  }
  return value;
}
