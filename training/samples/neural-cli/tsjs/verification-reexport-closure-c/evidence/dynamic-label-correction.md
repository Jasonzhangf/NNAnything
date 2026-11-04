# Dynamic label correction

This correction supersedes the dynamic property label for
`d-verification-unknown-dynamic` without deleting the original record.

## Original record

`labels/gold.jsonl#d-verification-unknown-dynamic` records label `unknown` with
`unknownReason` `dynamic_undecidable`, authority
`human_structural_proof+typescript_language_service`, and oracle
`independent_tsc+typescript_compiler_api`. `episode-d-verification-unknown-dynamic.jsonl`
and `evidence/manual-structural-proof.md` carry the same claim. `tsc-receipt.txt`
only proves a successful compile.

## Finding

`computedName` is the string concatenation `"make" + "Local"`, a compile-time
constant that folds to `makeLocal`. The object literal initializes exactly one
property with that key, `{ makeLocal }`, and the imported binding resolves
through `index.ts` to `local-shadow.ts#top:makeLocal`. The final callee is
therefore statically determinable.

The previous `dynamic_undecidable` label reflects a checker and adapter
limitation, not program semantics. It is not valid as a semantic-unknown
benchmark and must not be used to score "unknown reporting".

## Corrected supervision

- Semantic gold: `true` for the relation
  `entry-dynamic.ts table[computedName] -> local-shadow.ts#top:makeLocal`.
- Label authority: `researcher_structural_proof + typescript_compiler_api`. No
  human authority is claimed for this sample.
- Admission: `diagnostic_only`. The sample is retained as known
  adapter-limitation evidence and must not enter independent verification as a
  true-unknown case.
- Original `gold.jsonl` label, episode label fields, and proof text are
  preserved as the superseded record; only the episode `candidateEnumeration`
  metadata was corrected to `deferred`, independently of this label.

## Replayable evidence

Run from the repository root:

```sh
node training/samples/neural-cli/tsjs/scripts/compiler-api-resolve.mjs \
  verification-reexport-closure-c
```

The captured receipt is `evidence/compiler-api-resolve-receipt.json`.
