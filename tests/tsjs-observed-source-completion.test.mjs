import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runTsJsSymbolTable,
} from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import {
  assessTsJsObservedDynamicCompletion,
  admitInitialEvidence,
} from "../dist/adapters/tsjs-unified-recursive.js";
import {
  loadStepwiseEpisodeFamily,
  observeTsJsStepwiseRequest,
} from "../dist/training/unified-student-converter.js";
import { relationStepContext } from "../dist/training/unified-step-context-builder.js";

const ENGINEERING_FILES = {
  "src/helper.js": `const table = {
  a: (x) => x,
  b: (x) => x + 1,
};
export function pick(k) {
  return table[k];
}
`,
  "src/caller.js": `import { pick } from "./helper.js";
export function run(k, x) {
  return pick(k)(x);
}
`,
  "src/other-helper.js": `const other = {
  a: (x) => x * 3,
  b: (x) => x * 5,
};
export function pickOther(k) {
  return other[k];
}
`,
  "src/other-caller.js": `import { pickOther } from "./other-helper.js";
export function runOther(k, x) {
  return pickOther(k)(x);
}
`,
  "src/dual-helper.js": `const first = {
  a: (x) => x + 1,
  b: (x) => x + 2,
};
export function pickFirst(k) {
  return first[k];
}
const second = {
  a: (x) => x + 3,
  b: (x) => x + 4,
};
export function pickSecond(k) {
  return second[k];
}
`,
  "src/dual-caller.js": `import { pickFirst, pickSecond } from "./dual-helper.js";
export function runBoth(k, x) {
  return pickFirst(k)(x) + pickSecond(k)(x);
}
`,
  "src/one-helper.js": `const one = {
  a: (x) => x + 1,
};
export function pickOne(k) {
  return one[k];
}
`,
  "src/one-caller.js": `import { pickOne } from "./one-helper.js";
export function runOne(k, x) {
  return pickOne(k)(x);
}
`,
  "src/mutated-helper.js": `const mutated = {
  a: (x) => x + 1,
  b: (x) => x + 2,
};
export function pickMutated(k) {
  return mutated[k];
}
pickMutated = replacement;
declare const replacement: typeof pickMutated;
`,
  "src/mutated-caller.js": `import { pickMutated } from "./mutated-helper.js";
export function runMutated(k, x) {
  return pickMutated(k)(x);
}
`,
  "src/broken.js": `const broken = ;
`,
};

async function makeEngineeringRepo() {
  const repo = await mkdtemp(join(tmpdir(), "tsjs-observed-completion-"));
  await mkdir(join(repo, "src"), { recursive: true });
  for (const [file, source] of Object.entries(ENGINEERING_FILES)) {
    await writeFile(join(repo, file), source);
  }
  return repo;
}

async function withEngineeringRepo(run) {
  const repo = await makeEngineeringRepo();
  try {
    return await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

function producerRequest(repo, files) {
  return {
    repo,
    language: "javascript",
    scope: ["src"],
    files,
  };
}

function exactTarget(member) {
  const identity = member.callableIdentity;
  assert.ok(identity);
  return {
    declarationRef: identity.declarationRef,
    moduleRef: `module:${identity.moduleRef}`,
    name: member.name,
    role: "member",
    kind: "function",
    evidenceRefs: [],
  };
}

function bridgeInput(producerRequestValue, observation, requestedDeclaration, overrides = {}) {
  const requestRef = overrides.requestRef ?? "request:engineering-completion";
  const pendingRelationRef = overrides.pendingRelationRef ?? "relation:engineering-completion";
  return {
    sourceGroup: "tsjs-observed-completion-engineering",
    language: "javascript",
    semanticStratum: "module_export",
    partition: "DEV",
    derivationFamily: "tsjs-observed-completion-engineering-family",
    sampleId: "engineering-completion",
    entryFile: "src/caller.js",
    request: {
      requestRef,
      requestedDeclaration,
      relationObligation: {
        requestRef,
        pendingRelationRef,
        callSiteRef: observation.callSiteRef,
        calleeName: "pick",
        ...(overrides.relationObligation ?? {}),
      },
    },
    stepId: overrides.stepId ?? "step:0",
    fromStepId: overrides.fromStepId ?? null,
    remainingObligations: overrides.remainingObligations ?? [],
    localCandidateCursor: overrides.localCandidateCursor ?? {
      pendingRelationRef,
      state: "closed",
      evidenceRefs: [],
    },
    producerRequest: producerRequestValue,
  };
}

async function buildRecord(repo, options = {}) {
  const files = options.files ?? ["src/caller.js", "src/helper.js"];
  const producer = await runTsJsSymbolTable(producerRequest(repo, files));
  assert.equal(producer.status, "ok", JSON.stringify(producer));
  if (producer.status !== "ok") return null;

  const observations = producer.result.runtimeSelectorObservations;
  const observation = observations[options.observationIndex ?? 0];
  assert.ok(observation, "selected observation");
  assert.ok(observation.callableTable, "typed callable table");

  const targetMember = options.targetMember
    ?? observation.callableTable.members.find(member => member.name === (options.targetName ?? "a"));
  assert.ok(targetMember, "requested table member");
  const requestedDeclaration = options.requestedDeclaration ?? exactTarget(targetMember);
  const bridge = await observeTsJsStepwiseRequest(bridgeInput(
    producerRequest(repo, files),
    observation,
    requestedDeclaration,
    options.bridgeOverrides,
  ));
  if (options.expectBridgeFailure) {
    assert.equal(bridge.record, null);
    return { producer, observation, bridge };
  }
  assert.deepEqual(bridge.reasons, []);
  assert.ok(bridge.record);
  return { producer, observation, bridge };
}

async function loadRecord(record) {
  const familyDir = await mkdtemp(join(tmpdir(), "tsjs-observed-completion-family-"));
  try {
    await mkdir(familyDir, { recursive: true });
    await writeFile(join(familyDir, "manifest.json"), JSON.stringify({
      sourceGroup: record.sourceGroup,
      language: record.language,
      semanticStratum: record.semanticStratum,
      partition: record.partition,
      derivationFamily: { familyId: record.family },
    }));
    await writeFile(
      join(familyDir, "student-observations.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    return await loadStepwiseEpisodeFamily(familyDir);
  } finally {
    await rm(familyDir, { recursive: true, force: true });
  }
}

function completionState(episode, overrides = {}) {
  return {
    stepSequence: [episode.stepId],
    context: relationStepContext(episode),
    terminal: true,
    terminalKind: "judge",
    terminalJudgement: "judge=unknown",
    ...overrides,
  };
}

function assessmentOf(episodes, overrides = {}, mutate = null) {
  const changed = mutate === null ? episodes : structuredClone(episodes);
  if (mutate !== null) mutate(changed[0]);
  const admission = admitInitialEvidence(changed[0].requestId, changed);
  const assessment = assessTsJsObservedDynamicCompletion(
    changed,
    completionState(changed[0], overrides),
    admission.initialObservation?.evidence ?? [],
  );
  return { admission, assessment, episodes: changed };
}

function gapCodes(assessment) {
  return assessment.gaps.map(gap => gap.code);
}

test("observed-source completion accepts an exact fully supported engineering record", async () => {
  await withEngineeringRepo(async repo => {
    const { observation, bridge } = await buildRecord(repo);
    const episodes = await loadRecord(bridge.record);
    const admission = admitInitialEvidence(episodes[0].requestId, episodes);
    assert.deepEqual(admission.invalidReasons, []);

    const assessment = assessTsJsObservedDynamicCompletion(
      episodes,
      completionState(episodes[0]),
      admission.initialObservation.evidence,
    );
    assert.equal(assessment.status, "supported");
    assert.equal(assessment.producer_backed, true);
    assert.deepEqual(assessment.gaps, []);
    assert.ok(assessment.evidenceRefs.includes(observation.sourceReadRef));

    const work = episodes[0].receipts[0].producerSource.completionWork;
    assert.ok(work);
    assert.deepEqual(
      work.items.map(item => [item.kind, item.subjectRef]),
      [
        ["source_read", "src/caller.js"],
        ["source_read", "src/helper.js"],
        ["selector_structure", observation.observationRef],
        ["callable_identity", observation.callableTable.members[0].initializerRef],
        ["callable_identity", observation.callableTable.members[1].initializerRef],
        ["requested_target_mapping", observation.callableTable.members[0].callableIdentity.declarationRef],
        ["selector_scope", observation.callSiteRef],
      ],
    );
    assert.ok(work.items.every(item => item.disposition.state === "satisfied"));
  });
});

test("observed-source completion rejects unrelated, same-name, and property-span targets", async () => {
  await withEngineeringRepo(async repo => {
    const dual = await buildRecord(repo, {
      files: ["src/dual-caller.js", "src/dual-helper.js"],
      observationIndex: 0,
      targetMember: null,
      targetName: "a",
    });
    const first = dual.observation.callableTable.members.find(member => member.name === "a");
    const second = dual.producer.result.runtimeSelectorObservations[1].callableTable.members
      .find(member => member.name === "a");
    assert.ok(first?.callableIdentity);
    assert.ok(second?.callableIdentity);
    assert.equal(first.callableIdentity.moduleRef, second.callableIdentity.moduleRef);
    assert.notEqual(first.callableIdentity.declarationRef, second.callableIdentity.declarationRef);

    const sameNameDifferentSpan = await buildRecord(repo, {
      files: ["src/dual-caller.js", "src/dual-helper.js"],
      observationIndex: 0,
      requestedDeclaration: exactTarget(second),
    });
    const sameSpanAssessment = assessmentOf(await loadRecord(sameNameDifferentSpan.bridge.record));
    assert.equal(sameSpanAssessment.assessment.status, "incomplete");
    assert.ok(gapCodes(sameSpanAssessment.assessment).includes("requested_target_mapping_invalid"));

    const other = await buildRecord(repo, {
      files: ["src/other-caller.js", "src/other-helper.js"],
    });
    const otherModule = await buildRecord(repo, {
      requestedDeclaration: exactTarget(other.observation.callableTable.members[0]),
    });
    const otherModuleAssessment = assessmentOf(await loadRecord(otherModule.bridge.record));
    assert.equal(otherModuleAssessment.assessment.status, "incomplete");
    assert.ok(gapCodes(otherModuleAssessment.assessment).includes("requested_target_mapping_invalid"));

    const propertySpan = await buildRecord(repo, {
      requestedDeclaration: {
        ...exactTarget(first),
        declarationRef: first.initializerRef,
      },
    });
    const propertyAssessment = assessmentOf(await loadRecord(propertySpan.bridge.record));
    assert.equal(propertyAssessment.assessment.status, "incomplete");
    assert.ok(gapCodes(propertyAssessment.assessment).includes("requested_target_mapping_invalid"));
  });
});

test("observed-source completion rejects unsupported, missing, or substituted identities", async () => {
  await withEngineeringRepo(async repo => {
    const oneMemberProducer = await runTsJsSymbolTable(producerRequest(repo, [
      "src/one-caller.js",
      "src/one-helper.js",
    ]));
    assert.equal(oneMemberProducer.status, "ok", JSON.stringify(oneMemberProducer));
    if (oneMemberProducer.status !== "ok") return;
    assert.equal(oneMemberProducer.result.runtimeSelectorObservations.length, 0);
    assert.ok(
      oneMemberProducer.result.runtimeSelectorGaps.some(
        gap => gap.reason === "unsupported_selector_shape",
      ),
    );

    const mutatedProducer = await runTsJsSymbolTable(producerRequest(repo, [
      "src/mutated-caller.js",
      "src/mutated-helper.js",
    ]));
    assert.equal(mutatedProducer.status, "ok", JSON.stringify(mutatedProducer));
    if (mutatedProducer.status !== "ok") return;
    assert.equal(mutatedProducer.result.runtimeSelectorObservations.length, 0);
    assert.ok(
      mutatedProducer.result.runtimeSelectorGaps.some(
        gap => gap.reason === "unsupported_selector_shape",
      ),
    );

    const valid = await buildRecord(repo);
    const missingIdentity = assessmentOf(
      await loadRecord(valid.bridge.record),
      {},
      episode => {
        episode.receipts[0].producerSource.rawObservation.callableTable.members[0].callableIdentity = null;
      },
    );
    assert.equal(missingIdentity.assessment.status, "incomplete");
    assert.ok(gapCodes(missingIdentity.assessment).includes("callable_identity_invalid"));

    const substituted = assessmentOf(
      await loadRecord(valid.bridge.record),
      {},
      episode => {
        const member = episode.receipts[0].producerSource.rawObservation.callableTable.members[0];
        member.callableIdentity.declarationRef = member.initializerRef;
      },
    );
    assert.equal(substituted.assessment.status, "incomplete");
    assert.ok(gapCodes(substituted.assessment).includes("callable_identity_invalid"));
  });
});

test("observed-source completion rejects failed, parse-error, and truncated reads", async () => {
  await withEngineeringRepo(async repo => {
    const missing = await buildRecord(repo, {
      files: ["src/caller.js", "src/helper.js", "src/missing.js"],
    });
    const missingAssessment = assessmentOf(await loadRecord(missing.bridge.record));
    assert.equal(missingAssessment.assessment.status, "incomplete");
    assert.ok(gapCodes(missingAssessment.assessment).includes("completion_work_unsatisfied"));

    const parseError = await buildRecord(repo, {
      files: ["src/caller.js", "src/helper.js", "src/broken.js"],
    });
    const parseAssessment = assessmentOf(await loadRecord(parseError.bridge.record));
    assert.equal(parseAssessment.assessment.status, "incomplete");
    assert.ok(gapCodes(parseAssessment.assessment).includes("completion_work_unsatisfied"));

    const valid = await buildRecord(repo);
    const truncated = assessmentOf(
      await loadRecord(valid.bridge.record),
      {},
      episode => {
        const source = episode.receipts[0].producerSource;
        source.coverage.truncated = true;
        episode.notReady = true;
      },
    );
    assert.equal(truncated.assessment.status, "incomplete");
    assert.ok(
      gapCodes(truncated.assessment).some(code =>
        code === "completion_work_unsatisfied" || code === "completion_evidence_invalid"),
    );
  });
});

test("observed-source completion rejects omitted, duplicate, unexpected, and open work", async () => {
  await withEngineeringRepo(async repo => {
    const valid = await buildRecord(repo);
    const loaded = await loadRecord(valid.bridge.record);

    const empty = assessmentOf(loaded, {}, episode => {
      episode.receipts[0].producerSource.completionWork.items = [];
    });
    assert.equal(empty.assessment.status, "incomplete");
    assert.ok(gapCodes(empty.assessment).includes("completion_work_omits_required_item"));

    const omitted = assessmentOf(loaded, {}, episode => {
      const items = episode.receipts[0].producerSource.completionWork.items;
      items.splice(3, 1);
    });
    assert.equal(omitted.assessment.status, "incomplete");
    assert.ok(gapCodes(omitted.assessment).includes("completion_work_omits_required_item"));

    const duplicate = assessmentOf(loaded, {}, episode => {
      const items = episode.receipts[0].producerSource.completionWork.items;
      items.push(structuredClone(items[0]));
    });
    assert.equal(duplicate.assessment.status, "incomplete");
    assert.ok(gapCodes(duplicate.assessment).includes("completion_work_duplicate_item"));

    const unexpected = assessmentOf(loaded, {}, episode => {
      const items = episode.receipts[0].producerSource.completionWork.items;
      items.push({
        kind: "selector_scope",
        subjectRef: "call:unexpected",
        disposition: { state: "satisfied", evidenceRefs: [valid.observation.sourceReadRef] },
      });
    });
    assert.equal(unexpected.assessment.status, "incomplete");
    assert.ok(gapCodes(unexpected.assessment).includes("completion_work_unexpected_item"));

    const unresolved = assessmentOf(loaded, {}, episode => {
      const item = episode.receipts[0].producerSource.completionWork.items[0];
      item.disposition = {
        state: "unresolved",
        evidenceRefs: [valid.observation.sourceReadRef],
        reason: "engineering negative control",
      };
    });
    assert.equal(unresolved.assessment.status, "incomplete");
    assert.ok(gapCodes(unresolved.assessment).includes("completion_work_unsatisfied"));

    for (const state of ["open", "failed"]) {
      const cursor = assessmentOf(loaded, {}, episode => {
        episode.localCandidateCursor.state = state;
      });
      assert.equal(cursor.assessment.status, "incomplete", state);
      assert.ok(gapCodes(cursor.assessment).includes("work_state_open"), state);
    }
  });
});

test("observed-source completion rejects binding, role, and visit substitutions", async () => {
  await withEngineeringRepo(async repo => {
    const valid = await buildRecord(repo);
    const loaded = await loadRecord(valid.bridge.record);
    const mutations = {
      request: episode => {
        episode.receipts[0].producerSource.requestRef = "request:other";
      },
      callSite: episode => {
        episode.receipts[0].producerSource.callSiteRef = "call:other";
      },
      pending: episode => {
        episode.receipts[0].producerSource.pendingRelationRef = "relation:other";
      },
      step: episode => {
        episode.receipts[0].producerSource.stepId = "step:other";
      },
      predecessor: episode => {
        episode.receipts[0].producerSource.fromStepId = "step:other";
      },
      requestedTarget: episode => {
        episode.receipts[0].producerSource.requestedDeclarationRef = "callable:other";
      },
      role: episode => {
        episode.receipts[0].producerSource.rawObservation.facts[0].role =
          "runtime_selector_dependency";
      },
      readRef: episode => {
        episode.receipts[0].producerSource.rawObservation.sourceReadRef = "source-read:other";
      },
    };

    for (const [label, mutate] of Object.entries(mutations)) {
      const { assessment } = assessmentOf(loaded, {}, mutate);
      assert.notEqual(assessment.status, "supported", label);
    }

    const { assessment: unvisited } = assessmentOf(loaded, {
      stepSequence: [],
      context: {
        ...relationStepContext(loaded[0]),
        stepId: "step:unvisited",
      },
    });
    assert.notEqual(unvisited.status, "supported");
  });
});

test("loader rejects malformed completionWork and substituted projections", async () => {
  await withEngineeringRepo(async repo => {
    const valid = await buildRecord(repo);

    const malformed = [
      ["contract", record => {
        record.steps[0].receipts[0].producerSource.completionWork.contract = "wrong";
      }],
      ["scope", record => {
        record.steps[0].receipts[0].producerSource.completionWork.scope = "global";
      }],
      ["kind", record => {
        record.steps[0].receipts[0].producerSource.completionWork.items[0].kind = "unknown";
      }],
      ["state", record => {
        record.steps[0].receipts[0].producerSource.completionWork.items[0].disposition.state =
          "unknown";
      }],
      ["reason", record => {
        const item = record.steps[0].receipts[0].producerSource.completionWork.items[0];
        item.disposition = {
          state: "unresolved",
          evidenceRefs: [record.steps[0].receipts[0].producerSource.rawObservation.sourceReadRef],
        };
      }],
      ["empty-items", record => {
        record.steps[0].receipts[0].producerSource.completionWork.items = [];
      }],
      ["duplicate-item", record => {
        const items = record.steps[0].receipts[0].producerSource.completionWork.items;
        items.push(structuredClone(items[0]));
      }],
      ["unexpected-item", record => {
        record.steps[0].receipts[0].producerSource.completionWork.items.push({
          kind: "selector_scope",
          subjectRef: "call:unexpected",
          disposition: { state: "satisfied", evidenceRefs: [] },
        });
      }],
      ["missing-identity", record => {
        record.steps[0].receipts[0].producerSource.rawObservation.callableTable.members[0]
          .callableIdentity = null;
      }],
      ["backslash-identity", record => {
        const identity =
          record.steps[0].receipts[0].producerSource.rawObservation.callableTable.members[0]
            .callableIdentity;
        identity.moduleRef = "src\\\\helper.js";
      }],
      ["prefixed-identity", record => {
        const identity =
          record.steps[0].receipts[0].producerSource.rawObservation.callableTable.members[0]
            .callableIdentity;
        identity.moduleRef = "module:src/helper.js";
      }],
      ["duplicate-receipt-module", record => {
        const modules =
          record.steps[0].receipts[0].producerSource.rawObservation.sourceReadReceipt.modules;
        modules.push(structuredClone(modules[0]));
      }],
    ];

    for (const [label, mutate] of malformed) {
      const record = structuredClone(valid.bridge.record);
      mutate(record);
      await assert.rejects(loadRecord(record), label);
    }
  });
});

test("historical producer-backed records remain loadable but cannot use the new completion branch", async () => {
  await withEngineeringRepo(async repo => {
    const valid = await buildRecord(repo);

    const withoutWork = structuredClone(valid.bridge.record);
    delete withoutWork.steps[0].receipts[0].producerSource.completionWork;
    const historicalWork = await loadRecord(withoutWork);
    const historicalAssessment = assessmentOf(historicalWork);
    assert.equal(historicalAssessment.assessment.status, "incomplete");
    assert.ok(gapCodes(historicalAssessment.assessment).includes("completion_work_missing"));

    const withoutTable = structuredClone(withoutWork);
    delete withoutTable.steps[0].receipts[0].producerSource.rawObservation.callableTable;
    const historicalTable = await loadRecord(withoutTable);
    const historicalTableAssessment = assessmentOf(historicalTable);
    assert.equal(historicalTableAssessment.assessment.status, "incomplete");
    assert.ok(gapCodes(historicalTableAssessment.assessment).includes("completion_work_missing"));

    const malformedTable = structuredClone(valid.bridge.record);
    delete malformedTable.steps[0].receipts[0].producerSource.rawObservation.callableTable;
    await assert.rejects(loadRecord(malformedTable));
  });
});
