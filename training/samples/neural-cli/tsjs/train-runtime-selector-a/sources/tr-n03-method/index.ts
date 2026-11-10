class PrimaryTool {
  step(value: number): number {
    return value + 3;
  }
}

class SecondaryTool {
  step(value: number): number {
    return value * 3;
  }
}

const primaryTool = new PrimaryTool();
const secondaryTool = new SecondaryTool();

export function useSecondaryTool(value: number): number {
  return secondaryTool.step(value);
}
