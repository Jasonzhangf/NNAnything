# unified-env fixtures

Typed acceptance fixtures for the NNAnything unified 64-slot fixed environment
(task `jenny-tsjs-fixed-env-implementation-milestone-r1`).

Boundary rules these fixtures encode:

- The encoder input never contains `gold`, `teacher`, `callEdge` or a final
  declaration shortcut. Decision truth lives only in the independent oracle set.
- Known relations (`gold=true|false`) must each be correct, error count 0; any
  single miss makes the whole run `incomplete`.
- Unknown results (independent oracle `unknown`) must be reported `judge=unknown`,
  not a made-up `true`/`false`. Valid unknown gold has its own denominator and
  full recall.
- `label_missing` is excluded from the correctness denominator but kept explicit.

Files:

- `terminal-vectors.json`: accepted v0.9 terminal three-state vectors, 8 blocks per
  row, four typed groups (`entry-pos`, `entry-other-different`,
  `entry-same-module-different`, `entry-missing`).
- `oracle-samples.json`: independent gold samples plus accepted and control
  student runs (known-miss and unknown-misreport).

These fixtures are local, run without a browser, fitter, installed binary or
network, and never carry training gold into the student input.
