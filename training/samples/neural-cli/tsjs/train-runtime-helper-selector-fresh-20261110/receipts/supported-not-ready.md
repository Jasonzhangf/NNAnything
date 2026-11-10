# Fresh TRAIN supported / not-ready table

Partition: TRAIN. Family: `train-runtime-helper-selector-fresh-20261110`.

Public producer: `runTsJsSymbolTable` at `dist/adapters/cli/tsjs-symbol-table-adapter.js`
built from this worktree (`origin/main` `8555b57f`).

Receipts:

- `receipts/public-producer-output.json` (`nnanything.tsjs.helper-source-public-producer.v1`)
- `receipts/raw-checks.json` (`nnanything.tsjs.helper-source-checks.fresh-train.v1`, `CHECKS_COMPLETE`)

| Case | Source and structural proof | Callable identity | Runtime contrast | Public producer | Admission |
| --- | --- | --- | --- | --- | --- |
| `tr-f01-direct-import-block` | supported | supported | supported | 1 observation, 2 known roles, complete read | NOT_READY |
| `tr-f02-alias-single-module` | supported | supported | supported | 1 observation, 2 known roles, complete read | NOT_READY |
| `tr-f03-direct-nested-block` | supported | supported | supported | 1 observation, 2 known roles, complete read | NOT_READY |

Each target emits exactly one dynamic binding
(`role=member`, `bindingMode=dynamic`, `resolution=dynamic_undecidable`,
`declarationRefs=[]`), one known `selector_candidate_table` fact, and one known
`runtime_selector_dependency` fact. Both facts, the binding, and the resolution
share the same `source-read:` ref and the same call site. The receipt lists
exactly the modules requested for that target. Parsing is complete,
`parser.semanticBinding` remains `false`, coverage is not partial, and
`dynamicMemberBoundaries` is empty.

## Controls

| Control | Producer observation | Producer gap |
| --- | --- | --- |
| `control-static-selector` | 0 | 0 |
| `control-direct-index` | 0 | 0 |

Controls are producer observations only. They are not gold rows, negative
labels, student observations, admitted rows, or training samples.

## Exact remaining gap

Admission is `NOT_READY` for all three cases for one reason: the request-aware
bridge is absent. The public producer emits raw producer evidence, not an
admitted episode. There is no accepted path from `TsJsSymbolTableResult` to a
request-bound stepwise observation, so there is no `requestId`, `fromStepId`,
`pendingRelationRef`, admitted source-read receipt, request-relative
`coverage.targetModuleReached`, or `runtime_dynamic_selector` completion note.

The named successor for that binding is the existing
`tsjs-symbol-table-to-stepwise-observation-bridge-r1`. This task does not
invent typed roles, joins, candidate groups, or receipts, and does not convert
or admit any row.

No fit, scoring, candidate rerun, conversion, admission, gold, weight,
threshold, adoption, product wiring, or global installation was performed.
