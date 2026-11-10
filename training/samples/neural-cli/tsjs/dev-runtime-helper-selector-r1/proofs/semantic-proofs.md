# DEV helper-form semantic proofs

Family: `tsjs-dev-runtime-helper-selector-r1`.

These are independent proof artifacts, not student observations, admitted
episodes, supervision rows, or training labels. The runtime contrast varies
only the selector and keeps every other argument constant.

The proof receipt is `raw-checks.json` (`nnanything.tsjs.helper-source-checks.v2`)
under the task run directory. It records the resolved helper symbol, the
resolved table symbol, the single return of `table[selector]`, unique member
keys with declaration positions, the outer call site, and per-selector
reference equality between the helper result and the concrete table member.
A null symbol on the outer `CallExpression` callee is not used as evidence.

## Partition isolation status

Independent DEV authorship is not established. Both the TRAIN and DEV source
families were authored by the same execution context: `peer-15`, Codex
session `01a1c6ca-701b-7d91-bf1a-17ac63a705a7`, on 2026-11-10 in
`/Volumes/Intel/playground/nnanything/tsjs-helper-source-20261110`. No
separate DEV author, author session, or allowed-input boundary exists in the
receipts. The pre-generation declaration asserted separate authorship but
named no author or access boundary, so that assertion is not used as
isolation evidence. Both lineage manifests retain
`independentNonDerivationVerified=false`.

The DEV family is preserved as unadmitted preparation. A clean DEV author
must be assigned with only the accepted contract and DEV scope. The existing
sources must not be deleted or silently relabelled. TRAIN preparation and
bridge engineering continue independently.

## `dv-h01-import-alias`

Requested declaration: `pickKernel` in
`sources/dv-h01-import-alias/dispatch.ts`.
Outer call site: `sources/dv-h01-import-alias/entry.ts:5:10`,
`pickKernel(selectedChannel)(input)`.

Structural proof:

- `channelKernels` is a `const` object literal with unique callable members
  `voice` (`dispatch.ts:4`) and `data` (`dispatch.ts:5`).
- `pickKernel` has exactly one statement, `return channelKernels[channel]`.
- `selectedChannel` is one immutable local alias declared as
  `const selectedChannel = channel;` and is not reassigned before the call.
- No shadowing, narrowing, branch, mutation, or other excluded control path
  is present.

Actual callable identity, per selector at the same outer call site:

| Selector | `helper(selector) === table[selector]` | Inferred callable name | Member declaration |
| --- | --- | --- | --- |
| `voice` | true | `voice` | `dispatch.ts:4` |
| `data` | true | `data` | `dispatch.ts:5` |

The two selectors reach distinct function references. The outer call-site
result equals the reached member result for each selector.

Controlled runtime contrast:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `voice` | `9` | `10` |
| `data` | `9` | `36` |

Source and semantic proof are supported. Admission remains `NOT_READY`
because the request-aware bridge is absent and independent DEV authorship is
not established.

## `dv-h02-local-forward-helper`

Requested declaration: `chooseRenderer` in
`sources/dv-h02-local-forward-helper/index.ts`.
Outer call site: `sources/dv-h02-local-forward-helper/index.ts:9:10`,
`chooseRenderer(theme)(index)`.

Structural proof:

- `themeRenderers` is a `const` object literal with unique callable members
  `paper` (`index.ts:4`) and `ink` (`index.ts:5`).
- `chooseRenderer` has exactly one statement, `return themeRenderers[theme]`.
- The caller is a function declaration placed before the local helper and
  uses the direct `theme` parameter.
- No shadowing, reassignment, narrowing, branch, or mutation is present.

Actual callable identity, per selector at the same outer call site:

| Selector | `helper(selector) === table[selector]` | Inferred callable name | Member declaration |
| --- | --- | --- | --- |
| `paper` | true | `paper` | `index.ts:4` |
| `ink` | true | `ink` | `index.ts:5` |

The two selectors reach distinct function references. The outer call-site
result equals the reached member result for each selector.

Controlled runtime contrast:

| Selector | Non-selector input | Result |
| --- | --- | --- |
| `paper` | `7` | `"paper:7"` |
| `ink` | `7` | `"ink:7"` |

Source and semantic proof are supported. Admission remains `NOT_READY`
because producer roles, the request-aware bridge, and independent DEV
authorship are not established.

## Controls

`controls/non-runtime-constant.ts` uses a constant helper result and must emit
no runtime-selector role. `controls/out-of-slice-array-index.ts` is a
deliberate array-index control and must remain outside the producer slice.
Neither control is a training instance or a negative semantic label.
