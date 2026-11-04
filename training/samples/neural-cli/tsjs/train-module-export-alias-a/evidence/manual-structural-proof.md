# Manual structural proof

This file records the source-level structural proof for each sample in this
family. The proof is independent from the TypeScript language-service oracle
receipt.

## entry-pos

`entry-pos.ts` imports `forwarded as helper` from `./util`.
`util.ts` re-exports `helper as forwarded` from `./impl`.
Therefore the call `helper(1)` resolves to `impl.ts:1` `helper`.
Gold: `true`.

## entry-other-forward

`entry-other-forward.ts` imports `helper` from `./other-forward`.
`other-forward.ts` re-exports `helper` from `./impl`.
Therefore the call `helper(2)` resolves to `impl.ts:1` `helper`.
Gold: `true`.

## entry-other-different

`entry-other-different.ts` imports `helper` from `./other-different`.
`other-different.ts` declares its own `helper`.
The call binds to `other-different.ts` `helper`, not to `impl.ts` `helper`.
Gold for the relation to `impl.ts#top:helper`: `false`.

## entry-other-same-different

`entry-other-same-different.ts` imports `otherHelper as helper` from
`./other-same-different`.
`other-same-different.ts` declares `helper` and `otherHelper`.
The call binds to `other-same-different.ts:2` `otherHelper`.
Gold for the relation to `impl.ts#top:helper`: `false`.

## entry-same-module-different

`entry-same-module-different.ts` imports `otherHelper as helper` from `./impl`.
`impl.ts` declares `helper` at line 1 and `otherHelper` at line 5.
The call binds to `impl.ts:5` `otherHelper`.
Gold for the relation to `impl.ts#top:helper`: `false`.

## entry-missing

`entry-missing.ts` imports `forwarded as helper` from `./missing`.
The module `./missing` does not exist.
The binding cannot be resolved.
Gold: `unknown` with `unknownReason` `evidence_insufficient`.

