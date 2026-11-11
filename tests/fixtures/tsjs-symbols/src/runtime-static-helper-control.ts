const controlledActionMap: Record<"left" | "right", (value: number) => number> = {
  left: value => value + 2,
  right: value => value * 5,
};
export function chooseControlledAction(key: "left" | "right") {
  if (key === "left") {
    return controlledActionMap.left;
  }
  return controlledActionMap.right;
}
