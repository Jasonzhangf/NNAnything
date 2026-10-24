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
| `verify.mjs` | Eight real trajectories through `runCliReadExpectationGoal` (segmented, exact-8 request, transient recovery, denial stop, denial with budget, transient exhaustion, transient without budget, budget truncation), two entry-level red tests (resource-level request conflict, foreign file reference), and a zeroed-profile sensitivity control |
| `online.mjs` | Online stage 1 only: baseline versus initially trained candidate, both through the same public entry and the same I/O cap |

## One public entry, one controller

`runCliReadExpectationGoal` is the only read-feedback execution entry. Its first
argument is the request: `requestId`, `requirement`, and `path`. The request is the
only source of the requested meaning. Execution resources carry the sandbox, session,
unit, and context, and must not repeat `requirement` or `path`; if they do, the entry
rejects the call before any read. A supplied `fileRef` is only accepted when it binds
the requested path in the requested session, so one request cannot read its path with
another target's reference. The entry re-binds the requested path itself.

It plugs this domain into the existing `runRecursiveGoal` controller:

- The root goal is a cover goal; the root evaluator decides success from real coverage
  and quantity against the user requirement. The model never decides the root.
- The model's current requirement binds exactly one child goal through a fixed binding:
  `need_remaining_data` → the uncovered range, `retry_current_read` → the same range,
  `need_current_target` → the same range on a re-bound file reference,
  `condition_met`/`terminal_error`/`need_observation` → no child (the chain closes).
- `executeAtomic` performs one real bounded read; its receipt updates the explicit
  State (attempts, coverage, reads). The controller, not this domain, owns retry
  limits: the entry always admits the bounded retry policy, and `assessRetry` consumes
  the model decision at that boundary. The model's `retry_current_read` is only a
  necessary condition; the controller's typed counting, permission, and effect checks
  still decide whether the repeat runs.
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
- Every read that produced a definite receipt, data or error, is a completed step that
  crossed no effect boundary, so the controller always hands the real error to the
  domain assessment. The model records its decision there: a transient error with
  retry budget left records `retry_current_read` and the controller then decides
  whether the typed repeat actually runs; a terminal error records `terminal_error`
  and is never repeated, even when a budget exists. Running out of budget is recorded
  as `terminal_error` from the real failure history, never claimed from a positive
  declared budget. A shortfall at a confirmed end is reported, never fabricated as
  success.
