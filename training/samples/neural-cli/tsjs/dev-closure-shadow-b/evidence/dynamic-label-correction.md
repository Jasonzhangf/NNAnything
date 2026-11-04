# Dynamic label correction

This correction supersedes the dynamic property label for
`c-dev-unknown-dynamic-property` without deleting the original record.

## Original record

`labels/gold.jsonl#c-dev-unknown-dynamic-property` records label `unknown` with
`unknownReason` `dynamic_undecidable`, authority
`typescript_language_service+human_review`, and oracle
`independent_tsc+typescript_compiler_api`. `episode-c-dev-unknown-dynamic-property.jsonl`
and `evidence/manual-structural-proof.md` carry the same claim. `tsc-receipt.txt`
only proves a successful compile.

## Finding

`computedName` is the string concatenation `"create" + "Stepper"`, a
compile-time constant that folds to `createStepper`. The object literal
initializes exactly one property with that key, `{ createStepper }`, and the
imported binding resolves through `entry-dynamic.ts` to `factory.ts#top:createStepper`.
The final callee is therefore statically determinable.

The previous `dynamic_undecidable` label reflects a checker and adapter
limitation, not program semantics. It is not valid as a semantic-unknown
benchmark and must not be used to score "unknown reporting".

## Corrected supervision

- Semantic gold: `true` for the relation
  `entry-dynamic.ts table[computedName] -> factory.ts#top:createStepper`.
- Label authority: `researcher_structural_proof + typescript_compiler_api`. No
  human authority is claimed for this sample.
- Admission: `diagnostic_only`. The sample is retained as known
  adapter-limitation evidence and must not enter independent evaluation as a
  true-unknown case.
- Original `gold.jsonl`, episode, and proof records are preserved as the
  superseded record.

## Replayable evidence

Run from the repository root:

```sh
node training/samples/neural-cli/tsjs/scripts/compiler-api-resolve.mjs \
  dev-closure-shadow-b
```

The captured receipt is `evidence/compiler-api-resolve-receipt.json`.
