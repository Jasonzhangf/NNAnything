const brokenMap = {
  left: (value: number) => value + 1,
  right: (value: number) => value * 2,
};
export function chooseBroken(key: string) {
  return brokenMap[key];
}
const broken = ;
