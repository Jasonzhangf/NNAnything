function createFormatter(prefix: string): (value: number) => string {
  return value => `${prefix}${value}`;
}

const formatRequest = createFormatter("request:");

export function renderRequest(value: number): string {
  return formatRequest(value);
}
