import { chooseAction } from "./runtime-actions.js";
chooseAction = replacement;
declare const replacement: typeof chooseAction;
export function runStaticMutated(value: number) {
  return chooseAction("right")(value);
}
