# Browser single-action consumers

The public package owns prediction, episode execution, and real fitting. These
scripts keep candidate training, process reload, and proposal-only stepping
separate.

```sh
node playground/browser/single-action/train.mjs \
  --handwired-root /Volumes/extension/code/handwired \
  --output /absolute/run/output \
  [--samples /absolute/samples.json]
```

`train.mjs` uses the built-in 3 train families and 1 development family when
`--samples` is absent. Verification episodes are rejected before fitting. The
default budget is 200 relation epochs, 200 capability epochs, and learning rate
0.1. A failed development comparison still writes the candidate and report, and
the command exits nonzero.

```sh
node playground/browser/single-action/reload.mjs \
  --profile /absolute/run/output/candidate.json \
  --cases /absolute/verification-cases.json
```

`reload.mjs` starts a new process, validates the saved profile, evaluates cases,
and never fits parameters.

```sh
node playground/browser/single-action/step.mjs \
  --profile /absolute/run/output/candidate.json \
  --request /absolute/request.json
```

`step.mjs` prints the current relation rows, capability head, scores, and
proposed target. It does not use a browser bridge and does not click.

## Fixture server

```sh
node playground/browser/single-action/fixture-server.mjs --port 0
```

The server prints one JSON line with its dynamic PID, port, and deterministic
case IDs. Use `?case=<id>` for a page, or `GET /api/cases` for metadata. The
fixture's normal application event handler changes its own DOM after a real
user click. The executor must not run JavaScript that changes those states.

## Read-only collector source

`collector-entry.ts` calls the A-owned `observeBrowserSingleAction` projection.
The caller supplies the explicit L1 profile and page selectors. The parent owns
the CUA bridge and execution. The bundle uses a finite Map/Set registry for the
current document because the read-only tool realm may not expose WeakMap/WeakRef.

`collector-bundle.mjs` returns `{ format: "callable-expression", exportName,
source }`. Evaluating `source` produces the collector function directly; it does
not install a page global or execute page code.
