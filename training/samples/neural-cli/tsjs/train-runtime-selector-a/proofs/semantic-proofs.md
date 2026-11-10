# TRAIN semantic proofs

Family: `tsjs-train-runtime-selector-a`.

All receipts are in
`/Volumes/Intel/playground/nnanything-runs/tsjs-unknown-supervision-static-source-production-unexposed-r1-20261110/raw-checks.json`.
Compiler checks used TypeScript `5.9.3`; every listed source compiled without
diagnostics and the named call expression was found at the recorded line.
These proofs are independent supervision evidence. They are not student input,
not an admitted episode, and not a candidate.

The current accepted runtime-selector producer shape is the bounded
object-literal `helper(selector)(...)` form. The direct table, tuple, and array
indexing forms below are not covered by that shape. They remain future
material and do not authorize a parser expansion.

## Runtime-selected unknown

### `tr-u01-routes`

Requested declaration: `deliveryRoutes.mail`.
Call site: `deliveryRoutes[channel](payload)`.

The source has a finite two-entry table with distinct callable declarations.
The function parameter `channel` reaches the computed table access and is not
constant at the call site. The compiler returns no symbol declaration for the
element-access callee. Runtime probes changed only the selector while keeping
the same payload `"alpha"`; they returned `"mail:alpha"` and `"chat:alpha"`.
This controlled comparison proves that the selector changes the selected
runtime callable.

Semantic action: `c:judge:unknown`, reason `runtime_dynamic_selector`.
Status: `NOT_READY` because the public source path does not emit source-read
backed `selector_candidate_table` and `runtime_selector_dependency` facts tied
to a `callSiteRef`. The direct object-property index shape is also outside the
currently accepted `helper(selector)(...)` producer shape.

### `tr-u02-slots`

Requested declaration: `workerSlots[0]`.
Call site: `workerSlots[slot](value)`.

The source has a fixed two-element tuple of callables. The parameter `slot`
flows into the tuple index. The compiler resolves no declaration symbol at the
element access. Runtime probes for slots `0` and `1` returned `12` and `55`,
which are the distinct handler results for input `5`.

Semantic action: `c:judge:unknown`, reason `runtime_dynamic_selector`.
Status: `NOT_READY` for the missing source-to-episode observation path. The
tuple-index call shape is outside the currently accepted
`helper(selector)(...)` producer shape.

### `tr-u03-modes`

Requested declaration: `arithmeticModes.sum`.
Call site: `arithmeticModes[mode](left, right)`.

The table is a finite two-key object whose values are distinct callable
declarations. The `mode` parameter reaches the computed access. The compiler
returns no selected declaration for the element-access expression. Runtime
probes with the same operands returned `10` for `sum` and `4` for `gap`.

Semantic action: `c:judge:unknown`, reason `runtime_dynamic_selector`.
Status: `NOT_READY` for the missing source-to-episode observation path. The
direct object-property index call shape is outside the currently accepted
`helper(selector)(...)` producer shape.

## Resolved negative

### `tr-n01-direct`

Requested declaration: `requestedFormat`.
Call site: `alternateFormat(value)`.

The compiler resolves the call to the declaration
`function alternateFormat`, not to `requestedFormat`. Runtime output
`"alternate:4"` agrees with that declaration. This is a resolved negative with
complete local evidence.

Semantic action: `c:judge:false`.
Status: `NOT_READY` because the public source path does not emit the accepted
relation episode or legal candidate group.

### `tr-n02-shadow`

Requested declaration: the outer `function label`.
Call site: `label(value)` inside `labelInNestedScope`.

The compiler resolves the call to the local arrow declaration
`const label = ...` in the nested scope. The outer `label` is shadowed and is
not the resolved callee. Runtime output `"inner:6"` agrees with the nested
declaration.

Semantic action: `c:judge:false`.
Status: `NOT_READY` for the missing episode and candidate producer.

### `tr-n03-method`

Requested declaration: `PrimaryTool.step`.
Call site: `secondaryTool.step(value)`.

The compiler resolves the member call to the `SecondaryTool.step` method
declaration. The requested `PrimaryTool.step` declaration is a different
method identity. Runtime output `9` agrees with `SecondaryTool.step(3)`.

Semantic action: `c:judge:false`.
Status: `NOT_READY` for the missing episode and candidate producer.

## Positive control

### `tr-p01-direct`

Requested declaration: `requestedHalf`.
Call site: `requestedHalf(value)`.

The compiler symbol and signature declaration both resolve to
`function requestedHalf`. Runtime output `6` agrees with the declared function.
This is the source used for the source-to-episode producer trace.

Semantic action: `c:judge:true`.
Status: `NOT_READY` because the public read emits top-level declarations but no
call-expression identity or accepted relation episode.

### `tr-p02-closure`

Requested declaration: `requestedOffset`.
Call site: `requestedOffset(value)`.

The compiler resolves the call expression to the local const declaration
`requestedOffset`, whose value is created by `makeOffset(4)`. Runtime output
`13` agrees with the stored closure.

Semantic action: `c:judge:true`.
Status: `NOT_READY` for the missing episode and candidate producer.

### `tr-p03-method`

Requested declaration: `Basket.requestedCount`.
Call site: `basket.requestedCount(items)`.

The compiler resolves the member call to the `Basket.requestedCount` method
declaration. Runtime output `1` agrees with the requested method on the given
array.

Semantic action: `c:judge:true`.
Status: `NOT_READY` for the missing episode and candidate producer.

## Continue for evidence

### `tr-a01-import`

The entry imports `buildLabel` from `./labels` and calls it at
`buildLabel(value)`. The compiler's cross-file signature is in `labels.ts`,
but that binding is oracle-only evidence and is not available to the student
until the observed import edge is read. The legal next action is to advance on
the observed import edge.

Semantic action: `c:advance:tsjs:import:./labels:buildLabel`.
Status: `NOT_READY` because no typed pending obligation or source read receipt
is produced for the legal advance candidate.

### `tr-a02-reexport`

Current observed module: `sources/tr-a02-reexport/index.ts`.

The entry imports `resize` from `./facade`, so the entry-only observation
supports an unread import edge to `./facade`, not an advance on a re-export
from `./facade` to `./engine`. A separate facade-read step must be observed
before the actual re-export edge to `./engine` can become a legal next edge.
The compiler's final engine binding is independent oracle evidence and must
not be inserted into the current student observation or future-file facts.

Expected semantic step: advance on the observed import edge
`./facade:resize`; the exact `candidateRef` must be generated by the existing
candidate builder from the typed obligation and is not authored by this proof.
Status: `NOT_READY` because the typed pending obligation and read receipt are
not emitted, and the facade-read step has not been executed.

### `tr-a03-namespace`

The entry has a namespace import from `./measurements` and calls
`measurements.scale(value)`. The compiler resolves the property to the
measurement module declaration, but the observed module edge remains unread at
the current student step.

Semantic action: `c:advance:tsjs:import:./measurements:measurements`.
Status: `NOT_READY` because the typed pending obligation and read receipt are
not emitted.
