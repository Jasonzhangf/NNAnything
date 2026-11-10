// dv-c01: the outer call site passes the direct caller parameter as the
// runtime selector. helper-form call shape: pickDispatch(selector)(payload).

import { pickDispatch, type DispatchKey } from "./dispatch.js";

export function runDirect(selector: DispatchKey, payload: string): string | number {
  return pickDispatch(selector)(payload);
}
