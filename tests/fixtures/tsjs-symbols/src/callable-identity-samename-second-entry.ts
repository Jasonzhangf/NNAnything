import { chooseSecond } from "./callable-identity-samename.js";
export function runSecond(key, value) {
  return chooseSecond(key)(value);
}
