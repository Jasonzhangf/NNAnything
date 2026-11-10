# Fixed adapter observation probe — family C

Command used the accepted public entry `runTsJsSymbolTable` plus
`mapTsJsSymbolTableToUnifiedFacts` from the current main checkout, reading the
sealed family C sources. This is a read-only observation, not a label.

Result:

- Parsed 10 files with complete coverage; no parse error and no failed scope
  file. `tsc` passed with exit 0.
- Emitted 15 `local` symbol facts only. Emitted no `import_binding` fact, no
  `call_site` relation fact, and no `selector_candidate_table` or
  `runtime_selector_dependency` local fact.
- `dynamicMemberBoundaries` is empty.
- Boundaries report `typeCheckerSemanticBinding=not_resolved`,
  `dynamicComputedProperties=not_resolved`, and
  `reExportTargetResolution=not_resolved`; parser `semanticBinding=false`.

Conclusion: `NOT_READY`. The fixed adapter cannot observe the runtime selector
relation or the two typed roles required by the accepted design. This matches
the independent source-preparation probe and is an observation gap, not a
semantic label. No episode, gold, supervision row, or student row was authored
from this probe.

Raw evidence: this run's
`/Volumes/Intel/playground/nnanything-runs/tsjs-unknown-supervision-verification-custody-r1-20261110/evidence/adapter-probe-family-c.json`.
