declare function outsideCandidate(value: string): (value: number) => number;
export function runOutsideCandidate(value: number) {
  return outsideCandidate(value);
}
