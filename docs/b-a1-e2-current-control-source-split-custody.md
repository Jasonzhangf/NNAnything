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

Concrete non-human custody example (documentary metadata only, not a runtime
`labelSource` enum):

```json
{
  "schema": "nnanything.b-a1.real-site-supervision.v1",
  "sourceGroupId": "rs-a-q1",
  "sampleId": "rs-a-q1/rel/search-input",
  "goldStatus": "labeled_selected",
  "goldValue": "<candidateRef proposed by independent non-human review>",
  "labelSource": "teacher-proposal",
  "labelAuthority": "gpt-6.1-sol teacher session <teacher-session-id> revision <teacher-revision>",
  "oracleKind": "teacher read of current page DOM/accessibility tree",
  "evidenceRefs": ["teacher-proposal.json#rs-a-q1", "raw-observation.json#rs-a-q1"],
  "reviewStatus": "pending",
  "oraclePreconditions": ["producer is score-blind", "proposal must be independently adjudicated before approval"]
}
```

`labelSource` is an independent custody-artifact field for human and
non-human provenance. It is not a converter supervision-row field and does not
add a `teacher`/`llm`/`rule` runtime enum. The actual producer identity and
method are named by `labelAuthority` and `oracleKind`.

Approved custody to `BA1EvaluatorGold` mapping (pending Alice review):

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

The examples above are pending drafts only; Tina has accepted the independent
gold-custodian duty, but no approved gold or machine-admitted record exists
yet. Only an independently approved record may map to
`BA1EvaluatorGold`. `BA1RealSiteFirstResultRequest.gold` accepts that
`BA1EvaluatorGold` directly and passes it to `evaluateBA1Sample`; the converter
supervision row is not a required custody-to-gold stage for first-result
evaluation. Converter mapping applies only where a supervision row is actually
produced.

Owners:

| responsibility | owner | entry |
|---|---|---|
| source admission and `real-site-source.json` fields | Carol, this task owner | `real-site-source.json` |
| split decision and `splitAuthority/splitDecisionRef` | Jenny, project master and resource authority | `real-site-source.json` plus the approved decision record |
| independent supervision/gold custody | Tina, accepted independent gold custodian | run directory `real-site-supervision.jsonl` |
| gold-only evaluator consumption | evaluator owner | `evaluateBA1Sample({gold,...})` in `lib/training/b-a1-evaluator.ts` |

The gold record maps to `BA1EvaluatorGold` only at the `evaluateBA1Sample` call,
never into student `x` or candidate input. Conflicts stay `labelConflict`.

### 3.1 Actual consumer truth and the non-human labelSource gap

Read-only inspection of the current consumers on `origin/main` (`4ca9357`):

- `lib/training/b-a1-sample-converter.ts` `BA1_SUPERVISION_ROW_KEYS` carries
  `supervisionStatus`, `goldAllowedCandidateRefs`, `labelAuthority` and
  `oracleKind`. It does not carry `labelSource`, `goldStatus`, `goldValue`,
  `reviewStatus`, `evidenceRefs` or `oraclePreconditions`.
- `BA1ObservationSupervision` in the same file represents a model-semantic row
  with `supervisionStatus`, `goldAllowedCandidateRefs`, `labelAuthority` and
  `oracleKind`. The last two are non-empty free-form strings, not enums.
- `BA1EvaluatorGold` in `lib/training/b-a1-sample-evaluator-skeleton.ts`,
  consumed by `lib/training/b-a1-evaluator.ts`, is only
  `{kind:"bound",state,selectedRef?,family,group}` or
  `{kind:"reject",reason,family,group}`. It has no `labelSource`,
  `labelAuthority`, `oracleKind`, `reviewStatus` or adjudication field.
- `lib/adapters/browser/b-a1-real-site-evaluation.ts` is the gold-free
  projection half. It defines no gold or label fields and cannot carry them.

Consequences:

- The current machine consumer has no `labelSource` field and no exact
  non-human `labelSource` value. Do not invent a `teacher`/`llm`/`rule` enum in
  this document. A non-human producer is represented through existing fields:
  `labelAuthority` names the producer and version, `oracleKind` names the
  oracle method, and `oraclePreconditions` plus `evidenceRefs` remain in the
  independent custody artifact. They are not serialized into the current
  supervision row or `BA1EvaluatorGold`.
- The current machine consumer has no `reviewStatus` or adjudication field.
  Pending and approved custody states cannot be distinguished after mapping.
  The custody gate owns adjudication upstream and must run before mapping: only
  an independently approved custody record may become `BA1EvaluatorGold`.
  The current consumer contract does not require a machine-visible adjudication
  field, and its absence alone does not justify another schema or engineering
  change.
- A future typed `labelSource` or `reviewStatus` requires a separate contract
  change and review. Until then those fields may exist only as custody-artifact
  metadata and must not be treated as current consumer schema.

The `nnanything.b-a1.real-site-supervision.v1` JSON above is an independent
custody artifact, not the converter supervision-row schema. Its fields are kept
for human/adjudication provenance. Only the fields listed in this subsection
cross into the current machine consumer.

Non-human producer rule: a teacher/LLM/rule proposal must name its exact
producer identity and version in `labelAuthority`, name its oracle method in
`oracleKind`, and carry explicit `oraclePreconditions` and evidence refs in the
custody artifact. It may not depend on candidate scores. Conflicts stay
`labelConflict` and are not machine-consumable as approved gold.

### 3.2 Accepted proposal serialization

A pending `nnanything.b-a1.real-site-supervision.v1` record may serialize an
accepted independent proposal before Alice approves gold. The custody record
must include these additional custody-only fields:

```json
{
  "recordId": "<unique custody record id>",
  "proposalRef": "<pending-proposals.jsonl>#sourceGroupId=<id>",
  "observationBinding": {
    "sourceRun": "<source run>",
    "documentRef": "<documentRef>",
    "observationId": "<observationId>",
    "revision": 1,
    "generation": 1,
    "candidateRef": "<candidateRef>",
    "scopeRef": "<scopeRef>",
    "projectionPhase": "<phase>",
    "bindingRole": "search-input-host",
    "sequenceRole": "<q1-pre-input or q2-pre-input>"
  },
  "supportingActionEvidence": [],
  "scoreBlind": true,
  "approvedGold": false,
  "machineAdmitted": false,
  "approvalStatus": null,
  "approvalEvidence": [],
  "splitDecisionRef": "<split-decisions/<sourceGroupId>.json>"
}
```

`observationBinding` preserves the exact observation-local identity of the
selected input host. `supportingActionEvidence` keeps post-input submit
observations separate and never converts them into a second selected target.
These fields remain custody-only and do not enter the converter supervision
row or `BA1EvaluatorGold`.

### 3.3 Exact approved custody status marker

The contract previously defined `pending` serialization and `approvedGold`,
but did not define the exact positive approved status token. The custody record
must carry these two custody-only fields:

- `approvalStatus`: exact positive status token. The only approved value is
  `"approved"`. `null`, `"pending"`, `"rejected"`, `"conflicting"`, or an
  absent field are not approved.
- `approvalEvidence`: non-empty array of evidence references supporting the
  approval. An empty or absent array is not approved.

A custody record is approved gold only when all three hold:
`approvedGold === true`, `approvalStatus === "approved"`, and
`approvalEvidence` is non-empty. `reviewStatus != "pending"` is never treated
as approval by itself; `reviewStatus` values `pending`, `rejected`,
`conflicting`, or absent remain rejected before model execution.

Pending serialization keeps the approval fields unapproved:

```json
"approvalStatus": null,
"approvalEvidence": []
```

These approval fields remain custody-only and do not enter the converter
supervision row or `BA1EvaluatorGold`.

A record with `reviewStatus:"pending"` is reviewable proposal material, not
approved gold. It must keep `approvedGold:false` and
`machineAdmitted:false`. A record whose proposal has no eligible target, whose
scope is partial, or whose continuation is unresolved must not invent a
binding or candidate. Its custody adjudication stays unresolved and points to
the accepted raw failure or partial-scope evidence.

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
| supervision/gold custody | `nnanything.b-a1.real-site-supervision.v1`; `BA1EvaluatorGold` | schema ready; Tina accepted as custodian; no approved gold or machine-admitted record |
| current-control record | `BA1Identity` three fields | proposed audit path only; `NOT_READY`; never derived by the consumer |
| labelSource/labelAuthority/oracleKind/evidenceRefs | supervision schema vs current converter | `labelAuthority`/`oracleKind` are current converter fields; `labelSource`/`evidenceRefs` are custody-artifact only; see §3.1 |
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
- independent gold custodian: Tina is accepted; the approved-gold artifact
  remains `NOT_READY` until independent review approves it
- current-control record: `current-control.json` is not written and remains
  `NOT_READY`; it must not be copied from the observation
- actual real-site observation/envelope and first projection: not run
- evaluation rows and summary: not run
- real-site execution: `UNVERIFIED`, with E3 autonomous binding `INCOMPLETE`

No sampling, evaluation, training, installation, merge or push evidence exists.
