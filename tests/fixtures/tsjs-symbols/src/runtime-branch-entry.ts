import { chooseBranch } from "./runtime-branch-actions.js";
export function runBranch(key: string, value: number) {
  return chooseBranch(key)(value);
}
