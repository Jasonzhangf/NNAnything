import { offsetBy } from "./barrel";

export function buildShadowed(delta: number): (value: number) => number {
  const offsetBy = (value: number): number => value - delta;

  return function step(value: number): number {
    return offsetBy(value) + delta;
  };
}
