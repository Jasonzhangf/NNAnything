import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { NodeDefinition } from "../core/contracts.js";
import { createWorkflowInputEvent } from "../core/events.js";
import type { TrainableSemanticUnit } from "../core/trainable-unit.js";
import { expectRecord } from "../core/schema.js";
import type {
  FeedbackInput,
  FeedbackPrediction,
} from "../adapters/browser/feedback-contract.js";
import type {
  SelectedExpansionStrategy,
  SingleActionEpisodeResult,
  SingleActionSnapshot,
} from "../adapters/browser/single-action-contract.js";
import {
  readSingleActionSnapshot,
} from "../adapters/browser/single-action-observation.js";
import type {
  BrowserExpansionStrategy,
  BrowserStrategyPrediction,
  BrowserStrategyRequest,
  StrategyEffectProof,
  StrategyStepResources,
  StrategyStepResult,
  StrategyTrainingReceipt,
  StrategyTrainingRequest,
  StrategyTrainingResources,
} from "../adapters/browser/strategy-contract.js";
import {
  predictBrowserStrategy,
  readBrowserStrategyRequest,
  validateBrowserStrategyProfile,
} from "../filters/browser-strategy.js";
import {
  predictFeedback,
  readFeedbackInput,
  validateFeedbackProfile,
} from "../filters/browser-feedback.js";
import { validateBrowserSingleActionProfile } from "../filters/browser-single-action-policy.js";
import {
  runSelectedBrowserSingleActionEpisode,
} from "./browser-single-action.js";
import { runBrowserStrategyTraining } from "./browser-strategy-training.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { loadWorkflow } from "../workflow/loader.js";
import { runWorkflow } from "../workflow/runner.js";

interface StrategyStepStage {
  readonly request: BrowserStrategyRequest;
  readonly decision: BrowserStrategyPrediction | null;
  readonly selectedStrategy: BrowserExpansionStrategy | null;
  readonly atomic: SingleActionEpisodeResult | null;
  readonly feedback: FeedbackPrediction | null;
  readonly feedbackInput: FeedbackInput | null;
  readonly effectProof: StrategyEffectProof | null;
  readonly newState: SingleActionSnapshot | null;
  readonly error: StrategyStepResult["error"];
  readonly collectionError: string | null;
  readonly alreadySatisfied: boolean;
}

const port = (name: string) => ({
  name,
  schemaId: `browser.strategy/${name}/v1`,
  eventType: `browser.strategy.${name}.v1`,
  validate: (value: unknown) => expectRecord(value, name),
});

const REQUEST_PORT = port("strategy_request");
const PREPARED_PORT = port("prepared");
const FEEDBACK_PORT = port("feedback");
const DECISION_PORT = port("decision");
const RECEIPT_PORT = port("receipt");
const RESULT_PORT = port("strategy_result");

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stageError(
  stage: StrategyStepStage,
  code: string,
  message: string,
): StrategyStepStage {
  return Object.freeze({
    ...stage,
    error: stage.error ?? Object.freeze({ code, message }),
  });
}

function initialStage(request: BrowserStrategyRequest): StrategyStepStage {
  return Object.freeze({
    request,
    decision: null,
    selectedStrategy: null,
    atomic: null,
    feedback: null,
    feedbackInput: null,
    effectProof: null,
    newState: null,
    error: null,
    collectionError: null,
    alreadySatisfied: false,
  });
}

function regionFor(snapshot: SingleActionSnapshot, regionRef: string) {
  return snapshot.regions.find(region => region.ref === regionRef) ?? null;
}

function goalSatisfied(snapshot: SingleActionSnapshot, regionRef: string): boolean {
  const region = regionFor(snapshot, regionRef);
  return region?.expanded.status === "observed"
    && region.expanded.value
    && region.rendered.status === "observed"
    && region.rendered.value;
}

function controlOf(snapshot: SingleActionSnapshot) {
  return {
    documentRef: snapshot.documentRef,
    observationId: snapshot.observationId,
    revision: snapshot.revision,
  };
}

function controlMatches(
  control: {
    readonly documentRef: string;
    readonly observationId: string;
    readonly revision: number;
  },
  snapshot: SingleActionSnapshot,
): boolean {
  return control.documentRef === snapshot.documentRef
    && control.observationId === snapshot.observationId
    && control.revision === snapshot.revision;
}

function selectedStrategy(
  strategy: BrowserExpansionStrategy,
): SelectedExpansionStrategy {
  return Object.freeze({
    strategyRef: strategy.strategyRef,
    skillId: strategy.skillId,
    targetRef: strategy.targetRef,
    goalRegionRef: strategy.goalRegionRef,
    equivalenceSetRef: strategy.equivalenceSetRef,
    evidenceRefs: Object.freeze([...strategy.evidenceRefs]),
  });
}

function strategyForPrediction(
  registry: readonly BrowserExpansionStrategy[],
  prediction: BrowserStrategyPrediction,
): BrowserExpansionStrategy | null {
  if (prediction.kind !== "SELECT"
    || prediction.skillId === null
    || prediction.strategyRef === null
    || prediction.targetRef === null) {
    return null;
  }
  return registry.find(strategy =>
    strategy.skillId === prediction.skillId
    && strategy.strategyRef === prediction.strategyRef
    && strategy.targetRef === prediction.targetRef) ?? null;
}

function evidenceIdSet(snapshot: SingleActionSnapshot): ReadonlySet<string> {
  return new Set(snapshot.evidence.map(item => item.id));
}

function validateEffectProof(
  proof: StrategyEffectProof | null,
  input: FeedbackInput,
  targetRef: string,
): StrategyEffectProof | null {
  if (proof === null) return null;
  const post = input.result.newState;
  if (post === null) {
    throw new TypeError("Effect proof requires an actual post-action observation");
  }
  if (input.result.invocation?.targetRef !== targetRef) {
    throw new TypeError("Effect proof attempt did not invoke the selected target");
  }
  if (proof.kind !== "controlled_fixture_no_effect"
    || proof.targetRef !== targetRef
    || proof.documentRef !== input.request.state.documentRef
    || proof.documentRef !== post.documentRef
    || proof.beforeObservationId !== input.request.state.observationId
    || proof.afterObservationId !== post.observationId
    || !Array.isArray(proof.evidenceRefs)
    || proof.evidenceRefs.length === 0) {
    throw new TypeError("Effect proof does not match the selected target and actual pre/post observations");
  }
  if (proof.evidenceRefs.some(ref => typeof ref !== "string" || ref.length === 0)) {
    throw new TypeError("Effect proof evidenceRefs must be non-empty strings");
  }
  if (new Set(proof.evidenceRefs).size !== proof.evidenceRefs.length) {
    throw new TypeError("Effect proof evidenceRefs contains duplicates");
  }
  const available = new Set([
    ...evidenceIdSet(input.request.state),
    ...evidenceIdSet(post),
  ]);
  if (proof.evidenceRefs.some(ref => !available.has(ref))) {
    throw new TypeError("Effect proof cites evidence outside the actual pre/post observations");
  }
  return Object.freeze({
    ...proof,
    evidenceRefs: Object.freeze([...proof.evidenceRefs]),
  });
}

function readStepResult(value: unknown): StrategyStepResult {
  const input = expectRecord(value, "browser strategy step result");
  if (!Object.hasOwn(input, "decision")
    || !Object.hasOwn(input, "atomic")
    || !Object.hasOwn(input, "feedback")
    || !Object.hasOwn(input, "feedbackInput")
    || !Object.hasOwn(input, "effectProof")
    || !Object.hasOwn(input, "newState")
    || !Object.hasOwn(input, "error")
    || !Object.hasOwn(input, "collectionError")) {
    throw new TypeError("Browser strategy step result has incomplete fields");
  }
  if (input.error !== null) {
    const error = expectRecord(input.error, "browser strategy step error");
    if (typeof error.code !== "string" || error.code.length === 0
      || typeof error.message !== "string") {
      throw new TypeError("Browser strategy step error is invalid");
    }
  }
  if (input.collectionError !== null && typeof input.collectionError !== "string") {
    throw new TypeError("Browser strategy collectionError must be a string or null");
  }
  return value as StrategyStepResult;
}

function resultOf(stage: StrategyStepStage): StrategyStepResult {
  return Object.freeze({
    decision: stage.decision,
    atomic: stage.atomic,
    feedback: stage.feedback,
    feedbackInput: stage.feedbackInput,
    effectProof: stage.effectProof,
    newState: stage.newState,
    error: stage.error,
    collectionError: stage.collectionError,
  });
}

export function createBrowserStrategyStepNodes(
  resources: StrategyStepResources,
): readonly NodeDefinition[] {
  validateBrowserStrategyProfile(resources.profile);
  validateBrowserSingleActionProfile(resources.atomicProfile);
  validateFeedbackProfile(resources.feedbackProfile);
  if (typeof resources.observe !== "function"
    || typeof resources.currentControl !== "function"
    || typeof resources.nativeClick !== "function"
    || typeof resources.collectAtomic !== "function"
    || typeof resources.collectStep !== "function"
    || typeof resources.proveNoEffect !== "function"
    || !(resources.grantedEffects instanceof Set)) {
    throw new TypeError("Explicit browser strategy step resources are required");
  }

  const node = (
    operator: string,
    inputPort: NodeDefinition["inputPorts"][number],
    outputPort: NodeDefinition["outputPort"],
    effects: readonly string[],
    execute: NodeDefinition["execute"],
  ): NodeDefinition => Object.freeze({
    operator,
    version: "0.1.0.0000",
    inputPorts: Object.freeze([inputPort]),
    outputPort,
    effects: Object.freeze([...effects]),
    acceptNonOkInputs: true,
    execute,
  });

  const prepare = node(
    "browser.strategy.prepare",
    REQUEST_PORT,
    PREPARED_PORT,
    [],
    async context => {
      let request: BrowserStrategyRequest;
      try {
        request = readBrowserStrategyRequest(context.inputs[0]!.payload);
      } catch (error) {
        throw new TypeError(`Browser strategy request is invalid: ${errorText(error)}`);
      }
      const stage = initialStage(request);
      try {
        const snapshot = readSingleActionSnapshot(await resources.observe());
        if (snapshot.documentRef !== request.request.state.documentRef
          || snapshot.scopeRef !== request.request.state.scopeRef) {
          return context.emit(stageError({
            ...stage,
            newState: snapshot,
          }, "invalid_binding", "Fresh observation replaced the Goal document or scope"));
        }
        const region = regionFor(snapshot, request.request.goal.regionRef);
        if (region === null) {
          return context.emit(stageError({
            ...stage,
            newState: snapshot,
          }, "invalid_binding", "Fresh observation no longer contains the Goal region"));
        }
        const current = await resources.currentControl();
        if (!controlMatches(current, snapshot)) {
          return context.emit(stageError({
            ...stage,
            newState: snapshot,
          }, "stale_reference", "Fresh strategy observation is not the current control"));
        }
        const preparedRequest = Object.freeze({
          request: Object.freeze({
            goal: request.request.goal,
            satisfactionThreshold: request.request.satisfactionThreshold,
            state: snapshot,
          }),
          history: request.history,
        });
        return context.emit(Object.freeze({
          ...stage,
          request: preparedRequest,
          newState: snapshot,
          alreadySatisfied: goalSatisfied(snapshot, request.request.goal.regionRef),
        }));
      } catch (error) {
        return context.emit(stageError(stage, "observation_failed", errorText(error)));
      }
    },
  );

  const feedback = node(
    "browser.strategy.feedback",
    PREPARED_PORT,
    FEEDBACK_PORT,
    [],
    context => {
      const stage = context.inputs[0]!.payload as StrategyStepStage;
      if (stage.error || stage.alreadySatisfied) return context.emit(stage);
      try {
        return context.emit(Object.freeze({
          ...stage,
          decision: predictBrowserStrategy(stage.request, resources),
        }));
      } catch (error) {
        return context.emit(stageError(stage, "prediction_failed", errorText(error)));
      }
    },
  );

  const select = node(
    "browser.strategy.select",
    FEEDBACK_PORT,
    DECISION_PORT,
    [],
    context => {
      const stage = context.inputs[0]!.payload as StrategyStepStage;
      if (stage.error || stage.alreadySatisfied || stage.decision === null) {
        return context.emit(stage);
      }
      if (stage.decision.kind === "DEFER") {
        return context.emit(stageError(
          stage,
          "policy_deferred",
          stage.decision.reason ?? "Strategy policy deferred",
        ));
      }
      if (stage.decision.skillId !== resources.selectedSkillId) {
        return context.emit(stageError(
          stage,
          "policy_error",
          `Core selected ${resources.selectedSkillId}, but the current strategy prediction chose ${stage.decision.skillId}`,
        ));
      }
      const strategy = strategyForPrediction(resources.registry, stage.decision);
      if (strategy === null) {
        return context.emit(stageError(
          stage,
          "invalid_binding",
          "Selected strategy is absent from the explicit equivalence registry",
        ));
      }
      return context.emit(Object.freeze({
        ...stage,
        selectedStrategy: strategy,
      }));
    },
  );

  const apply = node(
    "browser.strategy.apply",
    DECISION_PORT,
    RECEIPT_PORT,
    ["browser.nativeClick"],
    async context => {
      const stage = context.inputs[0]!.payload as StrategyStepStage;
      if (stage.error || stage.alreadySatisfied || stage.selectedStrategy === null) {
        return context.emit(stage);
      }
      const strategy = stage.selectedStrategy;
      const observed: SingleActionSnapshot[] = [];
      const observeForAtomic = async () => {
        const snapshot = readSingleActionSnapshot(await resources.observe());
        observed.push(snapshot);
        return snapshot;
      };
      const selectedRequest = readBrowserStrategyRequest({
        request: stage.request.request,
        history: stage.request.history,
      }).request;
      let atomic: SingleActionEpisodeResult;
      try {
        atomic = await runSelectedBrowserSingleActionEpisode({
          ...selectedRequest,
          contract: "browser.single-action.selected.v1",
          selectedStrategy: selectedStrategy(strategy),
        }, {
          profile: resources.atomicProfile,
          strategyRegistry: resources.registry,
          grantedEffects: resources.grantedEffects,
          observe: observeForAtomic,
          currentControl: () => resources.currentControl(),
          nativeClick: resources.nativeClick,
          collect: async result => {
            await resources.collectAtomic(result);
          },
        });
      } catch (error) {
        return context.emit(stageError({
          ...stage,
          newState: observed.at(-1) ?? stage.newState,
        }, "atomic_workflow_failed", errorText(error)));
      }

      let completionControl: FeedbackInput["controlAtCompletion"] = null;
      try {
        const current = await resources.currentControl();
        completionControl = Object.freeze({
          documentRef: current.documentRef,
          observationId: current.observationId,
          revision: current.revision,
        });
      } catch (error) {
        return context.emit(stageError({
          ...stage,
          atomic,
          newState: atomic.newState ?? observed.at(-1) ?? stage.newState,
        }, "control_unavailable", errorText(error)));
      }

      let feedbackInput: FeedbackInput | null = null;
      let feedbackPrediction: FeedbackPrediction | null = null;
      let proof: StrategyEffectProof | null = null;
      if (observed.length > 0) {
        try {
          feedbackInput = readFeedbackInput({
            request: {
              goal: stage.request.request.goal,
              satisfactionThreshold: stage.request.request.satisfactionThreshold,
              state: observed[0]!,
            },
            result: atomic,
            controlAtCompletion: completionControl,
          });
          feedbackPrediction = predictFeedback(feedbackInput, resources.feedbackProfile);
        } catch (error) {
          return context.emit(stageError({
            ...stage,
            atomic,
            feedbackInput,
            newState: atomic.newState ?? observed.at(-1) ?? stage.newState,
          }, "feedback_contract_invalid", errorText(error)));
        }
        if (atomic.dispatchState === "dispatched" && feedbackInput !== null) {
          try {
            proof = validateEffectProof(
              await resources.proveNoEffect(feedbackInput),
              feedbackInput,
              strategy.targetRef,
            );
          } catch (error) {
            return context.emit(stageError({
              ...stage,
              atomic,
              feedback: feedbackPrediction,
              feedbackInput,
              newState: atomic.newState ?? observed.at(-1) ?? stage.newState,
            }, "effect_proof_invalid", errorText(error)));
          }
        }
      }
      return context.emit(Object.freeze({
        ...stage,
        atomic,
        feedback: feedbackPrediction,
        feedbackInput,
        effectProof: proof,
        newState: atomic.newState ?? observed.at(-1) ?? stage.newState,
      }));
    },
  );

  const report = node(
    "browser.strategy.report",
    RECEIPT_PORT,
    RESULT_PORT,
    ["filesystem.write"],
    async context => {
      const stage = context.inputs[0]!.payload as StrategyStepStage;
      let result = resultOf(stage);
      try {
        await resources.collectStep(result);
      } catch (error) {
        result = Object.freeze({
          ...result,
          collectionError: errorText(error),
        });
      }
      return context.emit(readStepResult(result));
    },
  );

  return Object.freeze([prepare, feedback, select, apply, report]);
}

const configPath = fileURLToPath(
  new URL("../../workflows/browser-strategy-step.workflow.json", import.meta.url),
);
const allowedRoot = fileURLToPath(new URL("../../workflows/", import.meta.url));

export async function runBrowserStrategyStep(
  input: BrowserStrategyRequest,
  resources: StrategyStepResources,
): Promise<StrategyStepResult> {
  const request = readBrowserStrategyRequest(input);
  const definition = await loadWorkflow({ configPath, allowedRoot });
  const compiled = compileWorkflow(definition, {
    nodeDefinitions: createBrowserStrategyStepNodes(resources),
    grantedEffects: [...resources.grantedEffects],
  });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({
    runId,
    eventId: `${runId}:input`,
    port: REQUEST_PORT.name,
    type: "browser.strategy.strategy_request.v1",
    payload: request,
  }));
  if (result.status === "failed") {
    throw Object.assign(new Error(result.error.message, { cause: result.error }), {
      category: result.error.category,
      nodeId: result.error.nodeId,
    });
  }
  return readStepResult(result.outputEvent.payload);
}

export const browserStrategyUnit: TrainableSemanticUnit<
  BrowserStrategyRequest,
  StrategyStepResult,
  StrategyStepResources,
  StrategyTrainingRequest,
  StrategyTrainingReceipt,
  StrategyTrainingResources
> = {
  infer: runBrowserStrategyStep,
  train: runBrowserStrategyTraining,
};

export const browserStrategyStepOperatorNames = [
  "browser.strategy.prepare",
  "browser.strategy.feedback",
  "browser.strategy.select",
  "browser.strategy.apply",
  "browser.strategy.report",
] as const;
