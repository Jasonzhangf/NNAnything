import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handwiredBrowserSearchDecision,
  runBrowserSearchGoal,
} from "nnanything/browser-search";
import {
  SEARCH_MIGRATION_CASES,
  MIGRATION_FAMILIES,
  materializeMigrationCase,
} from "../playground/browser/feedback/search-migration-cases.mjs";
import { judgeSearchMigration } from "../playground/browser/feedback/search-migration-judge.mjs";

const QUERY = "露营";

function fact(value) {
  return { status: "observed", value };
}

function unknown() {
  return { status: "unknown", value: null };
}

function baseEvidence(item) {
  return {
    goalQuery: QUERY,
    root: "unknown",
    control: "error",
    controlStopReason: "fatal_error",
    exitCode: 1,
    phases: {
      input: "not_evaluated",
      submitted: "not_evaluated",
      results: "not_evaluated",
    },
    actionCounts: { input: 0, submit: 0, read: 0 },
    receipts: [],
    executionErrors: [],
    observationErrors: [],
    inputValue: unknown(),
    submittedQuery: unknown(),
    resultsFor: unknown(),
    batch: unknown(),
    association: {
      baseline: {
        submittedRequestRef: null,
        resultsRequestRef: null,
        batchRef: null,
        observedSubmission: null,
      },
      submittedQuery: null,
      submittedRequestRef: null,
      resultsQuery: null,
      resultsRequestRef: null,
      collectionRequestRef: null,
      batch: null,
    },
    effects: [],
    migrationId: item.id,
  };
}

function validEvidence(item) {
  const evidence = baseEvidence(item);
  if (item.id === "SM01") {
    evidence.actionCounts.input = 1;
    evidence.actionCounts.submit = 1;
    evidence.phases.input = "satisfied";
    evidence.phases.submitted = "unknown";
    evidence.phases.results = "not_evaluated";
    evidence.inputValue = fact(QUERY);
  } else if (item.id === "SM02") {
    evidence.receipts = [
      {
        action: "input",
        dispatched: false,
        ok: false,
        error: null,
        effectKnowledge: "none",
        source: "cdp.Input",
        dispatchState: "not_dispatched",
      },
    ];
    evidence.inputValue = fact("");
    evidence.executionErrors = [
      {
        action: "input",
        code: "execution_rejected",
        message: "Executor rejected current action",
      },
    ];
  } else if (item.id === "SM03") {
    evidence.actionCounts.input = 1;
    evidence.phases.input = "satisfied";
    evidence.inputValue = fact(QUERY);
    evidence.receipts = [
      {
        action: "input",
        dispatched: true,
        ok: true,
        error: null,
        effectKnowledge: "unknown",
        source: "cdp.Input",
        dispatchState: "dispatched",
      },
    ];
    evidence.executionErrors = [
      {
        action: "input",
        code: "native_action_failed",
        message: "transport error after native dispatch",
      },
    ];
    evidence.effects = [
      { action: "input", dispatchState: "unknown", effectKnowledge: "unknown" },
    ];
  } else if (item.id === "SM04") {
    evidence.actionCounts.input = 1;
    evidence.actionCounts.submit = 1;
    evidence.receipts = [
      {
        action: "submit",
        dispatched: true,
        ok: true,
        error: null,
        effectKnowledge: "unknown",
        source: "cdp.Input",
        dispatchState: "dispatched",
      },
    ];
    evidence.executionErrors = [
      {
        action: "submit",
        code: "native_action_failed",
        message: "transport error after native submit",
      },
    ];
    evidence.effects = [
      { action: "submit", dispatchState: "unknown", effectKnowledge: "unknown" },
    ];
  } else if (item.id === "SM05") {
    evidence.actionCounts.input = 1;
    evidence.actionCounts.submit = 1;
    evidence.observationErrors = [
      {
        action: "submit",
        code: "post_observation_failed",
        message: "injected post-submit read failure",
      },
    ];
  } else if (item.id === "SM06") {
    evidence.resultsFor = fact(QUERY);
    evidence.association.baseline = {
      submittedRequestRef: "request-1",
      resultsRequestRef: "request-1",
      batchRef: "request-1:batch-1",
      observedSubmission: true,
    };
    evidence.association.submittedQuery = QUERY;
    evidence.association.submittedRequestRef = "request-2";
    evidence.association.resultsQuery = QUERY;
    evidence.association.resultsRequestRef = "request-1";
    evidence.association.collectionRequestRef = "request-1";
    evidence.association.batch = "request-1:batch-1";
  } else if (item.id === "SM07") {
    evidence.submittedQuery = fact(QUERY);
    evidence.resultsFor = fact("登山");
    evidence.association.submittedQuery = QUERY;
    evidence.association.submittedRequestRef = "request-2";
    evidence.association.resultsQuery = "登山";
    evidence.association.resultsRequestRef = "request-1";
  } else if (item.id === "SM08") {
    evidence.root = "satisfied";
    evidence.control = "completed";
    evidence.controlStopReason = "root_evaluation";
    evidence.exitCode = 0;
    evidence.actionCounts = { input: 1, submit: 1, read: 1 };
    evidence.mainMatches = 1;
    evidence.inputValue = fact(QUERY);
    evidence.submittedQuery = fact(QUERY);
    evidence.resultsFor = fact(QUERY);
    evidence.batch = fact("request-1:batch-1");
    evidence.receipts = [
      {
        action: "input",
        dispatched: true,
        ok: true,
        error: null,
        effectKnowledge: "known",
        source: "cdp.Input",
        dispatchState: "dispatched",
      },
      {
        action: "submit",
        dispatched: true,
        ok: true,
        error: null,
        effectKnowledge: "known",
        source: "cdp.Input",
        dispatchState: "dispatched",
      },
    ];
    evidence.association.submittedQuery = QUERY;
    evidence.association.submittedRequestRef = "request-1";
    evidence.association.resultsQuery = QUERY;
    evidence.association.resultsRequestRef = "request-1";
    evidence.association.collectionRequestRef = "request-1";
    evidence.association.batch = "request-1:batch-1";
    evidence.effects = [
      { action: "input", dispatchState: "dispatched", effectKnowledge: "known" },
      { action: "submit", dispatchState: "dispatched", effectKnowledge: "known" },
    ];
  }
  return evidence;
}

function syntheticSearchResources(item) {
  const config = materializeMigrationCase("A", item);
  const bindings = config.bindings;
  const state = {
    inputValue: "",
    submittedQuery: null,
    submittedRequestRef: null,
    resultsQuery: null,
    resultsRequestRef: null,
    batch: null,
    request: "unknown",
    display: "none",
    items: [],
    submitted: false,
  };
  if (item.id === "SM06" || item.id === "SM07") {
    state.submittedQuery = "露营";
    state.submittedRequestRef = "request-1";
    state.resultsQuery = "露营";
    state.resultsRequestRef = "request-1";
    state.batch = "request-1:batch-1";
    state.request = "settled";
    state.display = "current";
    state.items = [{ collectionRef: "main", role: "main", text: "露营装备清单" }];
  }

  let revision = 0;
  let latest = null;
  let submissions = 0;
  const actions = [];

  function fact(value, evidenceId) {
    return value === null
      ? { status: "unknown", reason: "not_observed" }
      : { status: "observed", value, evidenceRefs: [evidenceId] };
  }

  function observe() {
    if (item.observeFailAfterSubmit && state.submitted) {
      throw new Error("injected: post-submit read failure");
    }
    revision += 1;
    const observationId = `synthetic-search-${item.id}-${revision}`;
    const refs = {
      value: `${observationId}:input.value`,
      editable: `${observationId}:input.editable`,
      submittedQuery: `${observationId}:submitted.query`,
      resultsQuery: `${observationId}:results.query`,
      submittedRequestRef: `${observationId}:submitted.requestRef`,
      resultsRequestRef: `${observationId}:results.requestRef`,
      collectionRequestRef: `${observationId}:collection.requestRef`,
      batch: `${observationId}:collection.batch`,
    };
    const items = state.items.map((entry, index) => ({
      ref: `item-${index + 1}`,
      collectionRef: entry.collectionRef,
      role: entry.role,
      text: fact(entry.text, `${observationId}:item.${index}.text`),
    }));
    const evidence = [
      { id: refs.value, source: "synthetic.search-fixture", fact: { value: state.inputValue } },
      { id: refs.editable, source: "synthetic.search-fixture", fact: { value: true } },
      { id: refs.submittedQuery, source: "synthetic.search-fixture", fact: { value: state.submittedQuery } },
      { id: refs.resultsQuery, source: "synthetic.search-fixture", fact: { value: state.resultsQuery } },
      { id: refs.submittedRequestRef, source: "synthetic.search-fixture", fact: { value: state.submittedRequestRef } },
      { id: refs.resultsRequestRef, source: "synthetic.search-fixture", fact: { value: state.resultsRequestRef } },
      { id: refs.collectionRequestRef, source: "synthetic.search-fixture", fact: { value: state.resultsRequestRef } },
      { id: refs.batch, source: "synthetic.search-fixture", fact: { value: state.batch } },
      ...items.map((entry, index) => ({
        id: `${observationId}:item.${index}.text`,
        source: "synthetic.search-fixture",
        fact: { value: state.items[index].text },
      })),
    ];
    latest = {
      documentRef: bindings.documentRef,
      scopeRef: bindings.scopeRef,
      observationId,
      revision,
      input: {
        ref: bindings.inputRef,
        tag: "input",
        type: "text",
        value: fact(state.inputValue, refs.value),
        editable: fact(true, refs.editable),
      },
      submitRef: bindings.submitRef,
      submittedQuery: fact(state.submittedQuery, refs.submittedQuery),
      resultsFor: fact(state.resultsQuery, refs.resultsQuery),
      submittedRequestRef: fact(state.submittedRequestRef, refs.submittedRequestRef),
      resultsRequestRef: fact(state.resultsRequestRef, refs.resultsRequestRef),
      request: state.request,
      display: state.display,
      access: "available",
      collection: {
        ref: bindings.collectionRef,
        scopeRef: bindings.resultScopeRef,
        requestRef: fact(state.resultsRequestRef, refs.collectionRequestRef),
        items,
        batch: fact(state.batch, refs.batch),
      },
      evidence,
    };
    return latest;
  }

  const resources = {
    grantedEffects: new Set([
      "browser.read",
      "browser.nativeInputText",
      "browser.nativeSubmit",
      "filesystem.write",
    ]),
    decision: handwiredBrowserSearchDecision,
    observe: async () => observe(),
    readResults: async () => observe(),
    currentControl: () => {
      if (latest === null) throw new Error("synthetic observation missing");
      return {
        documentRef: latest.documentRef,
        observationId: latest.observationId,
        revision: latest.revision,
      };
    },
    nativeInputText: async (invocation) => {
      actions.push("input");
      if (item.rejectInputWithoutBody) {
        return {
          dispatched: false,
          ok: false,
          effectKnowledge: "none",
          source: "cdp.Input",
          error: null,
        };
      }
      state.inputValue = invocation.value;
      if (item.throwAfterDispatch) {
        throw new Error("injected: transport error after native input dispatch");
      }
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: "unknown",
        source: "cdp.Input",
        error: null,
      };
    },
    nativeSubmit: async () => {
      actions.push("submit");
      if (!["SM01"].includes(item.id)) {
        submissions += 1;
        state.submittedQuery = state.inputValue;
        state.submittedRequestRef = `request-${submissions + 1}`;
        state.submitted = true;
        if (["SM06", "SM07"].includes(item.id)) {
          state.request = "loading";
          state.display = "old";
        } else {
          state.resultsQuery = state.inputValue;
          state.resultsRequestRef = state.submittedRequestRef;
          state.batch = `${state.submittedRequestRef}:batch-1`;
          state.request = "settled";
          state.display = "current";
          state.items = [{ collectionRef: "main", role: "main", text: "露营装备清单" }];
        }
      }
      if (item.throwAfterSubmit) {
        throw new Error("injected: transport error after native submit dispatch");
      }
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: "unknown",
        source: "cdp.Input",
        error: null,
      };
    },
    collect: async () => {},
  };
  return { bindings, config, actions, resources, state };
}

async function runSyntheticMigration(item) {
  const fixture = syntheticSearchResources(item);
  const response = await runBrowserSearchGoal(
    {
      requestId: `synthetic-${item.id}`,
      goal: fixture.config.goal,
      satisfactionThreshold: 100,
      bindings: fixture.bindings,
      maxResultReads: 2,
    },
    fixture.resources,
  );
  return { ...fixture, response };
}

function sourceEpisodes(report) {
  return report.atomicResults
    .map((entry) => entry.sourceResult?.value)
    .filter((entry) => entry && typeof entry === "object");
}

function actionCount(episodes, action) {
  return episodes.filter((episode) => episode.action === action).length;
}

test("search migration declares eight stop-behavior obligations for two independent families", async () => {
  assert.equal(SEARCH_MIGRATION_CASES.length, 8);
  assert.deepEqual(MIGRATION_FAMILIES, ["A", "B"]);
  assert.deepEqual(
    SEARCH_MIGRATION_CASES.map((item) => item.id),
    ["SM01", "SM02", "SM03", "SM04", "SM05", "SM06", "SM07", "SM08"],
  );
  for (const item of SEARCH_MIGRATION_CASES) {
    assert.equal(typeof item.obligation, "string", `${item.id} must name its obligation`);
    assert.ok(["existing", "injected"].includes(item.source), `${item.id} source must be honest`);
    if (item.source === "injected") {
      assert.match(item.injection ?? "", /^injected:/, `${item.id} injection must be labelled`);
    }
    assert.equal(item.familyIndependent, true, `${item.id} must run in both families`);
  }
  assert.equal(SEARCH_MIGRATION_CASES.filter((item) => item.source === "injected").length, 3);
  for (const family of MIGRATION_FAMILIES) {
    for (const item of SEARCH_MIGRATION_CASES) {
      const config = materializeMigrationCase(family, item);
      assert.ok(config.goal.kind === "BrowserSearch", `${family}/${item.id} keeps the search contract`);
    }
  }
});

test("every stop-behavior obligation has a passing synthetic positive control", async () => {
  for (const item of SEARCH_MIGRATION_CASES) {
    const verdict = judgeSearchMigration(item, validEvidence(item));
    assert.equal(verdict.passed, true, `${item.id} must pass its positive control: ${verdict.reason}`);
    assert.equal(verdict.stopReason, item.expectedStopReason, `${item.id} stop reason`);
  }
});

test("the public search entry preserves all eight stop behaviors offline", async () => {
  for (const item of SEARCH_MIGRATION_CASES) {
    const { response, state, actions } = await runSyntheticMigration(item);
    assert.equal(response.kind, "run_result", `${item.id} must produce a run report`);
    const report = response.report;
    const episodes = sourceEpisodes(report);
    const expectedControl = item.expectedRoot === "satisfied" ? "completed" : "error";
    const expectedStop = item.expectedRoot === "satisfied" ? "root_evaluation" : "fatal_error";
    assert.equal(report.rootEvaluation.result, item.expectedRoot, `${item.id} root`);
    assert.equal(report.control.outcome, expectedControl, `${item.id} control`);
    assert.equal(report.control.stopReason, expectedStop, `${item.id} control stop reason`);
    assert.ok(actions.length >= 1, `${item.id} must exercise a real search phase`);
    assert.equal(
      episodes.every((episode) => episode.decisionSource.source === "handwired"),
      true,
      `${item.id} must use the explicit decision provider`,
    );

    if (item.id === "SM01") {
      assert.equal(actionCount(episodes, "input"), 1);
      assert.equal(actionCount(episodes, "submit"), 1);
      assert.equal(state.submitted, false);
      assert.equal(episodes.find((episode) => episode.action === "submit").observationFeedback.status, "incomplete");
    } else if (item.id === "SM02") {
      assert.equal(actionCount(episodes, "input"), 1);
      assert.equal(actionCount(episodes, "submit"), 0);
      assert.equal(state.inputValue, "");
      const input = episodes.find((episode) => episode.action === "input");
      assert.equal(input.receipt.dispatched, false);
      assert.equal(input.receipt.ok, false);
      assert.equal(input.receipt.error, null);
      assert.equal(input.receipt.effectKnowledge, "none");
      assert.equal(input.executionErrors[0].code, "execution_rejected");
    } else if (item.id === "SM03") {
      assert.equal(actionCount(episodes, "input"), 1);
      assert.equal(actionCount(episodes, "submit"), 0);
      assert.equal(state.inputValue, "露营");
      const input = episodes.find((episode) => episode.action === "input");
      assert.equal(input.receipt, null);
      assert.equal(input.dispatchState, "unknown");
      assert.equal(input.executionErrors[0].code, "native_action_failed");
      assert.equal(input.effectKnowledge, "unknown");
    } else if (item.id === "SM04") {
      assert.equal(actionCount(episodes, "input"), 1);
      assert.equal(actionCount(episodes, "submit"), 1);
      assert.equal(state.submitted, true);
      const submit = episodes.find((episode) => episode.action === "submit");
      assert.equal(submit.receipt, null);
      assert.equal(submit.executionErrors[0].code, "native_action_failed");
      assert.equal(submit.effectKnowledge, "unknown");
      assert.equal(submit.state.observation.submittedQuery.value, "露营");
    } else if (item.id === "SM05") {
      assert.equal(actionCount(episodes, "input"), 1);
      assert.equal(actionCount(episodes, "submit"), 1);
      assert.equal(state.submitted, true);
      const submit = episodes.find((episode) => episode.action === "submit");
      assert.equal(submit.state, null);
      assert.equal(submit.observationFeedback.status, "failed");
      assert.equal(submit.observationFeedback.errors[0].code, "post_observation_failed");
    } else if (item.id === "SM06") {
      assert.equal(state.submittedRequestRef, "request-2");
      assert.equal(state.resultsRequestRef, "request-1");
      assert.equal(state.resultsQuery, "露营");
      assert.equal(state.request, "loading");
    } else if (item.id === "SM07") {
      assert.equal(state.submittedQuery, "登山");
      assert.equal(state.resultsQuery, "露营");
      assert.notEqual(state.submittedRequestRef, state.resultsRequestRef);
    } else if (item.id === "SM08") {
      assert.equal(report.control.outcome, "completed");
      assert.equal(actionCount(episodes, "input"), 1);
      assert.equal(actionCount(episodes, "submit"), 1);
      assert.deepEqual(report.errors, []);
      assert.equal(state.submittedQuery, "露营");
      assert.equal(state.resultsQuery, "露营");
      assert.equal(state.submittedRequestRef, state.resultsRequestRef);
      assert.equal(state.batch, `${state.submittedRequestRef}:batch-1`);
      assert.equal(state.request, "settled");
      assert.equal(state.display, "current");
    }
  }
});

test("a correct draft must never be accepted as a search root success", async () => {
  const item = SEARCH_MIGRATION_CASES.find((entry) => entry.id === "SM01");
  const evidence = validEvidence(item);
  evidence.root = "satisfied";
  evidence.control = "completed";
  const verdict = judgeSearchMigration(item, evidence);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /root/);
});

test("a stop obligation must keep the fatal_error control stop reason", async () => {
  const item = SEARCH_MIGRATION_CASES.find((entry) => entry.id === "SM03");
  const evidence = validEvidence(item);
  evidence.controlStopReason = "root_evaluation";
  const verdict = judgeSearchMigration(item, evidence);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /controlStopReason|fatal_error/);
});

test("a typed input rejection with an error body must not pass the no-body obligation", async () => {
  const item = SEARCH_MIGRATION_CASES.find((entry) => entry.id === "SM02");
  const evidence = validEvidence(item);
  evidence.receipts[0].error = { code: "native_failure", message: "an invented body" };
  const verdict = judgeSearchMigration(item, evidence);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /no.?body|error|null|reject/i);
});

test("a submit throw must not repeat the submit action", async () => {
  const item = SEARCH_MIGRATION_CASES.find((entry) => entry.id === "SM04");
  const evidence = validEvidence(item);
  evidence.actionCounts.submit = 2;
  evidence.receipts.push({
    action: "submit",
    dispatched: true,
    ok: true,
    error: null,
    effectKnowledge: "unknown",
    source: "cdp.Input",
    dispatchState: "dispatched",
  });
  const verdict = judgeSearchMigration(item, evidence);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /repeat|submit|count/);
});

test("missing posterior must not be judged as an available current result", async () => {
  const item = SEARCH_MIGRATION_CASES.find((entry) => entry.id === "SM05");
  const evidence = validEvidence(item);
  evidence.observationErrors = [];
  const verdict = judgeSearchMigration(item, evidence);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /observation|posterior|missing/);
});

test("an input throw with a mismatched actual value must not pass", async () => {
  const item = SEARCH_MIGRATION_CASES.find((entry) => entry.id === "SM03");
  const evidence = validEvidence(item);
  evidence.inputValue = fact("别的词");
  const verdict = judgeSearchMigration(item, evidence);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /reached value|input/);
});

test("a submit throw without a dispatched submit receipt must not pass", async () => {
  const item = SEARCH_MIGRATION_CASES.find((entry) => entry.id === "SM04");
  const evidence = validEvidence(item);
  evidence.receipts = [];
  const verdict = judgeSearchMigration(item, evidence);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /submit receipt|dispatched|submit/);
});

test("a satisfied root must have exactly one input and one submit, with no extra mutation", async () => {
  const item = SEARCH_MIGRATION_CASES.find((entry) => entry.id === "SM08");
  const evidence = validEvidence(item);
  evidence.actionCounts.input = 2;
  evidence.receipts.push({
    action: "input",
    dispatched: true,
    ok: true,
    error: null,
    effectKnowledge: "known",
    source: "cdp.Input",
    dispatchState: "dispatched",
  });
  const verdict = judgeSearchMigration(item, evidence);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /extra|mutation|input/);
});

test("native IO declares only the three injected obligations and keeps the existing projection flags", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../playground/browser/search/native-io.mjs", import.meta.url), "utf8"),
  );
  assert.match(source, /rejectInputWithoutBody/);
  assert.match(source, /throwAfterSubmit/);
  assert.match(source, /observeFailAfterSubmit/);
  assert.match(source, /injected: post-submit read failure/);
  assert.doesNotMatch(source, /materializeExpected|CASE_ROWS|rows\.jsonl/);
  assert.doesNotMatch(source, /\.focus\s*\(|\.click\s*\(|requestSubmit\s*\(|dispatchEvent\s*\(/);
});

test("the migration runner drives exactly 8 items over both families for 16 rows", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../playground/browser/feedback/search-migration.mjs", import.meta.url), "utf8"),
  );
  assert.match(source, /SEARCH_MIGRATION_CASES/);
  assert.match(source, /MIGRATION_FAMILIES/);
  assert.match(source, /rows\.jsonl/);
  assert.match(source, /table\.md/);
  assert.match(source, /summary\.json/);
  assert.match(source, /const repo = resolve\(here, "\.\.\/\.\.\/\.\."\)/);
  assert.match(source, /deriveEvidence\(parsed, config\)/);
  assert.match(source, /--cdp http:\/\/127\.0\.0\.1:9444/);
  assert.match(source, /--origin http:\/\/127\.0\.0\.1:4173/);
});
