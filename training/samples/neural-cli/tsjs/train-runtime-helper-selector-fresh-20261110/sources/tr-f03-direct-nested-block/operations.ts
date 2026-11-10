export type Step = "add" | "multiply";

const steppers = {
  add: (base: number) => base + 1,
  multiply: (base: number) => base * 2,
};

export function stepperFor(step: Step) {
  return steppers[step];
}
