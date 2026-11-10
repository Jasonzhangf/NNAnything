# Manual structural proof — family C (Rose, independent verification custody)

This family is authored independently by Rose. It does not read, copy, rename,
or derive its programs from the exposed `verification-independent-callgraph-d`
program, from the TRAIN/DEV source-preparation worktree, or from the
capability-probe text. It uses a fresh unit-conversion domain and new
identifiers and call-site structure.

The family is reserved and sealed. No episode, gold, supervision row, or
student row has been authored yet because the accepted fixed observation
adapter does not emit the typed facts required by the design for the runtime
selector cases. This file records the source-level structural truth that a
valid admission would need, without fabricating role facts.

## registry.ts — runtime table key

`unitTable` stores `toCelsius` and `toFahrenheit` from `units.ts`.
`convertWithTable(direction, value)` applies `unitTable[direction]` where
`direction` is a runtime parameter. The callee for the requested
`units.ts#top:toCelsius` depends on the runtime value. Static truth: unknown,
reason `runtime_dynamic_selector`.

## lookup.ts — runtime map lookup

`lookup` maps `"to_c"` and `"to_f"` to the same two functions.
`convertWithLookup(code, value)` resolves the callee through `lookup.get(code)`
at runtime. The callee for `units.ts#top:toCelsius` depends on the runtime
value. Static truth: unknown, reason `runtime_dynamic_selector`.

## direct.ts — positive control

`freezePoint` imports `toCelsius` from `units.ts` and calls it directly. The
call resolves to `units.ts#top:toCelsius`. Gold: true.

## alias.ts — positive control

`boilPoint` imports `toFahrenheit as toF` from `units.ts` and calls `toF`.
The call resolves to `units.ts#top:toFahrenheit`. Gold: true.

## cross-module.ts — resolved negative

`cross-module.ts` imports `toCelsius` from `other-units.ts`, which declares its
own `toCelsius`. The call resolves to `other-units.ts#top:toCelsius`, not the
requested `units.ts#top:toCelsius`. Gold: false.

## local-shadow.ts — resolved negative

`local-shadow.ts` declares a local `toCelsius` and calls it in `rescale`. The
call resolves to the local declaration, not `units.ts#top:toCelsius`. Gold:
false.

## via-barrel.ts — legal advance edge

`via-barrel.ts` imports `toCelsius` through `barrel.ts`, which re-exports from
`units.ts`. The relation is not terminal from the entry snapshot alone; it
requires reading the barrel module first. This is an advance edge, not a final
judge.

## Readiness

The fixed observation adapter returns only `local` symbol facts and empty
`dynamicMemberBoundaries` for this family. It emits no `import_binding`,
no `call_site` relation, and no `selector_candidate_table` or
`runtime_selector_dependency` fact. Its boundaries report
`typeCheckerSemanticBinding=not_resolved`,
`dynamicComputedProperties=not_resolved`, and
`reExportTargetResolution=not_resolved`. Therefore the terminal unknown
episodes cannot be admitted under the current witness contract. Admission and
conversion are `NOT_READY`; this is an observation gap, not a guessed label.
