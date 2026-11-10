import { chooseWrapped } from "./callable-identity-wrapped.js";
export function runWrapped(key, value) {
  return chooseWrapped(key)(value);
}
