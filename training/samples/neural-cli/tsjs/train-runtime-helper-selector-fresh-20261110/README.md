# Fresh TRAIN helper-form runtime-selector family

Partition: TRAIN. Family root: `train-runtime-helper-selector-fresh-20261110`.

This is a fresh, independently authored TRAIN source family for the accepted
bounded runtime-selector relation: a call through `helper(selector)(...)` where
the helper returns a member selected from a finite `const` object-literal
callable table. It was authored from the accepted
`helper-source-proof-contract.md` and the public `runTsJsSymbolTable` producer.
It does not read any DEV or verification family and does not use a shared
template, copy, rename, or transformed derivative.

The contract's requested TRAIN root `train-runtime-helper-selector-r1` is
already occupied by preserved, Alice-accepted preparation material in
`origin/main`. This fresh family therefore uses a distinct root and leaves the
earlier family untouched, matching the sibling fresh DEV task's resolution.

## Cases

- `sources/tr-f01-direct-import-block`: direct caller parameter, separate caller
  and helper modules, call result captured in a `const` and returned.
- `sources/tr-f02-alias-single-module`: one immutable local alias, single
  module, single straight-line return.
- `sources/tr-f03-direct-nested-block`: direct caller parameter, separate
  caller and helper modules, return inside one nested block statement.

## Controls

- `controls/static-selector.ts`: constant selector; no runtime-selector role.
- `controls/direct-index.ts`: direct table-index call; outside the reviewed slice.

## Evidence and replay

Replay the whole family from this directory:

```sh
node proofs/verify-fresh-train.mjs
```

Receipts are written under `receipts/`. Manual structural proof is in
`proofs/semantic-proofs.md`; `receipts/supported-not-ready.md` records the
per-case disposition.

Source facts, student observations, and supervision stay physically separate:
this family contains source and proof-side evidence only. No student
observation, episode, supervision row, or admitted sample is created here.
Admission is `NOT_READY` for every case because the accepted request-aware
bridge does not yet exist.
