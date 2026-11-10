const actionMap = {
  left: (value) => value + 2,
  right: function (value) { return value * 5; },
};
export function chooseAction(key) {
  return actionMap[key];
}
