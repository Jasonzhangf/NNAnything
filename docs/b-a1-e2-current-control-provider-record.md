# B-A1 E2 authoritative currentControl producer/binding record

Task: `b-a1-e2-current-control-provider-records-r1-20261109`
Owner: Carol. Reviewer: Alice.
Date: 2026-11-09 America/Los_Angeles.
Kind: design/readiness handoff only. No implementation is claimed.

## 1. Decision

No production authoritative `currentControl` producer exists in the inspected
repository state (`aac53336828eef42fa3444298b982b0afafb61a8`).

The runtime has an explicit consumer boundary and an injected callback
contract, but no module currently owns, updates, and reads the evaluation
identity authority. The E2 consumer therefore remains dependent on an
externally supplied identity and cannot self-produce one.

This task records that concrete gap and a minimal producer/binding design for
Alice to audit before any implementation.

## 2. Exact entry points inspected

| entry point | current behavior | why it is not authority |
|---|---|---|
| `observeLiveDom` in `lib/adapters/browser/live-dom.ts:2395` | Accepts caller-provided `snapshotRef` and `documentRef`; returns a `LiveDomSnapshot`. | It measures the current DOM. It neither creates `observationId` nor owns `revision`. |
| `observeBrowserSingleAction` in `lib/adapters/browser/single-action-observation.ts:940` | Validates caller-provided `documentRef`, `observationId`, and `revision`; propagates them into the snapshot. | It validates and copies a caller token. It does not establish the current control fact. |
| `BrowserSearchResources.currentControl()` in `lib/adapters/browser/search-contract.ts:140` | Injected callback used by recursive search to reject a stale initial observation. | The contract has no production implementation. Test doubles and playground callers supply the callback. |
| `SingleActionResources.currentControl()` in `lib/adapters/browser/single-action-contract.ts:155` | Injected callback used by single-action execution. | Same gap: the resource contract requires a producer, but no production factory or owning runtime supplies it. |
| `BA1RealSiteEvaluationRequest.currentControl` in `lib/adapters/browser/b-a1-real-site-evaluation.ts:89` | Explicit `BA1Identity` input. The stale gate at lines 413-429 compares it with the observation. | It is a consumer boundary, not an identity source. It correctly rejects a stale observed envelope. |
| `runBA1RealSiteFirstResult` in `lib/adapters/browser/b-a1-real-site-consumer.ts:405` | Accepts caller-owned `currentControl` and `gold`; performs the accepted first-result pipeline. | It preserves caller input and does not derive authority from the observation. |
| `DOMInspectorController` in `extension/controller.ts:89` | Owns page-local `documentRef`, `snapshotCounter`, and `refreshRevision`; builds overlay snapshots. | These fields are private overlay state. They are not exposed as the shared `currentControl()` contract and are not connected to the E2 evaluation boundary. |

The existing stale checks are useful. They prove that a caller can prevent an
old observed envelope from posing as current. They do not prove who is allowed
to create the current identity.

## 3. Minimal producer/binding design for audit

### 3.1 Single owner

Add one browser-adapter authority owned by the runtime that performs live
observations. The proposed module is:

```text
lib/adapters/browser/current-control-authority.ts
```

The exact path is a design proposal, not an implemented file. The authority
must be created once per document session and supplied to every observation and
evaluation consumer in that session. It must not be reconstructed by the E2
consumer from an observation envelope.

The authority owns only these facts:

```ts
interface CurrentControlAuthority {
  beginObservation(): Readonly<SingleActionControl>;
  currentControl(): Readonly<SingleActionControl>;
}
```

It is created with the document-session identity:

```ts
createCurrentControlAuthority({ documentRef: string }): CurrentControlAuthority
```

`SingleActionControl` already means:

```ts
{
  documentRef: string;
  observationId: string;
  revision: number;
}
```

No new identity fields are required. The E2 boundary maps this structurally
identical value to its existing `BA1Identity` input. The authority module stays
in the browser adapter and does not import the training-layer type.

### 3.2 Update boundary

`beginObservation()` is a single-writer operation:

1. It increments the authority's monotonic revision.
2. It creates an `observationId` unique within the document session.
3. It makes that identity the current control value immediately.
4. It returns an immutable identity token.

The observation producer passes the token fields into
`observeLiveDom`/`observeBrowserSingleAction`. Those functions continue to
validate and echo the token. Starting a new observation immediately invalidates
the previous token. This is conservative: if a refresh fails or is aborted, no
old observation can pass the stale gate as current. A document replacement
creates a new authority with a new `documentRef`.

### 3.3 Read boundary

`currentControl()` returns a defensive copy of the latest issued identity. The
runtime supplies that value directly to:

- `BrowserSearchResources.currentControl()`;
- `SingleActionResources.currentControl()`;
- `BA1RealSiteEvaluationRequest.currentControl`;
- `BA1RealSiteFirstResultRequest.currentControl`.

The E2 consumer receives the observation and the independent authority value.
At the evaluation boundary, the existing stale gate compares them. The
consumer must never synthesize `currentControl` from the observation. A saved
`current-control.json`, if written later, is an audit record only; it does not
become authority by existing.

### 3.4 Lifecycle

- One authority per document session.
- First observation start establishes revision 1.
- Each observation start advances the revision by one.
- A failed or aborted observation leaves no new observable state; the prior
  observation is already stale, so an old result cannot pass the gate.
- Document replacement/reset creates a fresh authority and invalidates all
  previous tokens.
- No timer, polling loop, or background refresher is needed for the authority.

This is a narrow state owner, not a new workflow. The existing observation
functions, browser search resources, and E2 stale gate remain the consumers.

## 4. Required tests before implementation acceptance

These tests are design requirements. They were not run in this task because no
implementation was authorized.

1. A new authority rejects `currentControl()` before the first commit.
2. `beginObservation` returns the same identity later returned by
   `currentControl()`.
3. Starting a second observation makes the first token stale immediately,
   including when the second observation does not complete.
4. An old observation cannot pass the authority or stale gate after document
   replacement.
5. The existing E2 stale gate rejects an observation whose identity differs
   from the authority value, including an empty stale envelope.
6. The consumer preserves an independently supplied control value and never
   invents it from `BA1RealSiteObservation`.
7. `BrowserSearchResources.currentControl()` and
   `SingleActionResources.currentControl()` can delegate to the same authority
   without changing their public return shape.

Applicable validation after implementation should include `npm run typecheck`
and focused tests for the new authority plus the existing E2 stale-boundary
test. Real-site sampling and scoring remain separate execution tasks.

## 5. Ownership and status

| item | status | owner or entry |
|---|---|---|
| authority module | design proposal only, not implemented | browser-adapter runtime owner, to be assigned after Alice audit |
| currentControl producer | absent | `NOT_READY` |
| E2 consumer boundary | present and explicit-input only | `projectBA1RealSiteEvaluationInput`, `runBA1RealSiteFirstResult` |
| existing custody record | accepted and remains unchanged | `docs/b-a1-e2-current-control-source-split-custody.md` |
| real-site observation | not run | `UNVERIFIED` |
| real-site evaluation and first result | not run | `UNVERIFIED` |
| source admission and split decision | separate task, not part of this task | `NOT_READY` |

No source file, evaluator, score, gold, threshold, weights, wiring, installation,
or adoption state was changed. No merge or push was performed.
