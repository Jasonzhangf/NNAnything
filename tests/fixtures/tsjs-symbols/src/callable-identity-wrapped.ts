const wrappedMap = {
  left: (((value) => value + 1) as (value: number) => number),
  right: ((value) => value * 3)!,
};
export function chooseWrapped(key) {
  return wrappedMap[key];
}
