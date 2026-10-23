import { runRecursiveGoal } from "./workflow/recursive-goal/module.js";
import {
  createReadCompositionAdapter,
  createReadCompositionDependencies,
  READ_ROOT_EVALUATOR,
  READ_ROOT_SELECTOR,
} from "./adapters/cli/read-composition-recursive.js";
import {
  validateReadCompositionRequest,
  type ReadCompositionDomainProjection,
  type ReadCompositionRequest,
  type ReadCompositionResources,
  type ReadCompositionRunResult,
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
    ...(resources.onSample === undefined ? {} : { onSample: resources.onSample }),
  });
  const state = initialState(
    resources.sandbox,
    resources.session,
    `${validated.requestId}:state:initial`,
  );
  const response = await runRecursiveGoal(
    {
      schema: RECURSIVE_REQUEST_SCHEMA,
      requestId: validated.requestId,
      rootGoal: validated.goal,
      satisfactionThreshold: 100,
      rootBindings: Object.freeze({
        session: resources.session,
        directory: validated.goal.target.directory,
        name: validated.goal.target.name,
        requiredType: validated.goal.target.requiredType,
        range: validated.goal.requirement.range,
        expectedBase64: validated.goal.requirement.expectedBase64,
      }),
      state,
      rootEvaluatorId: READ_ROOT_EVALUATOR,
      rootSelectorId: READ_ROOT_SELECTOR,
      limits: resources.limits,
    },
    createReadCompositionDependencies(created, resources.signal),
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
