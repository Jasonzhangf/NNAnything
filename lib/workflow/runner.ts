import { FlowManager } from "flowed";
import type { FlowSpec, TaskResolverMap } from "flowed";
import type { CompiledWorkflow, EmitOptions, WorkflowRunFailure, WorkflowRunResult } from "../core/contracts.js";
import type { EventEnvelope, EventPort } from "../core/events.js";
import { createEventEnvelope, WORKFLOW_INPUT_NODE_ID } from "../core/events.js";
import { WorkflowRunError } from "../core/errors.js";
import { expectNonEmptyString, expectRecord } from "../core/schema.js";

// Failures remain internal dependency results, never successful business events.
// Flowed drains the finite graph while dependent nodes avoid executing effects.
type ArcResult = { event: EventEnvelope } | { failure: WorkflowRunFailure };
// Flowed JSON-stringifies every task result for its audit log. Large payloads
// must never cross that boundary as task results, so only a tiny reference is
// passed through the engine and the real ArcResult stays local to this run.
type FlowRef = { flowRef: string };

function validateEvent(raw: unknown, port: EventPort, runId: string, producer: string, producerPort: string): EventEnvelope {
  const event = expectRecord(raw, "event");
  expectNonEmptyString(event.runId, "event.runId");
  expectNonEmptyString(event.eventId, "event.eventId");
  const source = expectRecord(event.producer, "event.producer");
  if (event.runId !== runId || source.nodeId !== producer || source.port !== producerPort || event.type !== port.eventType) throw new Error("Event runId, producer or type differs from its declared port");
  const correlation = expectRecord(event.correlation, "event.correlation");
  for (const key of ["itemKey", "nodeRef"]) if (correlation[key] !== undefined) expectNonEmptyString(correlation[key], `correlation.${key}`);
  if (correlation.index !== undefined && (!Number.isInteger(correlation.index) || (correlation.index as number) < 0)) throw new Error("Invalid correlation.index");
  if (!["ok", "skipped", "filtered_out", "unknown"].includes(String(event.status))) throw new Error("Invalid event status");
  if (event.status === "ok") port.validate(event.payload);
  else expectNonEmptyString(expectRecord(event.payload, "non-ok payload").reason, "non-ok reason");
  return raw as EventEnvelope;
}

export async function runWorkflow(compiled: CompiledWorkflow, inputEvent: EventEnvelope): Promise<WorkflowRunResult> {
  const events: EventEnvelope[] = [];
  const runId = inputEvent?.runId;
  const arcValues = new Map<string, ArcResult>();
  let nextRef = 0;
  const storeArc = (value: ArcResult): FlowRef => {
    const flowRef = `arc-result-${nextRef++}`;
    arcValues.set(flowRef, value);
    return { flowRef };
  };
  const resolveArc = (value: FlowRef): ArcResult => {
    const resolved = arcValues.get(value.flowRef);
    if (!resolved) throw new Error(`Missing flow ref ${value.flowRef}`);
    return resolved;
  };
  const failed = (failure: WorkflowRunFailure): WorkflowRunResult => ({ status: "failed", runId, error: failure, events });
  try {
    for (const node of compiled.graph.nodes) node.inputs.forEach((arc, index) => {
      if (arc === compiled.entryArc.id) validateEvent(inputEvent, compiled.nodeBindings.get(node.id)!.definition.inputPorts[index]!, runId, WORKFLOW_INPUT_NODE_ID, compiled.entryArc.id);
    });
  } catch (error) { return failed({ category: "invalid_input_event", message: error instanceof Error ? error.message : String(error) }); }

  const arcKeys = new Map([compiled.entryArc, ...compiled.graph.nodes.map(node => node.output)].map((arc, index) => [arc.id, `arc${index}`]));
  const tasks: NonNullable<FlowSpec["tasks"]> = {};
  const resolvers: TaskResolverMap = {};
  const eventIds = new Set([inputEvent.eventId]);
  compiled.graph.nodes.forEach((node, index) => {
    const key = `node${index}`;
    const outputKey = arcKeys.get(node.output.id)!;
    const requires = node.inputs.map(arc => arcKeys.get(arc)!);
    const binding = compiled.nodeBindings.get(node.id)!;
    const op = binding.definition;
    tasks[key] = { requires, provides: [outputKey], resolver: { name: key } };
    resolvers[key] = async params => {
      const values = requires.map(input => resolveArc(params[input] as FlowRef));
      const upstreamFailure = values.find((value): value is { failure: WorkflowRunFailure } => "failure" in value);
      if (upstreamFailure) return { [outputKey]: storeArc(upstreamFailure) };
      const inputs = values.map(value => (value as { event: EventEnvelope }).event);
      try {
        for (const effect of op.effects ?? []) if (!compiled.grantedEffects.has(effect)) throw new WorkflowRunError("unauthorized_effect", `Unauthorized effect ${effect}`, node.id);
        inputs.forEach((event, i) => {
          if (event.correlation.itemKey !== inputs[0]!.correlation.itemKey) throw new Error("Input itemKey differs across ports");
          if (event.status === "ok") op.inputPorts[i]!.validate(event.payload);
        });
        let emission = 0;
        const emit = (payload: unknown, options: EmitOptions = {}) => createEventEnvelope({
          runId, eventId: `${runId}:${key}:${++emission}`, producer: { nodeId: node.id, port: op.outputPort.name },
          type: options.type ?? op.outputPort.eventType, status: options.status ?? "ok", correlation: options.correlation ?? inputs[0]!.correlation, payload,
        });
        let raw: unknown;
        if (!op.acceptNonOkInputs && inputs.some(event => event.status !== "ok")) raw = emit({ reason: "upstream_not_ok" }, { status: "skipped" });
        else {
          try { raw = await op.execute({ runId, nodeId: node.id, inputs, config: binding.config, profile: binding.profile, grantedEffects: new Set(compiled.grantedEffects), emit }); }
          catch (error) { throw new WorkflowRunError("node_execution_failed", error instanceof Error ? error.message : String(error), node.id, { cause: error }); }
        }
        let event: EventEnvelope;
        try {
          event = validateEvent(raw, op.outputPort, runId, node.id, op.outputPort.name);
          if (event.correlation.itemKey !== inputs[0]!.correlation.itemKey) throw new Error("Output itemKey differs from input");
          if (eventIds.has(event.eventId)) throw new Error("Reused eventId");
        } catch (error) { throw new WorkflowRunError("invalid_node_event", error instanceof Error ? error.message : String(error), node.id); }
        eventIds.add(event.eventId); events.push(event);
        return { [outputKey]: storeArc({ event }) };
      } catch (error) {
        return { [outputKey]: storeArc({ failure: { category: error instanceof WorkflowRunError ? error.category : "invalid_node_input", message: error instanceof Error ? error.message : String(error), nodeId: node.id } }) };
      }
    };
  });
  try {
    const outputKey = arcKeys.get(compiled.outputArc.id)!;
    const results = await FlowManager.run({ tasks, options: { resolverAutomapParams: true, resolverAutomapResults: true, throwErrorOnUnsolvableResult: true } }, { [arcKeys.get(compiled.entryArc.id)!]: storeArc({ event: inputEvent }) }, [outputKey], resolvers);
    const output = resolveArc(results[outputKey] as FlowRef);
    if ("failure" in output) return failed(output.failure);
    return { status: "completed", runId, outputEvent: output.event, events };
  } catch (error) { return failed({ category: "flow_execution_failed", message: error instanceof Error ? error.message : String(error) }); }
}
