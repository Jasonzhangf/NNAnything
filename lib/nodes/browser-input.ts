import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { NodeDefinition } from "../core/contracts.js";
import { expectRecord } from "../core/schema.js";
import { createWorkflowInputEvent } from "../core/events.js";
import { loadWorkflow } from "../workflow/loader.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { runWorkflow } from "../workflow/runner.js";
import type {
  BrowserInputControl,
  BrowserInputEpisode,
  BrowserInputInvocation,
  BrowserInputNativeReceipt,
  BrowserInputObservation,
  BrowserInputResources,
} from "../adapters/browser/input-contract.js";
import {
  assertInputBindings,
  inputGoalFact,
  readBrowserInputObservation,
  readBrowserInputRequest,
} from "../adapters/browser/input-contract.js";

const ports = ["request", "observed", "recognized", "decision", "receipt", "reobserved", "verified", "ended"].map(name => ({
  name: `${name}_event`,
  schemaId: `browser.input/${name}/v1`,
  eventType: `browser.input.${name}.v1`,
  validate: (value: unknown) => expectRecord(value, "browser input stage"),
}));
const names = ["dom.observeState", "dom.recognizeWorkflow", "operation.decide", "operation.apply", "dom.reobserve", "operation.verify", "operation.report"];
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function sameControl(observation: BrowserInputObservation, control: BrowserInputControl): boolean {
  return observation.documentRef === control.documentRef
    && observation.scopeRef === control.scopeRef
    && observation.observationId === control.observationId
    && observation.revision === control.revision;
}

interface InputStage {
  readonly request: ReturnType<typeof readBrowserInputRequest>;
  readonly action: "input";
  readonly decisionSource: { readonly id: string; readonly source: "handwired" };
  readonly beforeState: BrowserInputObservation | null;
  readonly invocation: BrowserInputInvocation | null;
  readonly receipt: BrowserInputNativeReceipt | null;
  readonly textWriteCount: 0 | 1;
  readonly dispatchState: BrowserInputEpisode["dispatchState"];
  readonly effectKnowledge: BrowserInputEpisode["effectKnowledge"];
  readonly state: BrowserInputEpisode["state"];
  readonly executionErrors: BrowserInputEpisode["executionErrors"];
  readonly observationFeedback: BrowserInputEpisode["observationFeedback"];
  readonly refusal: BrowserInputEpisode["refusal"];
}

interface NativeTransportError extends Error {
  readonly dispatched?: boolean;
  readonly textWriteCount?: 0 | 1;
}

const BEFORE_STATE_REFUSALS = new Set(["precondition_unsatisfied", "permission_denied", "focus_not_on_target"]);
const UNKNOWN_FACT_REFUSALS = new Set(["stale_binding", "object_rebuilt", "unsupported_host", "sensitive_host_denied"]);

function stageError(stage: InputStage, code: string, text: string): InputStage {
  return {
    ...stage,
    refusal: code === "precondition_unsatisfied" || code === "permission_denied" || code === "unsupported_host"
      || code === "sensitive_host_denied" || code === "focus_not_on_target" || code === "stale_binding"
      || code === "object_rebuilt" ? { code, message: text } : stage.refusal,
    executionErrors: [...stage.executionErrors, { code, message: text }],
  };
}

function observationFailure(stage: InputStage, code: string, text: string): InputStage {
  return {
    ...stage,
    state: null,
    observationFeedback: {
      ...stage.observationFeedback,
      status: "failed",
      errors: [{ code, message: text }],
    },
  };
}

function obligationFor(request: ReturnType<typeof readBrowserInputRequest>, freshness: "current" | "after_action") {
  return {
    conditionRef: "BrowserInput.targetValue",
    method: "input-value",
    subjectRef: request.bindings.targetRef,
    scopeRef: request.bindings.scopeRef,
    requiredFacts: ["value", "editable"],
    freshness,
  };
}

function episodeOf(stage: InputStage, fact: BrowserInputEpisode["goalFact"]): BrowserInputEpisode {
  const satisfied = fact === "satisfied";
  const canContinue = satisfied && stage.executionErrors.length === 0;
  return {
    requestId: stage.request.requestId,
    goal: stage.request.goal,
    bindings: stage.request.bindings,
    action: "input",
    decisionSource: stage.decisionSource,
    dispatchState: stage.dispatchState,
    effectKnowledge: stage.effectKnowledge,
    textWriteCount: stage.textWriteCount,
    focus: stage.receipt?.focus ?? (stage.invocation === null ? "not_attempted" : "unknown"),
    beforeState: stage.beforeState,
    state: stage.state,
    invocation: stage.invocation,
    receipt: stage.receipt,
    nativeEvents: stage.receipt?.events ?? [],
    goalFact: fact,
    satisfaction: fact === "satisfied" ? 100 : fact === "unsatisfied" ? 0 : null,
    refusal: stage.refusal,
    executionErrors: stage.executionErrors,
    observationFeedback: stage.observationFeedback,
    canContinue,
  };
}

function evaluate(stage: InputStage): InputStage {
  const post = stage.state?.observation;
  if (!post) {
    return {
      ...stage,
      observationFeedback: {
        ...stage.observationFeedback,
        status: "incomplete",
        observationId: null,
        unmetFacts: ["value", "editable"],
        evidenceRefs: [],
        errors: stage.observationFeedback.errors,
      },
    };
  }
  if (stage.beforeState === null
    || (stage.invocation !== null
      && (post.observationId === stage.beforeState.observationId
        || post.revision <= stage.beforeState.revision))) {
    return observationFailure(stage, "stale_observation", "Post-action observation is not current");
  }
  const unmet = ["value", "editable"].filter(key => {
    const fact = post.target[key as "value" | "editable"];
    return fact.status !== "observed";
  });
  return {
    ...stage,
    observationFeedback: {
      ...stage.observationFeedback,
      status: unmet.length ? "incomplete" : "satisfied",
      observationId: post.observationId,
      evidenceRefs: post.evidence.map(item => item.id),
      unmetFacts: unmet,
      errors: [],
    },
  };
}

export function createBrowserInputEpisodeNodes(resources: BrowserInputResources): readonly NodeDefinition[] {
  return names.map((operator, index) => ({
    operator,
    version: "0.1.0-design",
    inputPorts: [ports[index]!],
    outputPort: ports[index + 1]!,
    effects: [],
    acceptNonOkInputs: true,
    async execute(context) {
      let s = context.inputs[0]!.payload as InputStage;
      if (index === 0) {
        const request = readBrowserInputRequest(s);
        s = {
          request,
          action: "input",
          decisionSource: { id: "browser.input.handwired.v1", source: "handwired" },
          beforeState: null,
          invocation: null,
          receipt: null,
          textWriteCount: 0,
          dispatchState: "not_dispatched",
          effectKnowledge: "none",
          state: null,
          executionErrors: [],
          refusal: null,
          observationFeedback: {
            obligation: obligationFor(request, "current"),
            status: "incomplete",
            observationId: null,
            evidenceRefs: [],
            unmetFacts: ["value", "editable"],
            errors: [],
          },
        };
        if (!resources.grantedEffects.has("browser.read")) {
          return context.emit(stageError(s, "permission_denied", "browser.read permission required"));
        }
        if (s.request.bindings.sensitive === true) {
          return context.emit(stageError(s, "sensitive_host_denied", "Target is marked sensitive by the caller"));
        }
        try {
          if (resources.signal?.aborted) throw new Error("Input cancelled before observation");
          const before = readBrowserInputObservation(await resources.observe(obligationFor(s.request, "current")));
          assertInputBindings(before, s.request.bindings);
          const control = await resources.currentControl();
          if (!sameControl(before, control)) throw new Error("Initial input observation is stale");
          s = {
            ...s,
            beforeState: before,
            observationFeedback: {
              ...s.observationFeedback,
              status: "satisfied",
              observationId: before.observationId,
              evidenceRefs: before.evidence.map(item => item.id),
              unmetFacts: [],
              errors: [],
            },
          };
        } catch (error) {
          s = observationFailure(s, "observation_failed", message(error));
        }
        return context.emit(s);
      }
      if (index === 1 && s.beforeState !== null && s.executionErrors.length === 0) {
        const target = s.beforeState.target;
        if (target.connected.status !== "observed" || target.connected.value !== true) s = stageError(s, "precondition_unsatisfied", "Target connectedness is not observed");
        else if (target.currentRef.status !== "observed" || target.currentRef.value !== s.request.bindings.targetRef) s = stageError(s, "stale_binding", "Bound DOM object identity is not confirmed");
        else if (target.host.status !== "observed" || target.type.status !== "observed" || target.contentEditable.status !== "observed") s = stageError(s, "precondition_unsatisfied", "Target host facts are unknown");
        else if (target.host.value === "contenteditable" || target.contentEditable.value === true) s = stageError(s, "unsupported_host", "contenteditable hosts are not supported");
        else if (target.host.value !== "input" || target.type.value !== "text") s = stageError(s, "unsupported_host", "Only ordinary input type=text is supported");
        else if (target.nativeDisabled.status !== "observed" || target.ariaDisabled.status !== "observed"
          || target.nativeReadonly.status !== "observed" || target.ariaReadonly.status !== "observed") {
          s = stageError(s, "precondition_unsatisfied", "Required native and ARIA facts are unknown");
        } else if (target.nativeDisabled.value) s = stageError(s, "precondition_unsatisfied", "Native disabled target cannot be written");
        else if (target.ariaDisabled.value === true || target.ariaReadonly.value === true
          || target.readonlyState.status !== "observed" || target.readonlyState.value !== "editable") {
          s = stageError(s, "precondition_unsatisfied", "Target is not confirmed editable across native and ARIA facts");
        } else if (target.editable.status !== "observed" || target.editable.value !== true) s = stageError(s, "precondition_unsatisfied", "Editable qualification is not confirmed");
        else if (target.value.status !== "observed") s = stageError(s, "precondition_unsatisfied", "Current target value is unknown");
        return context.emit(s);
      }
      if (index === 2 && s.beforeState !== null && s.executionErrors.length === 0) {
        const alreadySatisfied = s.beforeState.target.value.status === "observed"
          && s.beforeState.target.value.value === s.request.goal.targetText;
        if (!alreadySatisfied) {
          const before = s.beforeState;
          s = {
            ...s,
            invocation: {
              kind: "input",
              targetRef: s.request.bindings.targetRef,
              value: s.request.goal.targetText,
              documentRef: before.documentRef,
              scopeRef: before.scopeRef,
              observationId: before.observationId,
              revision: before.revision,
            },
          };
        }
        return context.emit(s);
      }
      if (index === 3 && s.invocation !== null && s.beforeState !== null && s.executionErrors.length === 0) {
        if (!resources.grantedEffects.has("browser.nativeInputText")) {
          return context.emit(stageError(s, "permission_denied", "browser.nativeInputText permission required"));
        }
        try {
          if (resources.signal?.aborted) throw new Error("Input cancelled before dispatch");
          if (!sameControl(s.beforeState, await resources.currentControl())) throw new Error("Input control changed before dispatch");
        } catch (error) {
          return context.emit(stageError(s, "stale_binding", message(error)));
        }
        const invocation = s.invocation;
        s = { ...s, dispatchState: "unknown", effectKnowledge: "unknown" };
        try {
          const receipt = await resources.nativeInputText(invocation);
          const validReceipt = receipt && typeof receipt.dispatched === "boolean"
            && typeof receipt.ok === "boolean" && ["none", "known", "unknown"].includes(receipt.effectKnowledge)
            && typeof receipt.source === "string" && receipt.source.length > 0
            && Array.isArray(receipt.events) && receipt.events.length > 0
            && (receipt.textWriteCount === 0 || receipt.textWriteCount === 1)
            && ["target", "other", "unknown"].includes(String(receipt.focus));
          if (!validReceipt) throw new Error("Malformed native input receipt");
          s = {
            ...s,
            receipt,
            textWriteCount: receipt.textWriteCount,
            dispatchState: receipt.dispatched ? "dispatched" : "not_dispatched",
            effectKnowledge: receipt.effectKnowledge,
          };
          if (receipt.error !== null && (typeof receipt.error !== "object" || typeof receipt.error.code !== "string" || typeof receipt.error.message !== "string")) {
            throw new Error("Malformed native input receipt error");
          }
          if (receipt.focus === "other") {
            s = stageError(s, "focus_not_on_target", "Focus left the bound target before text dispatch");
          } else if (receipt.textWriteCount === 0) {
            s = stageError(s, "execution_rejected", "Native executor did not dispatch a logical text write");
          } else if (receipt.error || !receipt.ok) {
            s = stageError(s, receipt.error?.code ?? "execution_rejected", receipt.error?.message ?? "Native executor reported failure");
          }
        } catch (error) {
          const detail = error as NativeTransportError;
          s = {
            ...stageError(s, "native_action_failed", message(error)),
            dispatchState: detail.dispatched === true ? "dispatched" : s.dispatchState,
            textWriteCount: detail.textWriteCount === 1 ? 1 : s.textWriteCount,
          };
        }
        return context.emit(s);
      }
      if (index === 4 && s.beforeState !== null) {
        // Post-action observation is obligatory only when a native write was
        // attempted or its dispatch outcome is uncertain. A pre-dispatch
        // refusal (stale binding, permission, precondition) leaves the target
        // untouched, so observing again would fabricate a post obligation.
        if (s.invocation !== null && s.dispatchState !== "not_dispatched") {
          try {
            if (resources.signal?.aborted) throw new Error("Input cancelled during observation");
            const post = readBrowserInputObservation(await resources.observe(obligationFor(s.request, "after_action")));
            assertInputBindings(post, s.request.bindings);
            if (post.target.currentRef.status !== "observed" || post.target.currentRef.value !== s.request.bindings.targetRef) {
              throw new Error("Post-action DOM object is not the originally bound target");
            }
            if (!sameControl(post, await resources.currentControl())) throw new Error("Post-action observation is not current");
            s = { ...s, state: { observation: post, checkedObservationId: post.observationId } };
          } catch (error) {
            s = observationFailure(s, "post_observation_failed", message(error));
          }
        } else if (s.beforeState.target.value.status === "observed" && s.beforeState.target.value.value === s.request.goal.targetText) {
          s = { ...s, state: { observation: s.beforeState, checkedObservationId: s.beforeState.observationId } };
        }
        return context.emit(s);
      }
      if (index === 5 && s.beforeState !== null) {
        if (s.state !== null) {
          const evaluated = evaluate(s);
          return context.emit(evaluated.observationFeedback.status === "failed" ? { ...evaluated, state: null } : evaluated);
        }
        return context.emit(s);
      }
      if (index === 6) {
        const stateBlocked = s.refusal !== null && UNKNOWN_FACT_REFUSALS.has(s.refusal.code);
        const fact = stateBlocked
          ? "unknown"
          : s.state !== null
            ? s.observationFeedback.status === "failed" ? "unknown" : inputGoalFact(s.request.goal, s.state.observation)
            : s.beforeState !== null && s.refusal !== null
              && BEFORE_STATE_REFUSALS.has(s.refusal.code)
              && !s.executionErrors.some(error => error.code === "native_action_failed"
                || error.code === "post_observation_failed" || error.code === "observation_failed")
              ? inputGoalFact(s.request.goal, s.beforeState)
              : "unknown";
        return context.emit(episodeOf(s, fact));
      }
      return context.emit(s);
    },
  }));
}

export async function runBrowserInputEpisode(input: unknown, resources: BrowserInputResources): Promise<BrowserInputEpisode> {
  const request = readBrowserInputRequest(input);
  if (!(resources.grantedEffects instanceof Set)
    || typeof resources.observe !== "function"
    || typeof resources.currentControl !== "function"
    || typeof resources.nativeInputText !== "function") {
    throw new TypeError("Explicit browser input resources are required");
  }
  const definition = await loadWorkflow({
    configPath: fileURLToPath(new URL("../../workflows/browser-input.workflow.json", import.meta.url)),
    allowedRoot: fileURLToPath(new URL("../../workflows/", import.meta.url)),
  });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createBrowserInputEpisodeNodes(resources),
    grantedEffects: [...resources.grantedEffects],
  });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "request_event",
    type: "browser.input.request.v1",
    payload: request,
  }));
  if (result.status === "failed") throw new Error(result.error.message);
  return result.outputEvent.payload as BrowserInputEpisode;
}
