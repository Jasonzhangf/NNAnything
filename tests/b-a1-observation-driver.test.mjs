import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBA1RealSiteCdpRuntime } from "../dist/adapters/browser/b-a1-real-site-cdp-runtime.js";
import { runBA1ObservationDriver } from "nnanything/b-a1-observation-driver";

const legalHtml = `<!doctype html>
<html>
  <body>
    <div id="search-scope">
      <form role="search">
        <label>Search <input id="visible" type="search"></label>
      </form>
      <input id="hidden" type="search" style="display:none">
    </div>
  </body>
</html>`;

const incompleteHtml = `<!doctype html>
<html>
  <body>
    <div id="search-scope">
      <label>Search <input id="visible" type="search"></label>
      <input id="hidden" type="search" style="display:none">
      <iframe title="unassessed"></iframe>
    </div>
  </body>
</html>`;

async function startFixtureServer() {
  const server = createServer((request, response) => {
    if (request.url === "/legal") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(legalHtml);
      return;
    }
    if (request.url === "/incomplete") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(incompleteHtml);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fixture server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    }),
  };
}

async function fileExists(path) {
  return access(path).then(() => true, () => false);
}

test("observation driver captures legal contrast and rejects incomplete coverage", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  const runtime = await createBA1RealSiteCdpRuntime();
  const evidenceRoot = process.env.B_A1_OBSERVATION_DRIVER_EVIDENCE_DIR
    ?? await mkdtemp(join(tmpdir(), "b-a1-observation-driver-"));
  const root = join(evidenceRoot, "fixture-run");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const legalOut = join(root, "legal");
  const incompleteOut = join(root, "incomplete");
  let scopeProjectionCalls = 0;
  let pinnedObservedBeforeAdmittedCapture = false;

  const wrappedRuntime = {
    installProjectionBundle: source => runtime.installProjectionBundle(source),
    navigate: (url, documentRef) => runtime.navigate(url, documentRef),
    beginProjection: async input => {
      if (input.scopeSelector === "#search-scope") {
        scopeProjectionCalls += 1;
        if (scopeProjectionCalls === 2) {
          const pinned = JSON.parse(await readFile(join(legalOut, "source-plan.json"), "utf8"));
          pinnedObservedBeforeAdmittedCapture = pinned.trainSlots[0].scopeSelector === "#search-scope";
        }
      }
      return runtime.beginProjection(input);
    },
  };

  try {
    const legalResult = await runBA1ObservationDriver({
      sourcePlan: {
        schema: "nnanything.b-a1.selection-contrast-source-plan.v1",
        partition: "TRAIN",
        trainSlots: [{
          slot: "A",
          sourceFamily: "fixture-legal",
          siteId: "127.0.0.1",
          entryUrl: `${fixture.baseUrl}/legal`,
          selectorCandidates: ["#missing", "#search-scope"],
        }],
        reserves: [],
      },
      outDir: legalOut,
      runtime: wrappedRuntime,
    });

    assert.equal(legalResult.status, "captured");
    assert.equal(legalResult.sources.length, 1);
    const legal = legalResult.sources[0];
    assert.equal(legal.status, "captured");
    assert.equal(legal.pinnedSelector, "#search-scope");
    assert.equal(legal.discovery.passedSelector, "#search-scope");
    assert.equal(legal.derivedCoverage.status, "complete");
    assert.equal(legal.derivedCoverage.evaluatedCount, 2);
    assert.equal(legal.derivedCoverage.expectedCount, 2);
    assert.equal(legal.derivedCoverage.unassessedIframeCount, 0);
    assert.equal(legal.derivedCoverage.unassessedObjectCount, 0);
    assert.equal(legal.derivedCoverage.unassessedOpenShadowRootCount, 0);
    assert.equal(legal.rawObservation.operation.identity.documentRef, legal.rawObservation.projection.identity.documentRef);
    assert.equal(legal.rawObservation.projection.scopeRef, "#search-scope");
    assert.deepEqual(Object.keys(legal.rawObservation.projection.coverage).sort(), [
      "excluded",
      "observedCandidateCount",
      "scopeRef",
      "unassessedIframeCount",
      "unassessedObjectCount",
      "unassessedOpenShadowRootCount",
    ]);
    assert.equal(Object.hasOwn(legal.rawObservation.projection.coverage, "status"), false);
    assert.equal(Object.hasOwn(legal.rawObservation.projection.coverage, "evaluatedCount"), false);
    assert.equal(Object.hasOwn(legal.rawObservation.projection.coverage, "expectedCount"), false);
    assert.equal(pinnedObservedBeforeAdmittedCapture, true);

    const pinnedPlan = JSON.parse(await readFile(join(legalOut, "source-plan.json"), "utf8"));
    assert.equal(pinnedPlan.trainSlots[0].scopeSelector, "#search-scope");
    const storedRaw = JSON.parse(await readFile(join(legalOut, "raw", "fixture-legal", "admitted.json"), "utf8"));
    assert.deepEqual(storedRaw.projection.coverage, legal.rawObservation.projection.coverage);
    assert.deepEqual(storedRaw.operation, legal.rawObservation.operation);
    assert.equal(await fileExists(join(legalOut, "driver-report.json")), true);
    assert.equal(await fileExists(join(legalOut, "observations.json")), false);
    assert.equal(await fileExists(join(legalOut, "samples")), false);

    const incompleteResult = await runBA1ObservationDriver({
      sourcePlan: {
        schema: "nnanything.b-a1.selection-contrast-source-plan.v1",
        partition: "TRAIN",
        trainSlots: [{
          slot: "A",
          sourceFamily: "fixture-incomplete",
          siteId: "127.0.0.1",
          entryUrl: `${fixture.baseUrl}/incomplete`,
          selectorCandidates: ["#search-scope"],
        }],
        reserves: [],
      },
      outDir: incompleteOut,
      runtime: wrappedRuntime,
    });

    assert.equal(incompleteResult.status, "observation_missing");
    const incomplete = incompleteResult.sources[0];
    assert.equal(incomplete.status, "observation_missing");
    assert.equal(incomplete.rejection, "incomplete_coverage");
    assert.equal(incomplete.discovery.attempts.length, 1);
    assert.equal(incomplete.discovery.attempts[0].rawCoverage.unassessedIframeCount, 1);
    assert.equal(incomplete.discovery.attempts[0].derivedCoverage.status, "partial");
    assert.equal(incomplete.discovery.attempts[0].passed, false);
    assert.equal(await fileExists(join(incompleteOut, "driver-report.json")), true);
    assert.equal(await fileExists(join(incompleteOut, "raw", "fixture-incomplete", "admitted.json")), false);
    assert.equal(await fileExists(join(incompleteOut, "observations.json")), false);
    assert.equal(await fileExists(join(incompleteOut, "samples")), false);
  } finally {
    await runtime.close();
    await fixture.close();
  }
});
