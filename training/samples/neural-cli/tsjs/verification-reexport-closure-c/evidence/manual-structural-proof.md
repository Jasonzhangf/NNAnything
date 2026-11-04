# Manual structural proof

This file records the source-level structural proof for each sample in this
family. It is independent from the TypeScript language-service oracle receipt.

## makeShifted entry

`entry.ts` imports `makeShifted` from `./index`.
`index.ts` re-exports `makeShifted` from `./shift`.
The call `makeShifted(3)` binds to `shift.ts:5` `makeShifted`.
Gold: `true`.

## makeShifted inner call

`makeShifted` returns the inner `shifted` function. The inner function calls
module-scope `shift.ts:1` `shift`.
The call does not bind to `local-shadow.ts` or `other.ts`.
Gold: `shift.ts#top:shift`.

## makeLocal

`entry-dynamic.ts` imports `makeLocal` from `./index`.
`index.ts` re-exports `makeLocal` from `./local-shadow`.
`makeLocal` declares a local `const shift`.
The inner `shifted` function calls the local `shift`, not any module-scope
`shift`.
The local function expression starts at `local-shadow.ts:2` column 9.
Gold: `local-shadow.ts#local:shift`.

## entry-dynamic property load

`entry-dynamic.ts` stores `makeLocal` in `table` and reads
`table[computedName]`. `computedName` is built from string concatenation.
The static binding for the property load is `table` itself.
The final callee is not statically decidable.
Gold: `unknown` with `unknownReason` `dynamic_undecidable`.

Superseded: `evidence/dynamic-label-correction.md` and
`evidence/compiler-api-resolve-receipt.json` show that `computedName` folds to
the compile-time constant `makeLocal`, so the final callee is
`local-shadow.ts#top:makeLocal`. The original text above is retained as the
superseded record.

