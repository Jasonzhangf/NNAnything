const replacedMap = {
  left: (value: number) => value + 1,
  right: (value: number) => value * 2,
};
export function chooseReplaced(key: string) {
  return replacedMap[key];
}
chooseReplaced = replacement;
declare const replacement: typeof chooseReplaced;
export function runReplaced(key: string, value: number) {
  return chooseReplaced(key)(value);
}
