const prefixes = {
  brief: (value: string) => `brief:${value}`,
  full: (value: string) => `full:${value}`,
};

function choosePrefix(_style: string) {
  return prefixes.brief;
}

export function renderBrief(value: string): string {
  return choosePrefix("brief")(value);
}
