type ArrayLane = 0 | 1;

const laneHelpers: readonly ((value: number) => number)[] = [
  value => value + 5,
  value => value - 5,
];

export function useLane(lane: ArrayLane, value: number): number {
  return laneHelpers[lane](value);
}
