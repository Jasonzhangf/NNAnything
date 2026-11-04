import { makeLocal } from "./index";

const table: Record<string, typeof makeLocal> = { makeLocal };
const computedName = "make" + "Local";

export const result = table[computedName](3)(4);

