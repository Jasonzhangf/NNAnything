export type ParseStrategy = "strict" | "loose";

const parsers = {
  strict: (raw: string) => raw.trim(),
  loose: (raw: string) => raw,
};

export function parserFor(strategy: ParseStrategy) {
  return parsers[strategy];
}
