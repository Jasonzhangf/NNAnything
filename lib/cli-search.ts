import { runRecursiveGoal } from "./workflow/recursive-goal/module.js";
import {
  createEntrySearchAdapter,
  createEntrySearchDependencies,
  ROOT_EVALUATOR,
  ROOT_SELECTOR,
} from "./adapters/cli/entry-search-recursive.js";
import {
  resolveEntrySearchScan,
  validateEntrySearchRequest,
  type EntrySearchDomainProjection,
  type EntrySearchRequest,
  type EntrySearchResources,
  type EntrySearchRunResult,
  type EntrySearchState,
} from "./adapters/cli/entry-search-contract.js";
import { projectDomain } from "./filters/cli-entry-search.js";
import type { CliFilesystemSandbox, SessionRef, SessionSnapshot } from "./adapters/cli/filesystem-sandbox.js";

const RECURSIVE_REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1" as const;

function initialState(
  sandbox: CliFilesystemSandbox,
  session: SessionRef,
  stateId: string,
  cardinality: "one" | "all",
  recursion: "flat" | "nested",
  maxDirectoryDepth: number | null,
): EntrySearchState {
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
    cardinality,
    recursion,
    maxDirectoryDepth,
    directories: Object.freeze([]),
    pendingDirectories: Object.freeze([]),
    candidates: Object.freeze([]),
  });
}

export async function runCliEntrySearchGoal(
  request: unknown,
  resources: EntrySearchResources,
): Promise<EntrySearchRunResult> {
  const validated = validateEntrySearchRequest(request, resources.session);
  const scan = resolveEntrySearchScan(validated.goal.requirement.predicate, resources.scan);
  const created = createEntrySearchAdapter({
    sandbox: resources.sandbox,
    session: resources.session,
    profile: resources.profile,
    ...(resources.onSample === undefined ? {} : { onSample: resources.onSample }),
  });
  const state = initialState(
    resources.sandbox,
    resources.session,
    `${validated.requestId}:state:initial`,
    validated.goal.requirement.predicate.cardinality,
    scan.recursion,
    scan.maxDirectoryDepth,
  );
  const response = await runRecursiveGoal(
    {
      schema: RECURSIVE_REQUEST_SCHEMA,
      requestId: validated.requestId,
      rootGoal: validated.goal,
      satisfactionThreshold: 100,
      rootBindings: Object.freeze({
        session: resources.session,
        directory: validated.goal.target,
        predicate: validated.goal.requirement.predicate,
      }),
      state,
      rootEvaluatorId: ROOT_EVALUATOR,
      rootSelectorId: ROOT_SELECTOR,
      ...(resources.limits === undefined ? {} : { limits: resources.limits }),
      ...(resources.continuation === undefined ? {} : { continuation: resources.continuation }),
    },
    createEntrySearchDependencies(created, resources.signal),
  );
  const domain: EntrySearchDomainProjection = projectDomain(validated, response);
  return Object.freeze({
    request: validated,
    response,
    domain,
  });
}

export { createCliFilesystemSandbox } from "./adapters/cli/filesystem-sandbox.js";
export { createCliCommandPolicy } from "./cli-goal.js";
