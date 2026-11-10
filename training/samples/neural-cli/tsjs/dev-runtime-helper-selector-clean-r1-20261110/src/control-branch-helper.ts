// Unsupported-shape control: the helper returns through a branch instead of a
// single straight-line table[index] return. The accepted producer must emit no
// runtime-selector observation for this call site.

export type BranchKey = "left" | "right";

const branchTable = {
  left: (payload: string): string => `left:${payload}`,
  right: (payload: string): number => payload.length,
};

function pickBranch(selector: BranchKey) {
  if (selector === "left") {
    return branchTable.left;
  }
  return branchTable[selector];
}

export function runBranch(selector: BranchKey, payload: string): string | number {
  return pickBranch(selector)(payload);
}
