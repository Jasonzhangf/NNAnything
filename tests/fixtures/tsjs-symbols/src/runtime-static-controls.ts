import { chooseAction } from "./runtime-actions.js";
export function constantAction(value: number) {
  return chooseAction("left")(value);
}
export function directMemberAction(value: number) {
  return chooseAction.left(value);
}
