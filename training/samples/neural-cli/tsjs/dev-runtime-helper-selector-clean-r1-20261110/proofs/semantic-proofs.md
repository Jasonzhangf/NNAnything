# Clean DEV semantic proof: runtime helper selector

Family: `training/samples/neural-cli/tsjs/dev-runtime-helper-selector-clean-r1-20261110`

This file records the manual and machine-checked semantic evidence for the two
unknown-decision contexts `dv-c01` and `dv-c02`, plus the accepted controls.
Selector values, reached callable identities, oracle results, and labels in
this file are proof-side only. They never enter student observations.

## 1. Declaration exists

`src/dispatch.ts` declares a finite object-literal table and one straight-line
helper:

- `dispatchTable` (`src/dispatch.ts:8-11`) is a `const` object literal with
  exactly two uniquely keyed callable members. Member `spell` is an arrow
  function at `src/dispatch.ts:9:10-9:57`; member `chant` is an arrow function
  at `src/dispatch.ts:10:10-10:53`.
- `pickDispatch` (`src/dispatch.ts:13-15`) takes one parameter `selector` and
  has a single body statement: `return dispatchTable[selector];`
  (`src/dispatch.ts:14:10-14:33`). The return expression is an element access
  whose object is the table identifier and whose index is the parameter.

## 2. Exact outer call sites

Both unknown contexts use the helper-return-then-call shape `helper(selector)(payload)`.

- `dv-c01` direct parameter: `src/dv-c01-direct.ts:7:10-7:41` is the outer call
  `pickDispatch(selector)(payload)` inside `runDirect` (`src/dv-c01-direct.ts:6`).
  The inner selector argument is the caller parameter `selector`.
- `dv-c02` immutable alias: `src/dv-c02-alias.ts:9:10-9:39` is the outer call
  `pickDispatch(chosen)(payload)` inside `runAlias` (`src/dv-c02-alias.ts:7`).
  Line `src/dv-c02-alias.ts:8` is the single `const chosen = selector;` alias
  initializer, and there is no later assignment to `chosen` or `selector`.

## 3. Finite table member selection

The accepted producer (`runTsJsSymbolTable`) parsed both files of each context
and emitted exactly one dynamic binding and exactly two typed role facts for
the same outer call site, all sharing the same raw source-read receipt. Raw
values from `receipts/producer-receipt.json`:

- `dv-c01` `callSiteRef = call:src/dv-c01-direct.ts@7:10-7:41`
  - `selector_candidate_table` value:
    `[{"name":"spell","initializerRef":"member:src/dispatch.ts@9:10-9:57"},{"name":"chant","initializerRef":"member:src/dispatch.ts@10:10-10:53"}]`
  - `runtime_selector_dependency` value:
    `{"tableRef":"table:src/dispatch.ts@8:14-11:2","indexParameter":"selector","useRef":"selector-use:src/dispatch.ts@14:10-14:33"}`
  - `binding.resolution = { status: "dynamic", reason: "dynamic_undecidable" }`,
    `binding.bindingMode = "dynamic"`, `declarationRefs = []`, `scopeRef = null`.
- `dv-c02` `callSiteRef = call:src/dv-c02-alias.ts@9:10-9:39`, with the same
  two roles and the same shared `source-read:call:src/dv-c02-alias.ts@9:10-9:39`
  receipt.

Both cases read both relevant modules completely
(`src/<caller>.ts` and `src/dispatch.ts`) with `coverage.partial = false` and
`parser.semanticBinding = false`.

## 4. Compiler evidence: callee unresolved because of the runtime selector

The compiler proof uses a real TypeScript program and its `TypeChecker`, not a
null symbol on a call expression. Raw values from
`receipts/compiler-receipt.json`:

- Query: `TypeChecker.getTypeAtLocation` on the node
  `ElementAccessExpression "dispatchTable[selector]"`, scoped to the
  `pickDispatch` body return expression (`src/dispatch.ts:14`).
- Result: `((payload: string) => string) | ((payload: string) => number)`,
  `isUnion = true`, `unionPartCount = 2`.
- The named members resolve to single distinct callables:
  `dispatchTable.spell` is `(payload: string) => string` and
  `dispatchTable.chant` is `(payload: string) => number`;
  `membersAreDistinct = true` and each member has exactly one call signature.

Because the return expression's type is the union of two distinct callables
selected by the runtime parameter, the compiler cannot pick one callee at
compile time. The union is not a syntactic or symbol-lookup artifact; it is the
resolved type of the indexed access.

## 5. Controlled runtime contrast (actual callable identity reached)

`proofs/runtime-contrast.mjs` compiles a disposable copy that keeps every outer
call site byte-for-byte identical and instruments only the two table member
bodies to push the reached member key into an exported log. It then runs each
outer call site twice, varying only the selector, holding `payload = "payload"`
constant. Raw values from `receipts/runtime-contrast-receipt.json`:

| context | selector | output | reached member key | reached callee name | reference-identical |
| --- | --- | --- | --- | --- | --- |
| `dv-c01` | `spell` | `spell:payload` | `spell` | `spell` | `=== dispatchTable.spell` |
| `dv-c01` | `chant` | `7` | `chant` | `chant` | `=== dispatchTable.chant` |
| `dv-c02` | `spell` | `spell:payload` | `spell` | `spell` | `=== dispatchTable.spell` |
| `dv-c02` | `chant` | `7` | `chant` | `chant` | `=== dispatchTable.chant` |

`dispatchTable.spell !== dispatchTable.chant` is true. The reached member key at
the unchanged outer call site, the reached callee name, and the reference
equality together show that selector `spell` reaches the `spell` member and
selector `chant` reaches the `chant` member. Distinct outputs alone are not
used as the identity argument.

## 6. Accepted controls

From `receipts/producer-receipt.json`:

- Non-runtime constant selector `src/control-static-selector.ts:7`
  (`pickDispatch("spell")(payload)`): `0` observations and `0` gaps; the
  literal selector is not an identifier selector, so no runtime-selector roles
  are emitted.
- Out-of-slice direct table-index call `src/control-direct-table-index.ts:8`
  (`dispatchTable["spell"](payload)`): `0` observations and `0` gaps; the callee
  expression is an element access, not a helper call.
- Unsupported shape `src/control-branch-helper.ts`: `pickBranch`
  (`src/control-branch-helper.ts:12-17`) returns through a branch, so the outer
  call `pickBranch(selector)(payload)` (`src/control-branch-helper.ts:20`)
  produces `0` observations and one `unsupported_selector_shape` gap. A
  producer rejection is a coverage state, not a negative relation and not a
  semantic unknown.

## 7. Not verified / gaps

- Request-aware admission, cross-partition joins, and coverage obligation
  binding are downstream owners; this family emits raw source observations only.
- No conversion, fitting, scoring, gold, weights, thresholds, adoption, or
  product wiring was performed.
