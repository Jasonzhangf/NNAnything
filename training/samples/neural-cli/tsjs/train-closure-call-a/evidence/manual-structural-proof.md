# Manual structural proof

This file records the source-level structural proof for each sample in this
family. The proof is independent from the TypeScript language-service oracle
receipt.

## makeAdder

`entry.ts` imports `makeAdder` from `./closure`.
`closure.ts` `makeAdder` returns the inner `addOffset` function.
The inner `addOffset` calls module-scope `closure.ts:1` `base`.
It does not call `other.ts` `base`.
Gold for the call `base(value)` inside `makeAdder`: `closure.ts#top:base`.

## makeShadow

`entry.ts` imports `makeShadow` from `./closure`.
`closure.ts` `makeShadow` declares a local `const base` at line 12.
The inner `addOffset` calls the local `base`, not module-scope `base`.
The local function expression starts at `closure.ts:12` column 9.
Gold for the call `base(value)` inside `makeShadow`:
`closure.ts#local:base` with module `closure.ts`.

## dynamic registry

`entry.ts` imports `registry` from `./closure`.
`closure.ts` declares `registry = { base }`.
The property key is `"base"`.
The call site uses `registry[computedName]` where `computedName = "ba" + "se"`.
The compiler API folds `"ba" + "se"` to `"base"`, resolves the `base` property
in the imported `registry` object, and reaches `closure.ts:1`
`base`.
Gold for the call `registry[computedName](4)`:
`closure.ts#top:base` with label `true`.

Original evidence retained for history: the earlier label was `unknown` with
reason `dynamic_undecidable`. It was corrected because the string
concatenation is compile-time constant and has a single matching property.

