# Dynamic label correction

`b-closure-unknown-dynamic-property` previously used label `unknown` with
reason `dynamic_undecidable`.

The source uses `const computedName = "ba" + "se"` and `registry = { base }`.
The compiler API receipt folds `computedName` to `"base"`, finds exactly one
matching property, and resolves it to `closure.ts#top:base`. The corrected
semantic gold is therefore `true` with target
`closure.ts#top:base`.

The original unknown record is retained in `gold.jsonl` and the episode as
`originalLabel`, `originalUnknownReason`, and
`originalLabelAuthority`. This correction does not invent new student rows,
change thresholds, or authorize training.
