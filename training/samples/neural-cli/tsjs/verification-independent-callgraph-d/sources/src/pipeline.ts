import { offsetBy } from "./barrel";

export function buildPipeline(delta: number): (value: number) => number {
  return function step(value: number): number {
    return offsetBy(value, delta);
  };
}
