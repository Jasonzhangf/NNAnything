import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { createCliSession } from "nnanything/cli";
import {
  createCliCommandPolicy,
  createCliFilesystemSandbox,
  migrateCliCommandProfileV10x30,
} from "nnanything/cli-goal";
import { runRecursiveGoal } from "nnanything/recursive-goal";

import {
  EQUALITY_EVALUATOR,
  ROOT_SELECTOR,
  createCwdAdapter,
  createCwdDependencies,
  emptyCwdState,
  BOUNDED_CWD_EVALUATOR, BOUNDED_CWD_SELECTOR, BOUNDED_CWD_EQUALS_SKILL,
  createBoundedCwdAdapter, createBoundedCwdDependencies,
} from "./cwd-adapter.mjs";

const GRANTED_EFFECTS = Object.freeze([
  "filesystem.read",
  "process.exec",
  "session.write",
]);

const OBSERVATION_GRANTS = Object.freeze([
  "filesystem.read",
  "process.exec",
]);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function treePaths(root) {
  const result = [];
  async function visit(path, prefix) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const item = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      result.push({ path: item, type: entry.isDirectory() ? "directory" : "file" });
      if (entry.isDirectory()) await visit(join(path, entry.name), item);
    }
  }
  await visit(root, "");
  return result;
}

function errorRecord(error) {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        code: error.code ?? null,
      }
    : {
        name: "Error",
        message: String(error),
        code: null,
      };
}

export function scenarioOptions(name) {
  if (name === "same") {
    return { initialCwd: "scene/target" };
  }
  if (name === "different") {
    return { initialCwd: "scene/start" };
  }
  if (name === "binding-refused") {
    return { initialCwd: "scene/start", removeTargetAfterPwd: true };
  }
  if (name === "postcommit-observation-injected") {
    return { initialCwd: "scene/start", injectPostcommitObservationFailure: true };
  }
  throw new TypeError(`Unknown cwd scenario: ${name}`);
}

export function recipeFor(scenarioId, initialCwd) {
  return {
    scenarioId,
    entries: [
      { path: "scene", kind: "directory" },
      { path: "scene/start", kind: "directory" },
      { path: "scene/target", kind: "directory" },
      { path: "scene/foreign", kind: "directory" },
    ],
    sessions: [
      { id: "root-session", cwd: initialCwd, grantedEffects: GRANTED_EFFECTS },
      { id: "foreign-session", cwd: "scene/foreign", grantedEffects: GRANTED_EFFECTS },
    ],
  };
}

export function injectedObservation(injection) {
  return async input => {
    if (injection.targetPhysical !== null && input.cwd === injection.targetPhysical) {
      injection.count += 1;
      injection.calls.push({
        count: injection.count,
        cwd: input.cwd,
        code: "INJECTED_OBSERVATION",
      });
      return {
        ok: false,
        error: {
          operation: "pwd",
          stage: "observe",
          code: "INJECTED_OBSERVATION",
          message: "controlled postcommit observation failure",
        },
      };
    }
    return createCliSession({
      cwd: input.cwd,
      grantedEffects: input.grantedEffects.filter(effect =>
        OBSERVATION_GRANTS.includes(effect),
      ),
    }).observe({ kind: "pwd" });
  };
}

function reportOf(response) {
  return response?.kind === "run_result" ? response.report : null;
}

function atomicTrace(trace) {
  return trace.filter(entry => entry.kind === "atomic");
}

function headSequence(trace) {
  return atomicTrace(trace).map(entry => entry.selectedHead);
}

function atomicResult(report, skillId) {
  return report?.atomicResults.find(result => result.skillId === skillId) ?? null;
}

function rootSatisfied(result) {
  return result.response?.kind === "run_result" &&
    result.response.report.rootEvaluation.state === "evaluated" &&
    result.response.report.rootEvaluation.result === "satisfied" &&
    result.response.report.control.outcome === "completed";
}

function commonPass(result) {
  return (
    result.error === null &&
    result.fixture.agentCwdUnchanged &&
    result.fixture.foreignSessionUnchanged &&
    result.fixture.cleaned &&
    result.fixture.rootAbsent
  );
}

function scenarioPass(result) {
  const report = reportOf(result.response);
  const heads = headSequence(result.trace);
  if (!commonPass(result) || report === null) return false;

  if (result.name === "same") {
    return rootSatisfied(result) &&
      heads.length === 1 &&
      heads[0] === "pwd" &&
      result.finalSession.revision === result.initialSession.revision &&
      report.rootEvaluation.state === "evaluated" &&
      report.rootEvaluation.result === "satisfied";
  }

  if (result.name === "different") {
    return rootSatisfied(result) &&
      heads.length === 2 &&
      heads[0] === "pwd" &&
      heads[1] === "cd" &&
      result.finalSession.cwd === result.request.targetPhysical &&
      result.finalSession.revision === result.initialSession.revision + 1 &&
      report.effects.some(effect => effect.knowledge === "known");
  }

  if (result.name === "binding-refused") {
    const cd = atomicTrace(result.trace).find(entry =>
      entry.selectedHead === "cd",
    );
    const cdAtomic = atomicResult(report, "cwd.equals.atomic") ?? atomicResult(report, BOUNDED_CWD_EQUALS_SKILL);
    return !rootSatisfied(result) &&
      heads.filter(head => head === "cd").length === 1 &&
      cd !== undefined &&
      cd.reason === "directory_binding_failed" &&
      cd.executorInvoked === false &&
      cdAtomic?.outcome === "rejected" &&
      cdAtomic.executorInvoked === false &&
      report.errors.some(error => error.code === "invalid_binding");
  }

  if (result.name === "postcommit-observation-injected") {
    const cd = atomicTrace(result.trace).find(entry =>
      entry.selectedHead === "cd",
    );
    return !rootSatisfied(result) &&
      report.rootEvaluation.state === "evaluated" &&
      report.rootEvaluation.result === "unknown" &&
      heads.filter(head => head === "cd").length === 1 &&
      result.injection.count === 1 &&
      result.finalSession.cwd === result.request.targetPhysical &&
      result.finalSession.revision === result.initialSession.revision + 1 &&
      cd?.changed === true &&
      report.effects.some(effect =>
        effect.knowledge === "known" &&
        effect.confirmedEffects.some(fact =>
          fact.kind === "cli.session.cwd" &&
          fact.revision === result.finalSession.revision,
        ),
      ) &&
      report.errors.some(error => error.code === "evidence_unavailable");
  }

  return false;
}

function transitionSummary(entry) {
  const transition = entry.transition;
  return {
    kind: "atomic",
    sequence: entry.sequence,
    step: entry.step,
    goalKind: entry.goalKind,
    skillId: entry.skillId,
    selectedHead: transition.policy.selectedHead,
    invocation: transition.invocation,
    status: transition.status,
    satisfaction: transition.satisfaction,
    reason: transition.reason,
    changed: transition.changed,
    executorInvoked: transition.execution_result.executorInvoked,
    executionStatus: transition.execution_result.status,
    executionError: transition.execution_result.error,
    postcondition:
      transition.postcondition === null
        ? null
        : {
            matchedTarget: transition.postcondition.matchedTarget,
            executionStatus: transition.postcondition.receipt.execution.status,
            error:
              transition.postcondition.receipt.execution.status === "failed"
                ? transition.postcondition.receipt.execution.error
                : null,
          },
    sessionAfter: transition.session_after,
  };
}

function traceSummary(entry) {
  if (entry.kind === "selection") {
    return {
      kind: entry.kind,
      sequence: entry.sequence,
      frameId: entry.frameId,
      goalKind: entry.goalKind,
      selectorId: entry.selectorId,
      selection: entry.selection,
    };
  }
  if (entry.kind === "atomic") return transitionSummary(entry);
  throw new TypeError(`Unknown cwd trace record kind: ${entry.kind}`);
}

function responseSummary(response) {
  const report = reportOf(response);
  if (report === null) {
    return {
      kind: response?.kind ?? "missing",
      acceptedRoot: response?.acceptedRoot ?? null,
      error:
        response?.kind === "request_rejected"
          ? response.error
          : response?.kind === "module_fault"
            ? response.fault
            : null,
    };
  }
  return {
    kind: response.kind,
    acceptedRoot: report.root,
    control: report.control,
    rootEvaluation: report.rootEvaluation,
    frameCount: report.frames.length,
    frames: report.frames.map(frame => ({
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      fulfillsConditionId: frame.fulfillsConditionId,
      mode: frame.mode,
      depth: frame.depth,
      selectedSkillId: frame.selectedSkillId,
      fact: frame.fact,
      execution: frame.execution,
      unexecutedReason: frame.unexecutedReason,
      evidenceRefs: frame.evidenceRefs,
      atomicResultRefs: frame.atomicResultRefs,
    })),
    atomicResults: report.atomicResults.map(atomic => ({
      dispatchId: atomic.dispatchId,
      frameId: atomic.frameId,
      skillId: atomic.skillId,
      runId: atomic.runId,
      executorInvoked: atomic.executorInvoked,
      outcome: atomic.outcome,
      executionErrorIds: atomic.executionErrorIds,
      verificationErrorIds: atomic.verificationErrorIds,
      effect: atomic.effect,
      sourceStatus:
        atomic.sourceResult?.tag === "cli.command.transition.v1"
          ? atomic.sourceResult.value.status
          : null,
      sourceReason:
        atomic.sourceResult?.tag === "cli.command.transition.v1"
          ? atomic.sourceResult.value.reason
          : null,
    })),
    effects: report.effects,
    errors: report.errors,
    primaryErrorId: report.primaryErrorId,
    budgetUsed: report.budgetUsed,
  };
}

export async function runCwdScenario({
  name,
  profile,
  fixtureParent,
  bounded = null,
}) {
  const options = scenarioOptions(name);
  await mkdir(fixtureParent, { recursive: true });
  const caseRoot = await mkdtemp(join(fixtureParent, `${name}-`));
  const scenarioId = name;
  const agentCwdBefore = process.cwd();
  const injection = {
    targetPhysical: null,
    count: 0,
    calls: [],
  };
  let sandbox = null;
  let session = null;
  let foreign = null;
  let foreignBefore = null;
  let initialSession = null;
  let finalSession = null;
  let treeBefore = null;
  let treeAfter = null;
  let response = null;
  const responses=[];
  let boundedContext=null;
  let created = null;
  let target = null;
  let targetPhysical = null;
  let targetRemoved = false;
  let cleanup = null;
  let error = null;

  try {
    sandbox = await createCliFilesystemSandbox({
      root: caseRoot,
      recipe: recipeFor(scenarioId, options.initialCwd),
      ownerGrantedEffects: ["filesystem.read", "filesystem.write"],
      ...(options.injectPostcommitObservationFailure
        ? { observation: injectedObservation(injection) }
        : {}),
    });
    session = sandbox.bindSession("root-session");
    foreign = sandbox.bindSession("foreign-session");
    initialSession = sandbox.getSession(session);
    foreignBefore = sandbox.getSession(foreign);
    const initialPhysical = await realpath(join(sandbox.scenarioRoot, options.initialCwd));
    targetPhysical = await realpath(join(sandbox.scenarioRoot, "scene/target"));
    injection.targetPhysical = targetPhysical;
    const relativeTarget = relative(initialPhysical, targetPhysical) || ".";
    target = await sandbox.bindDirectory(session, relativeTarget);
    treeBefore = await treePaths(sandbox.scenarioRoot);

    const policy = createCliCommandPolicy({ profile, sandbox, session });
    boundedContext=bounded===null ? null : bounded({session,target,targetPhysical});
    created = (boundedContext===null ? createCwdAdapter : createBoundedCwdAdapter)({
      policy,
      sandbox,
      session,
      bindings: { session, target, targetPhysical },
      onTransition: async ({ step, transition }) => {
        if (
          options.removeTargetAfterPwd &&
          step === 1 &&
          transition.policy.selectedHead === "pwd"
        ) {
          await rm(targetPhysical, { recursive: true, force: true });
          targetRemoved = !(await pathExists(targetPhysical));
        }
      },
    });
    const state = emptyCwdState(initialSession, `${scenarioId}:state-initial`);
    const request={
        schema: "nnanything.recursive-goal.request.v1",
        requestId: `${scenarioId}:request`,
        rootGoal: boundedContext===null ? { kind: "cli.cwd.equals", targetPhysical } : {kind:"file.property",property:"file.property.relation.sessionCwd",target:{kind:"cli.file-query",relation:"sessionCwd",session},requirement:{kind:"equals",expected:target}},
        satisfactionThreshold: 100,
        rootBindings: { session, target, targetPhysical },
        state,
        rootEvaluatorId: boundedContext===null ? EQUALITY_EVALUATOR : BOUNDED_CWD_EVALUATOR,
        rootSelectorId: boundedContext===null ? ROOT_SELECTOR : BOUNDED_CWD_SELECTOR,
        limits: {
          maxTransitions: 64,
          maxDepth: 8,
          maxDerivedGoals: 8,
        },
        ...(boundedContext===null ? {} : {planning:boundedContext.planning,invocation:{maxAtomicDispatches:1}}),
      };
    const dependencies=boundedContext===null ? createCwdDependencies(created) : createBoundedCwdDependencies(created,boundedContext.capability);
    let continuation;
    do {
      response=await runRecursiveGoal({...request,...(continuation===undefined ? {} : {continuation})},dependencies);
      responses.push(response);
      continuation=response.kind==="run_result" && response.report.control.outcome==="yielded" ? response.report.continuation : undefined;
    } while(continuation!==undefined);
  } catch (caught) {
    error = errorRecord(caught);
  } finally {
    try {
      if (sandbox !== null) {
        finalSession = sandbox.getSession(session);
        treeAfter = await treePaths(sandbox.scenarioRoot);
      }
    } catch (caught) {
      if (error === null) error = errorRecord(caught);
    }
    const foreignAfter = sandbox === null ? null : sandbox.getSession(foreign);
    try {
      cleanup = sandbox === null
        ? null
        : await sandbox.cleanup();
      await rm(caseRoot, { recursive: true, force: true });
    } catch (caught) {
      if (error === null) error = errorRecord(caught);
    }
    const rootAbsent = !(await pathExists(caseRoot));
    const result = {
      name,
      status: "FAIL",
      sourceKind:
        name === "postcommit-observation-injected"
          ? "real_cd_with_controlled_observation_injection"
          : "real_os",
      error,
      request: {
        targetRef: target,
        targetPhysical,
        relativeTarget: target === null || initialSession === null
          ? null
          : target.path,
      },
      injection,
      targetRemoved,
      initialSession,
      finalSession,
      trace:
        created === null
          ? []
          : created.trace.map(traceSummary),
      rawTrace:
        created === null
          ? []
          : created.trace,
      transitions: created === null
        ? []
        : created.transitions.map(transitionSummary),
      rawTransitions:
        created === null
          ? []
          : created.transitions.map(entry => ({
              step: entry.step,
              goalKind: entry.goalKind,
              skillId: entry.skillId,
              request: entry.request,
              transition: entry.transition,
            })),
      response,
      responses,
      predictionCalls:boundedContext?.predictionCalls() ?? 0,
      summary: responseSummary(response),
      fixture: {
        caseRoot,
        treeBefore,
        treeAfter,
        foreignBefore,
        foreignAfter,
        foreignSessionUnchanged:
          foreignBefore !== null &&
          foreignAfter !== null &&
          JSON.stringify(foreignBefore) === JSON.stringify(foreignAfter),
        agentCwdBefore,
        agentCwdAfter: process.cwd(),
        agentCwdUnchanged: process.cwd() === agentCwdBefore,
        cleanup,
        cleaned: cleanup?.removed === true,
        rootAbsent,
      },
    };
    result.status = scenarioPass(result) ? "PASS" : "FAIL";
    return result;
  }
}

export async function runCwdScenarios({
  profilePath,
  fixtureParent = tmpdir(),
  bounded = null,
}) {
  if (typeof profilePath !== "string" || profilePath.length === 0) {
    throw Object.assign(new Error("--profile requires an explicit candidate path"), {
      code: "PROFILE_MISSING",
    });
  }
  const profileTextBefore = await readFile(profilePath, "utf8");
  const rawProfile = JSON.parse(profileTextBefore);
  const profile = rawProfile.wires?.length === 30
    ? migrateCliCommandProfileV10x30(rawProfile)
    : rawProfile;
  await mkdir(fixtureParent, { recursive: true });
  const fixtureRoot = await mkdtemp(join(fixtureParent, "nnanything-recursive-cwd-"));
  const scenarios = [];
  try {
    for (const name of [
      "same",
      "different",
      "binding-refused",
      "postcommit-observation-injected",
    ]) {
      scenarios.push(await runCwdScenario({
        name,
        profile,
        fixtureParent: fixtureRoot,
        bounded,
      }));
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  const profileTextAfter = await readFile(profilePath, "utf8");
  const fixtureRootAbsent = !(await pathExists(fixtureRoot));
  const result = {
    status: "FAIL",
    profilePath,
    profile: {
      contract: profile.contract,
      calibration: profile.calibration,
      adoption: profile.adoption,
      heads: profile.heads?.length ?? null,
      wires: profile.wires?.length ?? null,
      fitted: false,
      textUnchanged: profileTextAfter === profileTextBefore,
    },
    environment: {
      cwd: process.cwd(),
      node: process.version,
    },
    fixtureRoot,
    fixtureRootAbsent,
    scenarios,
    counts: {
      total: scenarios.length,
      passed: scenarios.filter(scenario => scenario.status === "PASS").length,
      failed: scenarios.filter(scenario => scenario.status === "FAIL").length,
    },
  };
  result.status =
    result.counts.failed === 0 &&
    fixtureRootAbsent &&
    result.profile.textUnchanged
      ? "PASS"
      : "FAIL";
  return result;
}

export function renderReadableReport(result) {
  const lines = [
    `recursive-goal cwd consumer: ${result.status}`,
    `profile: ${result.profilePath}`,
    `profile contract: ${result.profile.contract}`,
    `profile state: ${result.profile.calibration}/${result.profile.adoption}`,
    `profile matrix: ${result.profile.heads}x${result.profile.wires}`,
    `fixture root removed: ${result.fixtureRootAbsent}`,
  ];
  for (const scenario of result.scenarios) {
    const heads = scenario.transitions.map(item => item.selectedHead).join(",") || "none";
    const root = scenario.summary?.rootEvaluation;
    const rootText = root?.state === "evaluated"
      ? `${root.result}:${root.satisfaction}`
      : root?.state ?? "not_evaluated";
    const errors = scenario.summary?.errors?.map(error => error.code).join(",") || "none";
    lines.push(
      `${scenario.name}: ${scenario.status}; heads=${heads}; root=${rootText}; errors=${errors}; ` +
      `cleanup=${scenario.fixture.cleaned}; foreign=${scenario.fixture.foreignSessionUnchanged}; ` +
      `agentCwd=${scenario.fixture.agentCwdUnchanged}`,
    );
  }
  lines.push(
    `cases: ${result.counts.passed}/${result.counts.total} passed`,
  );
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  let profilePath = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--profile") {
      profilePath = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new TypeError(`Unknown argument: ${arg}`);
    }
  }
  if (profilePath === null) {
    throw Object.assign(
      new Error("Usage: node playground/recursive-goal/cwd.mjs --profile <path> [--json]"),
      { code: "PROFILE_MISSING" },
    );
  }
  return { profilePath, json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runCwdScenarios({ profilePath: args.profilePath });
  process.stdout.write(
    args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderReadableReport(result),
  );
  return result.status === "PASS" ? 0 : 1;
}

const invokedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(process.argv[1]).href;

if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const record = errorRecord(error);
    process.stderr.write(`${JSON.stringify(record, null, 2)}\n`);
    process.exitCode = record.code === "PROFILE_MISSING" ? 2 : 1;
  }
}
