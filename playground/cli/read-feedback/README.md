# CLI read feedback experiment entries (M1)

Module prefix `cli-read-feedback/read-expectation`; public package entry `nnanything/cli-read-feedback`.

Two units only:

- `ReadFeedbackUnit`: per-head multi-label base feedback over real `file.read` receipts.
  Supervised states: `data_obtained`, `end_observed`, `incomplete_observation`,
  `execution_error`, `target_changed`, `observation_unknown`. Each head has its own
  supervision mask `m_h`; a head whose facts were not measured contributes no loss.
- `ReadReasoningUnit`: single next requirement over the base unit's infer output.
  Labels: `condition_met`, `need_remaining_data`, `need_current_target`,
  `retry_current_read`, `terminal_error`, `need_observation`. Acceptance is
  `argmax ∈ allowed set`, and the allowed set comes from the independent oracle.

Input masks (`*_measured`) are features only. They never gate loss; only an unknown
output label (`m_h=0`) skips that head's loss and gradient.

## Entries

All entries need a Handwired source root: `NN_HANDWIRED_ROOT=<dir containing src/runtime/numeric-ui-core.ts>`.
Outputs default to `playground/cli/read-feedback/out` (`NN_OUT_DIR` overrides).

| Entry | What it does |
| --- | --- |
| `prepare.mjs` | Measures the real sandbox cases and writes samples plus real per-label counts |
| `train.mjs` | Fits the base unit, then fits the reasoning unit on the base unit's infer output, writes both profiles |
| `reload.mjs` | New process: rebuilds the units from disk and scores the verification partition |
| `verify.mjs` | Four real trajectories through `runCliReadExpectationGoal` (segmented, transient recovery, denial stop, budget truncation) plus a zeroed-profile sensitivity control |
| `online.mjs` | Online stage 1 only: baseline versus initially trained candidate, both through the same public entry and the same I/O cap |

## One public entry, one controller

`runCliReadExpectationGoal` is the only read-feedback execution entry. It plugs this
domain into the existing `runRecursiveGoal` controller:

- The root goal is a cover goal; the root evaluator decides success from real coverage
  and quantity against the user requirement. The model never decides the root.
- The model's current requirement binds exactly one child goal through a fixed binding:
  `need_remaining_data` → the uncovered range, `retry_current_read` → the same range,
  `need_current_target` → the same range on a re-bound file reference,
  `condition_met`/`terminal_error`/`need_observation` → no child (the chain closes).
- `executeAtomic` performs one real bounded read; its receipt updates the explicit
  State (attempts, coverage, reads). The controller, not this domain, owns retry
  limits: it admits the bounded retry policy and repeats a no-effect read.
- A model answer outside the oracle's allowed set throws at that step, so the run stops
  and no further operation follows. `verify.mjs` asserts every recorded decision
  against the allowed set, and a zeroed reasoning profile must fail it.

## Facts that drove the implementation

- `eof` from the reader is a short-read flag, not an end-of-file truth. The harness
  derives `end_at_read = size_measured && bytes_read_measured && request_measured && (offset + bytesRead >= size)`.
- `coverage_complete` covers the user-requested range, not the whole file. `head 3` on a
  large file needs only `[0,3)`; `up_to` truncates at a confirmed end.
- The base unit needs the requirement mode to tell a short read at a confirmed end
  (whole, `up_to`) apart from a real shortfall (`exact`), so the mode wires are part of
  its input. Wire counts are derived from the arrays, never hardcoded.
- A terminal read error (EACCES) stays a real failure and stops the run. Only a
  transient code the controller may safely repeat is treated as a completed no-effect
  step. A shortfall at a confirmed end is reported, never fabricated as success.
