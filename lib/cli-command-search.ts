import { runRecursiveGoal } from "./workflow/recursive-goal/module.js";
import {
  createCommandSearchAdapter,
  createCommandSearchDependencies,
  COMMAND_SEARCH_ROOT_EVALUATOR,
  COMMAND_SEARCH_ROOT_SELECTOR,
} from "./adapters/cli/command-search-recursive.js";
import {
  validateCommandSearchRequest,
  validateCommandSearchResources,
  type CommandSearchDomainProjection,
  type CommandSearchRequest,
  type CommandSearchResources,
  type CommandSearchRunResult,
  type CommandSearchState,
} from "./adapters/cli/command-search-contract.js";
import {
  loadCliHybridSearchModel,
  projectCommandSearchDomain,
  type CliHybridSearchModel,
} from "./filters/cli-command-search.js";
import { createIncrementalStreamParser } from "./adapters/cli/directory-command-search.js";
import type { SessionSnapshot } from "./adapters/cli/filesystem-sandbox.js";

const RECURSIVE_REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;

function initialState(
  sandbox: { getSession(ref: { kind: "cli.session"; scenarioId: string; sessionId: string }): SessionSnapshot },
  session: { kind: "cli.session"; scenarioId: string; sessionId: string },
  stateId: string,
  request: CommandSearchRequest,
  model: CliHybridSearchModel,
): CommandSearchState {
  const snapshot = sandbox.getSession(session);
  const meta = metaOf(request, model);
  return Object.freeze({
    stateId,
    session: Object.freeze({
      id: snapshot.id,
      cwd: snapshot.cwd,
      revision: snapshot.revision,
      grantedEffects: Object.freeze([...snapshot.grantedEffects]),
    }),
    goalKind: meta.goalKind,
    cardinality: meta.cardinality,
    s1Enabled: meta.scopeRefs.length > 1,
    lastSearchedSlot: null,
    slotReceipts: Object.freeze({ s0: null, s1: null }),
    readReceipt: null,
    issuedRefs: Object.freeze([]),
    spawnLedger: Object.freeze([]),
    stepTrace: Object.freeze([]),
  });
}

function metaOf(request: CommandSearchRequest, model: CliHybridSearchModel) {
  const goal = request.goal;
  const target = goal.target;
  if (goal.property === "file.property.content.bytes") {
    return Object.freeze({
      goalKind: "g3.literal-search" as const,
      cardinality: goal.requirement.cardinality,
      scopeRefs: target.scopeRefs,
      fileFilter: target.fileFilter,
      ignorePolicy: target.ignorePolicy,
      queryLiteral: goal.requirement.queryLiteral,
      followUpRead: null,
      modelRef: model.ref,
    });
  }
  return Object.freeze({
    goalKind: "g2.read" as const,
    cardinality: goal.requirement.cardinality,
    scopeRefs: target.scopeRefs,
    fileFilter: target.fileFilter,
    ignorePolicy: target.ignorePolicy,
    queryLiteral: null,
    followUpRead: goal.requirement.followUpRead,
    modelRef: model.ref,
  });
}

export async function runCliCommandSearchGoal(
  request: unknown,
  resources: CommandSearchResources,
): Promise<CommandSearchRunResult> {
  const validated = validateCommandSearchRequest(request);
  const injected = validateCommandSearchResources(resources);
  const model = injected.l2Model as unknown as CliHybridSearchModel;
  const meta = metaOf(validated, model);
  const created = createCommandSearchAdapter({
    sandbox: injected.sandbox,
    session: injected.session,
    l2Model: model,
    ...(injected.explicitLimits === undefined ? {} : { explicitLimits: injected.explicitLimits }),
  });
  const state = initialState(
    injected.sandbox,
    injected.session,
    `${validated.requestId}:state:initial`,
    validated,
    model,
  );
  const response = await runRecursiveGoal(
    {
      schema: RECURSIVE_REQUEST_SCHEMA,
      requestId: validated.requestId,
      rootGoal: validated.goal,
      satisfactionThreshold: 100,
      rootBindings: Object.freeze({
        session: injected.session,
        scopeRefs: meta.scopeRefs,
        fileFilter: meta.fileFilter,
        ignorePolicy: meta.ignorePolicy,
        goalKind: meta.goalKind,
        cardinality: meta.cardinality,
        queryLiteral: meta.queryLiteral,
        followUpRead: meta.followUpRead,
        modelRef: meta.modelRef,
      }),
      state,
      rootEvaluatorId: COMMAND_SEARCH_ROOT_EVALUATOR,
      rootSelectorId: COMMAND_SEARCH_ROOT_SELECTOR,
      ...(injected.limits === undefined ? {} : { limits: injected.limits }),
      ...(injected.continuation === undefined ? {} : { continuation: injected.continuation }),
    },
    createCommandSearchDependencies(created, injected.signal),
  );
  const domain: CommandSearchDomainProjection = projectCommandSearchDomain({
    request: validated,
    model,
    response,
  });
  return Object.freeze({
    request: validated,
    response,
    domain,
  });
}

export { createCliFilesystemSandbox } from "./adapters/cli/filesystem-sandbox.js";
export { loadCliHybridSearchModel } from "./filters/cli-command-search.js";
export { createIncrementalStreamParser } from "./adapters/cli/directory-command-search.js";
export { createCommandSearchAdapter, createCommandSearchDependencies } from "./adapters/cli/command-search-recursive.js";
export type { CliHybridSearchModel } from "./filters/cli-command-search.js";
export type {
  CommandSearchRequest,
  CommandSearchResources,
  CommandSearchRunResult,
  CommandSearchDomainProjection,
  CommandSearchState,
} from "./adapters/cli/command-search-contract.js";
