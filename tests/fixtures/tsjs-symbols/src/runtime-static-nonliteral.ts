import { chooseAction } from "./runtime-actions.js";
export function runStaticNonLiteral(key: string, value: number) {
  return chooseAction(`${key}`)(value);
}
