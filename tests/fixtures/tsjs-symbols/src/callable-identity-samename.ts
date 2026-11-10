const firstMap = {
  left: (value) => value + 1,
  right: (value) => value + 2,
};
export function chooseFirst(key) {
  return firstMap[key];
}
// spacer keeps the second table at a distinct span
const secondMap = {
  left: (value) => value + 3,
  right: (value) => value + 4,
};
export function chooseSecond(key) {
  return secondMap[key];
}
