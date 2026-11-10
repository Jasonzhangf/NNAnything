# B-A1 E2 runtime caller host and realm design

Task: `b-a1-e2-current-control-runtime-caller-design-r1-20261109`
Owner: Carol. Reviewer: Alice.
Date: 2026-11-09 America/Los_Angeles.
Kind: design only. No runtime implementation or real-site result is claimed.

## 1. Decision

Use a dedicated headless Chrome/Chromium target controlled by a Node process.
The realm split is:

| stage | host | realm | owner in the eventual implementation |
| --- | --- | --- | --- |
| document-session identity and current-control authority | Node runtime caller | Node process | per-document provider slot backed by `createCurrentControlAuthority` after its candidate is integrated |
| live DOM measurement and host projection | dedicated CDP page | page main world | browser-safe E2 projection bridge compiled and injected into that page |
| typed projection transport | Node runtime caller and page bridge | CDP JSON boundary | one request/response contract carrying only JSON-safe candidate facts |
| model-package load and forward | Node runtime caller | Node process | existing E2 projection/forward path after it accepts a projected observation |
| evaluation and artifact persistence | Node runtime caller | Node process | existing evaluator plus `runBA1RealSiteFirstResult` |

The extension remains outside E2. The extension controller owns overlay state
and a private page identity. It is not connected to the E2 evaluator, does not
load the model package, and must not be extended by this task.

The playground search runner also remains outside E2. Its
`state.latest`-derived control is an example provider for the search slice, not
production authority for a real-site evaluation.

A plain Playwright TCP wrapper is not sufficient. It can navigate and execute
JavaScript, but it cannot move live `Element` values through a Node API call.
The design therefore keeps DOM measurement in the page and moves the existing
projection step there. Node receives typed facts only.

An all-browser runtime is also rejected. The page cannot read the saved model
package from disk, execute the existing Node package loader, or persist the
first-result artifacts. Copying the model or filesystem work into the page would
add a second implementation path and would not preserve the accepted consumer
boundary.

## 2. Realm boundary

### 2.1 Page-side input and output

The page bridge receives a request with the authority-issued identity:

```ts
interface BA1RealSiteBrowserProjectionRequest {
  readonly schema: "nnanything.b-a1.real-site-browser-projection-request.v1";
  readonly requestId: string;
  readonly identity: {
    readonly documentRef: string;
    readonly observationId: string;
    readonly revision: number;
  };
  readonly scopeSelector: string;
  readonly requestedRole: string;
  readonly access: "available" | "login_required" | "challenge" | "unknown";
}
```

The page bridge resolves `scopeSelector` to the live scope root. A missing or
ambiguous resolver is a typed error, not a fallback to the whole document.

Scope limitation: `scopeSelector` resolves only to the explicitly resolvable
host-document scope. It does not authorize traversal through MDN's known
shadow-root boundary. If candidates are behind that boundary, coverage is
reported `partial`/unresolved for this successor; no minimal exact shadow-root
resolver is defined in this design, and scope must not be broadened to claim
full source coverage.

The page bridge then:

1. Calls the existing live-DOM observer in the page.
2. Uses the resulting live `Element` values and `propertiesOf` map directly.
3. Applies the existing search-input-host projection and measurement
   corrections in the page.
4. Computes actual DOM scope membership while the Elements are still live.
5. Returns a JSON-safe projection.

The response shape is:

```ts
interface BA1RealSiteBrowserProjectionResponse {
  readonly schema: "nnanything.b-a1.real-site-browser-projection-response.v1";
  readonly requestId: string;
  readonly ok: true;
  readonly projection: {
    readonly identity: {
      readonly documentRef: string;
      readonly observationId: string;
      readonly revision: number;
    };
    readonly scopeRef: string;
    readonly requestedRole: string;
    readonly candidates: readonly SearchInputHostCandidate[];
    readonly outsideScopeRefs: readonly string[];
    readonly coverage: SearchInputHostCoverage;
  };
}
```

The projection contains measured candidate fields and evidence references. It
contains no `Element`, no `Document`, no `Window`, no `propertiesOf` callback,
and no DOM node object. `SearchInputHostCandidate` is already the JSON-safe
contract used by the numeric binder. The browser bridge returns defensive
copies with exact-field validation.

The failure shape is:

```ts
interface BA1RealSiteBrowserProjectionFailure {
  readonly schema: "nnanything.b-a1.real-site-browser-projection-response.v1";
  readonly requestId: string;
  readonly ok: false;
  readonly error: {
    readonly code:
      | "invalid_request"
      | "scope_not_found"
      | "scope_ambiguous"
      | "observation_failed"
      | "projection_failed";
    readonly stage: "request" | "resolver" | "observation" | "projection";
    readonly message: string;
  };
}
```

No failure path serializes a partially observed DOM and no failure path
constructs a synthetic Element in Node.

### 2.2 Node-side input

The Node evaluator accepts only the validated projection:

```ts
interface BA1RealSiteProjectedObservation {
  readonly identity: BA1Identity;
  readonly scopeRef: string;
  readonly requestedRole: string;
  readonly candidates: readonly SearchInputHostCandidate[];
  readonly outsideScopeRefs: readonly string[];
  readonly coverage: SearchInputHostCoverage;
}
```

This type has no live DOM field. The Node path must not accept
`scopeRoot: Element`, `nodes: { element: Element }[]`, or `propertiesOf`. Those
fields belong only to the page bridge input. Removing them from the Node entry
prevents a caller from casting JSON into a fake `Element`.

The Node runtime validates the response before evaluation:

1. `requestId` matches the outstanding command.
2. The projection identity equals the token issued by the active authority.
3. Every candidate identity equals the projection identity.
4. Every candidate `scopeRef` equals the projection `scopeRef`.
5. The candidate list contains no duplicate refs.
6. `coverage` has exact fields and finite nonnegative counts.
7. `outsideScopeRefs` contains only candidate refs.

A validation failure is a typed binding error. It is not repaired from the
observation envelope.

## 3. Current-control authority

The authoritative provider lives in the Node runtime caller, not in the page
bridge.

The page receives `documentRef`, `observationId`, and `revision`; it does not
create them. It echoes the token in the projection. Node still reads the current
control independently from its active provider at the evaluation boundary. A
page response therefore cannot make an old observation current by copying its
own identity into `currentControl`.

The runtime caller owns one active provider slot per CDP target:

```ts
interface BA1RealSiteControlProvider {
  beginObservation(): BA1Identity;
  currentControl(): BA1Identity;
}

interface BA1RealSiteControlSlot {
  generation(): number;
  current(): BA1RealSiteControlProvider;
  replace(provider: BA1RealSiteControlProvider): void;
}
```

`replace` increments the slot generation and atomically makes the new provider
current. There is no active-provider fallback to a previous document.

The first main-frame document in a target calls:

```ts
slot.replace(createCurrentControlAuthority({ documentRef }));
```

Every navigation or main-frame execution-context replacement calls `replace`
again with a new `documentRef`. The previous provider is never reused. The slot
generation is part of every pending runtime operation so a late response from
the previous document cannot be accepted.

Before observation, the Node caller does this in order:

1. Read `provider = slot.current()`.
2. Capture `generation = slot.generation()`.
3. Call `token = provider.beginObservation()`.
4. Send `token` to the page bridge.

After the page response, Node accepts it only when the slot generation and
current provider token still match the captured operation. A replacement before
the response produces `stale_candidate` or `provider_replaced`. A document
replacement therefore cannot leave consumers closed over the old authority.

## 4. Evaluation and persistence

`runBA1RealSiteFirstResult` remains in the Node runtime. Its request changes
from a live DOM observation to the projected observation plus a control reader:

```ts
interface BA1RealSiteControlRead {
  readonly identity: BA1Identity;
  readonly generation: number;
}

interface BA1RealSiteFirstResultRequest {
  readonly observation: BA1RealSiteProjectedObservation;
  readonly packagePath: string;
  readonly currentControl: () => BA1RealSiteControlRead;
  readonly gold: BA1EvaluatorGold;
  readonly sampleId: string;
  readonly outputDir: string;
}
```

The consumer reads an independent `currentControl()` value at three business
boundaries. A value captured when the request is constructed is not authority.

1. Admission gate before any package load: compare the projected identity with
   the independently read current-control identity. If they differ, write a
   typed failure receipt and do not load or call the model.
2. Pre-forward freshness gate after all awaited package preparation and
   immediately before synchronous encode/forward: read `currentControl()` again
   and compare its identity and generation with the captured operation token.
   Provider replacement while package load is pending rejects
   `stale_forward_gate` with no forward and no scores.
3. Acceptance cut after forward completes and before persistence: make one
   synchronous read of `currentControl()` and capture the observed identity,
   generation, forward status, scores/evaluation, and projection as the
   acceptance snapshot. If the token changed after forward but before
   acceptance, preserve the already-computed scores/evaluation and
   `forward: completed` in failure/attempt evidence, record
   `current_control_changed_before_acceptance`, do not discard the first
   scores, do not label forward `not_run`, and do not retry to replace them.

Persistence is a recorded decision cut, not continuous DOM freshness across
disk I/O. The saver performs multiple async `open`/`write`/`rename` operations
and per-file renames; it is not one navigation transaction spanning provider
state and all files. A single pre-write check cannot guarantee that no
navigation occurs during those writes. The acceptance cut is therefore the
synchronization point: it records the provider state at a synchronous decision
moment with immutable observed identity and result evidence. A later navigation
during or after save is an audit fact and does not retroactively turn the
historical record false. `currentControl` in persisted records is an audit
value only; it is never read back as authority and never substituted for the
active provider.

The output location and existing files are unchanged:

```text
first-projection.json
real-site-evaluation.jsonl
summary.json
failure-receipt.json
```

## 5. Exact runtime sequence

The successful path is:

```text
CDP target document created
-> Node creates a new documentRef and replaces the active provider
-> Node reads the active provider and issues one observation token
-> Node sends the token and a scope selector to the page bridge
-> page measures live DOM and projects JSON-safe candidates
-> Node validates the projection and candidate identities
-> Node reads the active provider at the admission gate
-> token mismatch: reject stale, save failure receipt, stop
-> token match: load the model package
-> Node reads the active provider at the pre-forward freshness gate
-> token mismatch: reject stale_forward_gate, save failure receipt, stop
-> token match: encode, forward, evaluate
-> Node reads the active provider at the acceptance cut
-> token mismatch: save failure/attempt receipt preserving forward: completed and scores/evaluation, stop
-> token match: atomically save the first result
```

The stale path is:

```text
first token issued
-> document replacement replaces the active provider
-> old projection returns
-> old generation or old token does not match the active provider
-> reject stale_candidate
-> no scoring, no success artifact
```

The new observation start path is:

```text
first token issued
-> second beginObservation on the active provider
-> first token is immediately non-current
-> first projection returns
-> stale comparison rejects the first envelope
```

Timing cases:

```text
before forward:
  admission token matches
  -> package load is pending
  -> provider replacement makes the token stale
  -> pre-forward freshness gate rejects with no forward

after forward before acceptance:
  forward completes
  -> provider replacement makes the token stale before the acceptance cut
  -> acceptance cut records current_control_changed_before_acceptance
  -> preserve first scores/evaluation and forward: completed; do not retry

after acceptance during save:
  acceptance cut matches and captures an immutable record
  -> file writes proceed as multiple async operations
  -> later navigation is an audit fact; the accepted record is not rewritten or invalidated
```

## 6. Explicit rejections

The design rejects all of these shortcuts:

- JSON-shaped fake DOM or a serialized `Element`.
- A Node `Element` constructor, proxy, cast, or synthetic DOM implementation
  used as real-site measurement.
- `currentControl` derived from `BA1RealSiteObservation`,
  `state.latest`, the response `identity`, or any helper that copies the
  observation envelope into authority.
- Reusing a previous `CurrentControlAuthority` after document replacement.
- A consumer closed over one authority value while the active slot has been
  replaced.
- Passing the model package path or Node filesystem work into the page.
- Treating the extension overlay or a playground callback as production
  authority.
- Falling back to the previous document or the previous token after a
  replacement.

## 7. Minimal successor implementation task

Successor task name:

```text
b-a1-e2-current-control-runtime-caller-bind-r2-20261109
```

Goal: implement the Node/CDP caller and the page-side JSON-safe projection
boundary described above, then prove the stale-token and document-replacement
behavior with real Chrome. This is not a source-admission, gold, training, or
source-sampling task.

Write boundary:

1. Add
   `lib/adapters/browser/b-a1-real-site-browser-projection.ts`.
   It is browser-safe and owns live DOM measurement, projection, and real scope
   membership.
2. Add
   `lib/adapters/browser/b-a1-real-site-cdp-runtime.ts`.
   It is Node-only and owns the dedicated CDP target, request/response
   transport, active-provider slot, document replacement, and projection
   validation.
3. Change
   `lib/adapters/browser/b-a1-real-site-evaluation.ts`
   to accept only `BA1RealSiteProjectedObservation`. Remove live `Element`,
   `propertiesOf`, and Node-side DOM projection from this entry.
4. Change
   `lib/adapters/browser/b-a1-real-site-consumer.ts`
   to accept the projected observation and the active-provider reader. Keep
   the existing evaluator, summary, and atomic persistence semantics.
5. Add focused contract tests and one real headless-Chrome runtime test. The
   real runtime test must run in the page main world and must not use a fake DOM
   or serialized DOM.
6. Reuse `lib/adapters/browser/current-control-authority.ts` only after its
   candidate is reviewed and integrated. Do not make the authority a second
   implicit provider.

Required evidence for the successor:

- one authority created for one real document session;
- an issued token passed to the page and echoed in a typeset projection;
- one valid evaluation that reads the active provider at the actual boundary;
- one second-observation case that rejects the earlier envelope before model
  load or forward;
- one document replacement case that rejects the earlier document token;
- one provider replacement while package load is pending that rejects
  `stale_forward_gate` with no forward and no scores;
- one after-forward-before-acceptance case that preserves the first
  scores/evaluation and `forward: completed` in failure/attempt evidence;
- one after-acceptance-during-save case where a later navigation does not
  rewrite or invalidate the accepted record;
- one host-scope source check that reports MDN shadow-root coverage as
  `partial`/unresolved instead of claiming full traversal;
- one real browser projection that contains no DOM objects and no callbacks.

The successor must not modify `extension/controller.ts`,
`playground/browser/search/native-io.mjs`,
`playground/browser/feedback/expanded-io.mjs`, or
`playground/browser/strategy/run.mjs` as authority. It must not change gold,
thresholds, weights, candidate packages, adoption state, source admission,
split decisions, or an existing run directory.

## 8. Status

This document defines the host/realm split and the successor boundary. It does
not prove that the runtime caller exists or that it works. Real-site
observation, projection, model forward, evaluation, persistence, and
stale-token behavior remain `UNVERIFIED` until the successor task provides
real runtime evidence.
