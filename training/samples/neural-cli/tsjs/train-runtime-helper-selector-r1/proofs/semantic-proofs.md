# TRAIN helper-form semantic proofs

Family: `tsjs-train-runtime-helper-selector-r1`.

These are independent proof artifacts, not student observations, admitted
episodes, supervision rows, or training labels. All cases use the exact
`helper(selector)(...)` shape over a finite `const` object-literal callable
table. The runtime contrast varies only the selector and keeps every other
argument constant.

The proof receipt is `raw-checks.json` (`nnanything.tsjs.helper-source-checks.v2`)
under the task run directory. It records the resolved helper symbol, the
resolved table symbol, the single return of `table[selector]`, unique member
keys with declaration positions, the outer call site, and per-selector
reference equality between the helper result and the concrete table member.
A null symbol on the outer `CallExpression` callee is not used as evidence.

## `tr-h01-import-direct`

Requested declaration: `email` in
`sources/tr-h01-import-direct/lookup.ts`.
Outer call site: `sources/tr-h01-import-direct/entry.ts:4:10`,
`selectDelivery(mode)(message)`.

Structural proof:

- `deliveryHandlers` is a `const` object literal with unique callable members
  `email` (`lookup.ts:4`) and `sms` (`lookup.ts:5`).
- `selectDelivery` has exactly one statement, `return deliveryHandlers[mode]`.
- The caller passes the direct `mode` parameter. No shadowing, reassignment,
  narrowing, branch, or mutation is present.
- The compiler resolves the helper to one function declaration and the table
  to one variable declaration whose initializer is the object literal.

Actual callable identity, per selector at the same outer call site:

| Selector | `helper(selector) === table[selector]` | Inferred callable name | Member declaration |
| --- | --- | --- | --- |
| `email` | true | `email` | `lookup.ts:4` |
| `sms` | true | `sms` | `lookup.ts:5` |

The two selectors reach distinct function references. The outer call-site
result equals the reached member result for each selector.

Controlled runtime contrast:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `email` | `"ping"` | `"email:ping"` |
| `sms` | `"ping"` | `"sms:ping"` |

The source and semantic proof are supported. Admission remains `NOT_READY`
until the public producer emits both source-read-backed roles and the
request-aware bridge is accepted.

## `tr-h02-local-alias`

Requested declaration: `double` in
`sources/tr-h02-local-alias/index.ts`.
Outer call site: `sources/tr-h02-local-alias/index.ts:14:10`,
`chooseScale(selectedScale)(amount)`.

Structural proof:

- `scaleOperations` is a `const` object literal with unique callable members
  `double` (`index.ts:4`) and `triple` (`index.ts:5`).
- `chooseScale` has exactly one statement, `return scaleOperations[mode]`.
- `selectedScale` is one immutable local alias declared as
  `const selectedScale = mode;` and is not reassigned before the call.
- The helper and table are local to the same module; no excluded control path
  is present.

Actual callable identity, per selector at the same outer call site:

| Selector | `helper(selector) === table[selector]` | Inferred callable name | Member declaration |
| --- | --- | --- | --- |
| `double` | true | `double` | `index.ts:4` |
| `triple` | true | `triple` | `index.ts:5` |

The two selectors reach distinct function references. The outer call-site
result equals the reached member result for each selector.

Controlled runtime contrast:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `double` | `6` | `12` |
| `triple` | `6` | `18` |

The source and semantic proof are supported. Admission remains `NOT_READY`
until producer roles and the request-aware bridge exist.

## `tr-h03-default-export-caller`

Requested declaration: `hex` in
`sources/tr-h03-default-export-caller/registry.ts`.
Outer call site: `sources/tr-h03-default-export-caller/entry.ts:4:10`,
`formatValue(kind)(value)`.

Structural proof:

- `valueFormatters` is a `const` object literal with unique callable members
  `hex` (`registry.ts:4`) and `fixed` (`registry.ts:5`).
- `formatValue` has exactly one statement, `return valueFormatters[kind]`.
- The call site is inside a default-exported function declaration using the
  direct `kind` parameter. No excluded control path is present.

Actual callable identity, per selector at the same outer call site:

| Selector | `helper(selector) === table[selector]` | Inferred callable name | Member declaration |
| --- | --- | --- | --- |
| `hex` | true | `hex` | `registry.ts:4` |
| `fixed` | true | `fixed` | `registry.ts:5` |

The two selectors reach distinct function references. The outer call-site
result equals the reached member result for each selector.

Controlled runtime contrast:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `hex` | `31` | `"1f"` |
| `fixed` | `31` | `"31.00"` |

The source and semantic proof are supported. Admission remains `NOT_READY`
until the public producer emits the two roles and a request-aware bridge is
accepted.

## Controls

`controls/non-runtime-constant.ts` uses a constant helper result and must emit
no runtime-selector role. `controls/out-of-slice-direct-index.ts` is a
deliberate direct-index control and must remain outside the producer slice.
Neither control is a training instance or a negative semantic label.
