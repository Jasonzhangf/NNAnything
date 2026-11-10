// Clean DEV family: finite dispatch table with a single straight-line helper.
// The helper returns the table member chosen by a runtime key. The two
// callers in this family are the unknown-decision contexts; the key is the
// only input the runtime contrast varies.

export type DispatchKey = "spell" | "chant";

export const dispatchTable = {
  spell: (payload: string): string => `spell:${payload}`,
  chant: (payload: string): number => payload.length,
};

export function pickDispatch(selector: DispatchKey) {
  return dispatchTable[selector];
}
