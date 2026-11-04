export function base(value: number): number {
  return value + 1;
}

export function makeAdder(offset: number): (value: number) => number {
  return function addOffset(value: number): number {
    return base(value) + offset;
  };
}

export function makeShadow(offset: number): (value: number) => number {
  const base = (value: number): number => value - 100;

  return function addOffset(value: number): number {
    return base(value) + offset;
  };
}

export const registry: Record<string, (value: number) => number> = { base };

