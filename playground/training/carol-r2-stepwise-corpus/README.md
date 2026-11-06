# TS/JS r2 fixed stepwise corpus generator

This directory contains the Carol-owned fixed local-step corpus generator for
the accepted contract:

```text
/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-converter-mapping-design-r2-20261106.md
```

The implementation follows section 12 and the delivery/test conditions of board
task `carol-tsjs-r2-stepwise-corpus-20261106`.

## Files

| File | Role |
| --- | --- |
| `generate-fixed-stepwise.mjs` | Runnable generator and exported `generateFixedStepwise` API |
| `tests/carol-tsjs-r2-stepwise-corpus.test.mjs` | Black-box red/green test in the worktree test tree |
| `README.md` | This file |

## Scope and boundaries

- Student rows contain local observations, typed gain, legal candidates,
  previous execution, receipts, and cursor state only.
- Supervision rows contain independent `A_g`, gold-directed terminal action,
  training admission, not-ready reasons, and conflicts only.
- Shared converter sources remain owned by Iris and are not modified.
- The original corpus is read-only. New output is written only to the
  task-exclusive directory.
- No training, evaluation, weight/gold/threshold/adoption change, install, or
  restoration of legacy `nn-code` is performed.

## Inputs

The generator reads the accepted corpus:

```text
/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/.worker-runs/jenny-tsjs-first-fit-engineering-r1/real-train-train-only/corpus
```

It reads two families:

- `train-module-export-alias-a`: six samples including alias/re-export trails
  and the missing-module sample.
- `train-closure-call-a`: four samples including shadow/other-module bindings
  and the dynamic-property sample.

The TypeScript compiler API is loaded from the main repository
`node_modules/typescript` (5.9.3) so the worktree does not need its own
`node_modules`.

## Run

```sh
cd /Volumes/Intel/playground/nnanything-worktrees/carol-tsjs-r2-stepwise-corpus-20261106
node playground/training/carol-r2-stepwise-corpus/generate-fixed-stepwise.mjs \
  --out /Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/.worker-runs/carol-tsjs-r2-stepwise-corpus-20261106/output
```

Output:

```text
student-observations.jsonl
independent-supervision.jsonl
self-check.json
field-mapping.md
generate-fixed-stepwise.mjs   (runnable script copy)
```

## Test

```sh
node --test tests/carol-tsjs-r2-stepwise-corpus.test.mjs
```

The test asserts:

- step0 is a real `source_observation`, not `known/null`;
- consecutive alias advance steps carry the correct predecessor and its
  receipt to the next step;
- request declared fields that are not observable stay `missing` and are not
  reconstructed from the target module;
- the three unrelated `entry.ts` import edges in the other-module sample remain
  preserved and produce no advance candidate;
- `known/none` observations do not emit observe candidates;
- `dynamic-property` and `missing-module` remain not training eligible;
- changing gold/teacher supervision leaves student bytes unchanged.
