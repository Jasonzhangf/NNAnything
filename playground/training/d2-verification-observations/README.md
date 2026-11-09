# D2 Verification Student Observation Converter

This converter produces `student-observations.jsonl` for
`training/samples/neural-cli/tsjs/verification-independent-callgraph-d`.

## Input Boundary

The converter reads only:

- the family `manifest.json`;
- the `episode-*.jsonl` request shells;
- the tracked TypeScript files under `sources/`.

It does not read `labels/gold.jsonl`, oracle receipts, teacher material, fitted packages,
or any TRAIN family. The output keeps `partition=verification` and contains no
supervision-only keys.

## Episode Shape

- Positive alias and pipeline samples use an `advance` chain: entry import, re-export
  edge, then terminal declaration.
- Shadow and runtime-dynamic samples are single-step terminal observations.
- The converter does not emit an `observe` step because the evaluate consumer cannot
  execute that module path.
- Output schema is the existing stepwise student schema
  `emma-tsjs-student-observation-v2`.

## Run

The converter needs the repository TypeScript package. From a task worktree without
`node_modules`, pass the package path explicitly:

```sh
NNANYTHING_TYPESCRIPT_PATH=/absolute/path/to/node_modules/typescript/lib/typescript.js \
  node playground/training/d2-verification-observations/generate-d2-observations.mjs \
  --report /path/to/self-check.json
```

The default output is
`training/samples/neural-cli/tsjs/verification-independent-callgraph-d/student-observations.jsonl`.
The run receipt records sample membership, step counts, legal-candidate counts, terminal
relations, forbidden-key checks, and partition isolation.
