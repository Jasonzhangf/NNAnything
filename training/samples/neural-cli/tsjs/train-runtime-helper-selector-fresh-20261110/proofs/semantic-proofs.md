# Fresh TRAIN helper-form semantic proofs

Family: `train-runtime-helper-selector-fresh-20261110`.

These are independent proof artifacts. They are not student observations,
admitted episodes, supervision rows, or training labels. Every case uses the
exact `helper(selector)(...)` shape over a finite `const` object-literal
callable table. The controlled runtime contrast varies only the selector and
keeps every non-selector input constant.

Target semantics: the uncertain outer-call target is the callable returned by
`helper(selector)` and invoked with the payload. That target is one of the
finite `const` table-member callables, not the helper declaration itself. Each
case below records the requested target-mapping to an actual table member and
its distinct alternative, taken from the public producer's
`callableTable.members[*].callableIdentity` evidence (declaration, module, and
span). The helper name is the selection mechanism only.

The machine receipt is `receipts/raw-checks.json`
(`nnanything.tsjs.helper-source-checks.fresh-train.v1`,
`CHECKS_COMPLETE`). The structural part resolves the helper symbol and the
table symbol with `TypeScript createProgram + getTypeChecker +
getSymbolAtLocation`, confirms one straight-line `return table[selector]`,
records each unique member key with its declaration position, and identifies
the exact outer call site and selector path. The runtime part compiles each
case to CommonJS in a disposable directory, appends proof-only exports for the
helper module, and compares `helper(selector) === table[selector]` by reference
while recording the outer call result and the reached member result.

A null symbol on the outer `CallExpression` callee is not used as evidence.
The raw public-producer observation is `receipts/public-producer-output.json`.

## `tr-f01-direct-import-block`

Selector helper (selection mechanism): `parserFor` in
`sources/tr-f01-direct-import-block/strategies.ts`.

Requested outer-call target: table member `strict`,
`callable.arrow_function:sources/tr-f01-direct-import-block/strategies.ts@4:11-4:38`
(module `sources/tr-f01-direct-import-block/strategies.ts`, span 4:11-4:38).
Distinct alternative: table member `loose`,
`callable.arrow_function:sources/tr-f01-direct-import-block/strategies.ts@5:10-5:30`.
Both mappings come from `callableTable.members[*].callableIdentity` in
`receipts/public-producer-output.json`.

Outer call site: `sources/tr-f01-direct-import-block/routes.ts:4:18`,
`parserFor(strategy)(raw)`.

Structural proof:

- `parsers` is a `const` object literal with unique callable members `strict`
  (`strategies.ts:4`) and `loose` (`strategies.ts:5`).
- `parserFor` has exactly one statement, `return parsers[strategy]`.
- The caller passes the direct `strategy` parameter and captures the result in
  a `const` before returning. No shadowing, reassignment, narrowing, branch,
  or mutation is present.
- The compiler resolves the helper and the table to single declarations. Zero
  pre-emit diagnostics are reported.

Actual callable identity at the same outer call site:

| Selector | `helper(selector) === table[selector]` | Reached callable name | Member declaration |
| --- | --- | --- | --- |
| `strict` | true | `strict` | `strategies.ts:4` |
| `loose` | true | `loose` | `strategies.ts:5` |

Controlled runtime contrast (non-selector input constant at `"  hi  "`):

| Selector | Result |
| --- | --- |
| `strict` | `hi` |
| `loose` | `  hi  ` |

The two selectors reach distinct function references. The outer call-site
result equals the reached member result for each selector.

## `tr-f02-alias-single-module`

Selector helper (selection mechanism): `styleFor` in
`sources/tr-f02-alias-single-module/formatter.ts`.

Requested outer-call target: table member `currency`,
`callable.arrow_function:sources/tr-f02-alias-single-module/formatter.ts@4:13-4:56`
(module `sources/tr-f02-alias-single-module/formatter.ts`, span 4:13-4:56).
Distinct alternative: table member `percent`,
`callable.arrow_function:sources/tr-f02-alias-single-module/formatter.ts@5:12-5:63`.
Both mappings come from `callableTable.members[*].callableIdentity` in
`receipts/public-producer-output.json`.

Outer call site: `sources/tr-f02-alias-single-module/formatter.ts:14:10`,
`styleFor(chosen)(amount)`.

Structural proof:

- `styles` is a `const` object literal with unique callable members `currency`
  (`formatter.ts:4`) and `percent` (`formatter.ts:5`).
- `styleFor` has exactly one statement, `return styles[style]`.
- `chosen` is one immutable local alias declared as `const chosen = style;` and
  is not reassigned before the call. The table, helper, and caller share one
  module; no excluded control path is present.

Actual callable identity at the same outer call site:

| Selector | `helper(selector) === table[selector]` | Reached callable name | Member declaration |
| --- | --- | --- | --- |
| `currency` | true | `currency` | `formatter.ts:4` |
| `percent` | true | `percent` | `formatter.ts:5` |

Controlled runtime contrast (non-selector input constant at `12.5`):

| Selector | Result |
| --- | --- |
| `currency` | `$12.50` |
| `percent` | `1250.0%` |

The two selectors reach distinct function references. The outer call-site
result equals the reached member result for each selector.

## `tr-f03-direct-nested-block`

Selector helper (selection mechanism): `stepperFor` in
`sources/tr-f03-direct-nested-block/operations.ts`.

Requested outer-call target: table member `add`,
`callable.arrow_function:sources/tr-f03-direct-nested-block/operations.ts@4:8-4:34`
(module `sources/tr-f03-direct-nested-block/operations.ts`, span 4:8-4:34).
Distinct alternative: table member `multiply`,
`callable.arrow_function:sources/tr-f03-direct-nested-block/operations.ts@5:13-5:39`.
Both mappings come from `callableTable.members[*].callableIdentity` in
`receipts/public-producer-output.json`.

Outer call site: `sources/tr-f03-direct-nested-block/index.ts:5:12`,
`stepperFor(step)(base)`.

Structural proof:

- `steppers` is a `const` object literal with unique callable members `add`
  (`operations.ts:4`) and `multiply` (`operations.ts:5`).
- `stepperFor` has exactly one statement, `return steppers[step]`.
- The call site is a direct `step` parameter inside one nested block statement.
  No shadowing, reassignment, narrowing, branch, or mutation is present.

Actual callable identity at the same outer call site:

| Selector | `helper(selector) === table[selector]` | Reached callable name | Member declaration |
| --- | --- | --- | --- |
| `add` | true | `add` | `operations.ts:4` |
| `multiply` | true | `multiply` | `operations.ts:5` |

Controlled runtime contrast (non-selector input constant at `41`):

| Selector | Result |
| --- | --- |
| `add` | `42` |
| `multiply` | `82` |

The two selectors reach distinct function references. The outer call-site
result equals the reached member result for each selector.

## Controls

`controls/static-selector.ts` passes a constant selector literal and must emit
no runtime-selector role. `controls/direct-index.ts` is a deliberate direct
table-index call and remains outside the reviewed helper slice. Both controls
produce zero producer observations and zero gaps. They are producer
observations only, not negative labels, student rows, or training samples.

## Readiness

Source, structural proof, controlled callable-identity contrast, and raw public
producer observation are complete for all three cases. Admission remains
`NOT_READY` for every case because this family has not been passed through the
existing request-aware admission/config path. The bridge and bounded
completion engineering are already accepted; the independent successor
`tsjs-request-aware-admission-config-r1-20261110` owns that path. This family
does not add a bridge implementation and is not made a dependency of the
accepted-family successor. No typed role, join, candidate group, or receipt is
invented here.

## Incremental purpose

Relative to the already accepted TRAIN source/proof preparation `bb67cd7`,
this fresh family adds three independently authored runtime-unknown contexts
with distinct module arrangements, selector constructions, and call-site
layouts. It does not displace the accepted preparation or the active
request-aware admission task. If no independent increment is confirmed by the
reviewer, it is retained as extra unadmitted preparation.
