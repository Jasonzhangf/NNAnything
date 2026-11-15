export function createStepper(delta: number) {
  return (value: number) => value + delta;
}

export function createShadowedStepper(delta: number) {
  return (value: number) => value - delta;
}
