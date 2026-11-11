export function runOutsideCandidate(value: number) {
  const localHelper = (key: string) => key;
  return localHelper("right")(value);
}
