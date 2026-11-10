function label(value: number): string {
  return `outer:${value}`;
}

export function labelInNestedScope(value: number): string {
  const label = (input: number): string => `inner:${input}`;
  return label(value);
}
