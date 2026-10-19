import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { CompiledWorkflow } from "./core/contracts.js";
import { createWorkflowInputEvent } from "./core/events.js";
import { compileWorkflow } from "./workflow/compiler.js";
import { loadWorkflow } from "./workflow/loader.js";
import { runWorkflow } from "./workflow/runner.js";
import { createCliObservationNode, readCliResult } from "./nodes/cli-observation.js";
import { validateCliCwd } from "./filters/cli-path.js";
import type { CliEffect, CliRequest, CliResult } from "./adapters/cli/observation.js";

export { interpretCliPath } from "./filters/cli-path.js";
export type { PathRequest, PathObservation } from "./filters/cli-path.js";
export type { CliRequest, CliResult, CliFailure, CliObservation, CliEffect, PwdObservation, FileAttributes } from "./adapters/cli/observation.js";
export { createCliObservationNode } from "./nodes/cli-observation.js";

export interface CliSession {
  readonly cwd: string;
  observe(request: CliRequest): Promise<CliResult>;
}

/** cwd is an explicit resolution base, not an authorization root or OS sandbox. */
export function createCliSession(options: { readonly cwd: string; readonly grantedEffects: readonly CliEffect[] }): CliSession {
  if (typeof options !== "object" || options === null || Object.keys(options).some(key => !["cwd", "grantedEffects"].includes(key))) throw new TypeError("CLI session needs cwd and grantedEffects only");
  const cwd = validateCliCwd(options.cwd);
  if (!Array.isArray(options.grantedEffects) || options.grantedEffects.some(effect => effect !== "filesystem.read" && effect !== "process.exec")) throw new TypeError("Unknown CLI effect grant");
  const grants = [...new Set(options.grantedEffects)];
  let compiled: Promise<CompiledWorkflow> | undefined;
  const getCompiled = () => compiled ??= loadWorkflow({
    configPath: fileURLToPath(new URL("../workflows/cli-foundation.workflow.json", import.meta.url)),
    allowedRoot: fileURLToPath(new URL("../workflows/", import.meta.url)),
  }).then(definition => compileWorkflow(definition, { nodeDefinitions: [createCliObservationNode({ cwd })], grantedEffects: grants }));
  return Object.freeze({
    cwd,
    async observe(request: CliRequest): Promise<CliResult> {
      const raw = request as unknown;
      const operation = typeof raw === "object" && raw !== null && "kind" in raw && typeof raw.kind === "string" && raw.kind.length > 0 ? raw.kind : "invalid";
      const runId = randomUUID();
      const result = await runWorkflow(await getCompiled(), createWorkflowInputEvent({
        runId, eventId: `${runId}:input`, port: "cli_request", type: "cli.request.v1", payload: request,
      }));
      if (result.status === "failed") return {
        ok: false,
        error: {
          operation, stage: result.error.category === "invalid_input_event" ? "validate" : "observe",
          code: result.error.category === "invalid_input_event" ? "EINVAL" : result.error.category,
          message: result.error.message,
        },
      };
      return readCliResult(result.outputEvent.payload);
    },
  });
}
