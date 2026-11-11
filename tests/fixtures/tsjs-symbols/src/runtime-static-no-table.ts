function outsideCandidate(value: string) {
  return value;
}
export function runOutsideCandidate(value: number) {
  return outsideCandidate("right")(value);
}
