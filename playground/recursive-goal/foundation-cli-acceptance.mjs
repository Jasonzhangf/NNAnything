import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createCliSession } from "nnanything/cli";
import {
  projectRecursiveGoalCompletion,
  readAtomicReceipt,
  readRecursiveGoalRequestEnvelope,
  runRecursiveGoal,
} from "nnanything/recursive-goal";

const REQUEST_SCHEMA = "nnanything.recursive-goal.request.v1";
const OBSERVE_SKILL_ID = "foundation.cli.attributes.observe";
const EVALUATOR_ID = "foundation.cli.path-fact";
const SELECTOR_ID = "foundation.cli.path-fact.selector";

const OBSERVE_SKILL = Object.freeze({
  id: OBSERVE_SKILL_ID,
  version: "1.0.0",
  mode: "atomic",
  capability: "cli.attributes",
  evaluatorId: EVALUATOR_ID,
  requiredEffects: ["filesystem.read"],
  allowedEffects: ["filesystem.read"],
  retry: "never",
  effectClass: "read_only",
});

const EVALUATOR = Object.freeze({
  id: EVALUATOR_ID,
  goalType: "cli.path-fact",
  thresholdContract: "0..100",
  allowsPartialSatisfaction: false,
});

const SELECTOR = Object.freeze({
  id: SELECTOR_ID,
  skillIds: Object.freeze([OBSERVE_SKILL_ID]),
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function readCliReply(value) {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError("CLI reply must contain a boolean ok");
  }
  if (value.ok === true) {
    if (!hasExactKeys(value, ["ok", "observation"]) ||
        !isRecord(value.observation) ||
        typeof value.observation.kind !== "string") {
      throw new TypeError("successful CLI reply must contain one observation");
    }
    return value;
  }
  if (!hasExactKeys(value, ["ok", "error"]) ||
      !isRecord(value.error) ||
      typeof value.error.operation !== "string" ||
      typeof value.error.stage !== "string" ||
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string") {
    throw new TypeError("failed CLI reply must contain one typed error");
  }
  return value;
}

function readPathFactGoal(value) {
  if (!hasExactKeys(value, ["kind", "path"]) ||
      value.kind !== "cli.path-fact" ||
      typeof value.path !== "string" ||
      value.path.length === 0 ||
      value.path.includes("\0")) {
    throw new TypeError("goal must be one explicit cli.path-fact path");
  }
  return value;
}

function readBindings(value) {
  if (!hasExactKeys(value, ["cwd", "path", "grantedEffects"]) ||
      typeof value.cwd !== "string" ||
      typeof value.path !== "string" ||
      !Array.isArray(value.grantedEffects) ||
      value.grantedEffects.some(effect => effect !== "filesystem.read")) {
    throw new TypeError("bindings must contain cwd, path, and CLI effect grants");
  }
  return value;
}

function readState(value) {
  if (value === null || isRecord(value) && typeof value.ok === "boolean") {
    return value;
  }
  throw new TypeError("state must be null or one real CLI reply");
}

function readEffectFact() {
  throw new TypeError("this fixed observation consumer has no effect facts");
}

function isEffectDeniedCode(code) {
  return code === "EFFECT_DENIED";
}

function createAdapter({ cwd, replies }) {
  return Object.freeze({
    async validateRequest(request) {
      const envelope = readRecursiveGoalRequestEnvelope(request);
      if (envelope.continuation != null) {
        throw new TypeError("this bounded consumer accepts new requests only");
      }
      const goal = readPathFactGoal(envelope.rootGoal);
      const bindings = readBindings(envelope.rootBindings);
      if (bindings.cwd !== cwd) {
        throw new TypeError("request bindings must use the owned temporary directory");
      }
      if (bindings.path !== goal.path) {
        throw new TypeError("request bindings must match the explicit goal path");
      }
      if (envelope.rootEvaluatorId !== EVALUATOR_ID ||
          envelope.rootSelectorId !== SELECTOR_ID) {
        throw new TypeError("request must use the fixed evaluator and selector");
      }
      if (envelope.state !== null) {
        throw new TypeError("this atomic demonstration starts with no observation");
      }
      return {
        requestId: envelope.requestId,
        rootGoal: goal,
        satisfactionThreshold: envelope.satisfactionThreshold,
        rootBindings: bindings,
        state: envelope.state,
        rootEvaluatorId: envelope.rootEvaluatorId,
        rootSelectorId: envelope.rootSelectorId,
        limits: envelope.limits,
        continuation: null,
      };
    },

    supports({ goal, skill }) {
      return goal?.kind === "cli.path-fact" && skill?.id === OBSERVE_SKILL_ID;
    },

    async evaluate({ goal, bindings, evidence }) {
      readPathFactGoal(goal);
      readBindings(bindings);
      const validEvidence = evidence.filter(item =>
        item.validity === "valid" && isRecord(item.payload)
      );
      const current = validEvidence.at(-1);
      if (current === undefined) {
        return {
          evaluatorId: EVALUATOR_ID,
          result: "unsatisfied",
          satisfaction: 0,
          necessaryConditionsMet: false,
          evidenceRefs: [],
        };
      }
      const reply = readCliReply(current.payload);
      if (reply.ok === true) {
        return {
          evaluatorId: EVALUATOR_ID,
          result: "satisfied",
          satisfaction: 100,
          necessaryConditionsMet: true,
          evidenceRefs: [current.id],
        };
      }
      if (reply.error.code === "ENOENT") {
        return {
          evaluatorId: EVALUATOR_ID,
          result: "satisfied",
          satisfaction: 100,
          necessaryConditionsMet: true,
          evidenceRefs: [current.id],
        };
      }
      return {
        evaluatorId: EVALUATOR_ID,
        result: "unknown",
        satisfaction: null,
        necessaryConditionsMet: false,
        evidenceRefs: [current.id],
      };
    },

    async select({ candidates }) {
      const selected = candidates.find(skill => skill.id === OBSERVE_SKILL_ID);
      if (selected === undefined) {
        return {
          kind: "no_capability",
          searchedSkillIds: candidates.map(skill => skill.id),
        };
      }
      return Object.freeze({ kind: "selected", skillId: selected.id });
    },

    async derive() {
      return {
        conditions: [],
        nextCursor: null,
        expansion: "closed",
      };
    },

    async executeAtomic({ context, goal, bindings, skill }) {
      readPathFactGoal(goal);
      const bound = readBindings(bindings);
      if (skill.id !== OBSERVE_SKILL_ID) {
        throw new TypeError("fixed selector dispatched the wrong skill");
      }
      const session = createCliSession({
        cwd: bound.cwd,
        grantedEffects: bound.grantedEffects,
      });
      const reply = await session.observe({
        kind: "attributes",
        path: bound.path,
        followSymlinks: false,
      });
      replies.push(reply);

      const stateId = `${context.frameId}:observed`;
      const evidenceId = `${stateId}:reply`;
      const executionErrors = reply.ok
        ? []
        : [{
            diagnosticId: `${stateId}:execution-error`,
            code: isEffectDeniedCode(reply.error.code)
              ? "effect_denied"
              : "execution_failed",
            stage: isEffectDeniedCode(reply.error.code)
              ? "effect"
              : "execution",
            sourceCategory: `cli.attributes.${reply.error.stage}`,
            message: reply.error.message,
            nativeCode: reply.error.code,
            refs: [evidenceId],
          }];

      return {
        runId: context.requestId,
        executorInvoked: true,
        outcome: reply.ok ? "succeeded" : "failed",
        sourceResult: {
          tag: "cli.attributes.reply",
          value: reply,
        },
        newState: {
          id: stateId,
          value: reply,
        },
        evidence: [{
          id: evidenceId,
          stateRef: stateId,
          payload: reply,
          validity: "valid",
        }],
        executionErrors,
        verificationErrors: [],
        effect: {
          knowledge: "none",
          confirmedEffects: [],
          receiptRef: null,
        },
      };
    },

    validateAtomicReceipt(raw) {
      return readAtomicReceipt(raw, {
        state: readState,
        evidencePayload: readCliReply,
        effectFact: readEffectFact,
        receiptPayload: readCliReply,
      });
    },

    measureProgress({ before, after, previousEvaluation, currentEvaluation }) {
      const comparable =
        before === null &&
        isRecord(after) &&
        typeof after.ok === "boolean" &&
        previousEvaluation.satisfaction !== null &&
        currentEvaluation.satisfaction !== null;
      const improved =
        comparable &&
        currentEvaluation.satisfaction > previousEvaluation.satisfaction;
      return {
        improved,
        reason: improved ? "facts_improved" : "none",
        comparable,
      };
    },
  });
}

function dependenciesFor({ cwd, replies, engineGrants = ["filesystem.read"] }) {
  return Object.freeze({
    adapter: createAdapter({ cwd, replies }),
    enabledSkills: Object.freeze([OBSERVE_SKILL]),
    enabledEvaluators: Object.freeze([EVALUATOR]),
    selectors: Object.freeze([SELECTOR]),
    comparators: Object.freeze({
      sameGoal: (left, right) => isDeepStrictEqual(left, right),
      sameBindings: (left, right) => isDeepStrictEqual(left, right),
      sameFacts: (left, right) => isDeepStrictEqual(left, right),
    }),
    grantedEffects: new Set(engineGrants),
  });
}

function requestFor({ requestId, cwd, path, grantedEffects }) {
  return {
    schema: REQUEST_SCHEMA,
    requestId,
    rootGoal: {
      kind: "cli.path-fact",
      path,
    },
    satisfactionThreshold: 100,
    rootBindings: {
      cwd,
      path,
      grantedEffects,
    },
    state: null,
    rootEvaluatorId: EVALUATOR_ID,
    rootSelectorId: SELECTOR_ID,
    limits: {
      maxTransitions: 8,
      maxDepth: 1,
      maxDerivedGoals: 0,
    },
  };
}

function requireReport(response) {
  if (!isRecord(response) || response.kind !== "run_result" || !isRecord(response.report)) {
    throw new Error(`recursive goal did not return a run report: ${JSON.stringify(response)}`);
  }
  return response.report;
}

async function runScenario({ requestId, cwd, path, grantedEffects, engineGrants }) {
  const replies = [];
  const request = requestFor({ requestId, cwd, path, grantedEffects });
  const response = await runRecursiveGoal(
    request,
    dependenciesFor({ cwd, replies, engineGrants }),
  );
  const report = requireReport(response);
  const summary = projectRecursiveGoalCompletion(report);
  return { request, response, report, summary, replies };
}

function cliReplyFromAtomic(atomic) {
  if (atomic?.sourceResult === null || atomic?.sourceResult?.tag !== "cli.attributes.reply") {
    throw new Error("atomic result did not retain the real CLI reply");
  }
  return readCliReply(atomic.sourceResult.value);
}

function assertOneAtomicResult(result) {
  assert.equal(result.report.atomicResults.length, 1);
  assert.equal(result.report.frames.length, 1);
  assert.equal(result.replies.length, 1);
}

async function main() {
  const parentCwdBefore = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), "nnanything-foundation-cli-"));
  const filePath = join(tempDir, "known.txt");
  const fileBytes = Buffer.from("foundation cli acceptance\n", "utf8");
  let output;

  try {
    await writeFile(filePath, fileBytes);
    const bytesBefore = await readFile(filePath);

    const engineDenied = await runScenario({
      requestId: "foundation-engine-denied", cwd: tempDir, path: "known.txt",
      grantedEffects: ["filesystem.read"], engineGrants: [],
    });
    assert.equal(engineDenied.summary.completion, "incomplete");
    assert.equal(engineDenied.replies.length, 0, "adapter grant cannot override engine denial");
    assert.equal(engineDenied.report.atomicResults.length, 0);
    assert.ok(engineDenied.report.errors.some(error => error.code === "effect_denied"));

    const existing = await runScenario({
      requestId: "foundation-cli-existing",
      cwd: tempDir,
      path: "known.txt",
      grantedEffects: ["filesystem.read"],
    });
    assertOneAtomicResult(existing);
    const existingAtomic = existing.report.atomicResults[0];
    const existingReply = cliReplyFromAtomic(existingAtomic);
    assert.equal(existingAtomic.outcome, "succeeded");
    assert.equal(existingAtomic.executionErrorIds.length, 0);
    assert.deepEqual(existingReply, existing.replies[0]);
    assert.equal(existingReply.ok, true);
    assert.equal(existingReply.observation.kind, "attributes");
    assert.equal(existingReply.observation.type, "file");
    assert.equal(existing.report.states.at(-1).value, existingReply);
    assert.equal(existing.report.evidence.at(-1).payload, existingReply);
    assert.equal(existing.summary.completion, "complete");
    assert.equal(existing.summary.rootEvaluation.state, "evaluated");
    assert.equal(existing.summary.rootEvaluation.result, "satisfied");

    const missing = await runScenario({
      requestId: "foundation-cli-missing",
      cwd: tempDir,
      path: "missing.txt",
      grantedEffects: ["filesystem.read"],
    });
    assertOneAtomicResult(missing);
    const missingAtomic = missing.report.atomicResults[0];
    const missingReply = cliReplyFromAtomic(missingAtomic);
    assert.equal(missingAtomic.outcome, "failed");
    assert.deepEqual(missingReply, missing.replies[0]);
    assert.equal(missingReply.ok, false);
    assert.equal(missingReply.error.code, "ENOENT");
    assert.equal(missing.report.states.at(-1).value, missingReply);
    assert.equal(missing.report.evidence.at(-1).payload, missingReply);
    assert.equal(missingAtomic.executionErrorIds.length, 1);
    const missingError = missing.report.errors.find(
      error => error.errorId === missingAtomic.executionErrorIds[0],
    );
    assert.equal(missingError.code, "execution_failed");
    assert.equal(missingError.source.nativeCode, "ENOENT");
    assert.equal(missingError.diagnosticMessage, missingReply.error.message);
    assert.equal(missing.summary.completion, "complete");
    assert.equal(missing.summary.rootEvaluation.state, "evaluated");
    assert.equal(missing.summary.rootEvaluation.result, "satisfied");
    assert.ok(missing.summary.errors.some(
      error => error.source.nativeCode === "ENOENT",
    ));

    const denied = await runScenario({
      requestId: "foundation-cli-denied",
      cwd: tempDir,
      path: "known.txt",
      grantedEffects: [],
    });
    assertOneAtomicResult(denied);
    const deniedAtomic = denied.report.atomicResults[0];
    const deniedReply = cliReplyFromAtomic(deniedAtomic);
    assert.equal(deniedAtomic.outcome, "failed");
    assert.deepEqual(deniedReply, denied.replies[0]);
    assert.equal(deniedReply.ok, false);
    assert.equal(deniedReply.error.code, "EFFECT_DENIED");
    assert.equal(deniedAtomic.executionErrorIds.length, 1);
    const deniedError = denied.report.errors.find(
      error => error.errorId === deniedAtomic.executionErrorIds[0],
    );
    assert.equal(deniedError.code, "effect_denied");
    assert.equal(deniedError.source.nativeCode, "EFFECT_DENIED");
    assert.equal(deniedError.diagnosticMessage, deniedReply.error.message);
    assert.notEqual(denied.summary.completion, "complete");
    assert.notEqual(denied.summary.rootEvaluation.result, "satisfied");
    assert.ok(!denied.summary.errors.some(
      error => error.source.nativeCode === "ENOENT",
    ));

    const bytesAfter = await readFile(filePath);
    assert.ok(isDeepStrictEqual(bytesAfter, bytesBefore));
    assert.equal(process.cwd(), parentCwdBefore);

    output = {
      kind: "nnanything.foundation-cli-acceptance.v1",
      output: "fixed CLI/engine consumer only; no trained effect, product restoration, or broad recommendation",
      scenarios: {
        engineDenied: {
          completion: engineDenied.summary.completion,
          adapterInvocations: engineDenied.replies.length,
          errors: engineDenied.summary.errors,
        },
        existingFile: {
          completion: existing.summary.completion,
          atomicOutcome: existingAtomic.outcome,
          observedType: existingReply.observation.type,
          reply: existingReply,
        },
        missingTarget: {
          completion: missing.summary.completion,
          atomicOutcome: missingAtomic.outcome,
          rootEvaluation: missing.summary.rootEvaluation,
          executionErrors: missing.summary.errors,
          reply: missingReply,
        },
        adapterDenied: {
          completion: denied.summary.completion,
          atomicOutcome: deniedAtomic.outcome,
          rootEvaluation: denied.summary.rootEvaluation,
          executionErrors: denied.summary.errors,
          reply: deniedReply,
        },
      },
      invariants: {
        fileBytesUnchanged: true,
        parentProcessCwdUnchanged: true,
        tempDirectoryRemoved: true,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify(output, null, 2));
}

await main().catch(error => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
