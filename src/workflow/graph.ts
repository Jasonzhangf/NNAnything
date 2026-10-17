import type { GraphArc, GraphEdge, GraphNode, GraphSelector, WorkflowGraph } from "../core/contracts.js";
import { WorkflowContractError, type WorkflowErrorCode } from "../core/errors.js";
import {
  expectArray,
  expectNonEmptyString,
  expectRecord,
  expectString,
  expectStringArray,
} from "../core/schema.js";

function contractError(code: WorkflowErrorCode, message: string): WorkflowContractError {
  return new WorkflowContractError(code, message);
}

function asArc(value: unknown, label: string, code: WorkflowErrorCode): GraphArc {
  const record = expectRecord(value, label);
  return {
    id: expectNonEmptyString(record.id, `${label}.id`),
    schema: expectString(record.schema, `${label}.schema`),
  };
}

function asSelector(value: unknown, label: string, code: WorkflowErrorCode): GraphSelector {
  const record = expectRecord(value, label);
  return {
    include: expectStringArray(record.include, `${label}.include`),
    exclude: expectStringArray(record.exclude, `${label}.exclude`),
  };
}

function asNode(value: unknown, label: string, code: WorkflowErrorCode): GraphNode {
  const record = expectRecord(value, label);
  const output = record.output;
  return {
    id: expectNonEmptyString(record.id, `${label}.id`),
    operator: expectNonEmptyString(record.operator, `${label}.operator`),
    operator_version: expectNonEmptyString(record.operator_version, `${label}.operator_version`),
    inputs: expectStringArray(record.inputs, `${label}.inputs`),
    output: asArc(output, `${label}.output`, code),
    input_selector: asSelector(record.input_selector, `${label}.input_selector`, code),
    output_selector: asSelector(record.output_selector, `${label}.output_selector`, code),
    iterator: expectNonEmptyString(record.iterator, `${label}.iterator`),
  };
}

function asEdge(value: unknown, label: string, code: WorkflowErrorCode): GraphEdge {
  const record = expectRecord(value, label);
  return {
    from: expectNonEmptyString(record.from, `${label}.from`),
    to: expectNonEmptyString(record.to, `${label}.to`),
    arc_id: expectNonEmptyString(record.arc_id, `${label}.arc_id`),
  };
}

/**
 * Parse an untrusted graph object into the typed WorkflowGraph shape.
 * Structural problems raise a WorkflowContractError so callers can map the
 * failure to the load or compile boundary.
 */
export function assertGraphShape(raw: unknown, code: WorkflowErrorCode): WorkflowGraph {
  try {
    const record = expectRecord(raw, "graph");
    return {
      id: expectNonEmptyString(record.id, "graph.id"),
      version: expectNonEmptyString(record.version, "graph.version"),
      inputs: expectArray(record.inputs, "graph.inputs").map((value, index) =>
        asArc(value, `graph.inputs[${index}]`, code),
      ),
      nodes: expectArray(record.nodes, "graph.nodes").map((value, index) =>
        asNode(value, `graph.nodes[${index}]`, code),
      ),
      edges: expectArray(record.edges, "graph.edges").map((value, index) =>
        asEdge(value, `graph.edges[${index}]`, code),
      ),
      outputs: expectStringArray(record.outputs, "graph.outputs"),
    };
  } catch (error) {
    if (error instanceof WorkflowContractError) throw error;
    throw contractError(code, error instanceof Error ? error.message : String(error));
  }
}
