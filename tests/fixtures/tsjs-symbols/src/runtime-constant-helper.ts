const constantMap = {
  left: (value: number) => value + 1,
  right: (value: number) => value * 2,
};
const unrelatedMap = {
  left: (value: number) => value + 3,
  right: (value: number) => value * 4,
};
export function readUnrelated(key: string) {
  return unrelatedMap[key];
}
export function chooseConstant(_key: string) {
  return constantMap.left;
}
export function chooseWithConstantArgument(key: string, value: number) {
  return chooseConstant("left")(value);
}
