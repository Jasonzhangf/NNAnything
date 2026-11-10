// Non-runtime control: the selector is a literal constant, so this call site
// must produce no runtime-selector roles from the accepted producer.

import { pickDispatch } from "./dispatch.js";

export function runStatic(payload: string): string | number {
  return pickDispatch("spell")(payload);
}
