const methodMap = {
  left(value) { return value + 1; },
  right(value) { return value * 2; },
};
export function chooseMethod(key) {
  return methodMap[key];
}
