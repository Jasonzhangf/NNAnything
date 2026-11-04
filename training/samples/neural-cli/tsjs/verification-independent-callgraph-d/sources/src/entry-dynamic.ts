import { scaleBy, offsetBy } from "./barrel";

const table: Record<string, (value: number, amount: number) => number> = {
  scaleBy,
  offsetBy,
};

export function dispatch(
  selector: string,
  value: number,
  amount: number,
): number {
  return table[selector](value, amount);
}
