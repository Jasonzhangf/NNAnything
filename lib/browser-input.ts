export * from "./adapters/browser/input-contract.js";
export * from "./filters/browser-stage1-policy.js";
export { runBrowserInputEpisode } from "./nodes/browser-input.js";
import { runBrowserInputEpisode } from "./nodes/browser-input.js";
import type { BrowserInputEpisode, BrowserInputResources } from "./adapters/browser/input-contract.js";

export async function runBrowserInputGoal(
  input: unknown,
  resources: BrowserInputResources,
): Promise<BrowserInputEpisode> {
  return runBrowserInputEpisode(input, resources);
}
