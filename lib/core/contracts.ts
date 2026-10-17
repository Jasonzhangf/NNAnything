import type {
  Awaitable,
  EventCorrelation,
  EventEnvelope,
  EventPort,
  EventStatus,
} from "./events.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface NodeConfigContract<TConfig> {
  readonly required?: boolean;
  readonly validate: (value: unknown) => TConfig;
}

export interface EmitOptions {
  readonly status?: EventStatus;
  readonly correlation?: EventCorrelation;
  readonly type?: string;
}

export interface NodeExecutionContext<TConfig = unknown, TOutput = unknown> {
  readonly runId: string;
  readonly nodeId: string;
  readonly config: TConfig | undefined;
  readonly profile: unknown;
  readonly inputs: readonly EventEnvelope[];
  readonly grantedEffects: ReadonlySet<string>;
  emit(payload: TOutput, options?: EmitOptions): EventEnvelope<TOutput>;
}

export interface NodeDefinition<TConfig = unknown, TOutput = unknown> {
  readonly operator: string;
  readonly version: string;
  readonly inputPorts: readonly EventPort[];
  readonly outputPort: EventPort<TOutput>;
  readonly config?: NodeConfigContract<TConfig>;
  readonly profileValidator?: (value: unknown) => unknown;
  readonly effects?: readonly string[];
  readonly acceptNonOkInputs?: boolean;
  execute(
    context: NodeExecutionContext<TConfig, TOutput>,
  ): Awaitable<EventEnvelope<TOutput>>;
}

export interface GraphArc {
  readonly id: string;
  readonly schema: string;
}

export interface GraphSelector {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface GraphNode {
  readonly id: string;
  readonly operator: string;
  readonly operator_version: string;
  readonly inputs: readonly string[];
  readonly output: GraphArc;
  readonly input_selector: GraphSelector;
  readonly output_selector: GraphSelector;
  readonly iterator: string;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly arc_id: string;
}

export interface WorkflowGraph {
  readonly id: string;
  readonly version: string;
  readonly inputs: readonly GraphArc[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly outputs: readonly string[];
}

export interface WorkflowBindingWithRef {
  readonly configRef: string;
  readonly profileId?: string;
}

export interface WorkflowBindingWithInlineConfig {
  readonly config: JsonValue;
  readonly profileId?: string;
}

export type WorkflowBinding =
  | WorkflowBindingWithRef
  | WorkflowBindingWithInlineConfig;

export interface WorkflowConfig {
  readonly configVersion: 1;
  readonly graphRef: string;
  readonly configs: Readonly<Record<string, JsonValue>>;
  readonly bindings: Readonly<Record<string, WorkflowBinding>>;
}

export interface WorkflowDefinition {
  readonly graph: WorkflowGraph;
  readonly bindings: Readonly<Record<string, WorkflowBinding>>;
}

export interface WorkflowNodeBinding {
  readonly definition: NodeDefinition;
  readonly config: unknown;
  readonly profile: unknown;
}

export interface CompiledWorkflow {
  readonly graph: WorkflowGraph;
  readonly nodeBindings: ReadonlyMap<string, WorkflowNodeBinding>;
  readonly entryArc: GraphArc;
  readonly outputArc: GraphArc;
  readonly grantedEffects: ReadonlySet<string>;
}

export interface CompileWorkflowOptions {
  readonly nodeDefinitions: readonly NodeDefinition[];
  readonly grantedEffects?: readonly string[];
  readonly profiles?: Readonly<Record<string, unknown>>;
}

export interface WorkflowRunFailure {
  readonly category: string;
  readonly message: string;
  readonly nodeId?: string;
}

export interface WorkflowRunCompleted {
  readonly status: "completed";
  readonly runId: string;
  readonly outputEvent: EventEnvelope;
  readonly events: readonly EventEnvelope[];
}

export interface WorkflowRunFailed {
  readonly status: "failed";
  readonly runId: string;
  readonly error: WorkflowRunFailure;
  readonly events: readonly EventEnvelope[];
}

export type WorkflowRunResult = WorkflowRunCompleted | WorkflowRunFailed;
