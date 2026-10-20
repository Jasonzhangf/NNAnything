import { classifyBasicKindBatch, type BasicKindBatch } from "../../filters/basic-kinds.js";
import { loadBrowserWeightAsset, type BrowserFileWeightOptions } from "./weight-asset.js";

export async function classifyBrowserBasicKinds(
  input: unknown,
  options: BrowserFileWeightOptions,
): Promise<BasicKindBatch> {
  const asset = await loadBrowserWeightAsset(options);
  return classifyBasicKindBatch(input, asset.config, asset.profile);
}
