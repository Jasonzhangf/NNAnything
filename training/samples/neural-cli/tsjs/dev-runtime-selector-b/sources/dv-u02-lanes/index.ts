type Lane = 0 | 1;

const laneActions: readonly ((input: string) => string)[] = [
  input => `north:${input}`,
  input => `south:${input}`,
];

export function runLane(lane: Lane, input: string): string {
  return laneActions[lane](input);
}
