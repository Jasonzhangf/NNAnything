import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { NodeDefinition } from "../core/contracts.js";
import { createWorkflowInputEvent } from "../core/events.js";
import { expectRecord } from "../core/schema.js";
import type { BrowserReceiptInferenceResult, BrowserReceiptInput, BrowserReceiptProfile } from "../adapters/browser/receipt-contract.js";
import { predictBrowserReceipt, readBrowserReceiptInput, validateBrowserReceiptProfile } from "../filters/browser-receipt.js";
import { loadBrowserReceiptProfile } from "../training/browser-receipt-profile.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { loadWorkflow } from "../workflow/loader.js";
import { runWorkflow } from "../workflow/runner.js";

const port = (name: string) => ({ name, schemaId: `browser.receipt/${name}/v1`, eventType: `browser.receipt.${name}.v1`, validate: (value: unknown) => expectRecord(value, name) });

export function createBrowserReceiptInferenceNodes(resources: { readonly profile: BrowserReceiptProfile }): readonly NodeDefinition[] {
  const profile = validateBrowserReceiptProfile(resources.profile);
  return [{ operator: "browser.receipt.infer", version: "0.1.0.0000", inputPorts: [port("receipt_request")], outputPort: port("receipt_result"), effects: [],
    execute: context => {
      const input = readBrowserReceiptInput(context.inputs[0]!.payload);
      return context.emit({ input, prediction: predictBrowserReceipt(input, profile), satisfaction: null } satisfies BrowserReceiptInferenceResult);
    } }];
}

export async function runBrowserReceiptInference(input: BrowserReceiptInput, resources: { readonly profilePath: string }): Promise<BrowserReceiptInferenceResult> {
  const profile = await loadBrowserReceiptProfile(resources.profilePath);
  const definition = await loadWorkflow({ configPath: fileURLToPath(new URL("../../workflows/browser-receipt.workflow.json", import.meta.url)), allowedRoot: fileURLToPath(new URL("../../workflows/", import.meta.url)) });
  const compiled = compileWorkflow(definition, { nodeDefinitions: createBrowserReceiptInferenceNodes({ profile }), grantedEffects: [] });
  const runId = randomUUID();
  const result = await runWorkflow(compiled, createWorkflowInputEvent({ runId, eventId: `${runId}:input`, port: "receipt_request", type: "browser.receipt.receipt_request.v1", payload: readBrowserReceiptInput(input) }));
  if (result.status === "failed") throw new Error(result.error.message, { cause: result.error });
  return result.outputEvent.payload as BrowserReceiptInferenceResult;
}