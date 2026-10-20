import type {
  AdapterDiagnostic,
  EffectKnowledge,
  ErrorCause,
  ErrorOrigin,
  ErrorPropagation,
  RecursiveGoalErrorCode,
  RecursiveGoalErrorDiagnostic,
  RecursiveGoalErrorStage,
  RelatedIssue,
} from "./contracts.js";
import type { WorkflowRunFailure } from "../../core/contracts.js";

export interface DiagnosticSpec {
  readonly code: RecursiveGoalErrorCode;
  readonly stage: RecursiveGoalErrorStage;
  readonly message: string;
  readonly origin?: Partial<ErrorOrigin>;
  readonly owner?: "module" | "adapter" | "workflow";
  readonly category?: string | null;
  readonly nativeCode?: string | null;
  readonly refs?: readonly string[];
  readonly effectKnowledge?: EffectKnowledge;
  readonly atomicResultRefs?: readonly string[];
  readonly cause?: ErrorCause | null;
  readonly errorId?: string;
}

export class ModuleInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleInvariantError";
  }
}

export class RecursiveGoalDiagnosticFactory {
  readonly requestId: string | null;
  private sequence = 0;
  private readonly usedIds = new Set<string>();

  constructor(requestId: string | null) {
    this.requestId = requestId;
  }

  reserveIds(ids: readonly string[]): void {
    for (const id of ids) this.usedIds.add(nonEmptyMessage(id));
  }

  create(spec: DiagnosticSpec): RecursiveGoalErrorDiagnostic {
    const errorId = this.uniqueId(
      spec.errorId ?? `${this.requestId ?? "recursive-goal"}:error:${++this.sequence}`,
    );
    return {
      errorId,
      code: spec.code,
      stage: spec.stage,
      origin: {
        frameId: spec.origin?.frameId ?? null,
        skillId: spec.origin?.skillId ?? null,
        conditionId: spec.origin?.conditionId ?? null,
        evaluatorId: spec.origin?.evaluatorId ?? null,
        nodeId: spec.origin?.nodeId ?? null,
      },
      source: {
        owner: spec.owner ?? "module",
        category: spec.category ?? null,
        nativeCode: spec.nativeCode ?? null,
        refs: [...(spec.refs ?? [])],
      },
      effectKnowledge: spec.effectKnowledge ?? "none",
      atomicResultRefs: [...(spec.atomicResultRefs ?? [])],
      cause: spec.cause ?? null,
      propagation: [],
      diagnosticMessage: nonEmptyMessage(spec.message),
    };
  }

  fromAdapter(
    diagnostic: AdapterDiagnostic,
    origin: Partial<ErrorOrigin>,
    effectKnowledge: EffectKnowledge,
    atomicResultRefs: readonly string[],
  ): RecursiveGoalErrorDiagnostic {
    return this.create({
      errorId: diagnostic.diagnosticId,
      code: diagnostic.code,
      stage: diagnostic.stage,
      message: diagnostic.message,
      origin,
      owner: "adapter",
      category: diagnostic.sourceCategory,
      nativeCode: diagnostic.nativeCode,
      refs: diagnostic.refs,
      effectKnowledge,
      atomicResultRefs,
    });
  }

  fromWorkflow(
    failure: Pick<WorkflowRunFailure, "category" | "message" | "nodeId">,
    refs: readonly string[] = [],
  ): RecursiveGoalErrorDiagnostic {
    return this.create({
      code: "workflow_failure",
      stage: "finalization",
      message: failure.message,
      owner: "workflow",
      category: failure.category,
      refs,
      origin: failure.nodeId === undefined ? {} : { nodeId: failure.nodeId },
    });
  }

  withPropagation(
    diagnostic: RecursiveGoalErrorDiagnostic,
    propagation: readonly ErrorPropagation[],
  ): RecursiveGoalErrorDiagnostic {
    return {
      ...diagnostic,
      propagation: [...propagation],
    };
  }

  capturedCause(error: unknown): ErrorCause {
    if (error instanceof Error) {
      return {
        kind: "captured_error",
        name: nonEmptyMessage(error.name),
        message: nonEmptyMessage(error.message),
        nativeCode: null,
      };
    }
    return {
      kind: "captured_error",
      name: "ThrownValue",
      message: nonEmptyMessage(String(error)),
      nativeCode: null,
    };
  }

  related(errorId: string, relation: RelatedIssue["relation"], affectsCompletion = false): RelatedIssue {
    return { errorId, relation, affectsCompletion };
  }

  private uniqueId(preferred: string): string {
    const base = nonEmptyMessage(preferred);
    if (!this.usedIds.has(base)) {
      this.usedIds.add(base);
      return base;
    }
    let suffix = 2;
    while (this.usedIds.has(`${base}:${suffix}`)) suffix += 1;
    const id = `${base}:${suffix}`;
    this.usedIds.add(id);
    return id;
  }
}

function nonEmptyMessage(value: string): string {
  return value.length > 0 ? value : "unspecified recursive goal failure";
}
