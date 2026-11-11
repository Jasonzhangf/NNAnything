import { chooseAction } from "./runtime-actions.js";
export function runStaticConstAlias(value: number) {
  const selected = "right";
  return chooseAction(selected)(value);
}
