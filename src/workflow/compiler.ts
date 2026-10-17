import type { CompileWorkflowOptions, CompiledWorkflow, GraphArc, NodeDefinition, WorkflowDefinition, WorkflowNodeBinding } from "../core/contracts.js";
import { WorkflowContractError, type WorkflowErrorCode } from "../core/errors.js";
import { expectRecord } from "../core/schema.js";
import { assertGraphShape } from "./graph.js";

export function compileWorkflow(definition: WorkflowDefinition, options: CompileWorkflowOptions): CompiledWorkflow {
  const graph = assertGraphShape(definition.graph, "COMPILE_INVALID_GRAPH");
  const fail = (code: WorkflowErrorCode, message: string, nodeId?: string): never => { throw new WorkflowContractError(code, message, nodeId); };
  if (graph.inputs.length !== 1 || graph.outputs.length !== 1 || !graph.nodes.length) fail("COMPILE_INVALID_GRAPH", "Expected one entry ARC, one exit ARC and at least one node");
  const entryArc = graph.inputs[0]!;
  const arcs = new Map<string, { arc: GraphArc; producer?: string }>([[entryArc.id, { arc: entryArc }]]);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length) fail("COMPILE_DUPLICATE_NODE", "Duplicate node id");
  for (const node of graph.nodes) {
    if (arcs.has(node.output.id)) fail("COMPILE_DUPLICATE_ARC", `Duplicate ARC ${node.output.id}`, node.id);
    arcs.set(node.output.id, { arc: node.output, producer: node.id });
    if (!node.inputs.length || new Set(node.inputs).size !== node.inputs.length) fail("COMPILE_INVALID_GRAPH", "Node needs unique input ARCs", node.id);
    if (node.iterator !== "Whole") fail("COMPILE_UNSUPPORTED_ITERATOR", `Unsupported iterator ${node.iterator}`, node.id);
    if ([node.input_selector, node.output_selector].some(selector => selector.include.length || selector.exclude.length)) fail("COMPILE_UNSUPPORTED_SELECTOR", "Only empty selectors are supported", node.id);
  }
  const exit = arcs.get(graph.outputs[0]!);
  if (!exit?.producer) fail("COMPILE_INVALID_GRAPH", "Exit must be a node output");
  const expectedEdges = new Set<string>();
  const edgeKey = (from: string, to: string, arc: string) => JSON.stringify([from, to, arc]);
  for (const node of graph.nodes) for (const input of node.inputs) {
    const arc = arcs.get(input);
    if (!arc) fail("COMPILE_INVALID_GRAPH", `Unbound ARC ${input}`, node.id);
    if (arc!.producer) expectedEdges.add(edgeKey(arc!.producer!, node.id, input));
  }
  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    const key = edgeKey(edge.from, edge.to, edge.arc_id);
    if (!expectedEdges.has(key) || seenEdges.has(key)) fail("COMPILE_INVALID_GRAPH", `Invalid or duplicate edge ${key}`);
    seenEdges.add(key);
  }
  if (seenEdges.size !== expectedEdges.size) fail("COMPILE_INVALID_GRAPH", "Edges do not match node inputs");
  // Validation only; execution scheduling belongs exclusively to Flowed.
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail("COMPILE_INVALID_GRAPH", `Cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const input of nodes.get(id)!.inputs) {
      const producer = arcs.get(input)!.producer;
      if (producer) visit(producer);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const node of graph.nodes) visit(node.id);
  visited.clear(); visit(exit!.producer!);
  if (visited.size !== nodes.size) fail("COMPILE_INVALID_GRAPH", "Dead nodes do not reach the exit");
  if (graph.nodes.some(node => node.inputs.includes(exit!.arc.id))) fail("COMPILE_INVALID_GRAPH", "Exit ARC must be terminal");

  const definitions = new Map<string, NodeDefinition>();
  for (const node of options.nodeDefinitions) {
    const key = JSON.stringify([node.operator, node.version]);
    if (definitions.has(key)) fail("COMPILE_BINDING", `Duplicate operator binding ${key}`);
    definitions.set(key, node);
  }
  const bindings = expectRecord(definition.bindings, "bindings");
  for (const id of Object.keys(bindings)) if (!nodes.has(id)) fail("COMPILE_BINDING", `Unknown binding node ${id}`);
  const grantedEffects = new Set(options.grantedEffects ?? []);
  const nodeBindings = new Map<string, WorkflowNodeBinding>();
  for (const node of graph.nodes) {
    const operator = definitions.get(JSON.stringify([node.operator, node.operator_version]));
    if (!operator) fail("COMPILE_UNKNOWN_OPERATOR", `Unknown operator ${node.operator}@${node.operator_version}`, node.id);
    const op = operator!;
    if (op.inputPorts.length !== node.inputs.length) fail("COMPILE_PORT_MISMATCH", "Input port count differs", node.id);
    let config: unknown;
    let profile: unknown;
    try {
      const binding = Object.hasOwn(bindings, node.id) ? expectRecord(bindings[node.id], `binding ${node.id}`) : undefined;
      if (binding) {
        if (Object.keys(binding).some(key => !["config", "profileId"].includes(key)) || !Object.hasOwn(binding, "config")) throw new Error("Expected inline config and optional profileId; unresolved references and effects are forbidden");
        if (!op.config) throw new Error("Operator does not declare config");
        config = op.config.validate(binding.config);
        if (Object.hasOwn(binding, "profileId")) {
          const id = binding.profileId;
          if (typeof id !== "string" || !options.profiles || !Object.hasOwn(options.profiles, id)) throw new Error(`Missing profile ${String(id)}`);
          if (!op.profileValidator) throw new Error("Operator does not accept profiles");
          profile = op.profileValidator(options.profiles[id]);
        }
      } else if (op.config?.required) throw new Error("Missing required config");
    } catch (error) { fail("COMPILE_BINDING", error instanceof Error ? error.message : String(error), node.id); }
    for (const effect of op.effects ?? []) if (!grantedEffects.has(effect)) fail("COMPILE_EFFECT_UNAUTHORIZED", `Unauthorized effect ${effect}`, node.id);
    nodeBindings.set(node.id, { definition: op, config, profile });
  }
  let entryPort: NodeDefinition["outputPort"] | undefined;
  for (const node of graph.nodes) node.inputs.forEach((input, index) => {
    const target = nodeBindings.get(node.id)!.definition.inputPorts[index]!;
    const producer = arcs.get(input)!.producer;
    const source = producer ? nodeBindings.get(producer)!.definition.outputPort : entryPort;
    if (source && (source.schemaId !== target.schemaId || source.eventType !== target.eventType)) fail("COMPILE_PORT_MISMATCH", `Incompatible port at ARC ${input}`, node.id);
    if (!producer) entryPort = target;
  });
  return { graph, nodeBindings, entryArc, outputArc: exit!.arc, grantedEffects };
}
