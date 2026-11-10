export type DataChannel = "voice" | "data";

const channelKernels = {
  voice: (value: number) => value + 1,
  data: (value: number) => value * 4,
} satisfies Record<DataChannel, (value: number) => number>;

export function pickKernel(channel: DataChannel) {
  return channelKernels[channel];
}
