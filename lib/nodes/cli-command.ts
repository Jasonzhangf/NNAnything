import { resolve } from "node:path";
import type { NodeDefinition } from "../core/contracts.js";
import { expectRecord } from "../core/schema.js";
import type { CliFilesystemSandbox, SessionRef, DirectoryRef, SemanticCallReceipt, SessionSnapshot, SemanticCliCall } from "../adapters/cli/filesystem-sandbox.js";
import type { DirectoryListObservation } from "../adapters/cli/directory-listing.js";
import { validateCliGoal, validateCliGoalState, type CliGoalState, type StructuredCliGoal } from "../filters/cli-goal-policy.js";
import { expectedCliCommand, predictCliCommand, validateCliCommandProfile, type CliCommandProfile } from "../filters/cli-command-policy.js";

export type CliCommandState = CliGoalState & Readonly<{ directoryListing: null | Readonly<{
  directory: string; entries: DirectoryListObservation["entries"]; coverage: "complete"; errors: readonly [];
  evidence: DirectoryListObservation; sourceRun: string;
}> }>;
export type CliCommandRequest = Readonly<{ goal: StructuredCliGoal; state: CliCommandState; directory?: DirectoryRef }>;
export type CliCommandInvocation = readonly ["pwd"] | readonly ["cd" | "ls", DirectoryRef];
export type CliCommandTransition = Readonly<{
  goal: StructuredCliGoal; state_before: CliCommandState;
  policy: ReturnType<typeof predictCliCommand>;
  policy_error: null | Readonly<{ expectedHead: string; selectedHead: string }>;
  invocation: CliCommandInvocation | null;
  call: SemanticCliCall | null;
  execution_result: Readonly<{ status: "succeeded" | "failed" | "unsupported" | "rejected"; executorInvoked: boolean; receipt: SemanticCallReceipt | null; reason: string }>;
  session_before: SessionSnapshot; session_after: SessionSnapshot;
  observed_state_after: CliCommandState;
  postcondition: null | Readonly<{ receipt: SemanticCallReceipt; matchedTarget: boolean }>;
  goal_result: Readonly<{ status: "achieved" | "unmet" | "unverified"; reason: string; changed: boolean }>;
}>;
export type CliCommandBinding = Readonly<{ profile: CliCommandProfile; sandbox: CliFilesystemSandbox; session: SessionRef }>;

export function validateCliCommandRequest(value: unknown, session: SessionRef): CliCommandRequest {
  const input = expectRecord(value, "command request");
  if (Object.keys(input).some(key => !["goal", "state", "directory"].includes(key))) throw new TypeError("Unsupported command request field");
  const goal = validateCliGoal(input.goal), state = expectRecord(input.state, "command state");
  if (Object.keys(state).sort().join() !== ["cwdObservation", "directoryListing", "session"].join()) throw new TypeError("Invalid command state fields");
  const cwd = validateCliGoalState({ session: state.session, cwdObservation: state.cwdObservation });
  if (goal.session !== session.sessionId || cwd.session !== session.sessionId) throw new TypeError("Goal/state must belong to bound session");
  if (state.directoryListing !== null) expectRecord(state.directoryListing, "directoryListing");
  if (goal.kind === "list_directory" && (typeof goal.target !== "string" || !goal.target.startsWith("/") || goal.target.includes("\0"))) throw new TypeError("list_directory needs an absolute target");
  return Object.freeze({ goal, state: Object.freeze({ ...cwd, directoryListing: state.directoryListing as CliCommandState["directoryListing"] }),
    ...(input.directory === undefined ? {} : { directory: input.directory as DirectoryRef }) });
}

const record = (value: unknown) => expectRecord(value, "command workflow payload");
const port = (name: string) => ({ name, schemaId: `cli.${name}.v1`, eventType: `cli.${name}.v1`, validate: record });

export function createCliCommandStepNodes(binding: CliCommandBinding): readonly NodeDefinition[] {
  const profile = validateCliCommandProfile(binding.profile), { sandbox, session } = binding;
  const request = port("command_request"), selection = port("command_selection"), execution = port("command_execution"), transition = port("command_transition");
  return [
    { operator: "cli.command.select", version: "0.1.0", inputPorts: [request], outputPort: selection, effects: [],
      execute(context) {
        const input = validateCliCommandRequest(context.inputs[0]!.payload, session);
        const policy = predictCliCommand(input.goal, profile), expected = expectedCliCommand(input.goal);
        const policy_error = policy.selectedHead === expected ? null : { expectedHead: expected, selectedHead: policy.selectedHead };
        return context.emit({ input, policy, policy_error });
      } },
    { operator: "cli.command.execute", version: "0.1.0", inputPorts: [selection], outputPort: execution, effects: [],
      async execute(context) {
        const selected = context.inputs[0]!.payload as { input: CliCommandRequest; policy: ReturnType<typeof predictCliCommand>; policy_error: CliCommandTransition["policy_error"] };
        const { input, policy, policy_error } = selected, before = sandbox.getSession(session);
        let invocation: CliCommandInvocation | null = null, call: SemanticCliCall | null = null, receipt: SemanticCallReceipt | null = null;
        let reason = "unsupported";
        if (policy.selectedHead !== "unsupported" && policy_error === null) {
          if (policy.selectedHead === "pwd") {
            invocation = ["pwd"]; call = { operation: "cwd.get", parameters: { session } };
          } else {
            if (!input.directory) throw new TypeError("Selected command needs an explicit directory reference");
            invocation = [policy.selectedHead, input.directory];
            if (resolve(String(input.goal.target)) !== resolve(before.cwd, input.directory.path)) reason = "target_mismatch";
            else call = { operation: policy.selectedHead === "cd" ? "cwd.set" : "directory.list", parameters: { session, directory: input.directory } };
          }
          if (call !== null) { receipt = await sandbox.execute(call); reason = receipt.status === "succeeded" ? "executed" : "execution_failed"; }
        } else if (policy_error !== null) reason = "unexpected_command";
        return context.emit({ ...selected, invocation, call, receipt, before, after: sandbox.getSession(session), reason });
      } },
    { operator: "cli.command.verify", version: "0.1.0", inputPorts: [execution], outputPort: transition, effects: [],
      async execute(context) {
        const item = context.inputs[0]!.payload as {
          input: CliCommandRequest; policy: ReturnType<typeof predictCliCommand>; policy_error: CliCommandTransition["policy_error"];
          invocation: CliCommandInvocation | null; call: SemanticCliCall | null; receipt: SemanticCallReceipt | null;
          before: SessionSnapshot; after: SessionSnapshot; reason: string;
        };
        const { input, policy, receipt } = item;
        let state = input.state, postcondition: CliCommandTransition["postcondition"] = null;
        let status: "achieved" | "unmet" | "unverified" = "unmet", reason = item.reason;
        const changed = item.after.revision !== item.before.revision || item.after.cwd !== item.before.cwd;
        if (receipt?.execution.status === "succeeded") {
          const observed = receipt.execution.observation;
          if (policy.selectedHead === "cd" && observed.kind === "cwd.set") {
            const post = await sandbox.execute({ operation: "cwd.get", parameters: { session } });
            const matchedTarget = post.execution.status === "succeeded" && post.execution.observation.kind === "pwd"
              && post.execution.observation.physicalCwd === observed.targetPhysicalPath && sandbox.getSession(session).cwd === observed.targetPhysicalPath;
            postcondition = { receipt: post, matchedTarget };
            status = matchedTarget ? "achieved" : "unverified"; reason = matchedTarget ? "fresh_pwd_matches_target" : "postcommit_observation_failed";
            if (matchedTarget && post.execution.status === "succeeded" && post.execution.observation.kind === "pwd") state = { ...state,
              cwdObservation: { physicalCwd: post.execution.observation.physicalCwd, evidence: post.execution.observation, sourceRun: post.execution.runId } };
          } else if (observed.kind === "pwd" && !changed) {
            state = { ...state, cwdObservation: { physicalCwd: observed.physicalCwd, evidence: observed, sourceRun: receipt.execution.runId } };
            status = "achieved"; reason = "fresh_pwd_observation";
          } else if (observed.kind === "directory.list" && !changed) {
            if (observed.coverage === "complete") {
              state = { ...state, directoryListing: { directory: observed.physicalDirectory, entries: observed.entries, coverage: "complete", errors: [], evidence: observed, sourceRun: receipt.execution.runId } };
              status = "achieved"; reason = "complete_listing";
            } else reason = "partial_coverage";
          } else reason = "unexpected_state_change";
        }
        const result: CliCommandTransition = { goal: input.goal, state_before: input.state, policy, policy_error: item.policy_error,
          invocation: item.invocation, call: item.call,
          execution_result: { status: receipt === null ? item.policy_error === null && policy.selectedHead === "unsupported" ? "unsupported" : "rejected" : receipt.status,
            executorInvoked: receipt?.execution.executorInvoked ?? false, receipt, reason: item.reason },
          session_before: item.before, session_after: sandbox.getSession(session), observed_state_after: state, postcondition,
          goal_result: { status, reason, changed } };
        return context.emit(result);
      } },
  ];
}
