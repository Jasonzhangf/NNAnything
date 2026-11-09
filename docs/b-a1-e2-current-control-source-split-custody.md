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
contract. The outstanding items are the unrecorded source admission, split
decision, current-control record and gold-custodian acceptance, not missing
ownership assignments. These are concrete runtime prerequisites marked
`NOT_READY`. No source is admitted and no split decision is recorded yet.

## 1. Authoritative currentControl producer

The authoritative `currentControl` producer is the existing browser runtime
owner of `observeLiveDom` and the input/search invocation contract:

- Entry: `lib/adapters/browser/live-dom.ts` `observeLiveDom(input)` produces the
  `LiveDomSnapshot` containing `snapshotRef/documentRef/frameRef/pageRef`.
- Existing control shape: `SingleActionControl`
  (`lib/adapters/browser/single-action-contract.ts:32`) with
  `documentRef/observationId/revision`, exposed to search as
  `BrowserSearchResources.currentControl()`
  (`lib/adapters/browser/search-contract.ts:140`).
- `BA1Identity` (`lib/training/b-a1-evaluator.ts:52`) has exactly the same
  three fields. The E2 consumer or the caller supplies the identity explicitly;
  it is never derived from the observed envelope.

The first run must have an explicit current-control record before
`evaluateBA1Sample` can consume it. Until the real-site consumer task creates
it, this record does not exist and must not be synthesized from an observation
envelope:

```text
/Volumes/Intel/playground/nnanything-runs/b-a1-real-site-eval-e2-actual-r1-20261109/current-control.json
```

```json
{
  "documentRef": "<documentRef from the current observation>",
  "observationId": "<observationId from the current observation>",
  "revision": <revision from the current observation>
}
```

The record uses only the `BA1Identity` fields (`documentRef`, `observationId`,
`revision`) and no new schema. It is not a gold or provenance record.

Owner table:

| responsibility | owner | entry |
|---|---|---|
| live DOM observation and current document/revision identity | browser runtime contract owner | `lib/adapters/browser/live-dom.ts` `observeLiveDom` |
| current-control supply to E2 consumer | Jack, consumer task owner, under `b-a1-e2-consumer-first-result-jack-20261109` | `BrowserSearchResources.currentControl()` |
| current-control to `BA1Identity` mapping | Jack | `lib/adapters/browser/b-a1-real-site-evaluation.ts` `BA1RealSiteEvaluationRequest.currentControl` |

The consumption path in the accepted design is: `projectBA1RealSiteEvaluationInput`
receives `currentControl` as an independent input; its R4 `stale_candidate` gate
then compares it with the observation identity. The integrated adapter at
`7eeea6c` already declares this contract with real DOM objects; the minimal
first-result consumer/saver is being built in Jack's worktree
`b-a1-e2-consumer-20261109` and is not committed yet. That work is covered by
the separate task `b-a1-e2-consumer-first-result-jack-20261109`.

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
  current-control.json            (only created by the real-site consumer before run)
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

Accepted `goldStatus` to `BA1EvaluatorGold` mapping:

* `labeled_selected` -> `kind:"bound"`, `state:"selected"`, and
  `selectedRef` = `goldValue`
* `labeled_none` -> `kind:"bound"`, `state:"none"`, with no `selectedRef`
* `labeled_ambiguous` -> `kind:"bound"`, `state:"ambiguous"`, with no
  `selectedRef`
* `observation_missing` -> `kind:"bound"`,
  `state:"insufficient_observation"`, with no `selectedRef`
* `unresolved_supervision` / `labelConflict` -> unresolved gold;
  it must not be converted to `candidate-unseen` or silently resolved

The example above is a draft only; Henry has not created or accepted any record
yet.

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
for output only; `current-control.json` is written by the consumer before the
first run. Alice clarified the eventual consumer implementation and execution
must use an owned Git worktree; run outputs are evidence only. Paths are
registered in the results and rows.

| artifact | path |
|---|---|
| current-control identity fact (BA1Identity fields only; created by the real-site consumer before run) | `current-control.json` |
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
| currentControl producer and entry | `observeLiveDom` + `BrowserSearchResources.currentControl()` + `BA1Identity` | ready, runtime contract intact |
| real-site-source.json fields | `e2-observation-source-design.md` §2.3; §12 prep §1.5 | schema ready, source admission not recorded `NOT_READY` |
| splitAuthority/splitDecisionRef | same design, plus approved decision record required | schema ready, decision `NOT_READY` |
| supervision/gold custody | `nnanything.b-a1.real-site-supervision.v1`; `BA1EvaluatorGold` | schema ready, draft only; custodian assigned Henry but not accepted |
| current-control record | `BA1Identity` three fields | proposed path only; `NOT_READY` until Jack's consumer writes it before run |
| labelSource/labelAuthority/oracleKind/evidenceRefs | supervision schema | schema ready |
| first-result save contract | prep-receipt §3a.3; Alice handoff on owned worktree | consumer/engineer being built by Jack; actual execution `NOT_READY` |
| real-site execution status | prep-receipt and design | `UNVERIFIED` |

## 6. Explicit NOT_READY list

- source admission: Carol is the preparation owner; the actual source decision
  is not recorded and remains `NOT_READY`
- split decision: Jenny is the authority; the approved decision record is not
  recorded and remains `NOT_READY`
- independent gold custodian: Henry is designated for independent verification;
  his assignment/acceptance is not yet recorded and remains `NOT_READY`
- current-control record: Jack is the assigned consumer owner and producer;
  `current-control.json` is not written and remains `NOT_READY`
- actual real-site observation/envelope and first projection: not run
- evaluation rows and summary: not run
- real-site execution: `UNVERIFIED`, with E3 autonomous binding `INCOMPLETE`

No sampling, evaluation, training, installation, merge or push evidence exists.
