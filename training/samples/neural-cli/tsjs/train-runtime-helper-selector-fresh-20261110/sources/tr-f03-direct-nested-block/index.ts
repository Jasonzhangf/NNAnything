import { stepperFor, type Step } from "./operations";

export function advanceStep(step: Step, base: number): number {
  {
    return stepperFor(step)(base);
  }
}
