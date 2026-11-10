function convert(value: number): number {
  return value * 2;
}

export function convertInsideShadow(value: number): number {
  function convert(input: number): number {
    return input - 3;
  }

  return convert(value);
}
