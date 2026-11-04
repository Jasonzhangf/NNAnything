export function shift(value: number): number {
  return value + 1;
}

export function makeShifted(delta: number): (value: number) => number {
  return function shifted(value: number): number {
    return shift(value) + delta;
  };
}

