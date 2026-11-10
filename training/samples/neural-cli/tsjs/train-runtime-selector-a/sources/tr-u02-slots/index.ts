type WorkerSlot = 0 | 1;

const workerSlots = [
  (value: number) => value + 7,
  (value: number) => value * 11,
] as const;

export function runWorker(slot: WorkerSlot, value: number): number {
  return workerSlots[slot](value);
}
