# Manual structural proof

This file records the source-level structural proof for each sample in this
family. The source is a fresh, project-authored independent verification
fixture. It is not a renamed copy of any TRAIN or DEV family.

## entry-alias

`entry-alias.ts` imports `scaleBy as grow` from `./barrel`.
`barrel.ts` re-exports `scaleBy` from `./math-ops`.
The call `grow(6, 7)` therefore resolves to `math-ops.ts#top:scaleBy`.
Gold: `true`.

## pipeline

`pipeline.ts` imports `offsetBy` from `./barrel`.
`buildPipeline` returns the inner `step` function.
The inner `step` calls `offsetBy`, which resolves through `barrel.ts` to
`math-ops.ts#top:offsetBy`.
Gold: `true`.

## shadow

`shadow.ts` imports `offsetBy` from `./barrel`, but `buildShadowed` declares a
local `const offsetBy` before the inner `step`.
The inner `step` calls that local function, not the imported binding.
The query for `math-ops.ts#top:offsetBy` is therefore `false`.
Gold: `false`.

## entry-dynamic

`entry-dynamic.ts` stores both `scaleBy` and `offsetBy` in `table`.
`dispatch` selects a property with the runtime parameter `selector`.
The relation to `math-ops.ts#top:scaleBy` depends on the runtime selector value;
it is neither definitely true nor definitely false from the static input.
Gold: `unknown` with `unknownReason: runtime_dynamic_selector`.
