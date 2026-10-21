import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { NodeDefinition } from "../core/contracts.js";
import { createWorkflowInputEvent } from "../core/events.js";
import { expectRecord } from "../core/schema.js";
import { readBrowserObservationErrors, readBrowserObservationFeedback,
  type BrowserObservationError, type BrowserObservationFeedback } from "../adapters/browser/action-observation.js";
import {
  type NativeClickInvocation,
  type NativeClickReceipt,
  type SelectedExpansionStrategy,
  type SelectedSingleActionResources,
  type SingleActionControl,
  type SingleActionEpisodeResult,
  type SingleActionPrediction,
  type SingleActionRequest,
  type SingleActionResources,
  type SingleActionSnapshot,
  type SingleActionTargetConstraint,
} from "../adapters/browser/single-action-contract.js";
import {
  readSelectedSingleActionRequest,
  readSingleActionRequest,
  readSingleActionSnapshot,
} from "../adapters/browser/single-action-observation.js";
import {
  createBrowserSingleActionPolicy,
  predictBrowserSingleActionForTarget,
  validateBrowserSingleActionProfile,
} from "../filters/browser-single-action-policy.js";
import type { BrowserExpansionStrategy } from "../adapters/browser/strategy-contract.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { loadWorkflow } from "../workflow/loader.js";
import { runWorkflow } from "../workflow/runner.js";

const REQUEST_PORT = {
  name: "request_event",
  schemaId: "browser.single-action.episode/request/v1",
  eventType: "browser.single-action.episode.request.v1",
  validate: (value: unknown) => expectRecord(value, "browser single action episode request"),
};
const OBSERVED_PORT = {
  name: "observed_event",
  schemaId: "browser.single-action.episode/observed/v1",
  eventType: "browser.single-action.episode.observed.v1",
  validate: (value: unknown) => expectRecord(value, "browser single action observed event"),
};
const RECOGNIZED_PORT = {
  name: "recognized_event",
  schemaId: "browser.single-action.episode/recognized/v1",
  eventType: "browser.single-action.episode.recognized.v1",
  validate: (value: unknown) => expectRecord(value, "browser single action recognized event"),
};
const DECISION_PORT = {
  name: "decision_event",
  schemaId: "browser.single-action.episode/decision/v1",
  eventType: "browser.single-action.episode.decision.v1",
  validate: (value: unknown) => expectRecord(value, "browser single action decision event"),
};
const RECEIPT_PORT = {
  name: "receipt_event",
  schemaId: "browser.single-action.episode/receipt/v1",
  eventType: "browser.single-action.episode.receipt.v1",
  validate: (value: unknown) => expectRecord(value, "browser single action receipt event"),
};
const REORIGINATED_PORT = {
  name: "reobserved_event",
  schemaId: "browser.single-action.episode/reobserved/v1",
  eventType: "browser.single-action.episode.reobserved.v1",
  validate: (value: unknown) => expectRecord(value, "browser single action reobserved event"),
};
const VERIFIED_PORT = {
  name: "verified_event",
  schemaId: "browser.single-action.episode/verified/v1",
  eventType: "browser.single-action.episode.verified.v1",
  validate: (value: unknown) => expectRecord(value, "browser single action verified event"),
};
const ENDED_PORT = {
  name: "ended_event",
  schemaId: "browser.single-action.episode/result/v1",
  eventType: "browser.single-action.episode.result.v1",
  validate: (value: unknown) => expectRecord(value, "browser single action result"),
};

interface EpisodeStage {
  readonly request: SingleActionRequest;
  readonly prediction: SingleActionPrediction | null;
  readonly invocation: NativeClickInvocation | null;
  readonly receipt: NativeClickReceipt | null;
  readonly dispatchState: SingleActionEpisodeResult["dispatchState"];
  readonly effectKnowledge: SingleActionEpisodeResult["effectKnowledge"];
  readonly newState: SingleActionSnapshot | null;
  readonly satisfaction: 0 | 100 | null;
  readonly achieved: boolean;
  readonly error: SingleActionEpisodeResult["error"];
  readonly collectionError: string | null;
  readonly executionErrors: readonly BrowserObservationError[];
  readonly observationFeedback: BrowserObservationFeedback;
}

export interface BrowserSingleActionExecutionConstraint {
  readonly selectedStrategy: SelectedExpansionStrategy;
  readonly strategyRegistry: readonly BrowserExpansionStrategy[];
}

function stageError(
  stage: EpisodeStage,
  code: string,
  message: string,
): EpisodeStage {
  return Object.freeze({
    ...stage,
    error: stage.error ?? Object.freeze({ code, message }),
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultOf(stage: EpisodeStage): SingleActionEpisodeResult {
  return Object.freeze({
    prediction: stage.prediction,
    invocation: stage.invocation,
    receipt: stage.receipt,
    dispatchState: stage.dispatchState,
    effectKnowledge: stage.effectKnowledge,
    newState: stage.newState,
    satisfaction: stage.satisfaction,
    achieved: stage.achieved,
    error: stage.error,
    collectionError: stage.collectionError,
    executionErrors: stage.executionErrors,
    observationFeedback: stage.observationFeedback,
  });
}

export function readBrowserSingleActionEpisodeResult(value: unknown): SingleActionEpisodeResult {
  const input = expectRecord(value, "browser single action episode result");
  if (!["not_dispatched", "dispatched", "unknown"].includes(String(input.dispatchState))
    || !["none", "known", "unknown"].includes(String(input.effectKnowledge))) {
    throw new TypeError("browser single action dispatch/effect knowledge is invalid");
  }
  if (typeof input.achieved !== "boolean") {
    throw new TypeError("browser single action episode result.achieved must be boolean");
  }
  if (input.satisfaction !== null && input.satisfaction !== 0 && input.satisfaction !== 100) {
    throw new TypeError("browser single action episode result.satisfaction is invalid");
  }
  if (input.collectionError !== null && typeof input.collectionError !== "string") {
    throw new TypeError("browser single action episode result.collectionError must be string or null");
  }
  if (input.executionErrors !== undefined) readBrowserObservationErrors(input.executionErrors);
  if (input.observationFeedback !== undefined) readBrowserObservationFeedback(input.observationFeedback);
  return value as SingleActionEpisodeResult;
}

export function createBrowserSingleActionEpisodeNodes(
  resources: SingleActionResources,
  executionConstraint?: BrowserSingleActionExecutionConstraint,
): readonly NodeDefinition[] {
  const profile = validateBrowserSingleActionProfile(resources.profile);
  const policy = createBrowserSingleActionPolicy({ profile });
  const constraint = executionConstraint === undefined
    ? null
    : Object.freeze({
      selectedStrategy: executionConstraint.selectedStrategy,
      strategyRegistry: executionConstraint.strategyRegistry,
    });
  const targetConstraint: SingleActionTargetConstraint | null = constraint === null
    ? null
    : Object.freeze({
      targetRef: constraint.selectedStrategy.targetRef,
      goalRegionRef: constraint.selectedStrategy.goalRegionRef,
    });
  const operator = (
    name: string,
    inputPort: NodeDefinition["inputPorts"][number],
    outputPort: NodeDefinition["outputPort"],
    effects: readonly string[],
    execute: NodeDefinition["execute"],
  ): NodeDefinition => Object.freeze({
    operator: name,
    version: "0.1.0-design",
    inputPorts: Object.freeze([inputPort]),
    outputPort,
    effects,
    acceptNonOkInputs: true,
    execute,
  });

  const observeNode = operator(
    "dom.observeState",
    REQUEST_PORT,
    OBSERVED_PORT,
    [],
    async context => {
      const request = constraint === null
        ? readSingleActionRequest(context.inputs[0]!.payload)
        : readSelectedSingleActionRequest(
          context.inputs[0]!.payload,
          constraint.strategyRegistry,
        );
      const initial: EpisodeStage = {
        request, prediction: null, invocation: null, receipt: null,
        dispatchState: "not_dispatched", effectKnowledge: "none",
        newState: null, satisfaction: null, achieved: false, error: null, collectionError: null,
        executionErrors: [],
        observationFeedback: {
          obligation: { conditionRef: request.goal.regionRef, method: "expanded-state", subjectRef: request.goal.regionRef,
            scopeRef: request.state.scopeRef, requiredFacts: ["expanded", "rendered"], freshness: "after_action" },
          status: "incomplete", observationId: null, evidenceRefs: [], unmetFacts: ["expanded", "rendered"], errors: [],
        },
      };
      try {
        const snapshot = readSingleActionSnapshot(await resources.observe());
        if (snapshot.documentRef !== request.state.documentRef || snapshot.scopeRef !== request.state.scopeRef) {
          return context.emit(stageError(initial, "invalid_binding", "Fresh observation replaced the Goal document or scope"));
        }
        const current = constraint === null
          ? readSingleActionRequest({ ...request, state: snapshot })
          : readSelectedSingleActionRequest({
            ...request,
            contract: "browser.single-action.selected.v1",
            selectedStrategy: constraint.selectedStrategy,
            state: snapshot,
          }, constraint.strategyRegistry);
        let control: SingleActionControl;
        try {
          control = await resources.currentControl();
        } catch (error) {
          return context.emit(stageError(initial, "control_unavailable", errorText(error)));
        }
        if (control.documentRef !== snapshot.documentRef
          || control.observationId !== snapshot.observationId
          || control.revision !== snapshot.revision) {
          return context.emit(stageError(initial, "stale_reference", "Control resource invalidated the observation"));
        }
        return context.emit({ ...initial, request: current } satisfies EpisodeStage);
      } catch (error) {
        return context.emit(stageError(initial, "observation_failed", errorText(error)));
      }
    },
  );

  const recognizeNode = operator(
    "dom.recognizeWorkflow",
    OBSERVED_PORT,
    RECOGNIZED_PORT,
    [],
    context => {
      const stage = context.inputs[0]!.payload as EpisodeStage;
      if (stage.error) return context.emit(stage);
      try {
        const prediction = targetConstraint === null
          ? policy.predict(stage.request)
          : predictBrowserSingleActionForTarget(stage.request, profile, targetConstraint);
        return context.emit(Object.freeze({ ...stage, prediction }));
      } catch (error) {
        return context.emit(stageError(stage, "prediction_failed", errorText(error)));
      }
    },
  );

  const decideNode = operator(
    "operation.decide",
    RECOGNIZED_PORT,
    DECISION_PORT,
    [],
    context => {
      const stage = context.inputs[0]!.payload as EpisodeStage;
      if (stage.error || stage.prediction === null) return context.emit(stage);
      const prediction = stage.prediction;
      const scopedRelations = targetConstraint === null
        ? prediction.relations
        : prediction.relations.filter(relation => relation.ref === targetConstraint.targetRef);
      if (prediction.capability === "NOOP") {
        const region = stage.request.state.regions.find(item => item.ref === stage.request.goal.regionRef);
        if (region?.expanded.status !== "observed"
          || region.expanded.value !== true
          || region.rendered.status !== "observed"
          || region.rendered.value !== true) {
          return context.emit(stageError(stage, "invalid_noop", "NOOP requires an observed rendered expanded goal region"));
        }
        return context.emit(stage);
      }
      if (prediction.capability === "DEFER") {
        const region = stage.request.state.regions.find(item => item.ref === stage.request.goal.regionRef);
        if (!region || region.expanded.status !== "observed" || region.rendered.status !== "observed") {
          return context.emit(stageError(stage, "observation_insufficient", "DEFER: required region or relation facts are unknown"));
        }
        const providers = scopedRelations.filter(item => item.judgment === "actionable_provider");
        if (providers.length > 1) {
          return context.emit(stageError(stage, "binding_ambiguous", "DEFER: more than one provider was predicted"));
        }
        const controls = targetConstraint === null
          ? stage.request.state.elements.filter(item => item.controls.status === "observed"
            && item.controls.value.includes(stage.request.goal.regionRef))
          : stage.request.state.elements.filter(item => item.ref === targetConstraint.targetRef);
        if (controls.length > 0 && controls.every(item => (item.enabled.status === "observed" && !item.enabled.value)
          || (item.hit.status === "observed" && !item.hit.value))) {
          return context.emit(stageError(stage, "precondition_unsatisfied", "DEFER: all known controls are disabled or cannot be hit"));
        }
        if (prediction.relations.some(item => item.judgment === "unknown")) {
          return context.emit(stageError(stage, "observation_insufficient", "DEFER: relation facts are incomplete"));
        }
        return context.emit(stageError(stage, controls.length === 0 ? "capability_missing" : "policy_deferred",
          controls.length === 0 ? "DEFER: no control for the Goal is known" : "DEFER: model declined the available capability"));
      }
      if (prediction.proposedTargetRef === null) {
        return context.emit(stageError(stage, "missing_click_target", "CLICK requires one proposed provider"));
      }
      if (targetConstraint !== null && prediction.proposedTargetRef !== targetConstraint.targetRef) {
        return context.emit(stageError(stage, "invalid_click_proposal",
          "CLICK proposal does not match the selected target"));
      }
      const providers = scopedRelations.filter(relation => relation.judgment === "actionable_provider");
      if (providers.length !== 1 || providers[0]!.ref !== prediction.proposedTargetRef) {
        return context.emit(stageError(stage, "invalid_click_proposal", "CLICK proposal is not the unique predicted provider"));
      }
      const element = stage.request.state.elements.find(item => item.ref === prediction.proposedTargetRef);
      if (element?.controls.status === "observed" && !element.controls.value.includes(stage.request.goal.regionRef)) {
        return context.emit(stageError(stage, "policy_error", "Model proposed a control for a different Goal region"));
      }
      if ((element?.enabled.status === "observed" && !element.enabled.value)
        || (element?.hit.status === "observed" && !element.hit.value)) {
        return context.emit(stageError(stage, "precondition_unsatisfied", "Proposed control is disabled or cannot be hit"));
      }
      if (!element
        || element.controls.status !== "observed"
        || !element.controls.value.includes(stage.request.goal.regionRef)
        || element.enabled.status !== "observed"
        || element.enabled.value !== true
        || element.hit.status !== "observed"
        || element.hit.value !== true
        || element.point.status !== "observed") {
        return context.emit(stageError(stage, "observation_insufficient", "CLICK target lacks target/enabled/hit/point facts"));
      }
      const invocation: NativeClickInvocation = Object.freeze({
        kind: "click",
        targetRef: element.ref,
        point: Object.freeze({ ...element.point.value }),
        documentRef: stage.request.state.documentRef,
        observationId: stage.request.state.observationId,
        revision: stage.request.state.revision,
      });
      return context.emit(Object.freeze({ ...stage, invocation }));
    },
  );

  const applyNode = operator(
    "operation.apply",
    DECISION_PORT,
    RECEIPT_PORT,
    ["browser.nativeClick"],
    async context => {
      const stage = context.inputs[0]!.payload as EpisodeStage;
      if (stage.error || stage.invocation === null) return context.emit(stage);
      let current: SingleActionControl;
      try {
        current = await resources.currentControl();
      } catch (error) {
        return context.emit(stageError(stage, "control_unavailable", errorText(error)));
      }
      if (current.documentRef !== stage.invocation.documentRef
        || current.observationId !== stage.invocation.observationId
        || current.revision !== stage.invocation.revision) {
        return context.emit(stageError(stage, "stale_reference", "Native click control changed after observation"));
      }
      const pending: EpisodeStage = { ...stage, dispatchState: "unknown", effectKnowledge: "unknown" };
      try {
        const receipt = await resources.nativeClick(stage.invocation);
        if (!receipt || typeof receipt.dispatched !== "boolean" || typeof receipt.ok !== "boolean"
          || !["none", "known", "unknown"].includes(receipt.effectKnowledge)
          || typeof receipt.source !== "string" || !receipt.source
          || (!receipt.dispatched && receipt.effectKnowledge !== "none")
          || (receipt.error !== null && (typeof receipt.error?.code !== "string" || typeof receipt.error?.message !== "string"))) {
          const error = { code: "adapter_contract_invalid", message: "Native executor returned an invalid receipt" };
          return context.emit(stageError({ ...pending, executionErrors: [error] }, error.code, error.message));
        }
        const executionError = receipt.error ?? (!receipt.ok
          ? { code: "native_click_rejected", message: "Native executor reported failure" } : null);
        const completed: EpisodeStage = { ...pending, receipt,
          dispatchState: receipt.dispatched ? "dispatched" as const : "not_dispatched" as const,
          effectKnowledge: receipt.effectKnowledge,
          executionErrors: executionError === null ? [] : [executionError],
        };
        return context.emit(Object.freeze(executionError === null ? completed
          : stageError(completed, executionError.code, executionError.message)));
      } catch (error) {
        const diagnostic = { code: "native_click_failed", message: errorText(error) };
        return context.emit(stageError({ ...pending, executionErrors: [diagnostic] }, diagnostic.code, diagnostic.message));
      }
    },
  );

  const reobserveNode = operator(
    "dom.reobserve",
    RECEIPT_PORT,
    REORIGINATED_PORT,
    [],
    async context => {
      const stage = context.inputs[0]!.payload as EpisodeStage;
      const failedObservation = (code: string, message: string, newState = stage.newState) => stageError({
        ...stage, newState,
        observationFeedback: { ...stage.observationFeedback, status: "failed" as const,
          observationId: newState?.observationId ?? null, errors: [{ code, message }] },
      }, code, message);
      if (stage.invocation === null) {
        if (stage.error) return context.emit(stage);
        return context.emit(Object.freeze({ ...stage, newState: stage.request.state,
          observationFeedback: { ...stage.observationFeedback,
            obligation: { ...stage.observationFeedback.obligation, freshness: "current" as const },
            status: stage.prediction?.capability === "NOOP" ? "satisfied" as const : "not_required" as const,
            observationId: stage.request.state.observationId, evidenceRefs: stage.request.state.evidence.map(item => item.id),
            unmetFacts: [], errors: [] },
        }));
      }
      if (stage.dispatchState === "not_dispatched") return context.emit(stage);
      try {
        const newState = readSingleActionSnapshot(await resources.observe());
        if (newState.documentRef !== stage.request.state.documentRef
          || newState.scopeRef !== stage.request.state.scopeRef) {
          return context.emit(failedObservation("invalid_binding", "Post-action observation replaced the Goal document or scope", newState));
        }
        if (constraint === null) {
          readSingleActionRequest({ ...stage.request, state: newState });
        } else {
          readSelectedSingleActionRequest({
            ...stage.request,
            contract: "browser.single-action.selected.v1",
            selectedStrategy: constraint.selectedStrategy,
            state: newState,
          }, constraint.strategyRegistry);
        }
        let current: SingleActionControl;
        try {
          current = await resources.currentControl();
        } catch (error) {
          return context.emit(failedObservation("control_unavailable", errorText(error), newState));
        }
        if (current.documentRef !== newState.documentRef
          || current.observationId !== newState.observationId
          || current.revision !== newState.revision
          || newState.revision <= stage.request.state.revision
          || newState.observationId === stage.request.state.observationId) {
          return context.emit(failedObservation("stale_reference", "Post-action evidence is not a fresh current observation", newState));
        }
        const region = newState.regions.find(item => item.ref === stage.request.goal.regionRef);
        const unmetFacts = ["expanded", "rendered"].filter(key => !region
          || region[key as "expanded" | "rendered"].status !== "observed");
        return context.emit(Object.freeze({ ...stage, newState,
          observationFeedback: { ...stage.observationFeedback, status: unmetFacts.length ? "incomplete" as const : "satisfied" as const,
            observationId: newState.observationId, evidenceRefs: newState.evidence.map(item => item.id), unmetFacts, errors: [] },
        }));
      } catch (error) {
        return context.emit(failedObservation("post_observation_failed", errorText(error)));
      }
    },
  );

  const verifyNode = operator(
    "operation.verify",
    REORIGINATED_PORT,
    VERIFIED_PORT,
    [],
    context => {
      const stage = context.inputs[0]!.payload as EpisodeStage;
      if (stage.observationFeedback.status !== "satisfied" || stage.prediction === null) return context.emit(stage);
      if (stage.prediction.capability === "DEFER") return context.emit(stage);
      const snapshot = stage.newState;
      const region = snapshot?.regions.find(item => item.ref === stage.request.goal.regionRef);
      if (!region) return context.emit(Object.freeze({ ...stage, satisfaction: null, achieved: false }));
      if (region.expanded.status === "unknown" || region.rendered.status === "unknown") {
        return context.emit(Object.freeze({ ...stage, satisfaction: null, achieved: false }));
      }
      const satisfaction = region.expanded.value === true && region.rendered.value === true ? 100 : 0;
      return context.emit(Object.freeze({
        ...stage,
        satisfaction,
        achieved: satisfaction === 100,
      }));
    },
  );

  const reportNode = operator(
    "operation.report",
    VERIFIED_PORT,
    ENDED_PORT,
    ["filesystem.write"],
    async context => {
      const stage = context.inputs[0]!.payload as EpisodeStage;
      let result = resultOf(stage);
      try {
        await resources.collect(result);
      } catch (error) {
        result = Object.freeze({ ...result, collectionError: errorText(error) });
      }
      return context.emit(readBrowserSingleActionEpisodeResult(result));
    },
  );

  return Object.freeze([
    observeNode,
    recognizeNode,
    decideNode,
    applyNode,
    reobserveNode,
    verifyNode,
    reportNode,
  ]);
}

const configPath = fileURLToPath(new URL("../../workflows/browser-single-action.workflow.json", import.meta.url));
const allowedRoot = fileURLToPath(new URL("../../workflows/", import.meta.url));

export async function runBrowserSingleActionEpisode(
  request: unknown,
  resources: SingleActionResources,
): Promise<SingleActionEpisodeResult> {
  const validated = readSingleActionRequest(request);
  if (!(resources.grantedEffects instanceof Set)
    || typeof resources.observe !== "function"
    || typeof resources.currentControl !== "function"
    || typeof resources.nativeClick !== "function"
    || typeof resources.collect !== "function") {
    throw new TypeError("Explicit browser single action resources are required");
  }
  const definition = await loadWorkflow({ configPath, allowedRoot });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createBrowserSingleActionEpisodeNodes({
      ...resources,
      profile: validateBrowserSingleActionProfile(resources.profile),
    }),
    grantedEffects: [...resources.grantedEffects],
  });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "request_event",
    type: "browser.single-action.episode.request.v1",
    payload: validated,
  }));
  if (result.status === "failed") {
    throw Object.assign(new Error(result.error.message), {
      category: result.error.category,
      nodeId: result.error.nodeId,
    });
  }
  return readBrowserSingleActionEpisodeResult(result.outputEvent.payload);
}

export async function runSelectedBrowserSingleActionEpisode(
  request: unknown,
  resources: SelectedSingleActionResources,
): Promise<SingleActionEpisodeResult> {
  if (resources === null || typeof resources !== "object"
    || !Array.isArray(resources.strategyRegistry)
    || !(resources.grantedEffects instanceof Set)
    || typeof resources.observe !== "function"
    || typeof resources.currentControl !== "function"
    || typeof resources.nativeClick !== "function"
    || typeof resources.collect !== "function") {
    throw new TypeError("Explicit selected browser single action resources are required");
  }
  const validated = readSelectedSingleActionRequest(request, resources.strategyRegistry);
  const definition = await loadWorkflow({ configPath, allowedRoot });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createBrowserSingleActionEpisodeNodes({
      profile: validateBrowserSingleActionProfile(resources.profile),
      grantedEffects: resources.grantedEffects,
      observe: resources.observe,
      currentControl: resources.currentControl,
      nativeClick: resources.nativeClick,
      collect: resources.collect,
    }, {
      selectedStrategy: validated.selectedStrategy,
      strategyRegistry: resources.strategyRegistry,
    }),
    grantedEffects: [...resources.grantedEffects],
  });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: "request_event",
    type: "browser.single-action.episode.request.v1",
    payload: validated,
  }));
  if (result.status === "failed") {
    throw Object.assign(new Error(result.error.message), {
      category: result.error.category,
      nodeId: result.error.nodeId,
    });
  }
  return readBrowserSingleActionEpisodeResult(result.outputEvent.payload);
}

export const browserSingleActionEpisodeOperatorNames = [
  "dom.observeState",
  "dom.recognizeWorkflow",
  "operation.decide",
  "operation.apply",
  "dom.reobserve",
  "operation.verify",
  "operation.report",
] as const;
