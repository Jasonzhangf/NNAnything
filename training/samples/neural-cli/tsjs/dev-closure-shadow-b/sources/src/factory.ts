export type Stepper = (value: number) => number;

export function createStepper(delta: number): Stepper {
  const advance = (value: number): number => value + delta;

  return function step(value: number): number {
    return advance(value) * 2;
  };
}

export function createShadowedStepper(delta: number): Stepper {
  const advance = (value: number): number => value - delta;

  return function step(value: number): number {
    return advance(value) * 2;
  };
}

