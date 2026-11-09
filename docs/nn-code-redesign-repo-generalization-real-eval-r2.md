# NN Code: repo generalization real-eval r2 preparation

Status: 2026-11-09 design/preparation draft, owner Carol, reviewer Alice.
This document prepares the executable contract and corpus-admission evidence
for the repo-association/generalization real evaluation. It does not change
product, weights, gold, thresholds, adoption, wiring, install, or legacy
nn-code. No fit, training, sampling, wiring, install, or real evaluation is
started by this document.

## 0. Source evidence and accepted boundary

1. Roadmap: `docs/autonomous-capability-roadmap.md` NN-code MVP and the
   parallel redesign queue require a usable training loop whose evaluation
   includes independent holdout, old-capability regression, candidate
   `uncalibrated/not_applied`, and no future information in `t0`.
   Evidence lines: real entry at 146; completion gate at 148; current state
   and evaluate engineering at 149.
2. TS/JS symbols design: `docs/nn-code-redesign-symbols-tsjs-design.md`
   preserves the accepted four-element contract, the 64-slot `x[64]` encoder,
   the shared candidate scorer, and `label_missing`/unknown-coverage rules.
   Evidence lines: evaluation section start at 144; final hard gate at
   150-158; independent oracle assertion at 160-162; training/evaluation
   boundary at 181; INCOMPLETE lifecycle at 183.
3. Training entry and reload:
   `docs/nn-code-tsjs-training-entry-reload-contract.md` defines public
   `convert-samples` / `validate-data` / `train` / `resume` commands, typed
   model-package and checkpoint schemas, TRAIN-only admission, and new-process
   reload. At the accepted preparation baseline, `evaluate` stays NOT_READY
   until the independent holdout route is connected; Henry's current candidate
   and review status is separate from that baseline. Evidence lines: public
   entry at 22; historical evaluate NOT_READY at 42; new-process reload at 65;
   TRAIN-only admission at 72; model-package schema at 88; checkpoint boundary
   at 128; residual evaluate/timing at 188 and 223.
4. r1 evaluation mechanism:
   `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/frank-repo-generalization-evaluation-contract.md`
   revision 5 defines the NEV response contract, manifest-driven denominators,
   five separated denominators, partition leakage checks, root-status gates,
   and `t0` backfill rejection. Evidence lines: closed evaluation surface at
   23-28; manifest-driven denominator at 35-45; response contract at 51-111;
   partition contract at 113-132; root and no-backfill at 134-139; hard gates
   at 141-152; separated denominators at 172; Emma alignment at 267-274;
   Alice revision 4 denominator statistics at 283-288.
5. r1 real-eval projection:
   `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-tsjs-real-eval-projection-r1.md`
   maps the accepted TS/JS import/reexport/alias/terminal-declaration slice
   into the NEV view and proves the transport with four synthetic/oracle
   samples. Evidence lines: scope and independent family at 8-23; three-state
   evaluation at 25-44; identity and reference rules at 47-70; field
   projection at 72-127; gold authority and partition at 133-153;
   reproducible commands at 155-206; limitations at 208-211.
6. Alice route:
   `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-overall-redesign-route-r1.md`
   accepted Frank revision 5 with the boundary "design plus current TS slice
   offline eval prototype, not production evaluation environment or
   model-score acceptance" (159-163); real application still requires current
   TS real response projection, independent gold, source partition, and a
   public candidate evaluation entry. It also accepts the real-eval r1
   projection only as design/evaluation prep, not model-quality or real-repo
   generalization (244-250), and does not block the TS first fit.

This r2 slice closes one narrow gap: turn the accepted offline evaluator/projection
into a reproducible real-repo association/generalization evaluation contract with
named denominators, partition axes, fixed black-box entry, and admission evidence,
while keeping the evaluation in design/preparation only.

## 1. Unique gap to close in this slice

The only remaining preparation gap for repo association/generalization evaluation
is the executable real evaluation contract:

- r1 evaluator is accepted as the evaluation *mechanism* but is not an
  evaluation environment for real repos yet (Frank §9.1, §9.3; Alice route
  "正式应用时仍需当前 TS 真实响应投影、独立 gold、来源分区及候选公开入口评价").
- r1 projection is accepted only for the four verified TS samples and does not
  establish real-repository generalization, call-path depth, cross-language
  transfer, model quality, or production readiness (Emma §7).
- Neither r1 artifact defines a new real-repo master manifest, gold-record
  production command, or candidate admission command that would let an executor
  run unseen-repo / unseen-implementation / unseen-tool-family evaluation with
  fixed denominators and no fallback.

This r2 document defines those executable contracts and their admission
evidence without implementing them.

## 2. Real repo association/generalization evaluation: input denominators

### 2.1 Independent gold source

Gold is produced by an independent owner outside the response producer, with
the same authority contract as the accepted `labelAuthority =
researcher_structural_proof + typescript_language_service`, `oracleKind =
independent_tsc + typescript_compiler_api` (TS/JS design §9.3). For real repo
evaluation:

- gold records are produced from a checked-out read-only repository snapshot,
  using the public TypeScript compiler API plus a structural proof record;
- gold records include `caseId`, `known`, `unknown`, `requiredCandidates`,
  `requiredScopes`, `requiredExpansions`, `rootGoal` (same shape as r1 §2.0);
- no gold record is produced by the response producer, converter, or student
  encoder; gold files do not participate in response generation.

### 2.2 Partition axes and named denominators

Follow r1 §3 and Emma §4. Every case is registered from the authoritative case
manifest before any response exists. Denominators are counted on that manifest,
not on response presence. Missing/invalid cases remain in the denominator and
are not counted as correct.

Named denominators required in this real evaluation:

1. `seen_repo` (TRAIN/DEV diagnostic): cases whose repository root appears in
   training or development source families. This is the in-distribution
   control, kept on a diagnostic path with a separately named report. It never
   bypasses the public independent-only evaluate route's TRAIN/DEV refusal.
2. `unseen_repo` (VERIFICATION): cases from a repository root that never appears
   in any TRAIN/DEV source family. The repository root is the unit, not
   "another file in the same repo".
3. `unseen_impl` (VERIFICATION): cases from a separately sourced sub-family in
   the same repo or language where the implementation shape (alias, re-export,
   direct declaration) was not seen in TRAIN/DEV and derivation isolation is
   established. Shape renaming or translating a TRAIN case does not establish
   independence. Each accepted shape is a distinct unexposed sub-family.
4. `unseen_tool_family` (VERIFICATION): cases for a tool/runtime family (for
   example a different target library or a new runtime family) that was not seen
   in TRAIN/DEV. Tool family names are registered in the partition manifest and
   used only for partition, diagnosis, and adapter selection, never as an
   answer shortcut.
5. `known_relation`, `unknown_relation`, `root`, `coverage`, `failure`: the five
   r1/Emma separated denominators, each driven by the manifest.

Missing evidence is never filled with `false`. If an observation slot is
missing, the case keeps `missing`/`invalid` and is not counted as correct; it
may be reported as `UNVERIFIED` for the affected denominator only.

### 2.3 Independent admission input isolation

A candidate is admitted for real evaluation only when:

- student `S_g` is generated from current observable facts and legal skills,
  not from gold or teacher;
- independent supervision `A_g` is stored in a separate physical path and never
  used to construct student features or candidate enumeration;
- the admission manifest marks `usableForTrainingSupervision=false` and
  `usableForIndependentVerification=true` for VERIFICATION families;
- no previously TRAIN/DEV source family or related derivation-group member may
  become independent VERIFICATION by manifest declaration, role rename, copy,
  translation, or a leakage check. A repeated exposed sample remains known
  regression/diagnostic even after its manifest role changes.
- paper admission examples: a genuinely unrelated verification family is
  admitted as independent; a renamed/copied/translated TRAIN family is rejected
  as independent and retained as diagnostic.

## 3. Fixed black-box entry and acceptance

### 3.1 Public command vocabulary

The following are accepted route names in the public corridor, not one recipe.
An independent real evaluation may run `convert-samples`/`validate-data` and
then `evaluate` only; `train`/`resume` are separate fitting/resume routes and
must never be used on VERIFICATION inputs.

```sh
node dist/training/l2-standard-runner.js convert-samples --config <runner-config.json>
node dist/training/l2-standard-runner.js validate-data --config <runner-config.json>
node dist/training/l2-standard-runner.js train --config <runner-config.json>
node dist/training/l2-standard-runner.js resume --config <runner-config.json>
node dist/training/l2-standard-runner.js evaluate --config <runner-config.json>
```

The real evaluation entry is the accepted evaluator command from r1 §7:

```sh
node repo-generalization-evaluator/evaluator.mjs \
  --repo <repoRoot> --cases <case-manifest.json> \
  --responses <dir> --gold <dir> \
  --partition <partition.json> --out <report.json>
```

Exit contract: `0` = PASS, `2` = INCOMPLETE, `1` = evaluator input/environment
error. A candidate that fails the gate is never converted into a fallback or a
default score.

### 3.2 Candidate/admission isolation and per-case denominators

- The candidate response directory and the admission cases/gold directory are
  physically separate inputs.
- The evaluator never reads training plans, recipes, configs, weights,
  checkpoints, or `lib/training` code (r1 §1.1, §1.2).
- Denominators are registered from the case manifest before responses exist;
  `missing_response`, `duplicate_case_id`, `unexpected_response`,
  `partition_role_tampered`, `evaluation_kind_tampered`, `source_family_tampered`,
  `manifest_incomplete`, `partition_leakage`, `partition_undeclared` follow
  r1 §2.0/§2.2 and Emma §2/§4.
- Per-case parsed/convert/train/reload/evaluate segments stay separated; absent
  runtime fields remain null, not 0.

### 3.3 Typed failure without fallback

Any typed failure returns explicit failure evidence:

- `DATA_INVALID` for admission/candidate-join violations, with no candidate
  package produced;
- `CHECKPOINT_INVALID` for resume on mismatch, with no re-init and no fallback;
- `failure`/`exhausted` preserved from the original error chain, never swallowed
  into `unknown` or into a permissive default.

### 3.4 Save + new-process reload reading from file

Candidate admission requires the accepted training-entry reload contract:

- model package saved atomically, then reloaded in a new Node process by
  `loadUnifiedModelPackageFromFile`;
- `tensorsMatch=true` for the reloaded tensors;
- checkpoint `completed epochs`/epoch record count verified in the new process;
- the candidate is only evaluated when the reload reads the saved file and
  returns the same typed package.

### 3.5 Reuse accepted fixed-env/evaluate contracts, no second evaluation protocol

This r2 contract reuses the accepted fixed-env and evaluate contracts:

- fixed loss/recipe from `emma-tsjs-fixed-training-launch-r1.md` §2.1–§2.4,
  `lib/training/group-loss.ts`;
- public runner routes from the training-entry reload contract §2;
- r1 evaluator v5, r1 projection, and Emma denominator/root/identity rulings.

No new loss, no new candidate-scoring protocol, no second evaluation schema is
created here. Henry `tsjs-evaluate-engineering` remains the owner of the public
runner `evaluate` route; this contract only names its acceptance inputs.

## 4. Owner, dependencies, and INCOMPLETE/UNVERIFIED boundary

### 4.1 Owners

| Item | Owner |
| --- | --- |
| r2 contract (this document) | Carol (design), Alice (review) |
| r1 evaluator mechanism and self-tests | Frank (accepted r1) |
| TS/JS response projection into NEV | Emma (accepted r1 projection), with Alice review |
| public runner `evaluate` route and F1-F4 fixes | Henry (`tsjs-evaluate-engineering-henry-20261108`) |
| fixed training entry / train/config implementation | Iris (accepted fixed-env engineering) |
| real repo gold production and final acceptance | independent gold owner, not the response producer |

### 4.2 Dependencies and exclusions

- This contract does not depend on `a718710` (daemon upgrade) or any Collab
  runtime upgrade.
- It does not conflict with Henry `tsjs-evaluate-engineering` F1-F4; Henry's
  route is a dependency only after his evaluate engineering is accepted and
  connected to the public runner.
- `8d11940` (checkpoint reload subgraph) is referenced as a typed failure
  path (`CHECKPOINT_INVALID`), not as a blocker for this design slice.
- Rust transfer / R-transfer is out of scope: it does not block the TS first
  fit (Alice route).
- Legacy `nn-code` is not restored; it remains teacher/oracle/sample/control
  only.

### 4.3 INCOMPLETE/UNVERIFIED boundary

- Real repo association/generalization evaluation, real fit, real train, real
  save/reload of a trained candidate, real holdout, and old-capability
  regression are not executed by this slice. They are explicitly
  INCOMPLETE/UNVERIFIED until the named owners produce raw receipts.
- The r1 synthetic self-tests and oracle transport remain accepted offline
  evidence only; they do not establish real-repo generalization.
- No weight, gold, threshold, adoption, or product state is changed.

## 5. Run log and delivery

- This contract: `/Volumes/Intel/playground/nnanything/nn-code-redesign-repo-generalization-real-eval-r2-20261109/docs/nn-code-redesign-repo-generalization-real-eval-r2.md`
- Task log: `/Volumes/Intel/playground/nnanything-runs/nn-code-redesign-repo-generalization-real-eval-r2-20261109/task-log.md`
- Accepted evidence paths are listed in task-log with per-item line refs.

