// dv-c02: the outer call site passes one immutable local alias of the direct
// caller parameter. The alias is a single const initializer with no further
// assignment, so the same helper shape still sees a runtime selector.

import { pickDispatch, type DispatchKey } from "./dispatch.js";

export function runAlias(selector: DispatchKey, payload: string): string | number {
  const chosen = selector;
  return pickDispatch(chosen)(payload);
}
