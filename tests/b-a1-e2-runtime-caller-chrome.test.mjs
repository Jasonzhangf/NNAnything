import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  BA1RealSiteCdpRuntimeError,
  createBA1RealSiteCdpRuntime,
} from "../dist/adapters/browser/b-a1-real-site-cdp-runtime.js";
import {
  SEARCH_INPUT_HOST_WIRES,
  inferSearchInputHostBinding,
  neutralSearchInputHostProfile,
  validateSearchInputHostProfile,
} from "../dist/search-input-host.js";
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

async function waitUntil(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // The page context can disappear during a real navigation.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
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
const pageInitiatedTargetHtml = '<div id="scope"><input id="after-real-navigation" type="search"></div>';
const pageInitiatedHtml = target => `
  <div id="scope"><input id="before-real-navigation" type="search"></div>
  <script>
    setTimeout(() => {
      location.href = ${JSON.stringify(target)};
    }, 250);
  </script>
`;
const subframeTarget = `data:text/html,${encodeURIComponent("<p>subframe loaded</p>")}`;
const subframeOnlyHtml = `
  <div id="scope"><input id="main-control" type="search"></div>
  <script>
    setTimeout(() => {
      const frame = document.createElement("iframe");
      frame.id = "subframe";
      frame.src = ${JSON.stringify(subframeTarget)};
      frame.onload = () => {
        const input = document.createElement("input");
        input.id = "subframe-loaded";
        input.type = "search";
        document.getElementById("scope").appendChild(input);
      };
      document.body.appendChild(frame);
    }, 100);
  </script>
`;
const observerSemanticsHtml = `
  <div id="rootHost" contenteditable="true">
    <span id="inherited"></span>
    <div id="falseHost" contenteditable="false"></div>
  </div>
  <div id="ordinaryScope">
    <input id="nonnegative" type="search" tabindex="0">
    <input id="negative" type="search" tabindex="-1">
    <input id="absent" type="search">
    <input id="invalid" type="search" tabindex="abc">
    <input id="focusedAbsent" type="search" onfocus="this.setAttribute('aria-label', 'focused')">
    <input id="focusedNegative" type="search" tabindex="-1"
      onfocus="this.setAttribute('aria-label', 'focused')">
    <button id="ordinaryButton" type="button">ordinary</button>
    <div id="shadowHost"></div>
  </div>
  <script>
    const shadow = document.getElementById("shadowHost").attachShadow({ mode: "open" });
    shadow.innerHTML = '<input id="shadowInput" type="search">';
    setTimeout(() => document.getElementById("focusedAbsent").focus(), 0);
    setTimeout(() => document.getElementById("focusedNegative").focus(), 50);
  </script>
`;

function selectedGold(ref) {
  return {
    kind: "bound",
    state: "selected",
    selectedRef: ref,
    family: BA1_REAL_SITE_FAMILY,
    group: "runtime",
  };
}

async function projectionBundleScript() {
  const projectionBundle = await build({
    entryPoints: [new URL("../lib/adapters/browser/b-a1-real-site-browser-projection.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "BA1Projection",
    platform: "browser",
    target: "es2022",
  });
  return `${projectionBundle.outputFiles[0].text}
globalThis.__nnanythingBA1RealSiteProjection = BA1Projection.handleBA1RealSiteBrowserProjectionRequest;`;
}

function openShadowFixture({
  id = "mdn-search",
  hostStyle = "",
  rootHtml = '<dialog open style="display:block; position:relative; margin:20px; padding:16px; width:320px; height:80px;"><label>Search<input id="shadow-search" type="search" tabindex="0"></label></dialog>',
  hostTag = "div",
  className = "",
} = {}) {
  return `
    <${hostTag} id="${id}" class="${className}" style="${hostStyle}"></${hostTag}>
    <script>
      document.getElementById(${JSON.stringify(id)})
        .attachShadow({ mode: "open" })
        .innerHTML = ${JSON.stringify(rootHtml)};
    </script>
  `;
}

async function expectRuntimeProjectionFailure(promise, expectedCode, expectedStage) {
  const error = await promise.then(() => null, value => value);
  assert.ok(error instanceof BA1RealSiteCdpRuntimeError, `expected typed projection error, got ${String(error)}`);
  assert.equal(error.code, "projection_failed");
  assert.equal(error.detail.code, expectedCode);
  assert.equal(error.detail.stage, expectedStage);
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
  const pageNavigationServer = createServer((request, response) => {
    if (request.url === "/target") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageInitiatedTargetHtml);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const pageNavigationPort = await new Promise((resolve, reject) => {
    pageNavigationServer.once("error", reject);
    pageNavigationServer.listen(0, "127.0.0.1", () => {
      const address = pageNavigationServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("page navigation server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  const pageInitiatedTarget = `http://127.0.0.1:${pageNavigationPort}/target`;
  const projectionScript = await projectionBundleScript();

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
    assert.match(first.projection.candidates[0].ref, /^node-\d+$/);
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

    await runtime.setDocumentContent(
      pageInitiatedHtml(pageInitiatedTarget),
      "doc-runtime-page-source",
    );
    const pageOldProjection = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const observedAfterNavigation = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    assert.equal(observedAfterNavigation.projection.identity.documentRef, "page-document-1");
    assert.equal(observedAfterNavigation.projection.candidates.length, 1);
    assert.match(observedAfterNavigation.projection.candidates[0].ref, /^node-\d+$/);
    const realBodyControl = runtime.readControl();
    assert.equal(realBodyControl.identity.documentRef, "page-document-1");
    assert.notEqual(realBodyControl.identity.documentRef, pageOldProjection.projection.identity.documentRef);
    await assert.rejects(
      runBA1RealSiteFirstResult({
        observation: pageOldProjection.projection,
        packagePath: join(packageDir, "missing.json"),
        currentControl: () => runtime.readControl(),
        gold: selectedGold(pageOldProjection.projection.candidates[0].ref),
        sampleId: "runtime-page-navigation",
        outputDir: join(runRoot, "page-navigation"),
      }),
      error => error instanceof BA1RealSiteFreshnessError && error.code === "stale_candidate",
    );
    const pageReplacementReceipt = JSON.parse(await readFile(
      join(runRoot, "page-navigation", "failure-receipt.json"),
      "utf8",
    ));
    assert.equal(pageReplacementReceipt.stage, "admission");
    assert.equal(pageReplacementReceipt.failure.forward.status, "not_run");

    await runtime.setDocumentContent(subframeOnlyHtml, "doc-runtime-subframe");
    await waitUntil(
      async () => {
        try {
          const observed = await runtime.beginProjection({
            scopeSelector: "#scope",
            requestedRole: "search-input-host",
            access: "available",
          });
          return observed.projection.coverage.observedCandidateCount === 2;
        } catch {
          return false;
        }
      },
      "subframe did not load",
    );
    const observedAfterSubframe = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    assert.equal(observedAfterSubframe.projection.identity.documentRef, "doc-runtime-subframe");
    assert.equal(observedAfterSubframe.projection.candidates.length, 2);
    assert.match(observedAfterSubframe.projection.candidates[0].ref, /^node-\d+$/);
    const currentAfterSubframe = runtime.readControl();
    assert.equal(currentAfterSubframe.identity.documentRef, "doc-runtime-subframe");
    assert.equal(currentAfterSubframe.generation, 4, "subframe navigation must not replace the main document");

    await runtime.setDocumentContent(observerSemanticsHtml, "doc-runtime-observer");
    await new Promise(resolve => setTimeout(resolve, 500));
    const rootHostProjection = await runtime.beginProjection({
      scopeSelector: "#rootHost",
      requestedRole: "search-input-host",
      access: "available",
    });
    const rootHostCandidates = rootHostProjection.projection.candidates;
    assert.equal(rootHostProjection.projection.coverage.observedCandidateCount, 2);
    assert.equal(rootHostCandidates.length, 2);
    assert.equal(rootHostCandidates[0].host, "contenteditable");
    assert.equal(rootHostCandidates[0].contentEditable, true);
    assert.equal(rootHostCandidates[1].host, "contenteditable");
    assert.equal(rootHostCandidates[1].contentEditable, true);
    assert.equal(rootHostCandidates.some(candidate => candidate.contentEditable === false), false);

    const ordinaryProjection = await runtime.beginProjection({
      scopeSelector: "#ordinaryScope",
      requestedRole: "search-input-host",
      access: "available",
    });
    const observerCandidates = ordinaryProjection.projection.candidates;
    assert.equal(ordinaryProjection.projection.coverage.observedCandidateCount, 6);
    assert.equal(ordinaryProjection.projection.coverage.unassessedOpenShadowRootCount, 1);
    assert.equal(observerCandidates.length, 6);
    assert.equal(observerCandidates[0].explicitTabIndexKind, "nonnegative");
    assert.equal(observerCandidates[0].tabIndexFocus, true);
    assert.equal(observerCandidates[1].explicitTabIndexKind, "negative");
    assert.equal(observerCandidates[1].tabIndexFocus, false);
    assert.equal(observerCandidates[2].explicitTabIndexKind, "absent");
    assert.equal(observerCandidates[2].tabIndexFocus, false);
    assert.equal(observerCandidates[3].explicitTabIndexKind, "invalid");
    assert.equal(observerCandidates[3].tabIndexFocus, null);
    assert.equal(observerCandidates[4].explicitTabIndexKind, "absent");
    assert.equal(observerCandidates[4].hasAria, true);
    assert.equal(observerCandidates[4].tabIndexFocus, false);
    assert.equal(observerCandidates[5].explicitTabIndexKind, "negative");
    assert.equal(observerCandidates[5].hasAria, true);
    assert.equal(observerCandidates[5].tabIndexFocus, false);
    assert.equal(observerCandidates.every(candidate => candidate.host === "input"), true);

    await runtime.setDocumentContent(html1, "doc-runtime-observer-reset");

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
      rework: {
        pageInitiatedNavigation: {
          newDocumentRef: observedAfterNavigation.operation.identity.documentRef,
          oldProjectionRejected: pageReplacementReceipt.failure.code === "stale_candidate",
          oldProjectionStage: pageReplacementReceipt.stage,
          oldForwardStatus: pageReplacementReceipt.failure.forward.status,
          subframeDidNotReplaceMainDocument:
            currentAfterSubframe.identity.documentRef === "doc-runtime-subframe"
            && currentAfterSubframe.generation === 4,
        },
        observerSemantics: {
          rootHostObservedCandidateCount: rootHostProjection.projection.coverage.observedCandidateCount,
          rootHostCandidateCount: rootHostCandidates.length,
          rootHostKinds: rootHostCandidates.map(candidate => ({
            host: candidate.host,
            contentEditable: candidate.contentEditable,
          })),
          ordinaryObservedCandidateCount: ordinaryProjection.projection.coverage.observedCandidateCount,
          unassessedOpenShadowRootCount:
            ordinaryProjection.projection.coverage.unassessedOpenShadowRootCount,
          tabIndexCases: observerCandidates.map(candidate => ({
            explicitTabIndexKind: candidate.explicitTabIndexKind,
            tabIndexFocus: candidate.tabIndexFocus,
            hasAria: candidate.hasAria,
          })),
        },
      },
    };
    await writeFile(join(runRoot, "runtime-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await runtime.close();
    await new Promise(resolve => pageNavigationServer.close(() => resolve()));
  }
});

test("bounded open-shadow-root resolver public controls", async t => {
  const evidenceRoot = process.env.B_A1_RUNTIME_EVIDENCE_DIR
    ?? await mkdtemp(join(tmpdir(), "b-a1-shadow-runtime-evidence-"));
  const runRoot = join(evidenceRoot, "shadow-run");
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  const packageDir = await mkdtemp(join(tmpdir(), "b-a1-shadow-runtime-package-"));
  const packagePath = await packageScoringHasLabel(packageDir);
  const runtime = await createBA1RealSiteCdpRuntime();
  const projectionScript = await projectionBundleScript();
  const expectedScopeRef = JSON.stringify({
    kind: "open-shadow-root-child",
    hostSelector: "#mdn-search",
    childSelector: "dialog",
  });
  const selectionProfile = validateSearchInputHostProfile({
    ...neutralSearchInputHostProfile(),
    weights: SEARCH_INPUT_HOST_WIRES.map(wire => ({
      "type.search": 2,
      "hasLabel": 1,
      "markerHit": 2,
      "nonSearchMarker": -2,
    })[wire] ?? 0),
  });

  const bind = (projection, profile = selectionProfile) => inferSearchInputHostBinding({
    goal: { requestedRole: projection.requestedRole, allowedScopeRef: projection.scopeRef },
    candidates: projection.candidates,
    coverage: projection.coverage,
    currentControl: projection.identity,
  }, { profile });

  const projectionRequest = (scopeSelector = "#mdn-search", childSelector = "dialog") => ({
    scopeSelector,
    openShadowRootChildSelector: childSelector,
    requestedRole: "search-input-host",
    access: "available",
  });

  const setAndProject = async (html, documentRef, input = projectionRequest()) => {
    await runtime.setDocumentContent(html, documentRef);
    return runtime.beginProjection(input);
  };

  try {
    await runtime.setDocumentContent(html1, "shadow-light");
    await runtime.installProjectionBundle(projectionScript);
    const light = await runtime.beginProjection({
      scopeSelector: "#scope",
      requestedRole: "search-input-host",
      access: "available",
    });
    assert.equal(light.projection.scopeRef, "#scope");
    assert.equal(light.projection.candidates.length, 1);
    assert.equal(light.projection.candidates[0].cssHidden, false);
    assert.equal(light.projection.candidates[0].intersectsViewport, true);
    assert.equal(bind(light.projection).state, "selected");

    await runtime.setDocumentContent(openShadowFixture(), "shadow-q-sequence");
    const q1 = await runtime.beginProjection(projectionRequest());
    const q2 = await runtime.beginProjection(projectionRequest());
    assert.equal(q1.projection.scopeRef, expectedScopeRef);
    assert.equal(q2.projection.scopeRef, expectedScopeRef);
    assert.equal(q1.projection.identity.documentRef, q2.projection.identity.documentRef);
    assert.equal(q1.operation.generation, q2.operation.generation);
    assert.notEqual(q1.operation.identity.observationId, q2.operation.identity.observationId);
    assert.equal(q1.projection.identity.documentRef, q1.operation.identity.documentRef);
    assert.equal(q1.projection.identity.observationId, q1.operation.identity.observationId);
    assert.equal(q1.projection.identity.revision, q1.operation.identity.revision);
    assert.equal(q2.projection.identity.documentRef, q2.operation.identity.documentRef);
    assert.equal(q2.projection.identity.observationId, q2.operation.identity.observationId);
    assert.equal(q2.projection.identity.revision, q2.operation.identity.revision);
    assert.equal(q1.projection.candidates.length, 1);
    assert.equal(q2.projection.candidates.length, 1);
    assert.match(q1.projection.candidates[0].ref, /^node-\d+$/);
    assert.match(q2.projection.candidates[0].ref, /^node-\d+$/);
    assert.equal(q1.projection.candidates[0].scopeRef, expectedScopeRef);
    assert.equal(q2.projection.candidates[0].scopeRef, expectedScopeRef);
    assert.equal(q1.projection.coverage.scopeRef, expectedScopeRef);
    assert.equal(q2.projection.coverage.scopeRef, expectedScopeRef);
    const positiveCandidate = q2.projection.candidates[0];
    assert.equal(positiveCandidate.cssHidden, false);
    assert.equal(positiveCandidate.intersectsViewport, true);
    assert.equal(positiveCandidate.explicitTabIndexKind, "nonnegative");
    assert.equal(positiveCandidate.tabIndexFocus, true);
    assert.deepEqual(q2.projection.coverage, {
      scopeRef: expectedScopeRef,
      observedCandidateCount: 1,
      unassessedIframeCount: 0,
      unassessedObjectCount: 0,
      unassessedOpenShadowRootCount: 0,
      excluded: [],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(q2.projection)), q2.projection);
    assertJsonProjection(q2.projection);
    assert.equal(bind(q2.projection).state, "selected");
    await assert.rejects(
      runBA1RealSiteFirstResult({
        observation: q1.projection,
        packagePath,
        currentControl: () => runtime.readControl(),
        gold: selectedGold(q1.projection.candidates[0].ref),
        sampleId: "shadow-q1-stale",
        outputDir: join(runRoot, "shadow-q1-stale"),
      }),
      error => error instanceof BA1RealSiteFreshnessError && error.code === "stale_candidate",
    );

    await expectRuntimeProjectionFailure(
      setAndProject("<div id=\"other\"></div>", "shadow-missing-host"),
      "scope_not_found",
      "resolver",
    );

    await expectRuntimeProjectionFailure(
      setAndProject(
        `${openShadowFixture({ id: "mdn-search", className: "mdn-host" })}
         ${openShadowFixture({ id: "mdn-search-second", className: "mdn-host" })}`,
        "shadow-duplicate-host",
        projectionRequest(".mdn-host"),
      ),
      "scope_ambiguous",
      "resolver",
    );

    await expectRuntimeProjectionFailure(
      setAndProject(
        openShadowFixture({ rootHtml: "<span>no dialog</span>" }),
        "shadow-missing-child",
      ),
      "scope_not_found",
      "resolver",
    );

    await expectRuntimeProjectionFailure(
      setAndProject(
        openShadowFixture({ rootHtml: "<dialog>first</dialog><dialog>second</dialog>" }),
        "shadow-duplicate-child",
      ),
      "scope_ambiguous",
      "resolver",
    );

    await expectRuntimeProjectionFailure(
      setAndProject(
        openShadowFixture({ rootHtml: "<section><dialog>nested</dialog></section>" }),
        "shadow-nested-only",
      ),
      "scope_not_found",
      "resolver",
    );

    await expectRuntimeProjectionFailure(
      setAndProject(
        "<div id=\"mdn-search\"></div>",
        "shadow-no-open-root",
      ),
      "scope_shadow_root_unavailable",
      "resolver",
    );

    await expectRuntimeProjectionFailure(
      setAndProject(openShadowFixture(), "shadow-invalid-host-selector", projectionRequest("[")),
      "invalid_request",
      "request",
    );

    await expectRuntimeProjectionFailure(
      setAndProject(openShadowFixture(), "shadow-invalid-child-selector", projectionRequest("#mdn-search", "[")),
      "invalid_request",
      "request",
    );

    await expectRuntimeProjectionFailure(
      setAndProject(openShadowFixture(), "shadow-empty-child-selector", projectionRequest("#mdn-search", "")),
      "invalid_request",
      "request",
    );

    const hiddenHost = await setAndProject(
      openShadowFixture({ hostStyle: "display:none" }),
      "shadow-hidden-host",
    );
    assert.equal(hiddenHost.projection.candidates[0].cssHidden, true);
    const hiddenHostBinding = bind(hiddenHost.projection, neutralSearchInputHostProfile());
    assert.equal(hiddenHostBinding.state, "insufficient_observation");
    assert.equal(hiddenHostBinding.rejection, "unassessed_scope_content");

    const hiddenDialog = await setAndProject(
      openShadowFixture({
        rootHtml: '<dialog open style="display:none">Search<input id="shadow-search" type="search"></dialog>',
      }),
      "shadow-hidden-dialog",
    );
    assert.equal(hiddenDialog.projection.candidates[0].cssHidden, true);
    const hiddenDialogBinding = bind(hiddenDialog.projection, neutralSearchInputHostProfile());
    assert.equal(hiddenDialogBinding.state, "insufficient_observation");
    assert.equal(hiddenDialogBinding.rejection, "unassessed_scope_content");

    const opacityZero = await setAndProject(
      openShadowFixture({
        hostStyle: "opacity:0",
        rootHtml: '<dialog open style="display:block; position:relative; margin:20px; width:320px; height:80px;"><input id="shadow-search" type="search" style="display:block; opacity:1; width:200px; height:30px;"></dialog>',
      }),
      "shadow-opacity-zero",
    );
    assert.equal(opacityZero.projection.candidates[0].cssHidden, true);
    assert.equal(opacityZero.projection.candidates[0].intersectsViewport, true);
    const opacityZeroBinding = bind(opacityZero.projection, neutralSearchInputHostProfile());
    assert.equal(opacityZeroBinding.state, "insufficient_observation");
    assert.equal(opacityZeroBinding.rejection, "unassessed_scope_content");

    const unsupportedAncestry = await setAndProject(
      openShadowFixture({ hostStyle: "transform: perspective(100px)" }),
      "shadow-unsupported-ancestry",
    );
    assert.equal(unsupportedAncestry.projection.candidates[0].intersectsViewport, null);
    const unsupportedAncestryBinding = bind(
      unsupportedAncestry.projection,
      neutralSearchInputHostProfile(),
    );
    assert.equal(unsupportedAncestryBinding.state, "insufficient_observation");
    assert.equal(unsupportedAncestryBinding.rejection, "unmeasured_candidate_fields");

    const nestedCoverage = await setAndProject(
      `${openShadowFixture({
        rootHtml: '<dialog open style="display:block"><input type="search"><div id="nested-shadow-host"></div></dialog>',
      })}
      <script>
        document.getElementById("mdn-search").shadowRoot
          .querySelector("#nested-shadow-host")
          .attachShadow({ mode: "open" })
          .innerHTML = '<input type="search">';
      </script>`,
      "shadow-nested-coverage",
    );
    assert.equal(nestedCoverage.projection.coverage.unassessedOpenShadowRootCount, 1);
    const nestedCoverageBinding = bind(nestedCoverage.projection, neutralSearchInputHostProfile());
    assert.equal(nestedCoverageBinding.state, "insufficient_observation");
    assert.equal(nestedCoverageBinding.rejection, "unassessed_scope_content");

    const staleReplacement = `${openShadowFixture()}
      <script>
        const staleHost = document.getElementById("mdn-search");
        const staleDialog = staleHost.shadowRoot.querySelector("dialog");
        const originalRect = staleDialog.getBoundingClientRect.bind(staleDialog);
        let replaced = false;
        staleDialog.getBoundingClientRect = () => {
          if (!replaced) {
            replaced = true;
            const replacement = document.createElement("div");
            replacement.id = "mdn-search";
            replacement.attachShadow({ mode: "open" }).innerHTML =
              '<dialog open style="display:block"><input type="search"></dialog>';
            staleHost.replaceWith(replacement);
          }
          return originalRect();
        };
      </script>`;
    await expectRuntimeProjectionFailure(
      setAndProject(staleReplacement, "shadow-stale-replacement"),
      "scope_stale",
      "resolver",
    );

    const measurementFailure = `${openShadowFixture()}
      <script>
        document.getElementById("mdn-search").shadowRoot
          .querySelector("dialog")
          .getBoundingClientRect = () => { throw new Error("measurement failed"); };
      </script>`;
    await expectRuntimeProjectionFailure(
      setAndProject(measurementFailure, "shadow-measurement-failure"),
      "observation_failed",
      "observation",
    );

    const report = {
      ok: true,
      lightScopeRef: light.projection.scopeRef,
      shadowScopeRef: q2.projection.scopeRef,
      positiveCandidate: {
        cssHidden: positiveCandidate.cssHidden,
        intersectsViewport: positiveCandidate.intersectsViewport,
        explicitTabIndexKind: positiveCandidate.explicitTabIndexKind,
        tabIndexFocus: positiveCandidate.tabIndexFocus,
      },
      identity: q2.projection.identity,
      generation: q2.operation.generation,
      coverage: q2.projection.coverage,
      q1StaleRejected: true,
      hiddenHost: hiddenHostBinding,
      hiddenDialog: hiddenDialogBinding,
      opacityZero: {
        candidate: {
          cssHidden: opacityZero.projection.candidates[0].cssHidden,
          intersectsViewport: opacityZero.projection.candidates[0].intersectsViewport,
        },
        binder: opacityZeroBinding,
      },
      unsupportedAncestry: {
        candidate: {
          cssHidden: unsupportedAncestry.projection.candidates[0].cssHidden,
          intersectsViewport: unsupportedAncestry.projection.candidates[0].intersectsViewport,
        },
        binder: unsupportedAncestryBinding,
      },
      nestedCoverage: {
        coverage: nestedCoverage.projection.coverage,
        binder: nestedCoverageBinding,
      },
    };
    await writeFile(join(runRoot, "shadow-runtime-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await runtime.close();
  }
});
