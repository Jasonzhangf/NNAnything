export type Choice = "left" | "right";

const actions = {
  left: () => "left-result",
  right: () => "right-result",
};

export function chooseAction(which: Choice) {
  return actions[which];
}
