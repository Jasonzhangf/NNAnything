# DEV semantic proofs

Family: `tsjs-dev-runtime-selector-b`.

All receipts are in
`/Volumes/Intel/playground/nnanything-runs/tsjs-unknown-supervision-static-source-production-unexposed-r1-20261110/raw-checks.json`.
Compiler checks used TypeScript `5.9.3`; every listed source compiled without
diagnostics and the named call expression was found at the recorded line.
These proofs are independent supervision evidence. They are not student input,
not an admitted episode, and not a candidate.

## Runtime-selected unknown

### `dv-u01-palette`

Requested declaration: `paletteOperations.warm`.
Call site: `paletteOperations[swatch](value)`.

The source has a finite two-key palette with distinct callable values. The
`swatch` parameter reaches the computed access. The compiler returns no symbol
declaration for the element-access expression. Runtime probes for `warm` and
`cool` returned `10` and `40` for input `8`.

Semantic action: `c:judge:unknown`, reason `runtime_dynamic_selector`.
Status: `NOT_READY` because the public source path does not emit source-read
backed selector roles and a `callSiteRef`.

### `dv-u02-lanes`

Requested declaration: `laneActions[0]`.
Call site: `laneActions[lane](input)`.

The source has a fixed two-element lane array. The `lane` parameter reaches the
tuple access and the compiler returns no selected declaration. Runtime probes
returned `"north:x"` and `"south:x"` for lanes `0` and `1`.

Semantic action: `c:judge:unknown`, reason `runtime_dynamic_selector`.
Status: `NOT_READY` for the missing source-to-episode observation path.

## Resolved negative

### `dv-n01-pair`

Requested declaration: `leftStep`.
Call site: `rightStep(value)`.

The compiler resolves the call to `rightStep`, not `leftStep`. Runtime output
`"right:5"` agrees with the resolved declaration.

Semantic action: `c:judge:false`.
Status: `NOT_READY` because the public source path does not emit the accepted
relation episode or legal candidate group.

### `dv-n02-shadow`

Requested declaration: the outer `function convert`.
Call site: `convert(value)` inside `convertInsideShadow`.

The compiler resolves the call to the nested `function convert`, not the outer
declaration. Runtime output `7` agrees with the nested shadowed function.

Semantic action: `c:judge:false`.
Status: `NOT_READY` for the missing episode and candidate producer.

## Positive control

### `dv-p01-alias`

Requested declaration: `clampRequested`.
Call site: `clampRequested(value)`.

The compiler symbol and signature declaration both resolve to
`function clampRequested`. Runtime output `0` agrees with the declared
non-negative clamp.

Semantic action: `c:judge:true`.
Status: `NOT_READY` for the missing episode and candidate producer.

### `dv-p02-factory`

Requested declaration: `formatRequest`.
Call site: `formatRequest(value)`.

The compiler resolves the call to the local const declaration
`formatRequest`, initialized by `createFormatter("request:")`. Runtime output
`"request:7"` agrees with the stored closure.

Semantic action: `c:judge:true`.
Status: `NOT_READY` for the missing episode and candidate producer.

## Continue for evidence

### `dv-a01-import`

The entry imports `normalizeText` from `./normalizer` and calls it. The
cross-file compiler binding is oracle evidence, while the student step has only
the unread import edge. The legal next action is to advance on that edge.

Semantic action: `c:advance:tsjs:import:./normalizer:normalizeText`.
Status: `NOT_READY` because no typed pending obligation or read receipt is
produced for the legal advance candidate.

### `dv-a02-namespace`

The entry imports the `./dates` namespace and calls
`dateTools.formatDay(value)`. The compiler's final function binding remains
oracle-only evidence until the observed namespace import edge is read.

Semantic action: `c:advance:tsjs:import:./dates:dateTools`.
Status: `NOT_READY` because the typed pending obligation and read receipt are
not emitted.
