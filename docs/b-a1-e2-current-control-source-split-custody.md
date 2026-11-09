# B-A1 E2 currentControl, source/split custody and supervision preparation

Task: `b-a1-e2-source-control-custody-carol-20261109`
Owner: Carol. Reviewer: Alice. Date: 2026-11-09 America/Los_Angeles.
Kind: design / readiness handoff only.

## 0. Status and scope

This document names the producer and custody owners for the accepted E2
real-site evaluation, and defines the physical record shapes and paths. It is
readiness handoff only. Real-site sampling, browser execution, training,
evaluator or score changes, wiring, installation, merge and push remain
forbidden; real-site evaluation stays `UNVERIFIED`.

Every named owner below is the actual current owner of the referenced module or
contract. The current-control producer is not implemented or assigned, and the
source admission, split decision, current-control record and gold-custodian
acceptance are not recorded. These are concrete runtime prerequisites marked
`NOT_READY`. No source is admitted and no split decision is recorded yet.

## 1. currentControl authority and producer gap

The authoritative producer is not implemented in the current repository, and
no owner has been assigned to implement it. The current code exposes types and
call sites, but not an authority that establishes the current identity:

- `observeLiveDom(input)` (`lib/adapters/browser/live-dom.ts:2395`) requires
  `snapshotRef` and `documentRef` from its caller and returns a
  `LiveDomSnapshot` without `observationId` or `revision`. It is not an
  authoritative current-control producer.
- `observeBrowserSingleAction` (`lib/adapters/browser/single-action-observation.ts:940`)
  accepts `documentRef`, `observationId`, and `revision` as caller input. It
  validates and propagates those values; it does not create independent
  authority for them.
- `BrowserSearchResources.currentControl()`
  (`lib/adapters/browser/search-contract.ts:140`) and the strategy-resource
  callback (`lib/adapters/browser/strategy-contract.ts:142`) are injected
  callback contracts. `runBrowserSearchGoal` calls the callback to reject a
  stale initial observation (`lib/adapters/browser/search-recursive.ts:43-44`).
  The repository has no production implementation of that callback.
- `BA1RealSiteEvaluationRequest.currentControl`
  (`lib/adapters/browser/b-a1-real-site-evaluation.ts:81`) is an E2 consumer
  boundary. It accepts an explicit `BA1Identity` and rejects a stale candidate
  envelope; it does not produce the authoritative identity.

Producer and consumer ownership:

| responsibility | owner | status / entry |
|---|---|---|
| authoritative current-control producer | unassigned | `NOT_READY`; no implemented producer or update/read authority in the repository |
| bounded real-site consumer implementation | Jenny, task `b-a1-e2-consumer-first-result-jack-20261109`; bounded GCM worker | accepts explicit `currentControl` from the caller; it does not generate current-control facts |
| E2 evaluator boundary | existing `projectBA1RealSiteEvaluationInput` contract | consumes explicit `BA1Identity` and applies the stale-candidate gate; ready as a boundary, not as a producer |
| live DOM observation | `observeLiveDom` | provides document/observation measurement input, not current-control authority |

The first run must have an explicit current-control record before
`evaluateBA1Sample` can consume it, but persistence alone does not establish
freshness. The later run must obtain the authoritative identity from its
producer at the evaluation boundary. Until that producer exists, no record is
authoritative and none may be copied from the observed envelope:

```text
/Volumes/Intel/playground/nnanything-runs/b-a1-real-site-eval-e2-actual-r1-20261109/current-control.json
```

```json
{
  "documentRef": "<documentRef from the authoritative producer>",
  "observationId": "<observationId from the authoritative producer>",
  "revision": <revision from the authoritative producer>
}
```

The proposed file uses only the `BA1Identity` fields (`documentRef`,
`observationId`, `revision`) and no new schema. It is not authoritative merely
because it exists. The consumer must not create it by copying the observed
identity. A future authoritative producer may write it as an audit record at
the evaluation boundary, while the evaluator still receives the direct
`currentControl` input. That producer remains `NOT_READY`.

## 2. Source admission and split decision custody

`real-site-source.json` records the accepted provenance fields. No
`splitAuthority` or `splitDecisionRef` is instantiated yet. Before any source
may be labeled `candidate-unseen`, an authority must approve the source/split
decision and record an evidence-backed decision document.

Source admission owner is Carol, this task owner. She has not admitted any
source record yet.

Missing concrete runtime prerequisites (`NOT_READY`):

1. Source admission owner: Carol. No source record has been admitted or written.
2. Split decision owner: Jenny. No approved split decision is recorded before
   evaluation.

Proposed record path (created only after source admission and split authority
record their decisions):

```text
/Volumes/Intel/playground/nnanything-runs/b-a1-real-site-eval-e2-actual-r1-20261109/
  real-site-source.json
  current-control.json            (audit only; no producer exists yet, never copied from the observation)
  split-decisions/<sourceGroupId>.json   (approved split decision record)
```

The accepted source design already defines the fields:
`sourceGroupId`, `siteId`, `implementationFamily`, `pageKind`, `queryCaseId`,
`sequenceId`, `partition`, `priorExposure`, `relatedSourceGroups`,
`splitAuthority`, `splitDecisionRef`, `evidenceRefs`. Section 1.5 of
`b-a1-real-site-eval-section12-prep.md` proposes concrete sources `rs-a`,
`rs-b`, and `rs-c`, but they remain unadmitted.

`splitAuthority` and `splitDecisionRef` are `null` in any draft record and must
be replaced by assigned owners before any source is admitted.

Target `real-site-source.json` record shape:

```json
{
  "schema": "nnanything.b-a1.real-site-source.v1",
  "sourceGroupId": "<sourceGroupId>",
  "siteId": "<siteId>",
  "implementationFamily": "<implementationFamily>",
  "pageKind": "<pageKind>",
  "queryCaseId": "<queryCaseId>",
  "sequenceId": "<sequenceId>",
  "partition": "<partition or unresolved admission>",
  "priorExposure": "<seen-source or candidate-unseen>",
  "relatedSourceGroups": [],
  "splitAuthority": null,
  "splitDecisionRef": null,
  "evidenceRefs": []
}
```

A record with `splitAuthority:null` or `splitDecisionRef:null` is a draft and
cannot be used for a `candidate-unseen` or `real-site-held-out VERIFICATION`
evaluation. No such record exists yet.

## 3. Independent supervision and gold custody

Gold custody is independent of the evaluator and of any student input. The
preparation receipt and the accepted E2 design define
`nnanything.b-a1.real-site-supervision.v1`:

```json
{
  "schema": "nnanything.b-a1.real-site-supervision.v1",
  "sourceGroupId": "rs-a-q1",
  "sampleId": "rs-a-q1/rel/search-input",
  "goldStatus": "labeled_selected",
  "goldValue": "<candidateRef selected by independent human review>",
  "labelSource": "human",
  "labelAuthority": "human review of current page DOM",
  "oracleKind": "human read of current page DOM/accessibility tree",
  "evidenceRefs": ["raw-observation.json#rs-a-q1", "supervision-notes.md#rs-a-q1"],
  "reviewStatus": "pending",
  "oraclePreconditions": []
}
```

Permitted supervision to `BA1EvaluatorGold` mapping (pending Alice review):

- `labeled_selected` with `reviewStatus` explicitly approved -> `kind:"bound"`,
  `state:"selected"`, and `selectedRef` = `goldValue`.
- `labeled_none` or `labeled_ambiguous` with `reviewStatus` explicitly approved
  and independent oracle evidence -> the corresponding bound state, with no
  `selectedRef`.
- An independently adjudicated insufficient-observation case with
  `reviewStatus` explicitly approved and explicit `oraclePreconditions` /
  evidence ->
  `kind:"bound"`, `state:"insufficient_observation"`, with no `selectedRef`.
- An independently adjudicated reject case with an approved review whose
  `goldValue` is an existing `BA1_CONTRACT_GATE_REASONS` member ->
  `kind:"reject"`, `reason` = `goldValue`.
- `observation_missing`, `unresolved_supervision`, `pending`, or `labelConflict`
  -> no approved gold. Preserve the expected obligation and unresolved
  supervision. `observation_missing` does not by itself prove that
  `insufficient_observation` is the expected semantic result.

The example above is a pending draft only; Henry has not created or accepted any
record yet. Only an independently approved record may map to
`BA1EvaluatorGold`.

Owners:

| responsibility | owner | entry |
|---|---|---|
| source admission and `real-site-source.json` fields | Carol, this task owner | `real-site-source.json` |
| split decision and `splitAuthority/splitDecisionRef` | Jenny, project master and resource authority | `real-site-source.json` plus the approved decision record |
| independent supervision/gold custody | Henry, independent-verification peer; Jenny assignment/acceptance is required before it becomes live | run directory `real-site-supervision.jsonl` |
| gold-only evaluator consumption | evaluator owner | `evaluateBA1Sample({gold,...})` in `lib/training/b-a1-evaluator.ts` |

The gold record maps to `BA1EvaluatorGold` only at the `evaluateBA1Sample` call,
never into student `x` or candidate input. `labelSource` is expected `human`;
LLM/teacher/rule use requires `oraclePreconditions` and evidence refs and may not
depend on candidate scores. Conflicts stay `labelConflict`.

## 4. First-result and provenance paths

The accepted prep receipt proposes
`/Volumes/Intel/playground/nnanything-runs/b-a1-real-site-eval-e2-actual-r1-20261109/`
for output only. A future authoritative producer may write
`current-control.json` at the evaluation boundary, but the consumer must not
create it by copying the observation. Alice clarified the eventual consumer
implementation and execution must use an owned Git worktree; run outputs are
evidence only. Paths are registered in the results and rows.

| artifact | path |
|---|---|
| current-control identity audit (BA1Identity fields only; produced only by an authoritative producer, never copied from the observation) | `current-control.json` |
| raw observation envelope (original runtime observation, produced by the real-site consumer) | `raw-observation.json` |
| source/split provenance | `real-site-source.json` |
| approved split decision record | `split-decisions/<sourceGroupId>.json` |
| independent gold | `real-site-supervision.jsonl` |
| first gold-free projection and raw scores | `first-projection.json` |
| per-row evaluation | `real-site-evaluation.jsonl` |
| summary | `summary.json` |
| failure receipt | `failure-receipt.json` |

First-result saving uses create-only/atomic semantics (`wx` or equivalent),
never overwrite and never score-driven rerun. Guarded paths and obligations that
fail stay visible in the failure receipt.

## 5. Field mapping to existing contract

| required field | existing contract / design | status |
|---|---|---|
| currentControl authority | `BrowserSearchResources.currentControl()` callback + `BA1Identity` consumer boundary | type and stale-check boundary exist; authoritative producer missing `NOT_READY` |
| real-site-source.json fields | `e2-observation-source-design.md` §2.3; §12 prep §1.5 | schema ready, source admission not recorded `NOT_READY` |
| splitAuthority/splitDecisionRef | same design, plus approved decision record required | schema ready, decision `NOT_READY` |
| supervision/gold custody | `nnanything.b-a1.real-site-supervision.v1`; `BA1EvaluatorGold` | schema ready, draft only; custodian assigned Henry but not accepted |
| current-control record | `BA1Identity` three fields | proposed audit path only; `NOT_READY`; never derived by the consumer |
| labelSource/labelAuthority/oracleKind/evidenceRefs | supervision schema | schema ready |
| consumer task ownership | `b-a1-e2-consumer-first-result-jack-20261109`; `worker-task.md` | Jenny and bounded GCM worker; explicit-input consumer only, not a control producer |
| first-result save contract | prep-receipt §3a.3; Alice handoff on owned worktree | consumer implementation under way; actual execution `NOT_READY` |
| real-site execution status | prep-receipt and design | `UNVERIFIED` |

## 6. Explicit NOT_READY list

- source admission: Carol is the preparation owner; the actual source decision
  is not recorded and remains `NOT_READY`
- split decision: Jenny is the authority; the approved decision record is not
  recorded and remains `NOT_READY`
- authoritative currentControl producer: implementation and owner assignment
  are absent and remain `NOT_READY`
- independent gold custodian: Henry is designated for independent verification;
  his assignment/acceptance is not yet recorded and remains `NOT_READY`
- current-control record: `current-control.json` is not written and remains
  `NOT_READY`; it must not be copied from the observation
- actual real-site observation/envelope and first projection: not run
- evaluation rows and summary: not run
- real-site execution: `UNVERIFIED`, with E3 autonomous binding `INCOMPLETE`

No sampling, evaluation, training, installation, merge or push evidence exists.
