import { makeAdder, makeShadow, registry } from "./closure";

export const added = makeAdder(2)(3);
export const shadowed = makeShadow(2)(3);

const computedName = "ba" + "se";
export const dynamicResult = registry[computedName](4);

