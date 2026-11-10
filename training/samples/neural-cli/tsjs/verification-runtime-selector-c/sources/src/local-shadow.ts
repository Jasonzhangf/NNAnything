export function toCelsius(valueDegrees: number): number {
  return valueDegrees + 100;
}

export function rescale(valueDegrees: number): number {
  return toCelsius(valueDegrees);
}
