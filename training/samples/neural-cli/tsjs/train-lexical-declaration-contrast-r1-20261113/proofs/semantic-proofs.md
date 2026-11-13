# Direct import lexical declaration contrast proof

Family: `tsjs-train-lexical-declaration-contrast-r1-20261113`

This file is an independent semantic proof. It is not a student observation,
candidate feature row, model score, or injected verdict.

## Source set

- `sources/caller.ts`
- `sources/primary.ts`
- `sources/secondary.ts`

The caller contains one direct named import:

```ts
import { normalizeReading as normalize } from "./primary";
export const result = normalize(7);
```

The call-site span is `sources/caller.ts:2:23-2:35`, covering the local callee
`normalize`. The producer must derive this span from the AST. A copied request
string is not accepted as a call-site observation.

## Compiler API receipt

`compiler-api-receipt.json` records the TypeScript 5.9.3 compiler API result.
The compiler resolves the local alias `normalize` to:

```text
decl:sources/primary.ts#top:normalizeReading
module:sources/primary.ts
```

The imported name is `normalizeReading`, and the local alias is `normalize`.
The compiler reported no diagnostics for the three source files.

## Supervision

The producer and bridge receive the same observed binding for both requests.
Only the requested declaration is different.

| sampleId | compiler-proven declaration | request identity | projected observed declaration | fixed supervision |
| --- | --- | --- | --- | --- |
| `lp-r1-same-declaration` | `decl:sources/primary.ts#top:normalizeReading` | `decl:sources/primary.ts#top:normalizeReading` | `decl:sources/primary.ts#top:normalizeReading` | `c:judge:true` |
| `lp-r1-different-module` | `decl:sources/secondary.ts#top:normalizeReading` | `decl:sources/secondary.ts#top:normalizeReading` | `decl:sources/primary.ts#top:normalizeReading` | `c:judge:false` |

The second request is a same-name, different-module comparison. The
declaration identity and module identity differ even though the exported
function name is the same.

The accepted request format remains `decl:<file>#top:<name>`. The lexical
bridge maps only structurally proven top-level functions to that shared
identity. Producer span IDs remain unchanged in raw output and evidence.
The mapping is request-blind. The materializer asserts `x[61]/x[62]` are
`1/1` for the same declaration and `0/0` for the different-module declaration.

The requested declaration is task input. It does not alter
the producer selection. The student observation contains the source-backed
binding and declaration projection only. It contains no `judge=true`,
`judge=false`, `judge=unknown`, or verdict field.

## Source-read boundary

The producer request reads all three files. If `sources/primary.ts` is removed
from the read set, the lexical producer reports
`module_not_in_read_set`, emits no source-module read receipt, and the bridge
must emit no declaration projection for judge candidates. This missing-source
case is an acquisition control and is not a training group.
