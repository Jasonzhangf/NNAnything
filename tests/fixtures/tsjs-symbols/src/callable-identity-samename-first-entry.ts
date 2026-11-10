import { chooseFirst } from "./callable-identity-samename.js";
export function runFirst(key, value) {
  return chooseFirst(key)(value);
}
