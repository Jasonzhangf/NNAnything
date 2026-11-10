import { chooseAction, type ActionKey } from "./runtime-actions.js";
export function runAction(key: ActionKey, value: number) {
  return chooseAction(key)(value);
}
