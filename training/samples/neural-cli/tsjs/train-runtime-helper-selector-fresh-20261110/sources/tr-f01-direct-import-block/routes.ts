import { parserFor, type ParseStrategy } from "./strategies";

export function parsePayload(strategy: ParseStrategy, raw: string): string {
  const parsed = parserFor(strategy)(raw);
  return parsed;
}
