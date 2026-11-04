import { createStepper } from "./factory";

const table: Record<string, typeof createStepper> = { createStepper };
const computedName = "create" + "Stepper";

export const result = table[computedName](1)(2);

