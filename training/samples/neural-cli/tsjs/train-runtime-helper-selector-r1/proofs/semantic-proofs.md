# TRAIN helper-form semantic proofs

Family: `tsjs-train-runtime-helper-selector-r1`.

These are independent proof artifacts, not student observations, admitted
episodes, supervision rows, or training labels. All cases use the exact
`helper(selector)(...)` shape over a finite `const` object-literal callable
table. The runtime contrast varies only the selector and keeps every other
argument constant.

## `tr-h01-import-direct`

Requested declaration: `selectDelivery`.
Call site: `selectDelivery(mode)(message)`.
Current modules: `lookup.ts` and `entry.ts`.

`deliveryHandlers` is a finite const object literal with distinct callable
members `email` and `sms`. `selectDelivery` returns
`deliveryHandlers[mode]` through one straight-line return. The caller passes
the direct `mode` parameter into the helper, and no shadowing, reassignment,
narrowing, mutation, or alternate control path is present.

Controlled runtime probes:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `email` | `"ping"` | `"email:ping"` |
| `sms` | `"ping"` | `"sms:ping"` |

The same input and call site produce distinct handler outputs after changing
only the selector. Compiler evidence for the outer callee remains unresolved
at the dynamic selector. The source is `NOT_READY` until the public producer
emits both source-read-backed roles and the request-aware bridge is accepted.

## `tr-h02-local-alias`

Requested declaration: `chooseScale`.
Call site: `chooseScale(selectedScale)(amount)`.
Current module: `index.ts`.

`scaleOperations` is a finite const object literal with distinct callable
members. `chooseScale` returns `scaleOperations[mode]` through one
straight-line return. `selectedScale` is one immutable local alias of the
direct caller parameter and is not reassigned before the call.

Controlled runtime probes:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `double` | `6` | `12` |
| `triple` | `6` | `18` |

Only the selector changes. The helper and table are local to the same module.
The case remains `NOT_READY` until producer roles and the request-aware bridge
exist.

## `tr-h03-default-export-caller`

Requested declaration: `formatValue`.
Call site: `formatValue(kind)(value)`.
Current modules: `registry.ts` and `entry.ts`.

`valueFormatters` is a finite const object literal with distinct callable
members. `formatValue` returns `valueFormatters[kind]` through one
straight-line return. The call site is inside a default-exported function
declaration using the direct `kind` parameter. No excluded control path is
present.

Controlled runtime probes:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `hex` | `31` | `"1f"` |
| `fixed` | `31` | `"31.00"` |

Only the selector changes. The source remains `NOT_READY` until the public
producer emits the two roles and a request-aware bridge is accepted.

## Controls

`controls/non-runtime-constant.ts` uses a constant helper result and must emit
no runtime-selector role. `controls/out-of-slice-direct-index.ts` is a
deliberate direct-index control and must remain outside the producer slice.
Neither control is a training instance or a negative semantic label.
