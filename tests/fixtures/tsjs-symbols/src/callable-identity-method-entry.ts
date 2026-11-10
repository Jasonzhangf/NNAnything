import { chooseMethod } from "./callable-identity-method.js";
export function runMethod(key, value) {
  return chooseMethod(key)(value);
}
