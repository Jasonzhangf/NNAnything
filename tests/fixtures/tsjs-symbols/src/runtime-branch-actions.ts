const branchMap = {
  left: (value: number) => value + 1,
  right: (value: number) => value * 2,
};
export function chooseBranch(key: string) {
  if (key === "left") return branchMap.left;
  return branchMap[key];
}
