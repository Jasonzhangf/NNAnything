# Manual structural proof

This file records the source-level structural proof for each sample in this
family. It is independent from the TypeScript language-service oracle receipt.

## entry-known

`entry-known.ts` imports `createStepper` from `./factory`.
The call `createStepper(2)` binds to `factory.ts:3` `createStepper`.
Gold: `true`.

## entry-dynamic

`entry-dynamic.ts` imports `createStepper` from `./factory`.
It stores `createStepper` in `table` and reads `table[computedName]`.
`computedName` is built from string concatenation. The static binding for the
property load is `table` itself, not a function declaration.
The final callee is not statically decidable.
Gold: `unknown` with `unknownReason` `dynamic_undecidable`.

Superseded: `evidence/dynamic-label-correction.md` and
`evidence/compiler-api-resolve-receipt.json` show that `computedName` folds to
the compile-time constant `createStepper`, so the final callee is
`factory.ts#top:createStepper`. The original text above is retained as the
superseded record.

## alternate module

`alternate.ts` declares an unrelated `createStepper` returning `number`.
`entry-known.ts` and `entry-dynamic.ts` do not import from `./alternate`.
No sample in this family binds to `alternate.ts`.

