import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BA1RealSiteCdpRuntimeError,
  createBA1RealSiteCdpRuntime,
} from "../dist/adapters/browser/b-a1-real-site-cdp-runtime.js";
import {
  BA1ObservationDriverError,
  runBA1ObservationDriver,
  validateBA1ObservationDriverSourcePlan,
} from "nnanything/b-a1-observation-driver";

const acceptedSourcePlanFixtureUrl = new URL(
  "./fixtures/b-a1-observation-driver/source-plan.approved.json",
  import.meta.url,
);
const acceptedSourcePlanProvenanceUrl = new URL(
  "./fixtures/b-a1-observation-driver/provenance.json",
  import.meta.url,
);

const legalHtml = `<!doctype html>
<html>
  <body>
    <div id="search-scope">
      <form role="search">
        <label>Search <input id="visible" type="search"></label>
      </form>
      <input id="hidden" type="search" style="display:none">
    </div>
    <div id="legal-scope">
      <form role="search">
        <label>Search <input id="legal-visible" type="search"></label>
      </form>
      <input id="legal-hidden" type="search" style="display:none">
    </div>
  </body>
</html>`;

const changingHtml = `<!doctype html>
<html>
  <body>
    <div id="changing-scope">
      <form role="search">
        <label>Search <input id="changing-visible" type="search"></label>
      </form>
      <input id="changing-hidden" type="search" style="display:none">
    </div>
  </body>
</html>`;

const noHiddenHtml = `<!doctype html>
<html>
  <body>
    <div id="changing-scope">
      <form role="search">
        <label>Search <input id="changing-visible" type="search"></label>
      </form>
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
    const htmlByPath = {
      "/changing": changingHtml,
      "/incomplete": incompleteHtml,
      "/legal": legalHtml,
    };
    const html = htmlByPath[request.url];
    if (html !== undefined) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
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

async function prepareEvidenceRoot(prefix) {
  const evidenceRoot = process.env.B_A1_OBSERVATION_DRIVER_EVIDENCE_DIR
    ?? await mkdtemp(join(tmpdir(), "b-a1-observation-driver-"));
  const root = join(evidenceRoot, prefix);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return root;
}

function basePlan(trainSlots, reserves = []) {
  return {
    schema: "nnanything.b-a1.selection-contrast-source-plan.v1",
    status: "pre_registered_not_observed",
    partition: "TRAIN",
    trainSlots,
    reserves,
  };
}

function assertMonotonicTiming(timing) {
  assert.equal(timing.clock, "process.hrtime.bigint");
  assert.equal(timing.origin, "run_start");
  assert.ok(timing.stages.some(stage => stage.stage === "launch"));
  assert.ok(timing.stages.some(stage => stage.stage === "bundle_install"));
  assert.ok(timing.stages.some(stage => stage.stage === "navigation"));
  assert.ok(timing.stages.some(stage => stage.stage === "discovery"));
  assert.ok(timing.stages.some(stage => stage.stage === "admitted_projection"));
  assert.ok(timing.stages.some(stage => stage.stage === "save"));
  let previousEnd = 0n;
  for (const stage of timing.stages) {
    const started = BigInt(stage.started_at_ns);
    const ended = BigInt(stage.ended_at_ns);
    assert.ok(started <= ended, `${stage.stage} start must not follow end`);
    assert.ok(started >= previousEnd, `${stage.stage} must follow the previous stage`);
    previousEnd = ended;
  }
}

test("accepts the exact approved pre-registered source plan without live sites", { timeout: 90000 }, async () => {
  const provenance = JSON.parse(await readFile(acceptedSourcePlanProvenanceUrl, "utf8"));
  assert.equal(provenance.fixture, "source-plan.approved.json");
  assert.equal(provenance.relationship, "verbatim_copy_of_accepted_source_plan");
  const acceptedSourcePlan = JSON.parse(await readFile(
    process.env.B_A1_ACCEPTED_SOURCE_PLAN ?? acceptedSourcePlanFixtureUrl,
    "utf8",
  ));
  const parsed = validateBA1ObservationDriverSourcePlan(acceptedSourcePlan);
  assert.equal(parsed.status, "pre_registered_not_observed");
  assert.equal(parsed.trainSlots.length, 2);
  assert.equal(parsed.reserves.length, 3);

  const root = await prepareEvidenceRoot("accepted-plan-run");
  const navigations = [];
  const result = await runBA1ObservationDriver({
    sourcePlan: acceptedSourcePlan,
    outDir: root,
    runtime: {
      installProjectionBundle: async () => {},
      navigate: async url => {
        navigations.push(url);
        throw new BA1RealSiteCdpRuntimeError(
          "cdp_failure",
          "controlled navigation stop",
          { code: "fixture_navigation_stop", retryable: false },
        );
      },
      beginProjection: async () => {
        throw new Error("beginProjection must not run after navigation failure");
      },
    },
  });

  assert.deepEqual(navigations, [
    "https://docs.python.org/3/",
    "https://doc.rust-lang.org/std/",
    "https://go.dev/doc/",
    "https://www.postgresql.org/docs/",
    "https://nodejs.org/docs/latest/api/",
  ]);
  assert.equal(result.status, "navigation_failed");
  assert.equal(result.capturedCount, 0);
  assert.equal(result.sources.length, 5);
  for (const source of result.sources) {
    assert.equal(source.status, "navigation_failed");
    assert.equal(source.error.stage, "navigation");
    assert.equal(source.error.code, "cdp_failure");
    assert.equal(source.error.message, "controlled navigation stop");
    assert.deepEqual(source.error.detail, {
      code: "fixture_navigation_stop",
      retryable: false,
    });
  }

  const draftPath = join(root, "split-decisions", "pydocs-3.json");
  assert.equal(await fileExists(draftPath), true);
  const draft = JSON.parse(await readFile(draftPath, "utf8"));
  assert.deepEqual(draft, {
    sourceFamily: "pydocs-3",
    sourceGroupId: "pydocs-3",
    siteId: "docs.python.org",
    entryUrl: "https://docs.python.org/3/",
    partition: "TRAIN",
    priorExposure: "unseen",
    splitAuthority: null,
    splitDecisionRef: null,
    evidenceRefs: [],
  });
  assert.equal(Object.hasOwn(draft, "decidedAt"), false);
});

test("consumes explicit approved split-decision input without inference", { timeout: 90000 }, async () => {
  const root = await prepareEvidenceRoot("approved-split-run");
  const approvedSplitDecision = {
    sourceFamily: "fixture-approved",
    sourceGroupId: "fixture-approved-group",
    splitAuthority: "Jenny",
    splitDecisionRef: "split-decisions/fixture-approved-group.json",
    evidenceRefs: ["decision.md#approved-split", "source.json#fixture-approved"],
  };
  const sourcePlan = basePlan([{
    slot: "A",
    sourceFamily: "fixture-approved",
    siteId: "fixture.invalid",
    entryUrl: "https://fixture.invalid/approved",
    selectorCandidates: ["#search"],
  }]);

  const result = await runBA1ObservationDriver({
    sourcePlan,
    outDir: root,
    approvedSplitDecisions: [approvedSplitDecision],
    runtime: {
      installProjectionBundle: async () => {},
      navigate: async () => {
        throw new BA1RealSiteCdpRuntimeError(
          "cdp_failure",
          "controlled navigation stop",
          { code: "fixture_navigation_stop", retryable: false },
        );
      },
      beginProjection: async () => {
        throw new Error("beginProjection must not run after navigation failure");
      },
    },
  });

  assert.equal(result.status, "navigation_failed");
  const record = JSON.parse(await readFile(
    join(root, "split-decisions", "fixture-approved-group.json"),
    "utf8",
  ));
  assert.deepEqual(record, {
    sourceFamily: "fixture-approved",
    ...approvedSplitDecision,
    siteId: "fixture.invalid",
    entryUrl: "https://fixture.invalid/approved",
    partition: "TRAIN",
    priorExposure: "unseen",
  });
  assert.equal(record.splitAuthority, "Jenny");
  assert.equal(record.splitDecisionRef, "split-decisions/fixture-approved-group.json");
  assert.deepEqual(record.evidenceRefs, approvedSplitDecision.evidenceRefs);
});

test("rejects incomplete or extra approved split-decision fields", async () => {
  const sourcePlan = basePlan([{
    slot: "A",
    sourceFamily: "fixture-approved",
    siteId: "fixture.invalid",
    entryUrl: "https://fixture.invalid/approved",
    selectorCandidates: ["#search"],
  }]);
  const approvedSplitDecision = {
    sourceFamily: "fixture-approved",
    sourceGroupId: "fixture-approved-group",
    splitAuthority: "Jenny",
    splitDecisionRef: "split-decisions/fixture-approved-group.json",
    evidenceRefs: ["decision.md#approved-split"],
  };
  const invalidDecisions = [
    {
      label: "missing splitAuthority",
      value: { ...approvedSplitDecision, splitAuthority: undefined },
    },
    {
      label: "extra decidedAt",
      value: { ...approvedSplitDecision, decidedAt: "2026-11-11T20:57:27.990Z" },
    },
  ];

  for (const invalid of invalidDecisions) {
    await assert.rejects(
      runBA1ObservationDriver({
        sourcePlan,
        outDir: await mkdtemp(join(tmpdir(), "b-a1-invalid-split-")),
        approvedSplitDecisions: [invalid.value],
      }),
      error => error instanceof BA1ObservationDriverError && error.code === "invalid_plan",
      invalid.label,
    );
  }
});

test("rejects a recapture whose hidden contrast disappeared and continues to a reserve", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  const runtime = await createBA1RealSiteCdpRuntime();
  const root = await prepareEvidenceRoot("changing-contrast-run");
  let changed = false;
  let splitObservedBeforeNavigation = false;

  const wrappedRuntime = {
    installProjectionBundle: source => runtime.installProjectionBundle(source),
    navigate: async (url, documentRef) => {
      if (url === `${fixture.baseUrl}/changing`) {
        splitObservedBeforeNavigation = await fileExists(
          join(root, "split-decisions", "fixture-changing.json"),
        );
      }
      return runtime.navigate(url, documentRef);
    },
    beginProjection: async input => {
      const observed = await runtime.beginProjection(input);
      if (input.scopeSelector === "#changing-scope" && !changed) {
        changed = true;
        await runtime.setDocumentContent(
          noHiddenHtml,
          "b-a1-observation-fixture-changing",
        );
      }
      return observed;
    },
  };

  try {
    const result = await runBA1ObservationDriver({
      sourcePlan: basePlan(
        [{
          slot: "A",
          sourceFamily: "fixture-changing",
          siteId: "127.0.0.1",
          entryUrl: `${fixture.baseUrl}/changing`,
          selectorCandidates: ["#changing-scope"],
        }],
        [{
          sourceFamily: "fixture-reserve-legal",
          siteId: "127.0.0.1",
          entryUrl: `${fixture.baseUrl}/legal`,
          selectorCandidates: ["#legal-scope"],
        }],
      ),
      outDir: root,
      runtime: wrappedRuntime,
    });

    assert.equal(splitObservedBeforeNavigation, true);
    assert.equal(result.status, "captured");
    assert.equal(result.capturedCount, 1);
    assert.equal(result.sources.length, 2);
    const changedSource = result.sources[0];
    assert.equal(changedSource.status, "no_contrast");
    assert.equal(changedSource.rejection, "contrast_missing");
    assert.equal(changedSource.discovery.passedSelector, "#changing-scope");
    assert.equal(changedSource.derivedCoverage.status, "complete");
    assert.equal(changedSource.admissionPredicates.hiddenMeasuredCandidateCount, 0);
    assert.equal(changedSource.rawObservation.projection.coverage.observedCandidateCount, 1);
    assert.equal(
      await fileExists(join(root, "raw", "fixture-changing", "recapture.json")),
      true,
    );
    assert.equal(
      await fileExists(join(root, "rejected", "fixture-changing.json")),
      true,
    );

    const reserve = result.sources[1];
    assert.equal(reserve.sourceFamily, "fixture-reserve-legal");
    assert.equal(reserve.status, "captured");
    assert.equal(reserve.rawObservation.projection.coverage.observedCandidateCount, 2);

    const split = JSON.parse(await readFile(
      join(root, "split-decisions", "fixture-changing.json"),
      "utf8",
    ));
    assert.deepEqual(Object.keys(split).sort(), [
      "entryUrl",
      "evidenceRefs",
      "partition",
      "priorExposure",
      "siteId",
      "sourceFamily",
      "sourceGroupId",
      "splitAuthority",
      "splitDecisionRef",
    ]);
    assert.equal(split.sourceGroupId, "fixture-changing");
    assert.equal(split.partition, "TRAIN");
    assert.equal(split.priorExposure, "unseen");
    assert.equal(split.splitAuthority, null);
    assert.equal(split.splitDecisionRef, null);
    assert.deepEqual(split.evidenceRefs, []);
    assert.equal(Object.hasOwn(split, "decidedAt"), false);
    assertMonotonicTiming(JSON.parse(await readFile(join(root, "timing.json"), "utf8")));
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

test("preserves navigation error and isolates a later legal reserve", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  const runtime = await createBA1RealSiteCdpRuntime();
  const root = await prepareEvidenceRoot("failed-navigation-run");

  const wrappedRuntime = {
    installProjectionBundle: source => runtime.installProjectionBundle(source),
    navigate: (url, documentRef) => {
      if (url === "https://fixture.invalid/navigation-failure") {
        throw new BA1RealSiteCdpRuntimeError(
          "cdp_failure",
          "original navigation failure",
          { code: "fixture_original_navigation", scope: "family" },
        );
      }
      return runtime.navigate(url, documentRef);
    },
    beginProjection: input => runtime.beginProjection(input),
  };

  try {
    const result = await runBA1ObservationDriver({
      sourcePlan: basePlan(
        [{
          slot: "A",
          sourceFamily: "fixture-nav-fail",
          siteId: "fixture.invalid",
          entryUrl: "https://fixture.invalid/navigation-failure",
          selectorCandidates: ["#search-scope"],
        }],
        [{
          sourceFamily: "fixture-nav-reserve",
          siteId: "127.0.0.1",
          entryUrl: `${fixture.baseUrl}/legal`,
          selectorCandidates: ["#legal-scope"],
        }],
      ),
      outDir: root,
      runtime: wrappedRuntime,
    });

    assert.equal(result.status, "captured");
    assert.equal(result.capturedCount, 1);
    const failed = result.sources[0];
    assert.equal(failed.status, "navigation_failed");
    assert.deepEqual(failed.error, {
      stage: "navigation",
      selector: null,
      name: "BA1RealSiteCdpRuntimeError",
      code: "cdp_failure",
      message: "original navigation failure",
      detail: {
        code: "fixture_original_navigation",
        scope: "family",
      },
    });
    assert.equal(result.sources[1].status, "captured");
    const rejected = JSON.parse(await readFile(
      join(root, "rejected", "fixture-nav-fail.json"),
      "utf8",
    ));
    assert.deepEqual(rejected.error, failed.error);
  } finally {
    await runtime.close();
    await fixture.close();
  }
});

test("preserves discovery and admitted-projection errors", { timeout: 90000 }, async () => {
  const fixture = await startFixtureServer();
  const runtime = await createBA1RealSiteCdpRuntime();
  const discoveryRoot = await prepareEvidenceRoot("failed-discovery-run");
  const admittedRoot = await prepareEvidenceRoot("failed-admitted-run");

  const discoveryRuntime = {
    installProjectionBundle: source => runtime.installProjectionBundle(source),
    navigate: (url, documentRef) => runtime.navigate(url, documentRef),
    beginProjection: async input => {
      if (input.scopeSelector === "#discovery-boom") {
        throw new BA1RealSiteCdpRuntimeError(
          "projection_failed",
          "original discovery failure",
          { code: "scope_not_found", attempt: 1 },
        );
      }
      return runtime.beginProjection(input);
    },
  };

  try {
    const discoveryResult = await runBA1ObservationDriver({
      sourcePlan: basePlan([{
        slot: "A",
        sourceFamily: "fixture-discovery-error",
        siteId: "127.0.0.1",
        entryUrl: `${fixture.baseUrl}/legal`,
        selectorCandidates: ["#discovery-boom", "#legal-scope"],
      }]),
      outDir: discoveryRoot,
      runtime: discoveryRuntime,
    });

    assert.equal(discoveryResult.status, "captured");
    const discoveryAttempt = discoveryResult.sources[0].discovery.attempts[0];
    assert.equal(discoveryAttempt.rejection, "scope_not_found");
    assert.deepEqual(discoveryAttempt.error, {
      stage: "discovery",
      selector: "#discovery-boom",
      name: "BA1RealSiteCdpRuntimeError",
      code: "projection_failed",
      message: "original discovery failure",
      detail: {
        code: "scope_not_found",
        attempt: 1,
      },
    });

    let admittedCalls = 0;
    const admittedRuntime = {
      installProjectionBundle: source => runtime.installProjectionBundle(source),
      navigate: (url, documentRef) => runtime.navigate(url, documentRef),
      beginProjection: async input => {
        if (input.scopeSelector === "#legal-scope") {
          admittedCalls += 1;
          if (admittedCalls === 2) {
            throw new BA1RealSiteCdpRuntimeError(
              "projection_failed",
              "original admitted projection failure",
              { code: "scope_stale", attempt: 2 },
            );
          }
        }
        return runtime.beginProjection(input);
      },
    };

    const admittedResult = await runBA1ObservationDriver({
      sourcePlan: basePlan(
        [{
          slot: "A",
          sourceFamily: "fixture-admitted-error",
          siteId: "127.0.0.1",
          entryUrl: `${fixture.baseUrl}/legal`,
          selectorCandidates: ["#legal-scope"],
        }],
        [{
          sourceFamily: "fixture-admitted-reserve",
          siteId: "127.0.0.1",
          entryUrl: `${fixture.baseUrl}/legal`,
          selectorCandidates: ["#search-scope"],
        }],
      ),
      outDir: admittedRoot,
      runtime: admittedRuntime,
    });

    assert.equal(admittedResult.status, "captured");
    assert.equal(admittedResult.capturedCount, 1);
    const admittedFailure = admittedResult.sources[0];
    assert.equal(admittedFailure.status, "projection_failed");
    assert.equal(admittedFailure.discovery.passedSelector, "#legal-scope");
    assert.deepEqual(admittedFailure.error, {
      stage: "admitted_projection",
      selector: "#legal-scope",
      name: "BA1RealSiteCdpRuntimeError",
      code: "projection_failed",
      message: "original admitted projection failure",
      detail: {
        code: "scope_stale",
        attempt: 2,
      },
    });
    assert.equal(admittedResult.sources[1].status, "captured");
  } finally {
    await runtime.close();
    await fixture.close();
  }
});
