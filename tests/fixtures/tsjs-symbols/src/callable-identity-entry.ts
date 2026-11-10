import { chooseAction } from "./callable-identity-actions.js";
export function runAction(key, value) {
  return chooseAction(key)(value);
}
