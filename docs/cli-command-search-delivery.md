
---

## Ongoing worker notes (per worker-contract.md 105-107; in-worktree record, not a separate copy)

This section is the live worker note for the single in-flight implementation
worker (PID 68120, session `sc-product-sequence`). Start-of-node and
finish/blocked updates are appended here. No fabricated timestamps; entries are
written as the work actually progresses.

- **Node: design read + owner-module audit (start)** — Worker re-read task spec
  v2.1, project AGENTS, skills, and audited existing owner modules
  (`lib/cli-content-search.ts`, `lib/adapters/cli/filesystem-sandbox.ts`,
  `lib/workflow/recursive-goal/`, `lib/training/l2-hybrid-package.ts`). Confirmed
  `lib/training/l2-hybrid-package.ts` is a usable TS port of
  `hybrid-executor.mjs` and will be reused, not rewritten. Confirmed base
  `npm run build` passes.
- **Node: Phase 1 leaf executor + sandbox primitives (in progress)** — Files
  changed so far: `lib/adapters/cli/filesystem-sandbox.ts` (modified, adding
  `directory.search.*` branch and `SemanticCliCall`/`readSemanticCliCall`/
  `SemanticCallReceipt`/`sandbox.execute` dispatch + `bindFile`/`bindDirectory`/
  `resolveDirectory(..., true)`/`validateDirectoryRef` validation) and new
  `lib/adapters/cli/directory-command-search.ts` (real `rg`/`grep`/`find`
  parameter build, streaming child read, cross-chunk incremental parser,
  unterminated-fragment discard, coverage classification). Not yet committed;
  red tests not yet written. Next: write red tests for the two primitives with
  a temporary sandbox and real `rg`/`grep`/`find`, then make them green, then
  commit Phase 1.
- **No blockers.** Worker is actively editing; no external-repo reads, no
  training, no gold/weight changes, no digest ceremony.

- **Node: Phase 1 actual test update (correcting prior note)** — The earlier
  line said "red tests not yet written"; it was stale. Real log evidence:
  - `node --test tests/cli-command-search-sandbox.test.mjs` => `# pass 8 / # fail 0`
    (T0a/T0b cross-chunk + unterminated-fragment, T1 rg, T2 explicit stdout
    limit => partial, T3 find fallback, T4 grep NUL parse, T5 effect/binding/
    final-symlink gates reject before spawn, plus T6/T7).
  - `node --test tests/cli-command-search-sandbox.test.mjs tests/cli-cd-sandbox.test.mjs tests/cli-cwd-sandbox.test.mjs tests/cli-file-read-lines-sandbox.test.mjs tests/cli-file-read-sandbox.test.mjs tests/cli-filesystem-binding.test.mjs tests/cli-filesystem-evaluation.test.mjs tests/cli-filesystem-independent.test.mjs tests/cli-entry-inspect.test.mjs tests/cli-list.test.mjs` => `# pass 69 / # fail 0`.
  - With `NN_HANDWIRED_ROOT=/Volumes/extension/code/handwired`,
    `NN_CLI_COMMAND_PROFILE=.../35bd5ad9-.../candidate.json`,
    `NN_CWD_RELATION_PROFILE=.../0dbccef3-.../relation-candidate.json`:
    `node --test tests/cli-entry-search.test.mjs tests/cli-content-search.test.mjs tests/cli-content-search-m2.test.mjs` => `# pass 80 / # fail 0`.
  - Red-first caveat: the first-green of these 8 tests ran against the current
    implementation, so it is not a commit-level red-first proof. Failure
    evidence for the red side is being kept separately in this worktree's
    temporary test scratch and will be named in the Phase 1 commit message.
- **Node: Phase 1 commit** — Will commit the implemented sandbox branch
  (`filesystem-sandbox.ts`, `directory-command-search.ts`, `cli-goal.ts`) plus
  the sandbox tests with the real pass/fail and the red evidence path.

- **Node: Phase 1 committed (`3089443`)** — Committed by master because the
  worker sandbox returns EPERM on `.git`. Files: `filesystem-sandbox.ts`
  (+403), `lib/cli-goal.ts` (+6), `directory-command-search.ts` (new 663),
  `tests/cli-command-search-sandbox.test.mjs` (new 410).
- **Node: Slice 2 complete (run dir `.worker-runs/.../phase23-s2-r2`)** —
  Worker exited naturally after Slice 2. Files: `lib/filters/cli-command-search.ts`
  (new 943), `lib/adapters/cli/command-search-contract.ts` (new 1444),
  `tests/cli-command-search.test.mjs` (new 829). Evidence: `npx tsc --noEmit`
  exit 0, `npm run build` exit 0, `node --test tests/cli-command-search.test.mjs`
  exit 0 with 6/6 pass. First red run failed `ERR_MODULE_NOT_FOUND` before dist
  emit and is kept in the run dir `stderr.log`/`events.jsonl`. Master re-ran the
  same test file: 6/6 pass, tsc exit 0. Committed as `684247e`.

## Slice 3 actual results (run dir `.worker-runs/.../phase3-s3-r1`)

- **Implementation** — new `lib/adapters/cli/command-search-recursive.ts`
  (full `RecursiveGoalAdapter`; real R/E/D/A each step; `sandbox.execute` search
  and `bindFile` + `file.read`/`file.read.lines`; `slotReceipts`/`readReceipt`/
  `issuedRefs`/`spawnLedger`/`stepTrace`; continuation guards) and new
  `lib/cli-command-search.ts` (`runCliCommandSearchGoal`, explicit `l2Model`,
  returns `{ request, response, domain }`). New
  `workflows/cli-command-search.graph.json` (5N4E SESE). Registered export and
  `test:cli-command-search` in `package.json`; registered entry in `AGENTS.md`,
  `workflows/README.md`, and `docs/cli-filesystem-semantics.md` §8.
- **Minimal Slice 2 owner-file fixes (forced by real black box)**:
  `lib/adapters/cli/command-search-contract.ts` had to accept `file.read` /
  `file.read.lines` receipts in `readCommandSearchEvidencePayload`; otherwise the
  read atomic step cannot be evaluated `satisfied` because the recursive-goal
  contract requires evidence. `lib/filters/cli-command-search.ts` projection now
  treats a decisive root evaluation (`satisfied`/`unsatisfied`) as authoritative
  over the finite-derivation `precondition_unsatisfied` diagnostic; this is what
  maps a complete zero-hit search to `unmet/not_found` instead of `failed`.
- **Red-first evidence** — first run of `node --test tests/cli-command-search.test.mjs`
  failed `ERR_MODULE_NOT_FOUND` for `dist/cli-command-search.js` (implementation
  not yet emitted). Kept in the run dir log.
- **Gate results (actual exit codes)**:
  - `npx tsc --noEmit` → exit 0
  - `npm run build` (includes `scripts/check-layout.mjs` + `tsc`) → exit 0
  - `npm run test:cli-command-search` → exit 0, `# pass 13 / # fail 0`
    (6 Slice 2 unit tests + 7 Slice 3 black-box tests)
  - `dagpipe graph validate workflows/cli-command-search.graph.json` → exit 0,
    `valid DAG: cli-command-search-design@0.2.0-design (5 nodes, 4 edges, 5 waves)`
  - `dagpipe graph inspect workflows/cli-command-search.graph.json` → exit 0,
    single source → single sink waves 1..5
- **Slice 3 black-box coverage**:
  - T1: real fixture sandbox + real `cli.hybrid-package.json`; literal `one|all`
    and target `one|all` all `achieved/matched/100`; missing `l2Model` throws
    `TypeError`; forged `DirectoryRef` returns `rejected/rejected` with 0 spawns.
  - T2: `READ_TARGET_S0` via `sandbox.bindFile` + `file.read.lines` and
    `file.read`; `issuedRefs === 1`; exact line/byte content; read receipt
    operation matches the real call.
  - T3: complete negative literal search returns `unmet/not_found/0/complete`,
    `reasons` includes `no_matching_entries`, no false success.
  - T4: dual-slot `one` fallback (`s0` miss → `s1` hit) and `s0`-hit early stop
    (`coverage: partial`, `reasons` includes `unsearched_fallback_scope_early_stop`).
  - T5: `domain.modelMetadata` is `{ ref, schema: cli.hybrid-package.v1,
    calibration: uncalibrated, adoption: not_applied }`; no hash/digest/sha256/
    checksum field.
  - T6: `maxTransitions: 6` stops after `s0` (`unknown/budget_exhausted`,
    1 spawn, continuation non-null); continuation resumes at `s1` (2 spawns,
    `achieved/matched/100`, continuation null, transitionsUsed grows); a
    different `modelRef` is rejected. The literal task-book "5 transitions"
    value cannot reach `s0`; the real value is recorded instead of fabricated.
  - T7: dual-scope `cardinality: all` throws `TypeError` at the public boundary.
- **Affected regressions (with explicit assets)**:
  `cli-command-search-sandbox` 8/8, `cli-entry-search` 30/30,
  `cli-content-search` 17/17, `cli-content-search-m2` 33/33,
  `cli-autonomous-goal` 35/35, `recursive-goal-runtime` 8/8,
  `recursive-goal-review-baseline` 2/2.
- **`npm run test:full` (explicit assets)**: exit 1; `# tests 1739,
  pass 1723, fail 14, cancelled 1, skipped 1`. Classified as 13 known
  asset-missing baseline (`cli-read-feedback-online` 10, `extension-build-weight` 1,
  `l2-mlp-backend` 2) plus 2 sandbox network `listen EPERM 127.0.0.1`
  (browser single-action fixture cancelled; search-page fixture uncaught).
  None of these test files import command search; new failures caused by this
  slice = 0. Failures are not reported as an overall PASS.
- **Boundary confirmations**: no training, no weight/gold/threshold/adoption
  change, no hash/digest ceremony, no default deterministic fallback, no direct
  spawn outside `sandbox.execute`, no U01–U03/external repo read, no Git
  add/commit/merge/push/worktree command. Worker stops here for master.

### Slice 3 r2 (run dir `.worker-runs/.../phase3-s3-r2`)

- **Public partial projection fix** — `lib/filters/cli-command-search.ts`
  `projectCommandSearchDomain`'s `outcome === "error"` branch now first keeps the
  reject codes (`effect_denied`/`invalid_binding`/`invalid_request`/
  `adapter_contract_invalid`) and then adds a `derivation_closed` branch mapping
  `evidence_unavailable`/`precondition_unsatisfied` (or any error whose
  `source.category === "derivation_closed"`) to `unknown` with
  `resolution = hasHit ? "partial" : "insufficient_evidence"`, `satisfaction: null`,
  and `coverage: partial`; `reasons` keeps the facts reasons (e.g.
  `stdout_max_bytes_exceeded`) and adds the resolution plus error codes. A complete
  zero-hit still resolves through the earlier `rootResult === "unsatisfied"` branch
  to `unmet/not_found`; genuine execution failures without a `derivation_closed`
  diagnostic still map to `failed`. This mirrors the existing `cli-content-search`
  `PARTIAL_CODES` precedent with no change to the shared `recursive-goal` core or
  engine counts.
- **Red-first evidence** — T7a/T7b were added to `tests/cli-command-search.test.mjs`
  and run before the fix; both failed with `expected 'unknown' / actual 'failed'`
  (`red-test.log` in the run dir). After the fix all 18 tests pass.
- **New black-box coverage**:
  - T7a: 0-hit truncation (`explicitLimits.maxStdoutBytes: 64`) →
    `unknown/insufficient_evidence/null/partial`, `reasons` includes
    `stdout_max_bytes_exceeded`, 1 spawn, empty `matchedEntries`.
  - T7b: existing hit then truncation (`maxStdoutBytes: 256`) →
    `unknown/partial/null/partial`, `reasons` includes
    `stdout_max_bytes_exceeded`, non-empty `matchedEntries`, 1 spawn.
  - T2a: session without `process.exec` → `rejected/rejected/null/null`,
    `totalProcessSpawns === 0`.
  - T2b: final directory symlink → `rejected/rejected/null/null`,
    `totalProcessSpawns === 0`, and
    `preserve.errors[*].source.nativeCode === "FINAL_SYMLINK"`.
  - T5b: dual-slot `one`, s0 miss / s1 hit, `followUpRead` lines →
    `achieved/matched/100`, `stepTrace` includes `READ_TARGET_S1`,
    `readReceipt.slot === "s1"`, `readReceipt.operation === "file.read.lines"`,
    `issuedRefs.length === 1`, `searchCommandSpawns === 2`.
  - T3 (extended): the complete negative case also asserts
    `control.outcome === "error"`, primary error `precondition_unsatisfied`,
    `source.category === "derivation_closed"`, and that `errors` exclude
    `execution_failed`/`evidence_unavailable`/`effect_denied`.
- **Gate results (actual exit codes)**: `npx tsc --noEmit` exit 0; `npm run build`
  exit 0; `node --test tests/cli-command-search.test.mjs` exit 0 with
  `# pass 18 / # fail 0`; `dagpipe graph validate
  workflows/cli-command-search.graph.json` exit 0; `dagpipe graph inspect ...`
  exit 0; affected regression exit 0 with `# pass 133 / # fail 0` across
  `cli-command-search-sandbox`, `cli-entry-search`, `cli-content-search`,
  `cli-content-search-m2`, `cli-autonomous-goal`, `recursive-goal-runtime`,
  `recursive-goal-review-baseline`. `npm run test:full` was intentionally not run;
  master runs it after rebasing on latest `origin/main`.
- **Boundary confirmations**: only the permitted files changed
  (`lib/filters/cli-command-search.ts` projection branch,
  `tests/cli-command-search.test.mjs`, and this doc); no training, no
  weight/gold/threshold/adoption change, no shared `lib/workflow/recursive-goal/`
  change, no external repo read, no SHA/digest ceremony, no Git write. Worker
  stops for master.
