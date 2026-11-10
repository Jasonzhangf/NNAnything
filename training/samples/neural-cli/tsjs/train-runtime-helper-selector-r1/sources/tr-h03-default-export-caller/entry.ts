import { formatValue, type ValueFormat } from "./registry";

export default function renderValue(kind: ValueFormat, value: number): string {
  return formatValue(kind)(value);
}
