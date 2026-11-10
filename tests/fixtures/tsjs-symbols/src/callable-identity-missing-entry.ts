import { chooseMissing } from "./callable-identity-missing.js";
export function runMissing(key, value) {
  return chooseMissing(key)(value);
}
