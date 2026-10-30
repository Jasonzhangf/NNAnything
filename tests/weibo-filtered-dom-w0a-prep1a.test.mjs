import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  validateExplorationInput,
  isSafeRuleAttribute,
} from "nnanything/browser-classify";
import {
  runConversion,
  convertSourceA,
  convertSourceB,
  buildL1Wires16,
  describeSlotOutcome,
  computeRetainedNodes,
  L1_WIRE_NAMES,
  L1_KIND_ORDER,
  DEFAULT_SOURCE_A,
  DEFAULT_SOURCE_B,
  DEFAULT_SOURCE_C,
} from "../playground/browser/weibo-filtered-dom/w0a/convert-existing-filtered-dom.mjs";

const MISSING_PARENT_FIXTURE =
  "/Volumes/extension/code/NNAnything/training/samples/training-m1/unseen/weibo-search.json";
const CONVERTER_PATH = fileURLToPath(
  new URL(
    "../playground/browser/weibo-filtered-dom/w0a/convert-existing-filtered-dom.mjs",
    import.meta.url,
  ),
);

let workDir;
let outputs;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "w0a-prep1a-"));
  outputs = runConversion({
    outDir: workDir,
    sourceA: DEFAULT_SOURCE_A,
    sourceB: DEFAULT_SOURCE_B,
    sourceC: DEFAULT_SOURCE_C,
  });
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function readOutput(name) {
  return JSON.parse(readFileSync(join(workDir, name), "utf8"));
}

function readSourceA() {
  return JSON.parse(readFileSync(DEFAULT_SOURCE_A, "utf8"));
}

function readSourceB() {
  return JSON.parse(readFileSync(DEFAULT_SOURCE_B, "utf8"));
}

function assertL1Shape(wires) {
  assert.deepEqual(Object.keys(wires).sort(), [...L1_WIRE_NAMES].sort());
  for (const name of L1_WIRE_NAMES) {
    assert.ok(wires[name] === 0 || wires[name] === 1, `${name} must be 0 or 1`);
  }
}

describe("W0a-Prep-1A filtered-DOM conversion", () => {
  test("assertion 1: real public four-step run and ordered three-source output", () => {
    const a = readOutput("snapshot-001.prep.json");
    const b = readOutput("weibo-current-inputs.prep.json");
    const c = readOutput("weibo-live-capture.diagnostic.json");
    const s = readOutput("prep1a-summary.json");
    assert.equal(a.source.nodeCount, 2000);
    assert.equal(a.slots.length, 2000);
    assert.equal(b.source.nodeCount, 2313);
    assert.equal(b.slots.length, 2313);
    assert.equal(c.source.rowCount, 152);
    assert.equal(c.rows.length, 152);
    assert.ok(s.sources.sourceA);
    assert.ok(s.sources.sourceB);
    assert.ok(s.sources.sourceC);
    for (const prep of [a, b]) {
      for (const row of prep.slots) {
        assert.equal(row.slotIndex, row.index);
        assert.equal(row.index, prep.slots[row.index].index);
        assert.doesNotThrow(() => validateExplorationInput(row.explorationInput));
      }
    }
    for (const row of c.rows) {
      assert.equal(row.slotIndex, row.index);
      assert.doesNotThrow(() => validateExplorationInput(row.explorationInput));
    }
  });

  test("assertion 2: real missing data stays unmeasured, never fabricated", () => {
    const a = readOutput("snapshot-001.prep.json");
    const b = readOutput("weibo-current-inputs.prep.json");
    const aNodes = readSourceA().nodes;
    const bNodes = readSourceB().nodes;
    for (const prep of [a, b]) {
      for (const row of prep.slots) {
        const ei = row.explorationInput;
        assert.equal(ei.geometry.clippedRect, null);
        assert.equal(ei.measurementCoverage.clippedRect, "unmeasured");
        assert.equal(ei.childComposition.directChildrenStatus, "unknown");
        assert.equal(ei.measurementCoverage.childElementCount, "unmeasured");
        assert.equal(ei.measurementCoverage.positiveAreaChildCount, "unmeasured");
      }
    }
    for (const row of a.slots) {
      const source = aNodes[row.index];
      if (source.text === "") {
        assert.equal(row.explorationInput.measurementCoverage.directTextPresent, "unmeasured");
        assert.equal(row.explorationInput.measurementCoverage.nonFormatDirectTextPresent, "measured");
        assert.equal(row.itemObservation.nonFormatDirectTextPresent, false);
      }
    }
    for (const row of b.slots) {
      const source = bNodes[row.index];
      const attrs = source.attrs ?? {};
      if (!Object.prototype.hasOwnProperty.call(attrs, "href")) {
        assert.equal(row.explorationInput.measurementCoverage.hrefPresent, "unmeasured");
        assert.equal(row.itemObservation.hrefPresent, null);
      }
      for (const key of Object.keys(row.observationNode.attributes)) {
        assert.equal(isSafeRuleAttribute(key), true);
      }
      assert.ok(
        row.diagnosticEvidence.observedChildrenCountWithoutCompletenessProof === null ||
          typeof row.diagnosticEvidence.observedChildrenCountWithoutCompletenessProof ===
            "number",
      );
      assert.equal(row.explorationInput.measurementCoverage.childElementCount, "unmeasured");
    }
  });

  test("assertion 3: source C historical/current split and four-state 16-wire mapping", () => {
    const c = readOutput("weibo-live-capture.diagnostic.json");
    for (const row of c.rows) {
      assert.ok(row.historicalProposal);
      assert.ok("ruleRef" in row.historicalProposal);
      assert.ok("status" in row.historicalProposal);
      assert.ok("label" in row.historicalProposal);
      assert.ok(row.currentReclassification);
      assert.ok(row.currentReclassification.judgmentStatus);
      assert.ok(row.currentReclassification.basicKind !== undefined);
    }
    // Synthetic four-state mapping from the real public contract.
    const judgedLeaf = describeSlotOutcome({
      candidateStatus: "ok",
      judgmentStatus: "judged",
      basicKind: "link",
    });
    assert.equal(judgedLeaf.effectiveL1, "judged:link");
    assert.equal(judgedLeaf.inMainClassificationInput, true);
    assert.equal(judgedLeaf.l1Wires16.w01_l1_judged_mask, 1);
    assert.equal(judgedLeaf.l1Wires16.w08_l1_kind_link, 1);
    assert.equal(judgedLeaf.l1Wires16.w14_l1_kind_other, 0);
    assert.equal(judgedLeaf.l1Wires16.w15_l1_status_unknown, 0);
    assert.equal(judgedLeaf.l1Wires16.w16_l1_status_conflict, 0);

    const judgedOther = describeSlotOutcome({
      candidateStatus: "ok",
      judgmentStatus: "judged",
      basicKind: "other",
    });
    assert.equal(judgedOther.effectiveL1, "judged:other");
    assert.equal(judgedOther.l1Wires16.w01_l1_judged_mask, 1);
    assert.equal(judgedOther.l1Wires16.w14_l1_kind_other, 1);

    const unknownOther = describeSlotOutcome({
      candidateStatus: "unknown",
      semanticDiagnostic: { judgmentStatus: "unknown", basicKind: "other" },
    });
    assert.equal(unknownOther.effectiveL1, "unknown:other");
    assert.equal(unknownOther.l1Wires16.w01_l1_judged_mask, 0);
    assert.equal(unknownOther.l1Wires16.w14_l1_kind_other, 0);
    assert.equal(unknownOther.l1Wires16.w15_l1_status_unknown, 1);

    const conflictOther = describeSlotOutcome({
      candidateStatus: "unknown",
      semanticDiagnostic: { judgmentStatus: "conflict", basicKind: "other" },
    });
    assert.equal(conflictOther.effectiveL1, "conflict:other");
    assert.equal(conflictOther.l1Wires16.w01_l1_judged_mask, 0);
    assert.equal(conflictOther.l1Wires16.w14_l1_kind_other, 0);
    assert.equal(conflictOther.l1Wires16.w16_l1_status_conflict, 1);

    const excluded = describeSlotOutcome({ candidateStatus: "filtered_out" });
    assert.equal(excluded.effectiveL1, "excluded:null");
    assert.equal(excluded.inMainClassificationInput, false);
    assert.equal(excluded.l1Wires16, null);

    for (const name of L1_KIND_ORDER) {
      const wires = buildL1Wires16({ judgmentStatus: "judged", basicKind: name });
      assertL1Shape(wires);
      assert.equal(wires.w01_l1_judged_mask, 1);
      assert.equal(wires.w14_l1_kind_other, 0);
    }
  });

  test("assertion 4: folded ignore and excluded ancestors never drop descendants", () => {
    // Synthetic minimal chain: the fold and exclude bridge is a code path that
    // the real sources do not exercise (no judged:ignore row in A/B), so it is
    // verified deterministically as an engineering counterexample.
    const syntheticRows = [
      {
        slotIndex: 0,
        index: 0,
        nodeRef: "node-0",
        rawParentRef: null,
        disposition: "active_retained",
        effectiveL1: "judged:container",
        judgmentStatus: "judged",
        basicKind: "container",
        l1Wires16: buildL1Wires16({ judgmentStatus: "judged", basicKind: "container" }),
      },
      {
        slotIndex: 1,
        index: 1,
        nodeRef: "node-1",
        rawParentRef: "node-0",
        disposition: "folded_ignore_wrapper",
        effectiveL1: "judged:ignore",
        judgmentStatus: "judged",
        basicKind: "ignore",
        l1Wires16: buildL1Wires16({ judgmentStatus: "judged", basicKind: "ignore" }),
      },
      {
        slotIndex: 2,
        index: 2,
        nodeRef: "node-2",
        rawParentRef: "node-1",
        disposition: "excluded_candidate",
        effectiveL1: "excluded:null",
        judgmentStatus: "excluded",
        basicKind: null,
        l1Wires16: null,
      },
      {
        slotIndex: 3,
        index: 3,
        nodeRef: "node-3",
        rawParentRef: "node-2",
        disposition: "active_retained",
        effectiveL1: "judged:text",
        judgmentStatus: "judged",
        basicKind: "text",
        l1Wires16: buildL1Wires16({ judgmentStatus: "judged", basicKind: "text" }),
      },
    ];
    const retained = computeRetainedNodes(syntheticRows);
    assert.equal(retained.length, 2);
    const leaf = retained.find((row) => row.nodeRef === "node-3");
    assert.ok(leaf);
    assert.equal(leaf.effectiveRetainedAncestorRef, "node-0");
    assert.deepEqual(leaf.bridgedIntermediateNodeRefs, ["node-2", "node-1"]);
    assert.equal(leaf.collapsedWrapperHopCount, 2);
    const foldedOutcome = describeSlotOutcome({
      candidateStatus: "ok",
      judgmentStatus: "judged",
      basicKind: "ignore",
    });
    assert.equal(foldedOutcome.disposition, "folded_ignore_wrapper");
    assert.equal(foldedOutcome.l1Wires16.w13_l1_kind_ignore, 1);

    for (const file of ["snapshot-001.prep.json", "weibo-current-inputs.prep.json"]) {
      const prep = readOutput(file);
      const byRef = new Map(prep.slots.map((row) => [row.nodeRef, row]));
      const retainedByRef = new Map(
        prep.retainedNodes.map((row) => [row.nodeRef, row]),
      );
      const active = prep.slots.filter(
        (row) => row.disposition === "active_retained",
      );
      assert.equal(prep.retainedNodes.length, active.length);
      for (const row of active) {
        assert.ok(retainedByRef.has(row.nodeRef), "active row must be retained");
        assert.equal(row.l1Wires16.w13_l1_kind_ignore, 0);
      }
      for (const row of active) {
        const kept = retainedByRef.get(row.nodeRef);
        assert.ok(kept);
        // Independently recompute the nearest active_retained ancestor from the
        // real slot dispositions and raw parent refs.
        const expectedBridged = [];
        const seen = new Set([row.nodeRef]);
        let cursor = row.rawParentRef;
        let expectedAncestor = null;
        while (cursor !== null) {
          assert.ok(!seen.has(cursor), "retained ancestry must be acyclic");
          seen.add(cursor);
          const current = byRef.get(cursor);
          if (!current) break;
          if (current.disposition === "active_retained") {
            expectedAncestor = cursor;
            break;
          }
          expectedBridged.push(cursor);
          cursor = current.rawParentRef;
        }
        assert.equal(kept.effectiveRetainedAncestorRef, expectedAncestor);
        assert.deepEqual(kept.bridgedIntermediateNodeRefs, expectedBridged);
        for (const bridged of kept.bridgedIntermediateNodeRefs) {
          const candidate = byRef.get(bridged);
          assert.ok(candidate);
          assert.ok(
            candidate.disposition === "folded_ignore_wrapper" ||
              candidate.disposition === "excluded_candidate",
            "bridged refs must be folded or excluded",
          );
        }
        if (kept.effectiveRetainedAncestorRef !== null) {
          const ancestor = byRef.get(kept.effectiveRetainedAncestorRef);
          assert.ok(ancestor);
          assert.equal(ancestor.disposition, "active_retained");
        }
        assert.equal(kept.collapsedWrapperHopCount, kept.bridgedIntermediateNodeRefs.length);
      }
      // A descendant of a folded/excluded parent is never removed from the tree.
      for (const row of prep.slots) {
        if (row.disposition === "active_retained") continue;
        const parent = row.rawParentRef;
        if (parent === null) continue;
        const parentRow = byRef.get(parent);
        if (!parentRow) continue;
        if (parentRow.disposition === "active_retained") continue;
        const children = prep.slots.filter(
          (candidate) => candidate.rawParentRef === row.nodeRef,
        );
        for (const child of children) {
          if (child.disposition === "active_retained") {
            assert.ok(retainedByRef.has(child.nodeRef), "child must remain retained");
          }
        }
      }
    }
  });

  test("assertion 5: missing parent and corrupt inputs throw and CLI exits non-zero", () => {
    assert.throws(() => convertSourceA(MISSING_PARENT_FIXTURE), /parent tree edge/);
    assert.throws(() => convertSourceB(MISSING_PARENT_FIXTURE), /parent tree edge/);
    const corrupt = join(workDir, "corrupt.json");
    writeFileSync(corrupt, "{ not json", "utf8");
    assert.throws(() => convertSourceA(corrupt), /not valid JSON/);
    assert.throws(() => convertSourceB(corrupt), /not valid JSON/);
    assert.throws(() => convertSourceA("/nonexistent/path.json"), /could not be read/);

    const missingRun = spawnSync(
      process.execPath,
      [CONVERTER_PATH, "--out-dir", workDir, "--source-a", MISSING_PARENT_FIXTURE],
      { encoding: "utf8" },
    );
    assert.notEqual(missingRun.status, 0, "missing parent CLI must exit non-zero");
    assert.match(missingRun.stderr, /parent tree edge/);

    const corruptRun = spawnSync(
      process.execPath,
      [CONVERTER_PATH, "--out-dir", workDir, "--source-a", corrupt],
      { encoding: "utf8" },
    );
    assert.notEqual(corruptRun.status, 0, "corrupt CLI must exit non-zero");
    assert.match(corruptRun.stderr, /not valid JSON/);
  });

  test("assertion 6: honest diagnostic flags on every output file", () => {
    for (const name of [
      "snapshot-001.prep.json",
      "weibo-current-inputs.prep.json",
      "weibo-live-capture.diagnostic.json",
      "prep1a-summary.json",
    ]) {
      const payload = readOutput(name);
      assert.equal(payload.usageScope, "diagnostic_development_only");
      assert.equal(payload.trainingEligible, false);
      assert.equal(payload.autoGold, false);
      assert.equal(payload.filterRecallStatus, "UNVERIFIED");
    }
  });
});
