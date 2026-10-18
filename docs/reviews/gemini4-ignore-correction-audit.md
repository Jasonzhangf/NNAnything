# Independent Methodology and Audit Report: Offline Ignore Error Correction (Conditions C and D)

## 1. Audit Status and Scope Verdict

- Verdict: PASS for offline experiment and documentation delivery.
- Scope boundary: Candidate weights remain an offline prototype (`adoptionStatus: "not_applied"`, `confidenceState: "uncalibrated"`, `productionChanged: false`). This audit does not grant production classifier integration or browser extension auto-filter adoption.
- Baseline preservation: Canonical results in `training/results/ignore-scoring-20261017/` remain untouched.

## 2. Verification of Scientific Claims and Code Execution

### 2.1 Frozen B Reproduction and Supervision Partition
- [ignore-wired-experiment.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/ignore-wired-experiment.mjs#L32-L39) and [experiment-core.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/experiment-core.mjs#L374-L405) partition the 152 Weibo rows into 37 `ignore` rows, 70 `retain` rows (including provisional anti-ignore anchors, 107 fit rows total), and 45 `ambiguous` rows excluded from fitting.
- Frozen condition B reproduces all 152 baseline predictions identically and reproduces the 5 target false-ignore errors (`nnanything-inspector-274`, `299`, `315`, `422`, `424`).
- Supervision labels remain unchanged across B, C, and D.

### 2.2 Condition C Linear Additive Capacity Limit
- Under additive wires $s = a + b\cdot\text{Border} + p\cdot\text{PEnone} + r\cdot\text{Ratio}$ sharing the empty-div base score $a$, the two ignore rows (`306` blur line, `392` avatar overlay) and two retain rows (`422` media cover, `424` media slot) obey the linear coupling identity $s_{422} + s_{424} = s_{306} + s_{392} + 0.4444r$ when pointer-events terms match or vanish.
- Setting exact targets $s_{306} = s_{392} = 0.9$ with bounded weight $r \in [-1, 1]$ yields $s_{422} + s_{424} \ge 1.3556 > 1.2$, which prevents both retain rows from falling below the $0.6$ ignore threshold simultaneously.
- Validity limit: This algebra proves exact-target linear additive coupling on that 4-tuple under $s_{306}=s_{392}=0.9$. It does not prove general linear classification infeasibility across arbitrary margins or relaxed ignore targets. Preserving C's 300-epoch and 3300-epoch failure on `424` as motivation for conjunctive wires is scientifically sound.

### 2.3 Condition D Derived Conjunctive Wires and Handwired Mechanics
- [ignore-wired-experiment.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/ignore-wired-experiment.mjs#L16-L29) adds three derived wires in [0, 1]: `rel_single_child_div`, `rel_empty_pointer_eligible_extent` ($\text{empty} \cdot (1 - \text{PEnone}) \cdot \min(W,H)/\max(W,H)$), and `rel_empty_border_extent` ($\text{empty} \cdot \text{border} \cdot \min(W,H)/\max(W,H)$).
- Missing inputs propagate `null`, while known `0` factors annihilate the product (`0 * null -> 0`). No single feature acts as a hard veto.
- Zero migration (`named B seed + 0` on new wires) and save/reload round-trip ([wired-weights.json](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/wired-weights.json)) match intervals across all $152 + 357 = 509$ rows ([ignore-wired-experiment.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/ignore-wired-experiment.mjs#L40-L42), [ignore-wired-experiment.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/ignore-wired-experiment.mjs#L67-L70)).
- [experiment-core.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/experiment-core.mjs#L511-L580) builds a real Handwired `Circuit` (`multiply`, `reglu`, `affine`, `evaluateReference`, `backpropagateReference`) validated against finite differences ([experiment-core.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/experiment-core.mjs#L637-L683)).
- Surrogate competition in [experiment-core.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/experiment-core.mjs#L685-L756) checks `lowerIgnore >= 0.6` and `lowerIgnore - strongestConcreteUpper >= 0.15` against the maximum upper bound across all family and leaf stages.

### 2.4 Optimization Trajectory and Classification Counts
- Initial 300-epoch fit reduces loss from `0.038963` to `0.021328` (36/37 ignore, 2/70 retain false-ignore).
- Bounded 3000-epoch train-only continuation (`lr = 0.05`, weights clipped to `[-1, 1]`, raw squared targets `0.9` and `0`) reaches `finalLoss: 0.006555` and `finalMaxSquaredDeviation: 0.274168`.
- Because `0.274168 > 0.09`, [wired-comparison.json](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/wired-comparison.json#L338-L342) and [verification.json](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/verification.json#L8) honestly record `converged: false` and `lossConvergenceTargetMet: false`.
- Final classification on the 152 Weibo rows achieves 37/37 `ignore` recalled and 0/70 `retain` false-ignores:
  - `274`, `299`, `315` (popup wrappers): `0.7471 -> 0.2646` (`winnerIgnore: false`).
  - `422` (bordered cover): `0.7867 -> 0.1834` (`winnerIgnore: false`).
  - `424` (pointer-eligible slot): `0.7867 -> 0.1896` (`winnerIgnore: false`).
- Among the 45 `ambiguous` rows, 1 row (`nnanything-inspector-534`, video caption layer, score `0.8884`) remains above threshold and is explicitly reported as unresolved.

### 2.5 Gold 357, Sidecar Provenance, and Comment Action Regression
- Gold 357 evaluation (309 concrete, 48 other across `default` and `legacy` profiles) is strictly evaluation-only with `0` false-ignores and `0` prediction changes. Because `explorationInput` is `null` on Gold 357, all relation and sidecar wires evaluate to `null`; this proves zero-migration safety and non-regression, not new-page generalization.
- Sidecar alignment (`65` unique matches, `1` ambiguous left `null`) uses exact tag, class set, and rect solely for teacher/observation alignment; student features exclude raw class/id strings.
- Local [AGENTS.md](file:///Volumes/Intel/playground/nnanything/ignore-scoring/AGENTS.md) and [comment-action-regression.json](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/comment-action-regression.json#L1-L123) align on comment/reply expand, manual load more, and retry controls: 3 synthetic fixtures (`span` `0.000`, `div` `0.341`, `button` `0.000`) are retained, while live expand/load click proof is honestly marked `false` (`已加载全部评论` observed on visited pages; only the `更多` 9-button menu click was live-verified).

## 3. Audit Findings and Required Reporting Limits

1. Pre-multiplied JS features vs. circuit sensor boundary (Advisory): [ignore-wired-experiment.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/ignore-wired-experiment.mjs#L27-L28) computes the 3-way product in JS before passing a scalar wire in `[0, 1]` to Handwired. Documentation must state that conjunction is pre-extracted as a derived input wire rather than multiplied inside the production Handwired circuit.
2. Minor telemetry naming in helper (Advisory): [experiment-core.mjs](file:///Volumes/Intel/playground/nnanything-runs/ignore-scoring/experiment-core.mjs#L610-L613) computes `changedAddresses` by filtering `value !== 0` (active non-zero weights) rather than `value !== seed[name]`. Do not cite `changedWeightCount` as the count of weights modified from seed B.
3. Recommended final state: Offline 5 retain errors fixed (`37/37` ignore, `0/70` retain false-ignore), ambiguous `534` unresolved, comment expand/manual-load live cases unverified, and candidate profile kept `not_applied` / `uncalibrated`.
