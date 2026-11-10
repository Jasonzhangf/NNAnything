function clampRequested(value: number): number {
  return Math.max(0, value);
}

export function runRequestedClamp(value: number): number {
  return clampRequested(value);
}
