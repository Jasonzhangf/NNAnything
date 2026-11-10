# Fresh TRAIN helper-form semantic proofs

Family: `train-runtime-helper-selector-fresh-20261110`.

These are independent proof artifacts. They are not student observations,
admitted episodes, supervision rows, or training labels. Every case uses the
exact `helper(selector)(...)` shape over a finite `const` object-literal
callable table. The controlled runtime contrast varies only the selector and
keeps every non-selector input constant.

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

Requested declaration: `parserFor` in
`sources/tr-f01-direct-import-block/strategies.ts`.

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

Requested declaration: `styleFor` in
`sources/tr-f02-alias-single-module/formatter.ts`.

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

Requested declaration: `stepperFor` in
`sources/tr-f03-direct-nested-block/operations.ts`.

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
`NOT_READY` for every case because the accepted request-aware bridge is absent:
there is no `requestId`, `fromStepId`, `pendingRelationRef`, admitted
source-read receipt, request-relative coverage target, or
`runtime_dynamic_selector` completion note.
