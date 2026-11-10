import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { createCurrentControlAuthority } from "../dist/adapters/browser/current-control-authority.js";
import {
  BA1_REAL_SITE_MDN_SHADOW_ROOT_COVERAGE,
} from "../dist/adapters/browser/b-a1-real-site-browser-projection.js";
import {
  BA1RealSiteAcceptanceChangedError,
  BA1RealSiteFreshnessError,
  BA1_REAL_SITE_FAMILY,
  runBA1RealSiteFirstResult,
} from "../dist/adapters/browser/b-a1-real-site-consumer.js";
import {
  createBA1RealSiteCdpRuntime,
} from "../dist/adapters/browser/b-a1-real-site-cdp-runtime.js";
import { BA1_ENCODER_VERSION } from "../dist/training/b-a1-route-encoder.js";
import {
  createUnifiedModelPackage,
  saveUnifiedModelPackageAtomic,
} from "../dist/training/unified-model-package.js";
import { UNIFIED_PARAMETER_COUNTS } from "../dist/training/unified-forward.js";

function assertJsonProjection(value, path = "projection") {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) return;
  assert.notEqual(typeof value, "function", `${path} must not contain a callback`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonProjection(entry, `${path}[${index}]`));
    return;
  }
  assert.equal(typeof value, "object", `${path} must be JSON-safe`);
  for (const forbidden of ["element", "scopeRoot", "nodes", "propertiesOf", "nodeType", "ownerDocument"]) {
    assert.equal(Object.hasOwn(value, forbidden), false, `${path}.${forbidden} must be absent`);
  }
  for (const [key, entry] of Object.entries(value)) assertJsonProjection(entry, `${path}.${key}`);
}

async function packageScoringHasLabel(dir) {
  const W1 = new Array(UNIFIED_PARAMETER_COUNTS.W1).fill(0);
  W1[0 * 64 + 35] = 1;
  const W2 = new Array(UNIFIED_PARAMETER_COUNTS.W2).fill(0);
  W2[0 * 64 + 0] = 1;
  const W3 = new Array(UNIFIED_PARAMETER_COUNTS.W3).fill(0);
  W3[0] = 1;
  const pkg = createUnifiedModelPackage({
    modelId: "b-a1-real-site-runtime-fixture",
    version: "0.0.1",
    route: { domain: "browser", decisionKind: "R" },
    encoderVersion: BA1_ENCODER_VERSION,
    tensors: {
      W1,
      b1: new Array(UNIFIED_PARAMETER_COUNTS.b1).fill(0),
      W2,
      b2: new Array(UNIFIED_PARAMETER_COUNTS.b2).fill(0),
      W3,
      b3: [0],
    },
    resources: {
      thresholdsRef: "thresholds.json",
      thresholdsSchema: "nnanything.feature-thresholds.v1",
      missingModeTableRef: "missing.json",
      missingModeSchema: "nnanything.unified.missing-mode.v1",
    },
  });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thresholds.json"), "{}\n");
  await writeFile(join(dir, "missing.json"), "{}\n");
  return saveUnifiedModelPackageAtomic(join(dir, "package.json"), pkg);
}

const html1 = `
  <div id="scope">
    <label>搜索<input id="search" type="search"></label>
    <button type="submit">提交</button>
  </div>
  <input id="outside" type="search">
`;
const html2 = '<div id="scope"><label>查询<input id="search2" type="text"></label></div>';
const html3 = '<div id="scope"><label>检索<input id="search3" type="search"></label></div>';

function selectedGold(ref) {
  return {
    kind: "bound",
    state: "selected",
    selectedRef: ref,
    family: BA1_REAL_SITE_FAMILY,
    group: "runtime",
  };
}

test("real headless Chrome projection and current-control freshness", async t => {
  const evidenceRoot = process.env.B_A1_RUNTIME_EVIDENCE_DIR
    ?? await mkdtemp(join(tmpdir(), "b-a1-runtime-evidence-"));
  await mkdir(evidenceRoot, { recursive: true });
  const runRoot = join(evidenceRoot, "chrome-run");
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  const packageDir = await mkdtemp(join(tmpdir(), "b-a1-runtime-package-"));
  const packagePath = await packageScoringHasLabel(packageDir);
  const projectionBundle = await build({
    entryPoints: [new URL("../lib/adapters/browser/b-a1-real-site-browser-projection.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "BA1Projection",
    platform: "browser",
    target: "es2022",
  });
  const projectionScript = `${projectionBundle.outputFiles[0].text}
globalThis.__nnanythingBA1RealSiteProjection = BA1Projection.handleBA1RealSiteBrowserProjectionRequest;`;

  const runtime = await createBA1RealSiteCdpRuntime();
  try {
    await runtime.setDocumentContent(html1, "doc-runtime-1");
    await runtime.installProjectionBundle(projectionScript);
    const first = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    assert.equal(first.operation.identity.documentRef, "doc-runtime-1");
    assert.equal(first.operation.identity.observationId, "observation-1");
    assert.equal(first.projection.identity.observationId, first.operation.identity.observationId);
    assert.equal(first.projection.candidates.length, 1);
    assert.equal(first.projection.candidates[0].ref, "node-1");
    assert.deepEqual(JSON.parse(JSON.stringify(first.projection)), first.projection);
    assertJsonProjection(first.projection);
    assert.equal(BA1_REAL_SITE_MDN_SHADOW_ROOT_COVERAGE, "partial");

    const validOutput = join(runRoot, "valid-result");
    const valid = await runBA1RealSiteFirstResult({
      observation: first.projection,
      packagePath,
      currentControl: () => runtime.readControl(),
      gold: selectedGold(first.projection.candidates[0].ref),
      sampleId: "runtime-valid",
      outputDir: validOutput,
    });
    assert.equal(valid.evaluation.passed, true);
    assert.equal(valid.projection.scoredCandidates.length, 1);
    const validFile = JSON.parse(await readFile(valid.artifacts.projection, "utf8"));
    assert.equal(validFile.forward.status, "completed");
    assert.equal(validFile.acceptance.status, "accepted");
    assert.deepEqual(validFile.acceptance.operation, first.operation);

    const firstEnvelope = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    await assert.rejects(
      runBA1RealSiteFirstResult({
        observation: firstEnvelope.projection,
        packagePath: join(packageDir, "missing.json"),
        currentControl: () => runtime.readControl(),
        gold: selectedGold(firstEnvelope.projection.candidates[0].ref),
        sampleId: "runtime-second-observation",
        outputDir: join(runRoot, "second-observation"),
      }),
      error => error instanceof BA1RealSiteFreshnessError && error.code === "stale_candidate",
    );
    const secondReceipt = JSON.parse(await readFile(
      join(runRoot, "second-observation", "failure-receipt.json"),
      "utf8",
    ));
    assert.equal(secondReceipt.stage, "admission");
    assert.equal(secondReceipt.failure.forward.status, "not_run");

    const oldDocument = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    await runtime.setDocumentContent(html2, "doc-runtime-2");
    await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    await assert.rejects(
      runBA1RealSiteFirstResult({
        observation: oldDocument.projection,
        packagePath: join(packageDir, "missing.json"),
        currentControl: () => runtime.readControl(),
        gold: selectedGold(oldDocument.projection.candidates[0].ref),
        sampleId: "runtime-document-replacement",
        outputDir: join(runRoot, "document-replacement"),
      }),
      error => error instanceof BA1RealSiteFreshnessError && error.code === "stale_candidate",
    );

    const pending = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    let pendingReads = 0;
    const pendingReader = () => {
      pendingReads += 1;
      if (pendingReads === 2) {
        const replacement = createCurrentControlAuthority({ documentRef: "doc-runtime-pending" });
        runtime.slot.replace(replacement);
        replacement.beginObservation();
      }
      return runtime.readControl();
    };
    await assert.rejects(
      runBA1RealSiteFirstResult({
        observation: pending.projection,
        packagePath,
        currentControl: pendingReader,
        gold: selectedGold(pending.projection.candidates[0].ref),
        sampleId: "runtime-pending-load",
        outputDir: join(runRoot, "pending-load"),
      }),
      error => error instanceof BA1RealSiteFreshnessError
        && error.code === "stale_forward_gate",
    );
    const pendingReceipt = JSON.parse(await readFile(
        join(runRoot, "pending-load", "failure-receipt.json"),
      "utf8",
    ));
    assert.equal(pendingReceipt.failure.code, "stale_forward_gate");
    assert.equal(pendingReceipt.failure.forward.status, "not_run");
    assert.deepEqual(pendingReceipt.failure.scores, []);

    await runtime.setDocumentContent(html3, "doc-runtime-3");
    const afterForward = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    let acceptanceReads = 0;
    const acceptanceReader = () => {
      acceptanceReads += 1;
      if (acceptanceReads === 3) {
        const replacement = createCurrentControlAuthority({ documentRef: "doc-runtime-after-forward" });
        runtime.slot.replace(replacement);
        replacement.beginObservation();
      }
      return runtime.readControl();
    };
    const acceptanceError = await runBA1RealSiteFirstResult({
      observation: afterForward.projection,
      packagePath,
      currentControl: acceptanceReader,
      gold: selectedGold(afterForward.projection.candidates[0].ref),
      sampleId: "runtime-after-forward",
        outputDir: join(runRoot, "after-forward"),
    }).then(() => null, error => error);
    assert.ok(acceptanceError instanceof BA1RealSiteAcceptanceChangedError);
    assert.equal(acceptanceError.attempt.forward.status, "completed");
    assert.equal(acceptanceError.attempt.scores.length, 1);
    const acceptanceReceipt = JSON.parse(await readFile(
      join(runRoot, "after-forward", "failure-receipt.json"),
      "utf8",
    ));
    assert.equal(acceptanceReceipt.failure.kind, "current_control_changed_before_acceptance");
    assert.equal(acceptanceReceipt.attempt.forward.status, "completed");
    assert.equal(acceptanceReceipt.attempt.scores.length, 1);

    await runtime.setDocumentContent(html1, "doc-runtime-4");
    const accepted = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const acceptedOutput = join(runRoot, "after-acceptance-save");
    let navigation = Promise.resolve();
    let acceptedReads = 0;
    const acceptedReader = () => {
      acceptedReads += 1;
      if (acceptedReads === 3) {
        setTimeout(() => {
          navigation = runtime.setDocumentContent(html2, "doc-runtime-later");
        }, 0);
      }
      return runtime.readControl();
    };
    const acceptedResult = await runBA1RealSiteFirstResult({
      observation: accepted.projection,
      packagePath,
      currentControl: acceptedReader,
      gold: selectedGold(accepted.projection.candidates[0].ref),
      sampleId: "runtime-after-acceptance",
      outputDir: acceptedOutput,
    });
    const beforeNavigation = await readFile(acceptedResult.artifacts.projection, "utf8");
    await new Promise(resolve => setTimeout(resolve, 50));
    await navigation;
    assert.equal(await readFile(acceptedResult.artifacts.projection, "utf8"), beforeNavigation);
    assert.equal(JSON.parse(beforeNavigation).acceptance.observed.identity.documentRef, "doc-runtime-4");

    const report = {
      ok: true,
      realDocument: "doc-runtime-1",
      issuedToken: first.operation.identity,
      echoedField: first.projection.identity,
      candidateCount: first.projection.candidates.length,
      selectedCandidate: valid.projection.output.selectedRef,
      validForward: validFile.forward,
      secondObservationRejected: secondReceipt.failure.code,
      documentReplacementRejected: "stale_candidate",
      pendingLoadRejected: pendingReceipt.failure.code,
      afterForwardPreserved: acceptanceReceipt.attempt.forward,
      afterForwardScores: acceptanceReceipt.attempt.scores.length,
      afterAcceptanceRecord: JSON.parse(beforeNavigation).acceptance,
      shadowRootCoverage: BA1_REAL_SITE_MDN_SHADOW_ROOT_COVERAGE,
      projectionJsonSafe: true,
    };
    await writeFile(join(runRoot, "runtime-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await runtime.close();
  }
});
