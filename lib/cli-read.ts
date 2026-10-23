import { runRecursiveGoal } from "./workflow/recursive-goal/module.js";
import {
  createReadCompositionAdapter,
  createReadCompositionDependencies,
  createReadMultiCompositionDependencies,
  READ_ROOT_EVALUATOR,
  READ_MULTI_ROOT_EVALUATOR,
  READ_ROOT_SELECTOR,
  READ_MULTI_ROOT_SELECTOR,
} from "./adapters/cli/read-composition-recursive.js";
import {
  validateReadCompositionRequest,
  type ReadCompositionDomainProjection,
  type ReadCompositionMultiBindings,
  type ReadCompositionRequest,
  type ReadCompositionResources,
  type ReadCompositionRunResult,
  type ReadCompositionSourceState,
  type ReadCompositionState,
} from "./adapters/cli/read-composition-contract.js";
import { projectReadDomain } from "./filters/cli-read-composition.js";
import type { CliFilesystemSandbox, SessionRef, SessionSnapshot } from "./adapters/cli/filesystem-sandbox.js";

const RECURSIVE_REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;

function initialState(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  stateId: string,
): ReadCompositionState {
  const snapshot: SessionSnapshot = sandbox.getSession(session);
  return Object.freeze({
    stateId,
    session: Object.freeze({
      id: snapshot.id,
      cwd: snapshot.cwd,
      revision: snapshot.revision,
      grantedEffects: Object.freeze([...snapshot.grantedEffects]),
    }),
    cli: Object.freeze({
      session: session.sessionId,
      cwdObservation: null,
      directoryListing: null,
    }),
    listing: null,
    candidate: null,
    inspected: null,
    fileRef: null,
    read: null,
    sources: null,
  });
}

function multiInitialState(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  stateId: string,
  sources: readonly { directory: ReadCompositionSourceState["directory"]; order: number | null }[],
): ReadCompositionState {
  const single = initialState(sandbox, session, stateId);
  const sourceStates = sources.map((source, index) =>
    Object.freeze({
      sourceId: `source:${index}` as const,
      order: source.order,
      directory: source.directory,
      listing: null,
      candidate: null,
      inspected: null,
      fileRef: null,
      read: null,
    }),
  );
  const first = (sourceStates[0] ?? single.sources?.[0]) as ReadCompositionSourceState;
  const second = (sourceStates[1] ?? single.sources?.[1]) as ReadCompositionSourceState;
  return Object.freeze({
    ...single,
    sources: Object.freeze([first, second]) as readonly [ReadCompositionSourceState, ReadCompositionSourceState],
  });
}

export async function runCliReadCompositionGoal(
  request: unknown,
  resources: ReadCompositionResources,
): Promise<ReadCompositionRunResult> {
  const validated = validateReadCompositionRequest(request, resources.session);
  const created = createReadCompositionAdapter({
    sandbox: resources.sandbox,
    session: resources.session,
    profile: resources.profile,
    ...(resources.decision === undefined ? {} : { decision: resources.decision }),
    ...(resources.onSample === undefined ? {} : { onSample: resources.onSample }),
  });
  const stateId = `${validated.requestId}:state:initial`;
  const multi = validated.goal.target.kind === "cli.exact-child-sources";
  const state = multi
    ? multiInitialState(
        resources.sandbox,
        resources.session,
        stateId,
        validated.goal.target.sources,
      )
    : initialState(resources.sandbox, resources.session, stateId);
  const bindings: ReadCompositionMultiBindings | Readonly<{
    session: SessionRef;
    directory: unknown;
    name: string;
    requiredType: "regular";
    range: Readonly<{ offset: number; length: number }>;
    expectedBase64: string;
  }> = multi
    ? Object.freeze({
        session: resources.session,
        sources: validated.goal.target.sources,
        name: validated.goal.target.name,
        requiredType: validated.goal.target.requiredType,
        range: validated.goal.requirement.range,
        expectedBase64: validated.goal.requirement.expectedBase64,
      })
    : Object.freeze({
        session: resources.session,
        directory: validated.goal.target.directory,
        name: validated.goal.target.name,
        requiredType: validated.goal.target.requiredType,
        range: validated.goal.requirement.range,
        expectedBase64: validated.goal.requirement.expectedBase64,
      });
  const dependencies = multi
    ? createReadMultiCompositionDependencies(created, resources.signal)
    : createReadCompositionDependencies(created, resources.signal);
  const response = await runRecursiveGoal(
    {
      schema: RECURSIVE_REQUEST_SCHEMA,
      requestId: validated.requestId,
      rootGoal: validated.goal,
      satisfactionThreshold: 100,
      rootBindings: bindings,
      state,
      rootEvaluatorId: multi ? READ_MULTI_ROOT_EVALUATOR : READ_ROOT_EVALUATOR,
      rootSelectorId: multi ? READ_MULTI_ROOT_SELECTOR : READ_ROOT_SELECTOR,
      limits: resources.limits,
    },
    dependencies,
  );
  const domain: ReadCompositionDomainProjection = projectReadDomain(validated, response);
  return Object.freeze({
    request: validated,
    response,
    domain,
  });
}

export { createCliFilesystemSandbox } from "./adapters/cli/filesystem-sandbox.js";
export { createCliCommandPolicy } from "./cli-goal.js";
