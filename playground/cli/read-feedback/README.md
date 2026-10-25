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
| `prepare.mjs` | Measures the real sandbox cases and writes samples plus real per-label counts; also writes `out/pretrain-samples.json`, a content-free capture of the measured receipts (hidden bytes replaced by `""`) for later replay |
| `train.mjs` | Pretraining entry: zero start, and only the `train` partition may enter the gradient. Fits the base unit, then fits the reasoning unit on the base unit's infer output, and writes both profiles plus `training-report.json`. The report records the declared budget, the fitted episode ids with their partition counts (train only, dev/verification 0), the evaluation-only partitions, and the pre-declared gate verdict. An earlier revision passed all 76 measured cases to the fit; that recorded candidate is kept only as a known-regression reference, never as held-out evidence |
| `reload.mjs` | New process: rebuilds the units from disk and scores the verification partition |
| `verify.mjs` | Eight real trajectories through `runCliReadExpectationGoal` (segmented, exact-8 request, transient recovery, denial stop, denial with budget, transient exhaustion, transient without budget, budget truncation), two entry-level red tests (resource-level request conflict, foreign file reference), and a zeroed-profile sensitivity control |
| `sample.mjs` | Stage 2: deterministic real-usage corpus through the initial candidate, every run records the request-only t0, the real `finalState.attempts` receipts, per-attempt model decisions, and the exact `measureBase`/`measureReasoning` input vectors; writes `out/usage-samples.json` |
| `post-train.mjs` | Stage 3: continued post-training. Warm-starts both fits from the captured initial profiles through the explicit `initialProfile` input, mixes a content-free replay of the pretraining train partition with the new sourced usage supervision, regenerates every reasoning replay input from the current candidate base unit's infer output, and writes the delivery candidate to `out/post/`. Also fits the labeled zero-start diagnostic control into `out/post-zero/`. Never executes a read and never replays a sampled decision. |
| `post-reload.mjs` | Stage 3b: separate process, loads only `out/post/` profiles through `readReadFeedbackUnit` and scores the sampled verification partition; fails if the profiles are missing or a same-process shortcut would be needed |
| `post-regress.mjs` | Stage 3c: the non-regression gate. Compares the initial and the post-use candidate per case on the old gold (pretraining verification partition, evaluation only), reports retained/fixed/regressed/unknown per base head and per reasoning requirement, and puts the per-case verdict in `nonRegression`. `overallQualification` is always `false`/`INCOMPLETE` with its reasons, so a non-regression pass is never reported as an overall pass. The zero-start diagnostic control keeps its real failure numbers (base 87/94, reasoning 8/19) next to it. Writes `out/post-regression-report.json`. |
| `online.mjs` | Stage 4: three-arm paired evaluation (`baseline`, initial candidate, post-use candidate from `out/post/`) on a new deterministic held-out corpus through the same public entry, same I/O cap, same controller; reports root/recovery/accurate stop, reads, requested vs returned bytes, every decision's legality, and an identical-task cache control; writes `out/online-report.json` |

## Online-loop rules

- t0 purity: a sampling task input is only `requestId`, `requirement`, and `path`.
  Hidden file bytes, posterior answers, and same-task caches must never enter the
  request, the declared context, or any recorded model input vector. `sample.mjs`
  asserts this in code.
- Sourced supervision: base labels come from `superviseBase` on the real receipt;
  reasoning labels come from the oracle's recorded `allowed` set. A model
  prediction is never used as a label.
- Continued post-training is warm-started: both fits take the captured initial
  profiles as an explicit `initialProfile`. Omitting that input keeps the original
  zero-start behaviour, so initial training is unchanged. Under warm start the fit
  reports its epoch-0 forward (`epochZero`); it must reproduce the loaded initial
  profile exactly before any gradient step, which `post-train.mjs` asserts against
  an independent forward through the public loader.
- Mixed data: the pretraining train partition is replayed content-free together with
  the new sourced usage supervision. Pretraining dev/verification and the held-out
  corpus are evaluation only and never enter a fit. Every reasoning replay input is
  regenerated from the current candidate base unit's real infer output, never from
  gold feedback and never from an old base prediction.
- A wrong sampled prediction is sourced supervision, not fatal: the oracle's allowed
  set stays the target, the sample is reported in `sampledErrors`, and nothing is
  replayed as a read. Only a structurally unsourced sample (drifted recorded vector,
  or a recorded allowed set that is not the oracle's) is rejected, with its reason in
  `rejectedSamples`. In practice the sampled corpus contains no wrong prediction, so
  both lists are empty in the delivered report.
- Zero start is a diagnostic control only: `out/post-zero/` exists to keep the old
  failure evidence reproducible. It is not a post-training deliverable.
- Non-regression is narrow: `post-regress.mjs` compares initial and post per case on
  the same old gold and puts that verdict in `nonRegression`. Exit code 0 only means
  the report was written, never that the candidate passed. The delivered candidate
  keeps base 94/94 and reasoning 19/19 with zero regressed cases; the zero-start
  diagnostic control reproduces base 87/94 and reasoning 8/19 and fails the gate.
  Non-regression passing is not an overall qualification: `overallQualification` is
  always `false`/`INCOMPLETE` because independent-source generalization is not
  established, efficiency is not proven, and supervision positive gaps remain. For
  the legacy initial candidate the old verification slice is additionally in-sample,
  so it is a known-regression reference and never unseen evidence.
- Attribution: an extra warm-start-plus-replay fit without the new usage supervision
  is reported as an ablation. It scores exactly like the initial candidate on the
  usage partitions, so the observed corrections come from the new sourced feedback,
  not from replay or from added epochs.
- Honest efficiency: an efficiency win is claimed only when a pre-declared cost
  improves while root success, recovery, accurate stop, and legality hold.
  Otherwise `online.mjs` prints "not proven".
- Not applied: the post-use candidate is only a gitignored file under `out/`.
  It carries no applied marker and is never swapped into the runtime profile.

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

## Pretraining sufficiency, and what is still not delivered

The recorded old gold (base 94/94, reasoning 19/19 on the pretraining verification
partition) is a same-source result *and* an in-sample one: the 12 families are
deterministic templates from one author, and the recorded initial candidate was fitted
on the whole 76-case corpus. Those numbers are therefore coverage of what that
candidate already learned, not held-out generalization, and that slice is now only a
known-regression reference. Nothing in this round is called unseen on its strength.

Two chains are kept apart and both are named in `training-report.json`:

- Legacy contaminated chain, `out/`: the recorded initial candidate fitted all 76
  cases, so its verification score is in-sample. Its post candidate and its zero-start
  diagnostic stay as recorded evidence.
- Clean chain, `out/clean/`: a zero-start pretraining entry that fits the `train`
  partition only (dev and verification are evaluation only, never fitted, never a stop
  condition, never a parameter choice), followed by sampling and continued
  post-training from that clean initial. Its verification score is held out relative to
  the clean initial.

Independent-source generalization is not established and is not claimed in either
chain; the same-author cross-family partitions exercise the pipeline only. Efficiency
is still unproven: the three arms request the same 74 held-out bytes. Overall
qualification stays `false`/`INCOMPLETE` and the candidate stays unapplied, whatever
the non-regression result is.
