import type { NodeDefinition } from "../core/contracts.js";
import { expectFiniteNumber, expectNonEmptyString, expectRecord } from "../core/schema.js";
import {
  observeCliRequest, readCliRequest,
  type CliEffect, type CliResult,
} from "../adapters/cli/observation.js";
import { validateCliCwd } from "../filters/cli-path.js";

export function readCliResult(value: unknown): CliResult {
  const result = expectRecord(value, "CLI result");
  if (result.ok === false) {
    const error = expectRecord(result.error, "CLI error");
    expectNonEmptyString(error.operation, "error.operation");
    expectNonEmptyString(error.code, "error.code");
    expectNonEmptyString(error.message, "error.message");
    if (!["validate", "authorize", "observe"].includes(String(error.stage))) throw new TypeError("Invalid CLI error stage");
  } else if (result.ok === true) {
    const observation = expectRecord(result.observation, "CLI observation");
    switch (observation.kind) {
      case "path":
        for (const key of ["input", "normalized", "absolute", "parent"]) expectNonEmptyString(observation[key], key);
        if (!["absolute", "relative"].includes(String(observation.inputForm))) throw new TypeError("Invalid path form");
        break;
      case "pwd":
        expectNonEmptyString(observation.configuredCwd, "configuredCwd");
        expectNonEmptyString(observation.physicalCwd, "physicalCwd");
        if (observation.executable !== "/bin/pwd" || !Array.isArray(observation.argv) || observation.argv.length !== 1 || observation.argv[0] !== "-P" || observation.exitCode !== 0) throw new TypeError("Invalid pwd evidence");
        if (typeof observation.stdout !== "string" || typeof observation.stderr !== "string") throw new TypeError("Invalid pwd output");
        break;
      case "attributes":
        expectNonEmptyString(observation.absolutePath, "absolutePath");
        if (!["stat", "lstat"].includes(String(observation.observedWith))) throw new TypeError("Invalid attribute source");
        if (!["file", "directory", "symlink", "other"].includes(String(observation.type))) throw new TypeError("Invalid file type");
        for (const key of ["sizeBytes", "mode", "uid", "gid", "atimeMs", "mtimeMs", "ctimeMs"]) expectFiniteNumber(observation[key], key);
        if (observation.birthtimeMs !== null) expectFiniteNumber(observation.birthtimeMs, "birthtimeMs");
        if (observation.linkTarget !== undefined) expectNonEmptyString(observation.linkTarget, "linkTarget");
        break;
      case "read":
        expectNonEmptyString(observation.absolutePath, "absolutePath");
        for (const key of ["offset", "length", "size", "bytesRead"]) expectFiniteNumber(observation[key], key);
        if (typeof observation.bytes !== "string") throw new TypeError("Invalid read bytes");
        if (typeof observation.eof !== "boolean") throw new TypeError("Invalid read eof");
        if (observation.observedRange === null || typeof observation.observedRange !== "object") throw new TypeError("Invalid read observedRange");
        const observedRange = expectRecord(observation.observedRange, "observedRange");
        expectFiniteNumber(observedRange.offset, "observedRange.offset");
        expectFiniteNumber(observedRange.length, "observedRange.length");
        break;
      default: throw new TypeError("Unsupported CLI observation");
    }
  } else throw new TypeError("CLI result must have a boolean ok");
  return value as CliResult;
}

/** Request-specific effects let pure path requests run without IO authority. */
export function createCliObservationNode({ cwd }: { cwd: string }): NodeDefinition {
  const configuredCwd = validateCliCwd(cwd);
  return {
    operator: "cli.observe", version: "0.1.0.0001",
    inputPorts: [{ name: "cli_request", schemaId: "cli/request/v1", eventType: "cli.request.v1", validate: readCliRequest }],
    outputPort: { name: "cli_observation", schemaId: "cli/result/v1", eventType: "cli.result.v1", validate: readCliResult },
    effects: [],
    async execute(context) {
      const grants = new Set<CliEffect>();
      for (const effect of ["filesystem.read", "process.exec"] as const) if (context.grantedEffects.has(effect)) grants.add(effect);
      return context.emit(await observeCliRequest(configuredCwd, context.inputs[0]!.payload, grants));
    },
  };
}
