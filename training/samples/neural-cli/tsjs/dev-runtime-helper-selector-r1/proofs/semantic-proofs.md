# DEV helper-form semantic proofs

Family: `tsjs-dev-runtime-helper-selector-r1`.

These are independent proof artifacts, not student observations, admitted
episodes, supervision rows, or training labels. The runtime contrast varies
only the selector and keeps every other argument constant.

## `dv-h01-import-alias`

Requested declaration: `pickKernel`.
Call site: `pickKernel(selectedChannel)(input)`.
Current modules: `dispatch.ts` and `entry.ts`.

`channelKernels` is a finite const object literal with distinct callable
members `voice` and `data`. `pickKernel` returns
`channelKernels[channel]` through one straight-line return. The caller uses an
immutable local alias of the direct parameter and has no excluded control
path.

Controlled runtime probes:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `voice` | `9` | `10` |
| `data` | `9` | `36` |

The same input and call site produce different results after changing only
the selector. The case remains `NOT_READY` until the public producer emits both
roles and the request-aware bridge is accepted.

## `dv-h02-local-forward-helper`

Requested declaration: `chooseRenderer`.
Call site: `chooseRenderer(theme)(index)`.
Current module: `index.ts`.

`themeRenderers` is a finite const object literal with distinct callable
members. `chooseRenderer` returns `themeRenderers[theme]` through one
straight-line return. The caller is a function declaration placed before the
helper and uses the direct `theme` parameter. No shadowing, reassignment,
narrowing, branch, or mutation is present.

Controlled runtime probes:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `paper` | `7` | `"paper:7"` |
| `ink` | `7` | `"ink:7"` |

Only the selector changes. The source remains `NOT_READY` until producer roles
and a request-aware bridge exist.

## Controls

`controls/non-runtime-constant.ts` uses a constant helper result and must emit
no runtime-selector role. `controls/out-of-slice-array-index.ts` is a
deliberate array-index control and must remain outside the producer slice.
Neither control is a training instance or a negative semantic label.
