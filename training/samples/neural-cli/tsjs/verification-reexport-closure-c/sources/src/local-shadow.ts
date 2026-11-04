export function makeLocal(delta: number): (value: number) => number {
  const shift = (value: number): number => value - delta;

  return function shifted(value: number): number {
    return shift(value) + delta;
  };
}

