export type Unit = "celsius" | "fahrenheit";

export function toCelsius(valueDegrees: number): number {
  return (valueDegrees - 32) * (5 / 9);
}

export function toFahrenheit(valueDegrees: number): number {
  return valueDegrees * (9 / 5) + 32;
}
