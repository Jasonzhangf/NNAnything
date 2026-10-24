# search-input-host binder consumer

Public consumer for `nnanything/search-input-host`, the M1 phase 2 numeric unit
that binds a candidate batch to the single `search-input-host` role and returns
one of four states: `selected`, `none`, `ambiguous`, `insufficient_observation`.

The learned part is one scalar per candidate, `roleMatch in [-1, 1]`, over the
feature table in the M1 numeric design. Applicability, missing measurements,
coverage, access gating, currentness and threshold/uniqueness aggregation are
deterministic guard code. The unit never applies a candidate and never writes a
production weight.

## Commands

```sh
# Infer one JSON request with the neutral (all-zero) profile.
node playground/browser/search-input-host/run.mjs \
  --mode infer --request playground/browser/search-input-host/fixtures/request-selected.json

# Infer with a fitted candidate profile.
node playground/browser/search-input-host/run.mjs \
  --mode infer --request playground/browser/search-input-host/fixtures/request-selected.json \
  --profile /tmp/search-input-host/candidate.json

# Fit from training rows and save the candidate profile (explicit path only).
node playground/browser/search-input-host/run.mjs \
  --mode train --rows playground/browser/search-input-host/fixtures/train-rows.json \
  --weights /tmp/search-input-host/candidate.json

# Reload the saved profile in a new process and observe dev cases only.
node playground/browser/search-input-host/run.mjs \
  --mode observe --profile /tmp/search-input-host/candidate.json \
  --cases playground/browser/search-input-host/fixtures/dev-cases.json
```

`train` accepts `--epochs`, `--learning-rate` and `--margin`. The saved file is
`{ profile, fit }`; `profile.calibration` is always `uncalibrated` and
`profile.adoption` is always `not_applied`. Writing under `training/weights/` is
refused.

## Fixtures

- `fixtures/train-rows.json`: synthetic hand-labelled batches. Targets are
  search hosts by construction; the labels are not generated from the lexicon.
- `fixtures/dev-cases.json`: dev-only observation cases covering all four states
  plus role rejection, stale revision and unread shadow content.
- `fixtures/request-selected.json`: one infer request for a search host next to
  a memo field.

These are small synthetic fixtures for the consumer and the contract tests. They
are not an independent-source qualification set and are not a generalisation
claim.
