import type { NodeDefinition } from "../core/contracts.js";
import { expectArray, expectFiniteNumber, expectRecord } from "../core/schema.js";

export const JSON_EVENT_TYPE = "common.json.v1";
export const NUMBERS_EVENT_TYPE = "common.numbers.v1";
export const COLLECTION_EVENT_TYPE = "common.collection.v1";
const numbers = (value: unknown) => ({ values: expectArray(expectRecord(value, "numbers").values, "values").map((n, i) => expectFiniteNumber(n, `values[${i}]`)) });
const numberPort = (name: string) => ({ name, schemaId: "common/numbers/v1", eventType: NUMBERS_EVENT_TYPE, validate: numbers });
export const commonScaleNode: NodeDefinition = {
  operator: "common.scale", version: "1", inputPorts: [numberPort("in")], outputPort: numberPort("out"),
  config: { required: true, validate: value => ({ factor: expectFiniteNumber(expectRecord(value, "scale config").factor, "factor") }) },
  execute: context => {
    const { factor } = context.config as { factor: number };
    return context.emit({ values: numbers(context.inputs[0]!.payload).values.map(n => expectFiniteNumber(n * factor, "scaled value")) });
  },
};
export const commonSumNode: NodeDefinition = {
  operator: "common.sum", version: "1", inputPorts: [numberPort("in")],
  outputPort: { name: "out", schemaId: "common/total/v1", eventType: "common.total.v1", validate: value => ({ total: expectFiniteNumber(expectRecord(value, "total").total, "total") }) },
  execute: context => context.emit({ total: expectFiniteNumber(numbers(context.inputs[0]!.payload).values.reduce((sum, n) => sum + n, 0), "total") }),
};
export const commonCountNode: NodeDefinition = {
  operator: "common.count", version: "1",
  inputPorts: [{ name: "in", schemaId: "common/json/v1", eventType: JSON_EVENT_TYPE, validate: value => value }],
  outputPort: { name: "out", schemaId: "common/count/v1", eventType: "common.count.v1", validate: value => ({ count: expectFiniteNumber(expectRecord(value, "count").count, "count") }) },
  execute: context => {
    const payload = context.inputs[0]!.payload;
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { items?: unknown }).items)) return context.emit({ reason: "invalid_payload" }, { status: "unknown" });
    return context.emit({ count: (payload as { items: unknown[] }).items.length });
  },
};
export const commonNodeDefinitions: readonly NodeDefinition[] = [commonScaleNode, commonSumNode, commonCountNode];
