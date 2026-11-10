const oneMap = {
  left: (value: number) => value + 1,
};
export function chooseOne(key: string) {
  return oneMap[key];
}
