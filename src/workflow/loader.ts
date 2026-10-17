import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { WorkflowBinding, WorkflowDefinition, JsonValue } from "../core/contracts.js";
import { WorkflowContractError } from "../core/errors.js";
import { expectRecord, expectNonEmptyString } from "../core/schema.js";
import { assertGraphShape } from "./graph.js";

export async function loadWorkflow({ configPath, allowedRoot }: { configPath: string; allowedRoot: string }): Promise<WorkflowDefinition> {
  const lexicalRoot = resolve(allowedRoot);
  const root = await realpath(lexicalRoot);
  const check = (base: string, path: string): void => {
    const rel = relative(base, path);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new WorkflowContractError("LOAD_PATH_OUTSIDE_ROOT", `Path outside allowedRoot: ${path}`);
  };
  const local = async (path: string): Promise<string> => { check(lexicalRoot, resolve(path)); const actual = await realpath(path); check(root, actual); return actual; };
  try {
    const path = await local(resolve(configPath));
    const config = expectRecord(JSON.parse(await readFile(path, "utf8")), "WorkflowConfig");
    if (config.configVersion !== 1) throw new WorkflowContractError("LOAD_UNKNOWN_VERSION", `Unknown configVersion ${String(config.configVersion)}`);
    if (Object.keys(config).some(key => !["configVersion", "graphRef", "configs", "bindings"].includes(key))) throw new Error("Unsupported WorkflowConfig field");
    const ref = expectNonEmptyString(config.graphRef, "graphRef");
    if (isAbsolute(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref) || !ref.endsWith(".graph.json")) throw new WorkflowContractError("LOAD_REMOTE_OR_SCRIPT_GRAPH", "graphRef must be a relative local .graph.json path");
    const graphPath = await local(resolve(dirname(resolve(configPath)), ref));
    const graph = assertGraphShape(JSON.parse(await readFile(graphPath, "utf8")), "LOAD_INVALID_GRAPH");
    const configs = expectRecord(config.configs, "configs");
    const rawBindings = expectRecord(config.bindings, "bindings");
    const bindings: Record<string, WorkflowBinding> = Object.create(null);
    for (const [id, raw] of Object.entries(rawBindings)) {
      if (!graph.nodes.some(node => node.id === id)) throw new WorkflowContractError("LOAD_BAD_REFERENCE", `Unknown node ${id}`);
      const binding = expectRecord(raw, `binding ${id}`);
      if (Object.keys(binding).some(key => !["config", "configRef", "profileId"].includes(key)) || Object.hasOwn(binding, "config") === Object.hasOwn(binding, "configRef")) throw new Error(`Invalid binding ${id}: use exactly one config or configRef`);
      let value = binding.config;
      if (Object.hasOwn(binding, "configRef")) {
        const name = expectNonEmptyString(binding.configRef, "configRef");
        if (!Object.hasOwn(configs, name)) throw new WorkflowContractError("LOAD_BAD_REFERENCE", `Missing configRef ${name}`);
        value = configs[name];
      }
      bindings[id] = { config: value as JsonValue, ...(Object.hasOwn(binding, "profileId") ? { profileId: expectNonEmptyString(binding.profileId, "profileId") } : {}) };
    }
    return { graph, bindings };
  } catch (error) {
    if (error instanceof WorkflowContractError) throw error;
    throw new WorkflowContractError("LOAD_INVALID_CONFIG", error instanceof Error ? error.message : String(error));
  }
}
