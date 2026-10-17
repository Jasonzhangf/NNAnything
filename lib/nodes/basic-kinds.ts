import type { NodeDefinition } from "../core/contracts.js";
import { classifyBasicKindBatch, validateBasicKindConfig, validateBasicKindProfile, validateBasicKindRequest, type BasicKindConfig, type BasicKindProfile } from "../filters/basic-kinds.js";

export const domBasicKindsNode: NodeDefinition = {
  operator: "dom.basic_kinds", version: "0.1.0",
  inputPorts: [{ name: "input", schemaId: "dom/candidate-batch/v1", eventType: "dom.candidate-slots.v1", validate: value => { validateBasicKindRequest(value); return value; } }],
  outputPort: { name: "output", schemaId: "dom/basic-kind-batch/v1", eventType: "dom.basic-kind-slots.v1", validate: value => value },
  config: { required: true, validate: validateBasicKindConfig },
  profileValidator: validateBasicKindProfile,
  effects: [],
  execute: context => context.emit(classifyBasicKindBatch(context.inputs[0]!.payload, context.config as BasicKindConfig, context.profile as BasicKindProfile | undefined)),
};
