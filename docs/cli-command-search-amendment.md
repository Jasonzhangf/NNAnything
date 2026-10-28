# SC Product Integration Execution Amendment (2026-10-28)

Authorized by Jenny (project master). This amendment overrides the delivery
channel and phasing constraints in `sc-product-integration-20261028/task.md` for
the current implementation round.

## Delivery channel

- The run directory
  `/Volumes/Intel/playground/nnanything-runs/l2-layer-corpus-20261025/search-specialist/sc-product-integration-20261028`
  is not writable from the GCM `workspace-write` sandbox.
- The final delivery report must be written to
  `docs/cli-command-search-delivery.md` in this worktree (a docs change already
  permitted by task spec v2.1 section 2.1 item 10). Commit it with the last
  slice, or append per slice.
- Do not merge, push, or touch the main tree.

## Phased authorization

The task is a multi-thousand-line implementation. Do not attempt to produce a
single green full suite in one pass. Proceed autonomously through these three
phases in order, red-first then implement, commit each green phase, and do not
stop to ask master between phases:

1. Leaf executor + sandbox primitives: `lib/adapters/cli/directory-command-search.ts`
   and the `directory.search.*` branches in
   `lib/adapters/cli/filesystem-sandbox.ts` (including `SemanticCliCall`,
   `readSemanticCliCall`, `SemanticCallReceipt`, `sandbox.execute` dispatch,
   `bindFile`/`bindDirectory`/`resolveDirectory(..., true)`/`validateDirectoryRef`
   validation). Include temporary-sandbox tests using real `rg`/`grep`/`find`,
   covering cross-chunk incremental parsing and unterminated-fragment negatives.
   This is the foundation and should be green first.
2. Model/projection/contract: `lib/filters/cli-command-search.ts`
   (`loadCliHybridSearchModel` + R/D/E/A feature mapping +
   `projectCommandSearchDomain`; if `lib/training/l2-hybrid-package.ts` is a
   usable TS port of `hybrid-executor.mjs`, reuse it instead of rewriting) and
   `lib/adapters/cli/command-search-contract.ts` (strict schema validation). Add
   real-model loading and projection unit tests.
3. Adapter + public entry + full black-box suite:
   `lib/adapters/cli/command-search-recursive.ts` (full `RecursiveGoalAdapter`
   with `slotReceipts`/`readReceipt`/`stepTrace`/`spawnLedger`/`issuedRefs` and
   continuation guards), `lib/cli-command-search.ts`,
   `tests/cli-command-search.test.mjs` (T1-T7),
   `workflows/cli-command-search.graph.json` + `workflows/README.md` registration,
   `package.json` exports/test inclusion, and `docs/cli-filesystem-semantics.md`
   plus `AGENTS.md` entry registration. Finally run `npm run build`, affected
   regressions, and `npm run test:full` with explicit asset classification
   (baseline vs new).

## Delivery report contents

`docs/cli-command-search-delivery.md` must contain the actual exit codes and
commands, the file list, T1-T8 per-phase pass/fail with failure evidence paths,
affected-regression and test:full baseline/new counts, boundary confirmation
(no training, no gold/weight/threshold changes, no external-repo reads, no
digest ceremony), and any deviations or unfinished items.

All other boundaries from task spec v2.1 and the task contract remain in force:
explicit model injection, no default deterministic fallback, sandbox-only child
processes, single-root one/all and dual-slot one only, multi-range all
unsupported, no SHA/digest ceremony, no U01-U03 or external repos.
