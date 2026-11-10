// Out-of-slice control: a direct table-index call. The callee expression is an
// element access, not a helper call, so this shape is outside the reviewed
// helper slice and must produce no runtime-selector roles.

import { dispatchTable } from "./dispatch.js";

export function runDirectIndex(payload: string): string {
  return dispatchTable["spell"](payload);
}
