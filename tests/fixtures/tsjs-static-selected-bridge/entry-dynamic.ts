import { chooseAction, type Choice } from "./helper.js";

export function run(which: Choice) {
  return chooseAction(which)();
}
