import type { SingleActionControl } from "./single-action-contract.js";

export interface CurrentControlAuthority {
  beginObservation(): Readonly<SingleActionControl>;
  currentControl(): Readonly<SingleActionControl>;
}

function copyControl(control: SingleActionControl): Readonly<SingleActionControl> {
  return Object.freeze({ ...control });
}

export function createCurrentControlAuthority(input: {
  readonly documentRef: string;
}): CurrentControlAuthority {
  const documentRef = input.documentRef;
  if (typeof documentRef !== "string" || documentRef.length === 0) {
    throw new TypeError("current control authority.documentRef must be a nonempty string");
  }

  let revision = 0;
  let current: SingleActionControl | null = null;

  return Object.freeze({
    beginObservation(): Readonly<SingleActionControl> {
      revision += 1;
      current = {
        documentRef,
        observationId: `observation-${revision}`,
        revision,
      };
      return copyControl(current);
    },

    currentControl(): Readonly<SingleActionControl> {
      if (current === null) {
        throw new Error("current control is unavailable before the first observation starts");
      }
      return copyControl(current);
    },
  });
}
