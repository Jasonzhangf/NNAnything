const labelFormats = {
  short: (value: string) => `${value}`,
  long: (value: string) => `long:${value}`,
};

function chooseLabelFormat(_kind: string) {
  return labelFormats.short;
}

export function renderConstantLabel(value: string): string {
  return chooseLabelFormat("short")(value);
}
