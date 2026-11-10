import { pickKernel, type DataChannel } from "./dispatch";

export function dispatchValue(channel: DataChannel, input: number): number {
  const selectedChannel = channel;
  return pickKernel(selectedChannel)(input);
}
