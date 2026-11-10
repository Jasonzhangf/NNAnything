const leftStep = (value: number): string => `left:${value}`;
const rightStep = (value: number): string => `right:${value}`;

export function stepRight(value: number): string {
  return rightStep(value);
}
