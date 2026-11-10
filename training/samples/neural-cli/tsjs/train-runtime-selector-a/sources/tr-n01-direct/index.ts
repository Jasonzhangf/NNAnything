function requestedFormat(value: number): string {
  return `requested:${value}`;
}

function alternateFormat(value: number): string {
  return `alternate:${value}`;
}

export function formatAlternate(value: number): string {
  return alternateFormat(value);
}
