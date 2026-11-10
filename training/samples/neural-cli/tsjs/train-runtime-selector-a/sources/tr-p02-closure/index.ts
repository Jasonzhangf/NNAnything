function makeOffset(delta: number): (value: number) => number {
  return value => value + delta;
}

const requestedOffset = makeOffset(4);

export function applyRequestedOffset(value: number): number {
  return requestedOffset(value);
}
