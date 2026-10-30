import assert from "node:assert/strict";
import { test } from "node:test";
import { runBrowserInputGoal } from "nnanything/browser-input";
import { createBrowserInputPolicyProfile } from "nnanything/browser-input";

const INPUT_WEIGHTS = [
  [-9, 0, 2, 0, 2, 0, 2, 2, -4, 2, -6, 0, 2],
  [-3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0],
  [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
];

function modelResources(f, options = {}) {
  const resources = f.resources;
  const decision = {
    id: "browser.input-text-policy.v1",
    source: "model",
    profile: createBrowserInputPolicyProfile(INPUT_WEIGHTS),
  };
  return {
    ...resources,
    decision,
    ...(options.target
      ? {
          observe: async () => {
            const observation = await resources.observe();
            observation.target = {...observation.target, ...options.target};
            return observation;
          },
        }
      : {}),
  };
}

const observed = (value, evidenceRefs) => ({ status: "observed", value, evidenceRefs });
const unknown = reason => ({ status: "unknown", reason });

function request(overrides = {}) {
  return {
    requestId: "input-test",
    goal: { kind: "BrowserInput", targetText: "新文本" },
    satisfactionThreshold: 100,
    bindings: {
      documentRef: "input-doc",
      scopeRef: "scope",
      targetRef: "target",
    },
    ...overrides,
  };
}

function observation(options, sequence, value) {
  const evidenceId = `evidence-${sequence}`;
  const has = key => Object.hasOwn(options, key);
  return {
    documentRef: "input-doc",
    scopeRef: "scope",
    observationId: `observation-${sequence}`,
    revision: sequence,
    target: {
      ref: "target",
      connected: observed(true, [evidenceId]),
      currentRef: observed(has("currentRef") ? options.currentRef : "target", [evidenceId]),
      host: observed(options.host ?? "input", [evidenceId]),
      contentEditable: observed(options.contentEditable ?? null, [evidenceId]),
      type: observed(options.type ?? "text", [evidenceId]),
      value: options.unknownValue
        ? unknown("value_not_observed")
        : observed(value, [evidenceId]),
      placeholder: observed(options.placeholder ?? "", [evidenceId]),
      nativeDisabled: observed(options.nativeDisabled ?? false, [evidenceId]),
      ariaDisabled: observed(has("ariaDisabled") ? options.ariaDisabled : null, [evidenceId]),
      nativeReadonly: observed(options.nativeReadonly ?? false, [evidenceId]),
      ariaReadonly: observed(has("ariaReadonly") ? options.ariaReadonly : null, [evidenceId]),
      readonlyState: observed(options.readonlyState ?? "editable", [evidenceId]),
      editable: options.unknownEditable
        ? unknown("editable_not_probed")
        : observed(true, [evidenceId]),
      activeElementRef: observed("target", [evidenceId]),
      activeElementFocus: observed(true, [evidenceId]),
    },
    neighbors: [
      { ref: "neighbor", value: observed("保持原值", [evidenceId]) },
    ],
    evidence: [
      {
        id: evidenceId,
        source: "synthetic.input-fixture",
        fact: { kind: "input-fixture", value },
      },
    ],
  };
}

function fixture(options = {}) {
  let revision = 0;
  let currentValue = options.initialValue ?? "旧值";
  let current = null;
  let initial = null;
  let observeCalls = 0;
  let controlCalls = 0;
  let dispatched = false;
  const actions = [];
  const resources = {
    grantedEffects: new Set(
      options.grantedEffects ?? ["browser.read", "browser.nativeInputText"],
    ),
    observe: async () => {
      observeCalls += 1;
      if (options.observeFailsAfterDispatch && dispatched) throw new Error("read failed");
      if (options.stalePost && dispatched) return structuredClone(initial);
      if (options.postObjectRebuild && dispatched) {
        const post = observation(options, ++revision, currentValue);
        post.target.currentRef = observed("replacement", ["evidence-" + revision]);
        current = post;
        return structuredClone(post);
      }
      const value = options.resetAfterInput && dispatched ? options.initialValue ?? "旧值" : currentValue;
      const next = observation(options, ++revision, value);
      if (initial === null) initial = next;
      current = next;
      return structuredClone(next);
    },
    currentControl: async () => {
      controlCalls += 1;
      if (options.staleBeforeDispatch && controlCalls >= 2) {
        return {
          documentRef: "input-doc",
          scopeRef: "scope",
          observationId: "old-observation",
          revision: 0,
        };
      }
      if (current === null) throw new Error("no observation");
      return {
        documentRef: current.documentRef,
        scopeRef: current.scopeRef,
        observationId: current.observationId,
        revision: current.revision,
      };
    },
    nativeInputText: async invocation => {
      actions.push(invocation);
      dispatched = true;
      if (!options.ignoreEffect && !options.focusOther) currentValue = invocation.value;
      if (options.inputThrowsAfter) {
        const error = new Error("transport after dispatch");
        error.dispatched = true;
        error.textWriteCount = 1;
        throw error;
      }
      if (options.focusOther) {
        return {
          dispatched: true,
          ok: true,
          effectKnowledge: "known",
          source: "synthetic",
          error: null,
          events: [{ type: "mousePressed", targetRef: "target", detail: null }],
          textWriteCount: 0,
          focus: "other",
        };
      }
      return {
        dispatched: true,
        ok: true,
        effectKnowledge: "known",
        source: "synthetic",
        error: null,
        events: [{ type: "insertText", targetRef: "target", detail: invocation.value }],
        textWriteCount: 1,
        focus: "target",
      };
    },
  };
  return {
    resources,
    actions,
    get observeCalls() {
      return observeCalls;
    },
  };
}

test("I01 one logical write reaches the actual target and leaves the neighbor unchanged", async () => {
  const f = fixture();
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0].value, "新文本");
  assert.equal(episode.goalFact, "satisfied");
  assert.equal(episode.satisfaction, 100);
  assert.equal(episode.textWriteCount, 1);
  assert.equal(episode.dispatchState, "dispatched");
  assert.equal(episode.state.observation.target.value.value, "新文本");
  assert.equal(episode.state.observation.neighbors[0].value.value, "保持原值");
  assert.equal(episode.executionErrors.length, 0);
  assert.equal(episode.canContinue, true);
});

test("I02 placeholder text cannot substitute for the live value", async () => {
  const f = fixture({ initialValue: "", placeholder: "新文本" });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.actions.length, 1);
  assert.equal(episode.goalFact, "satisfied");
  assert.equal(episode.state.observation.target.value.value, "新文本");
});

test("I03 page reset after input reports unsatisfied without a second write", async () => {
  const f = fixture({ resetAfterInput: true });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.actions.length, 1);
  assert.equal(episode.goalFact, "unsatisfied");
  assert.equal(episode.satisfaction, 0);
  assert.equal(episode.canContinue, false);
  assert.equal(episode.state.observation.target.value.value, "旧值");
});

test("I04 native readonly is refused before any input", async () => {
  const f = fixture({
    nativeReadonly: true,
    ariaReadonly: false,
    readonlyState: "readonly",
  });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.deepEqual(f.actions, []);
  assert.equal(episode.goalFact, "unsatisfied");
  assert.equal(episode.canContinue, false);
  assert.ok(episode.executionErrors.some(error => error.code === "precondition_unsatisfied"));
});

test("I05 transport error after dispatch preserves the execution error and the real value", async () => {
  const f = fixture({ inputThrowsAfter: true });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.actions.length, 1);
  assert.equal(episode.goalFact, "satisfied");
  assert.equal(episode.satisfaction, 100);
  assert.equal(episode.textWriteCount, 1);
  assert.equal(episode.dispatchState, "dispatched");
  assert.ok(episode.executionErrors.some(error => error.message.includes("transport after dispatch")));
  assert.equal(episode.canContinue, false);
});

test("I06 read failure after dispatch remains unknown and separate from execution", async () => {
  const f = fixture({ observeFailsAfterDispatch: true });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.actions.length, 1);
  assert.equal(episode.goalFact, "unknown");
  assert.equal(episode.satisfaction, null);
  assert.equal(episode.canContinue, false);
  assert.equal(episode.executionErrors.length, 0);
  assert.ok(episode.observationFeedback.errors.some(error => error.message.includes("read failed")));
});

test("I13 a stale binding is not silently rebound and yields unknown", async () => {
  const f = fixture({ staleBeforeDispatch: true });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.deepEqual(f.actions, []);
  assert.equal(episode.goalFact, "unknown");
  assert.equal(episode.satisfaction, null);
  assert.equal(episode.canContinue, false);
  assert.ok(episode.executionErrors.some(error => error.code === "stale_binding"));
});

test("I14 a rebuilt post object cannot be credited with the old target value", async () => {
  const f = fixture({ postObjectRebuild: true });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.actions.length, 1);
  assert.equal(episode.goalFact, "unknown");
  assert.equal(episode.satisfaction, null);
  assert.equal(episode.canContinue, false);
});

test("I15 a successful receipt cannot replace a fresh value observation", async () => {
  const f = fixture({ ignoreEffect: true });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.actions.length, 1);
  assert.equal(episode.goalFact, "unsatisfied");
  assert.equal(episode.canContinue, false);
});

test("I16 missing native input permission is refused with zero writes", async () => {
  const f = fixture({ grantedEffects: ["browser.read"] });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.deepEqual(f.actions, []);
  assert.equal(episode.goalFact, "unsatisfied");
  assert.equal(episode.canContinue, false);
  assert.ok(episode.executionErrors.some(error => error.code === "permission_denied"));
});

test("I17 missing read permission returns unknown without observing", async () => {
  const f = fixture({ grantedEffects: [] });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.observeCalls, 0);
  assert.equal(episode.goalFact, "unknown");
  assert.equal(episode.refusal.code, "permission_denied");
  assert.equal(episode.canContinue, false);
});

test("I19 a sensitive host is denied before observation", async () => {
  const f = fixture();
  const episode = await runBrowserInputGoal(
    request({ bindings: { documentRef: "input-doc", scopeRef: "scope", targetRef: "target", sensitive: true } }),
    f.resources,
  );
  assert.equal(f.observeCalls, 0);
  assert.equal(episode.goalFact, "unknown");
  assert.equal(episode.refusal.code, "sensitive_host_denied");
  assert.equal(episode.canContinue, false);
});

test("I20 an already satisfied value uses the this-run observation and performs no write", async () => {
  const f = fixture({ initialValue: "新文本" });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.deepEqual(f.actions, []);
  assert.equal(episode.goalFact, "satisfied");
  assert.equal(episode.textWriteCount, 0);
  assert.equal(episode.dispatchState, "not_dispatched");
  assert.equal(episode.canContinue, true);
});

test("I21 a stale post observation cannot become the current state", async () => {
  const f = fixture({ stalePost: true });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.actions.length, 1);
  assert.equal(episode.goalFact, "unknown");
  assert.equal(episode.satisfaction, null);
  assert.equal(episode.canContinue, false);
  assert.ok(episode.observationFeedback.errors.some(error => error.code === "stale_observation"));
});

test("I22 a focus mismatch stops before text dispatch", async () => {
  const f = fixture({ focusOther: true });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(f.actions.length, 1);
  assert.equal(episode.textWriteCount, 0);
  assert.equal(episode.goalFact, "unsatisfied");
  assert.equal(episode.refusal.code, "focus_not_on_target");
  assert.equal(episode.canContinue, false);
});

test("I23 unknown editability is refused without filling a false fact", async () => {
  const f = fixture({ unknownEditable: true });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.deepEqual(f.actions, []);
  assert.equal(episode.beforeState.target.editable.status, "unknown");
  assert.equal(episode.goalFact, "unsatisfied");
  assert.ok(episode.executionErrors.some(error => error.code === "precondition_unsatisfied"));
});

test("I24 unsupported hosts are refused as unknown and never dispatched", async () => {
  for (const options of [{ host: "textarea" }, { type: "search" }, { host: "contenteditable" }]) {
    const f = fixture(options);
    const episode = await runBrowserInputGoal(request(), f.resources);
    assert.deepEqual(f.actions, []);
    assert.equal(episode.goalFact, "unknown");
    assert.equal(episode.refusal.code, "unsupported_host");
    assert.equal(episode.canContinue, false);
  }
});

test("B-S1.1 model: executableHit=false with unequal value defers with zero writes", async () => {
  const f = fixture();
  const resources = modelResources(f, {
    target: {executableHit: observed(false, ["evidence-1"]), point: unknown("no_hit_point")},
  });
  const episode = await runBrowserInputGoal(request(), resources);
  assert.deepEqual(f.actions, []);
  assert.equal(episode.dispatchState, "not_dispatched");
  assert.equal(episode.textWriteCount, 0);
  assert.equal(episode.goalFact, "unsatisfied");
  assert.equal(episode.refusal.code, "precondition_unsatisfied");
  assert.ok(episode.executionErrors.some(error => error.message.includes("execution precondition")));
});

test("B-S1.1 model: executableHit unknown defers with zero writes", async () => {
  const f = fixture();
  const resources = modelResources(f, {
    target: {executableHit: unknown("executable_hit_unmeasured"), point: unknown("executable_hit_point_unmeasured")},
  });
  const episode = await runBrowserInputGoal(request(), resources);
  assert.deepEqual(f.actions, []);
  assert.equal(episode.dispatchState, "not_dispatched");
  assert.equal(episode.textWriteCount, 0);
  assert.equal(episode.goalFact, "unknown");
  assert.equal(episode.refusal.code, "decision_deferred");
});

test("B-S1.1 model: valueEqual (1,1) wins over readonly, occlusion and unknown hit", async () => {
  for (const target of [
    {readonlyState: observed("readonly", ["evidence-1"])},
    {executableHit: observed(false, ["evidence-1"]), point: unknown("no_hit_point")},
    {executableHit: unknown("executable_hit_unmeasured"), point: unknown("executable_hit_point_unmeasured")},
  ]) {
    const f = fixture({initialValue: "新文本"});
    const resources = modelResources(f, {target});
    const episode = await runBrowserInputGoal(request(), resources);
    assert.deepEqual(f.actions, []);
    assert.equal(episode.goalFact, "satisfied");
    assert.equal(episode.satisfaction, 100);
    assert.equal(episode.textWriteCount, 0);
    assert.equal(episode.dispatchState, "not_dispatched");
  }
});

test("public contract rejects search-root fields and returns permission refusal as an episode", async () => {
  await assert.rejects(
    runBrowserInputGoal({ ...request(), phase: "submitted" }, fixture().resources),
    /Invalid typed browser input request/,
  );

  const f = fixture({ grantedEffects: [] });
  const episode = await runBrowserInputGoal(request(), f.resources);
  assert.equal(episode.goalFact, "unknown");
  assert.equal(episode.refusal.code, "permission_denied");
  assert.equal(episode.canContinue, false);
});
