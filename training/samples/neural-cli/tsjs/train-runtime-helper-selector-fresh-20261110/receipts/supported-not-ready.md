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

Admission is `NOT_READY` for all three cases for one reason: this family has
not been passed through the existing request-aware admission/config path. The
bridge and bounded completion engineering are already accepted, and
`tsjs-request-aware-admission-config-r1-20261110` (peer-15) owns that path.
The public producer emits raw producer evidence, not an admitted episode; no
request-bound `requestId`, `fromStepId`, `pendingRelationRef`, admitted
source-read receipt, request-relative `coverage.targetModuleReached`, or
`runtime_dynamic_selector` completion note has been produced for this family.

This task does not add a bridge implementation, does not make this extra family
a dependency of the accepted-family successor, and does not invent typed
roles, joins, candidate groups, or receipts.

## Requested outer-call target mapping

The requested outer-call target is the table-member callable reached through
`helper(selector)(payload)`, not the helper. Each case maps the requested
target to a real member using the public producer's
`callableTable.members[*].callableIdentity` (declaration, module, span), with a
distinct alternative:

| Case | Requested target | Target declarationRef | Distinct alternative |
| --- | --- | --- | --- |
| `tr-f01-direct-import-block` | `strict` | `callable.arrow_function:sources/tr-f01-direct-import-block/strategies.ts@4:11-4:38` | `loose` |
| `tr-f02-alias-single-module` | `currency` | `callable.arrow_function:sources/tr-f02-alias-single-module/formatter.ts@4:13-4:56` | `percent` |
| `tr-f03-direct-nested-block` | `add` | `callable.arrow_function:sources/tr-f03-direct-nested-block/operations.ts@4:8-4:34` | `multiply` |

No fit, scoring, candidate rerun, conversion, admission, gold, weight,
threshold, adoption, product wiring, or global installation was performed.
