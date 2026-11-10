const leftThunk = () => 1;
const rightThunk = () => 2;
const missingMap = {
  left: leftThunk,
  right: rightThunk,
};
export function chooseMissing(key) {
  return missingMap[key];
}
