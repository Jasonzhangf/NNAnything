# TS/JS Corpus

Owner: Emma

This is the first TS/JS import-alias corpus. It contains five source families:

- `train-module-export-alias-a`: TRAIN, module exports and aliases.
- `train-closure-call-a`: TRAIN, closure call points and shadowing.
- `dev-closure-shadow-b`: DEV, factory closures and dynamic property lookup.
- `verification-reexport-closure-c`: VERIFICATION, independent re-export and
  closure cases, reclassified as a derived diagnostic regression source.
- `verification-independent-callgraph-d`: VERIFICATION, a fresh module graph
  with a barrel re-export, alias call, closure call, local shadow, and runtime
  selector dispatch.

The families are split by source, not by row. A source group is present in
exactly one partition. The source snapshots are small, project-authored
fixtures so the corpus is reproducible without a private repository.

Each family contains:

- `sources/`: compilable TypeScript input and its `tsconfig.json`.
- `manifest.json`: source, partition, authority, oracle, license, and secret
  metadata.
- `episode-<sampleId>.jsonl`: one raw source-level decision episode.
- `labels/gold.jsonl`: independent gold and action supervision.
- `evidence/`: manual structural proof, compiler receipt, oracle receipt, and
  source-level pre-state records.

Run the read-only corpus black-box check from the repository root:

```sh
node training/samples/neural-cli/tsjs/scripts/verify-corpus.mjs
```

The check validates JSONL alignment, manifest sample counts, the explicit
admission/supersession contract, the three corrected dynamic labels, and the
independent family's single runtime-unknown result.

`student-rows/` is intentionally absent. The feature schema is not accepted
yet, so no 64-slot or student feature row is generated.

These are static source-level episodes. They have no product execution receipt
and no post-state claim. `executionReceiptRef` and `postStateRef` are therefore
null in each episode. The independent compiler/language-service result is
recorded in `evidence/oracle-receipt.json`.

`corpus-readiness-v1.json` records coverage and unresolved items. The status is
`incomplete` until the later feature projection and training gates exist.

## Candidate supervision meaning

Every gold `candidateSet` is an offline gold-only supervision set. It contains
only the correct judge and is not a complete student candidate group. The
episode `candidateSetRef` points at that gold record. Student candidate
enumeration is `deferred`; a future converter must build student candidates
independently from typed input, including legal contrasting candidates, and
must never filter candidates by the gold label. See
`candidate-supervision-contract.json`.

## Source derivation admission

`source-derivation.json` records that
`verification-reexport-closure-c` is a renamed-copy derivative of the
`train-closure-call-a` increment/offset-adder template. It is reclassified as
`derived_diagnostic_regression`. The original files remain in place.

`tsjs-verification-independent-callgraph-d` is a fresh source graph with no
template relationship to the TRAIN or DEV closure families. It is the admitted
independent verification family.

`tsjs-train-module-export-alias-a`, `tsjs-dev-closure-shadow-b`, and
`tsjs-verification-independent-callgraph-d` are recorded as independent source
groups.

## Dynamic label corrections

The dynamic property samples in `train-closure-call-a`,
`dev-closure-shadow-b`, and `verification-reexport-closure-c` had
`unknown / dynamic_undecidable` labels. Their keys are compile-time string
constants (`"ba" + "se"`, `"create" + "Stepper"`, and `"make" + "Local"`), so
the final callee is statically determinable. The current gold and episodes now
carry the corrected `true` label and target; the original label, reason, and
authority remain explicit historical fields. Each family also carries a
replayable TypeScript Compiler API receipt:

- `evidence/dynamic-label-correction.md`
- `evidence/compiler-api-resolve-receipt.json`

Replay from the repository root:

```sh
node training/samples/neural-cli/tsjs/scripts/compiler-api-resolve.mjs \
  train-closure-call-a
node training/samples/neural-cli/tsjs/scripts/compiler-api-resolve.mjs \
  verification-reexport-closure-c
node training/samples/neural-cli/tsjs/scripts/compiler-api-resolve.mjs \
  dev-closure-shadow-b
```

The corrected authority is `researcher_structural_proof + compiler_api`; no
human review is claimed.

`corpus-admissions-v1.json` is the explicit admission and supersession entry
point for future consumers. The old `candidateEnumeration=complete` values,
old label authorities, and corrected dynamic labels remain in the files as
historical fields with `admission`, `supersededBy`, and correction references.

