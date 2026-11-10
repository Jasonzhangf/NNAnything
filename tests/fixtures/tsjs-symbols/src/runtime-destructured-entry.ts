import { chooseAction } from "./runtime-actions.js";
export function destructuredSelector(key: string, value: number) {
  [key] = ["left"];
  return chooseAction(key)(value);
}
export function unrelatedDestructuredWrite(key: string, value: number, other: string) {
  [other] = ["right"];
  return chooseAction(key)(value);
}
