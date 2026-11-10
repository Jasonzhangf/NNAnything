export type ActionKey = "left" | "right";
const actionMap: Record<ActionKey, (value: number) => number> = {
  left: value => value + 2,
  right: value => value * 5,
};
export function chooseAction(key: ActionKey) {
  return actionMap[key];
}
