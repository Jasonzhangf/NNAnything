import { chooseAction } from "./runtime-actions.js";
export function shadowed(key: string, value: number) {
  const chooseAction = () => () => value;
  return chooseAction(key)(value);
}
