import { chooseAction } from "./runtime-actions.js";
chooseAction = replacement;
declare const replacement: typeof chooseAction;
export function runImportedReplacement(key: string, value: number) {
  return chooseAction(key)(value);
}
