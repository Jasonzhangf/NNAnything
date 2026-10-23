import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { prepareBasicKindSamples, partitionBasicKindSamples } from "nnanything/training";

const TASK_ID = "dom.basic-kinds.v1";
const INPUT_SCOPE = "candidate_qualified";
const PARTITION_SEED = 20261021;
const FIT_USAGE = new Set(["train", "eval"]);
const EXPERIMENT_FAMILIES = new Set(["sample-repair-train", "sample-repair-dev", "sample-repair-verification"]);
const WRAPPER_TYPES = ["W1", "W2", "W3"];
const POSITIVE_TABINDEX = [-1, 0];
const POSITIVE_STATES = ["initial", "focused", "blurred", "refocused"];
const IGNORE_STATES = ["before", "after"];
const HOLD_FOCUS_STATES = ["focused", "refocused"];
const TRAIN_SCHEMA = "browser-focus-sample-repair.snapshot.v1";
const DEV_SCHEMA = "browser-focus-sample-repair.capture-dev.snapshot.v1";
const VERIFICATION_SCHEMA = "browser-focus-sample-repair-verification.snapshot.v1";

function readJson(file, label) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function captureStates(capture) {
  return normalizeCaptureStates(capture);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function experimentStateName(family, name, state = null) {
  if (family === "sample-repair-dev") {
    if (name === "descendant-initial") return "before";
    if (name === "descendant-focused") return "after";
  }
  if (family === "sample-repair-verification") {
    if (name === "unfocused") return "before";
    if (name === "focused" && (state?.kind === "ignore" || state?.gold === "ignore")) return "after";
  }
  return name;
}

function snapshotRefOf(state, family, objectId, stateName) {
  if (typeof state.snapshotRef === "string" && state.snapshotRef.length > 0) return state.snapshotRef;
  return `${family}/${objectId}/${stateName}`;
}

function normalizeTrainState(state, family) {
  const wrapperRow = state.wrapperRow;
  if (!wrapperRow || typeof wrapperRow !== "object" || typeof wrapperRow.nodeRef !== "string") {
    throw new Error(`${String(state.caseId ?? state.sampleId ?? "?")} has no wrapperRow/nodeRef`);
  }
  const objectId = typeof state.objectId === "string" ? state.objectId : wrapperRow.nodeRef;
  const stateName = experimentStateName(family, String(state.stateName ?? state.state ?? ""));
  const snapshotRef = snapshotRefOf(state, family, objectId, stateName);
  return {
    sampleId: state.sampleId ?? `${family}:${objectId}:${stateName}`,
    objectId,
    wrapperType: String(state.wrapperType ?? state.construction ?? "").toUpperCase(),
    tabindex: state.tabindex === undefined ? null : state.tabindex,
    stateName,
    gold: state.gold ?? wrapperRow.gold ?? null,
    wrapperRow,
    properties: Array.isArray(state.properties) ? state.properties : [],
    snapshotRef,
    documentRef: state.documentRef ?? family,
    sourceAssociations: Array.isArray(state.sourceAssociations?.snapshotRefs)
      ? state.sourceAssociations
      : { snapshotRefs: [snapshotRef], postRefs: [], assetRefs: [state.documentRef ?? family] },
    evidenceRef: state.review?.evidenceRef ?? state.evidenceRef ?? null,
    reviewerRef: state.review?.reviewerRef ?? null,
  };
}

function normalizeDevState(state, family = "sample-repair-dev") {
  const wrapperRow = state.containerRow;
  if (!wrapperRow || typeof wrapperRow !== "object" || typeof wrapperRow.nodeRef !== "string") {
    throw new Error(`dev capture ${String(state.caseId ?? "?")} has no containerRow/nodeRef`);
  }
  const objectId = typeof state.caseId === "string" ? state.caseId : wrapperRow.nodeRef;
  const wrapperType = String(state.construction ?? wrapperRow.tag ?? "").toUpperCase();
  const stateName = experimentStateName(family, String(state.state ?? ""), state);
  const kind = String(state.kind ?? "");
  const gold = kind === "ignore" ? "ignore" : kind === "positive" ? "container" : state.gold ?? null;
  const snapshotRef = snapshotRefOf(state, family, objectId, stateName);
  return {
    sampleId: `${family}:${objectId}:${stateName}`,
    objectId,
    wrapperType,
    tabindex: numberOrNull(state.target?.tabindexAttribute ?? wrapperRow.tabindexAttribute),
    stateName,
    gold,
    wrapperRow,
    properties: Array.isArray(state.properties) ? state.properties : [],
    snapshotRef,
    documentRef: state.documentRef ?? family,
    sourceAssociations: { snapshotRefs: [snapshotRef], postRefs: [], assetRefs: [state.documentRef ?? family] },
    evidenceRef: null,
    reviewerRef: null,
  };
}

function normalizeVerificationState(state, family = "sample-repair-verification") {
  const row = state.targetProperties;
  const wrapperRow = row && typeof row === "object"
    ? { ...row, nodeRef: row.nodeRef ?? state.targetRef }
    : null;
  if (!wrapperRow || typeof wrapperRow.nodeRef !== "string") {
    throw new Error(`verification capture ${String(state.caseId ?? "?")} has no targetProperties/targetRef`);
  }
  const objectId = typeof state.caseId === "string" ? state.caseId : wrapperRow.nodeRef;
  const wrapperType = String(state.construction ?? wrapperRow.tag ?? "").toUpperCase();
  const stateName = experimentStateName(family, String(state.state ?? ""), state);
  const snapshotRef = snapshotRefOf(state, family, objectId, stateName);
  return {
    sampleId: `${family}:${objectId}:${stateName}`,
    objectId,
    wrapperType,
    tabindex: numberOrNull(state.tabindexAttribute ?? wrapperRow.tabindexAttribute),
    stateName,
    gold: state.gold ?? null,
    wrapperRow,
    properties: Array.isArray(state.properties) ? state.properties : [],
    snapshotRef,
    documentRef: state.documentRef ?? family,
    sourceAssociations: { snapshotRefs: [snapshotRef], postRefs: [], assetRefs: [state.documentRef ?? family] },
    evidenceRef: null,
    reviewerRef: null,
  };
}

function normalizeCaptureStates(capture) {
  if (!Array.isArray(capture?.states)) throw new TypeError("capture.states must be an array");
  const family = capture.family ?? null;
  return capture.states.map(state => {
    const schema = String(state.schemaVersion ?? "");
    if (schema.startsWith(DEV_SCHEMA)) return normalizeDevState(state, family ?? "sample-repair-dev");
    if (schema.startsWith(VERIFICATION_SCHEMA)) return normalizeVerificationState(state, family ?? "sample-repair-verification");
    return normalizeTrainState(state, family ?? "sample-repair-train");
  });
}

function stateObjectId(state) {
  return typeof state.objectId === "string" ? state.objectId : state.wrapperRow?.nodeRef ?? null;
}

export function auditMatrix(capture) {
  const states = normalizeCaptureStates(capture);
  if (states.length !== 30) {
    throw new Error(`matrix audit failed: expected 30 states, got ${states.length}`);
  }
  const objects = new Set(states.map(stateObjectId).filter(id => id !== null));
  if (objects.size !== 9) throw new Error(`matrix audit failed: expected 9 objects, got ${objects.size}`);
  const byKey = new Map();
  for (const state of states) {
    const wrapperType = String(state.wrapperType ?? state.construction ?? "").toUpperCase();
    const tabindex = state.tabindex;
    const name = String(state.stateName ?? state.state ?? "");
    const gold = state.gold ?? state.wrapperRow?.gold ?? null;
    if (!WRAPPER_TYPES.includes(wrapperType)) throw new Error(`matrix audit failed: unknown wrapper type ${wrapperType}`);
    if (tabindex !== -1 && tabindex !== 0 && tabindex !== null && tabindex !== undefined) {
      throw new Error(`matrix audit failed: unexpected tabindex ${tabindex}`);
    }
    const tabKey = tabindex === undefined ? null : tabindex;
    const key = `${wrapperType}|${tabKey}|${name}`;
    if (byKey.has(key)) throw new Error(`matrix audit failed: duplicate state ${key}`);
    byKey.set(key, state);
  }
  for (const wrapperType of WRAPPER_TYPES) {
    for (const tabindex of POSITIVE_TABINDEX) {
      for (const name of POSITIVE_STATES) {
        const key = `${wrapperType}|${tabindex}|${name}`;
        if (!byKey.has(key)) throw new Error(`matrix audit failed: missing positive state ${key}`);
      }
    }
    for (const name of IGNORE_STATES) {
      const key = `${wrapperType}|null|${name}`;
      if (!byKey.has(key)) throw new Error(`matrix audit failed: missing ignore state ${key}`);
    }
  }
  const missingHoldFocusFacts = [];
  for (const state of states) {
    if (state.tabindex !== -1 && state.tabindex !== 0) continue;
    const stateName = String(state.stateName ?? state.state ?? "");
    if (!HOLD_FOCUS_STATES.includes(stateName)) continue;
    const row = state.wrapperRow ?? {};
    const af = row.activeElementFocus;
    const fc = row.tabIndexFocus;
    const expectedFc = state.tabindex === 0;
    if (af !== true || fc !== expectedFc) {
      missingHoldFocusFacts.push({
        sampleId: state.sampleId ?? state.caseId,
        tabindex: state.tabindex,
        stateName,
        activeElementFocus: af,
        tabIndexFocus: fc,
      });
    }
  }
  if (missingHoldFocusFacts.length > 0) {
    throw new Error(`matrix audit failed: hold-focus positives must have af=true and fc matching tabindex: ${JSON.stringify(missingHoldFocusFacts)}`);
  }
  return { ok: true, states: states.length, objects: objects.size, missingHoldFocusFacts: missingHoldFocusFacts.length };
}

export function auditUsageAndClosure({ family, capture, usage }) {
  const states = normalizeCaptureStates(capture);
  const assigned = new Map();
  for (const entry of usage ?? []) {
    if (typeof entry?.sampleId !== "string") throw new Error("usage entry missing sampleId");
    if (typeof entry.usage !== "string") throw new Error("usage entry missing usage");
    if (assigned.has(entry.sampleId)) throw new Error(`usage audit failed: duplicate usage entry ${entry.sampleId}`);
    assigned.set(entry.sampleId, entry.usage);
  }
  const familyUsage = family === "sample-repair-train" ? "train" : family === "sample-repair-dev" ? "dev" : null;
  if (familyUsage === null) throw new Error(`usage audit failed: unsupported family ${family}`);
  const stateIds = new Set(states.map(state => state.sampleId));
  for (const [sampleId, usage] of assigned) {
    if (stateIds.has(sampleId) && usage !== familyUsage) {
      throw new Error(`usage audit failed: ${sampleId} uses ${usage}, expected ${familyUsage}`);
    }
  }
  for (const state of states) {
    if (!assigned.has(state.sampleId)) {
      throw new Error(`usage audit failed: unassigned ${state.sampleId}`);
    }
  }
  const usageBySample = new Map(states.map(state => [state.sampleId, assigned.get(state.sampleId)]));
  const usageByObject = new Map();
  for (const state of states) {
    const objectId = stateObjectId(state);
    if (objectId === null) continue;
    const previous = usageByObject.get(objectId);
    const current = usageBySample.get(state.sampleId);
    if (previous !== undefined && previous !== current) {
      throw new Error(`usage audit failed: object ${objectId} split across usages ${previous} and ${current}`);
    }
    usageByObject.set(objectId, current);
  }
  const usageByRef = new Map();
  for (const state of states) {
    for (const ref of state.sourceAssociations?.snapshotRefs ?? [state.snapshotRef]) {
      const previous = usageByRef.get(ref);
      const current = usageBySample.get(state.sampleId);
      if (previous !== undefined && previous !== current) {
        throw new Error(`usage audit failed: source ref ${ref} split across usages ${previous} and ${current}`);
      }
      usageByRef.set(ref, current);
    }
  }
  return { ok: true, family, assigned: assigned.size, objects: usageByObject.size };
}

function propertiesEntries(state) {
  if (Array.isArray(state.properties)) return state.properties;
  if (state.wrapperRow && typeof state.wrapperRow === "object") {
    return [{ nodeRef: state.wrapperRow.nodeRef, ...state.wrapperRow }];
  }
  return [];
}

export function auditFactFidelity({ capture, rowField = "wrapperRow" }) {
  const states = normalizeCaptureStates(capture);
  for (const state of states) {
    const row = state[rowField];
    if (row === undefined || row === null) continue;
    if (!Array.isArray(state.properties)) {
      throw new Error(`fact fidelity audit failed: ${state.sampleId} has wrapperRow but no properties array`);
    }
    const properties = propertiesEntries(state);
    let matched = false;
    for (const entry of properties) {
      const ref = entry.nodeRef;
      if (ref === undefined || ref === null) continue;
      if (ref === row.nodeRef) {
        matched = true;
        const names = ["activeElementFocus", "tabIndexFocus", "own_focus_target"];
        for (const name of names) {
          if (row[name] === null && entry[name] === false) {
            throw new Error(`fact fidelity audit failed: ${state.sampleId} converted null ${name} to false`);
          }
          if (row[name] === false && entry[name] === null) {
            throw new Error(`fact fidelity audit failed: ${state.sampleId} converted false ${name} to null`);
          }
        }
      }
    }
    if (!matched) {
      throw new Error(`fact fidelity audit failed: ${state.sampleId} properties missing wrapperRow nodeRef ${row.nodeRef}`);
    }
  }
  return { ok: true, states: states.length };
}

export function auditVerificationIsolation({ fitRequests, verification }) {
  const verificationIds = new Set();
  for (const state of normalizeCaptureStates({ states: verification })) {
    if (typeof state.sampleId === "string") verificationIds.add(state.sampleId);
    if (typeof state.caseId === "string") verificationIds.add(state.caseId);
  }
  const violations = [];
  for (const request of fitRequests ?? []) {
    for (const row of request?.rows ?? []) {
      if (typeof row?.sampleId !== "string") continue;
      if (row.sampleId.startsWith("sample-repair-verification") || verificationIds.has(row.sampleId)) {
        violations.push(row.sampleId);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`verification isolation audit failed: verification rows in fit request: ${violations.join(", ")}`);
  }
  return { ok: true, verificationIds: verificationIds.size, fitRequests: fitRequests?.length ?? 0 };
}

function rowForState(state, family, index, oracleEntry) {
  const row = state.wrapperRow;
  if (!row || typeof row !== "object") {
    throw new Error(`${family} capture ${state.caseId ?? state.sampleId} has no wrapperRow`);
  }
  const { nodeRef, ...properties } = row;
  if (typeof nodeRef !== "string" || nodeRef.length === 0) {
    throw new Error(`${family} capture ${state.caseId ?? state.sampleId} wrapperRow has no nodeRef`);
  }
  const sampleId = typeof state.sampleId === "string" && state.sampleId.length > 0
    ? state.sampleId
    : `${family}:${state.caseId ?? index}`;
  return {
    sampleId,
    inputRef: {
      snapshotRef: state.snapshotRef ?? `${family}/${state.caseId ?? index}`,
      documentRef: state.documentRef ?? family,
      frameRef: "top",
      nodeRef,
      index,
    },
    provenanceRef: `${sampleId}:evidence`,
    sourceAssociations: {
      snapshotRefs: Array.isArray(state.sourceAssociations?.snapshotRefs)
        ? state.sourceAssociations.snapshotRefs
        : [state.snapshotRef ?? `${family}/${state.caseId ?? index}`],
      postRefs: state.sourceAssociations?.postRefs ?? [],
      assetRefs: [state.documentRef ?? family],
    },
    candidateQualification: { status: "ok", reasons: [] },
    captureCoverage: { frameContent: "captured", directChildren: "complete" },
    properties,
    proposal: { ruleRef: null, label: null, status: "unknown" },
    review: {
      status: "verified",
      expectedLabel: oracleEntry.expectedLabel,
      reviewerRef: oracleEntry.reviewerRef ?? state.reviewerRef ?? "p4-supervision",
      evidenceRef: oracleEntry.evidenceRef ?? state.evidenceRef ?? `${family}:${state.caseId ?? state.sampleId}`,
      otherReason: null,
    },
  };
}

function cloneRow(row) {
  return { ...row, inputRef: { ...row.inputRef } };
}

function sourceRow(prepared) {
  const { index: _index, included: _included, reasons: _reasons, ...clean } = prepared;
  return clean;
}

function positiveGold(state) {
  return state.gold ?? state.expectedLabel ?? "container";
}

function sortExperimentRows(rows) {
  const rank = state => {
    const wrapper = String(state.wrapperType ?? state.construction ?? "").toUpperCase();
    const tabindex = state.tabindex;
    const name = String(state.stateName ?? state.state ?? "");
    const wrapperRank = WRAPPER_TYPES.indexOf(wrapper);
    const tabRank = tabindex === -1 ? 0 : tabindex === 0 ? 1 : 2;
    const stateRank = POSITIVE_STATES.includes(name) ? POSITIVE_STATES.indexOf(name) : IGNORE_STATES.length + IGNORE_STATES.indexOf(name);
    return wrapperRank * 100 + tabRank * 20 + stateRank;
  };
  return rows
    .map((row, index) => ({ row, index, state: row.__captureState, rank: rank(row.__captureState) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ row }) => {
      const { __captureState, ...clean } = row;
      return clean;
    });
}

function withCapturedState(row, state) {
  return { ...row, __captureState: state };
}

export function prepareExperiments({
  request,
  partition,
  trainCapture,
  devCapture,
  verificationCapture,
}) {
  if (!Array.isArray(request?.rows)) throw new Error("source request.rows must be an array");
  const explicitUsage = Array.isArray(partition) ? partition : partition?.explicitUsage;
  if (!Array.isArray(explicitUsage)) throw new Error("partition explicitUsage must be an array or carry an explicitUsage array");

  auditMatrix(trainCapture);
  auditMatrix(devCapture);
  if (verificationCapture) auditMatrix(verificationCapture);

  auditUsageAndClosure({
    family: "sample-repair-train",
    capture: trainCapture,
    usage: [
      ...captureStates(trainCapture).map(state => ({ sampleId: state.sampleId, usage: "train" })),
      ...explicitUsage,
    ],
  });

  const devUsage = captureStates(devCapture).map(state => ({ sampleId: state.sampleId, usage: "dev" }));
  const verificationUsage = verificationCapture
    ? captureStates(verificationCapture).map(state => ({ sampleId: state.sampleId, usage: "verification" }))
    : [];
  auditUsageAndClosure({ family: "sample-repair-dev", capture: devCapture, usage: devUsage });

  const verificationStates = verificationCapture ? captureStates(verificationCapture) : [];
  auditFactFidelity({ capture: trainCapture });
  auditFactFidelity({ capture: devCapture });
  if (verificationCapture) auditFactFidelity({ capture: verificationCapture });

  const oldRows = request.rows.map(row => cloneRow(row));
  const oldSampleIds = oldRows.map(row => row.sampleId);
  const partitionBySample = new Map(explicitUsage.map(entry => [entry.sampleId, entry.usage]));
  for (const row of oldRows) {
    if (!partitionBySample.has(row.sampleId)) {
      throw new Error(`partition usage missing old sample ${row.sampleId}`);
    }
  }
  for (const entry of explicitUsage) {
    if (!FIT_USAGE.has(entry.usage)) {
      throw new Error(`partition usage must stay train/eval, got ${entry.usage} for ${entry.sampleId}`);
    }
  }
  const trainRows = sortExperimentRows(
    captureStates(trainCapture).map((state, offset) => withCapturedState(
      rowForState(state, "sample-repair-train", oldRows.length + offset, {
        expectedLabel: positiveGold(state),
        reviewerRef: state.reviewerRef ?? state.review?.reviewerRef ?? "p4-supervision",
        evidenceRef: state.evidenceRef ?? state.review?.evidenceRef ?? `sample-repair-train:${state.sampleId}`,
      }),
      state,
    )),
  );
  const devRows = sortExperimentRows(
    captureStates(devCapture).map((state, offset) => withCapturedState(
      rowForState(state, "sample-repair-dev", oldRows.length + trainRows.length + offset, {
        expectedLabel: positiveGold(state),
        reviewerRef: state.reviewerRef ?? state.review?.reviewerRef ?? "p4-supervision",
        evidenceRef: state.evidenceRef ?? state.review?.evidenceRef ?? `sample-repair-dev:${state.sampleId}`,
      }),
      state,
    )),
  );

  const preparedAll = prepareBasicKindSamples(
    { schemaVersion: 1, taskId: TASK_ID, rows: [...oldRows, ...trainRows] },
    { taskId: TASK_ID, inputScope: INPUT_SCOPE },
  );
  const oldPrepared = preparedAll.rows.slice(0, oldRows.length);
  const oldInputRefs = oldPrepared.map(row => JSON.stringify(row.inputRef));
  const sourceInputRefs = oldRows.map(row => JSON.stringify(row.inputRef));
  if (oldPrepared.length !== oldRows.length || oldPrepared.some((row, index) => row.sampleId !== oldSampleIds[index])) {
    throw new Error("prepare changed old row order");
  }
  if (oldInputRefs.join("\n") !== sourceInputRefs.join("\n")) {
    throw new Error("prepare changed old row inputRef content");
  }
  const treatmentRows = preparedAll.rows.slice(oldRows.length).map(sourceRow);
  const newTrainIdCount = new Set(treatmentRows.map(row => row.sampleId)).size;
  if (treatmentRows.length !== 30 || newTrainIdCount !== 30) {
    throw new Error(`prepare expected exactly 30 appended new train rows, got ${treatmentRows.length}`);
  }
  const devRowsWithIndex = devRows.map((row, index) => ({
    ...row,
    inputRef: { ...row.inputRef, index: oldRows.length + 30 + index },
  }));

  const controlPrepared = prepareBasicKindSamples(
    { schemaVersion: 1, taskId: TASK_ID, rows: oldRows },
    { taskId: TASK_ID, inputScope: INPUT_SCOPE },
  );
  const treatmentPrepared = prepareBasicKindSamples(
    { schemaVersion: 1, taskId: TASK_ID, rows: [...oldRows, ...treatmentRows] },
    { taskId: TASK_ID, inputScope: INPUT_SCOPE },
  );
  const includedControl = new Set(controlPrepared.includedIndices);
  const includedTreatment = new Set(treatmentPrepared.includedIndices);
  if (includedControl.size !== oldRows.length) {
    const excluded = oldRows.filter((_, index) => !includedControl.has(index)).map(row => row.sampleId);
    throw new Error(`prepare excluded control rows: ${excluded.join(", ")}`);
  }
  if (includedTreatment.size !== oldRows.length + treatmentRows.length) {
    const excluded = [...oldRows, ...treatmentRows]
      .filter((_, index) => !includedTreatment.has(index))
      .map(row => row.sampleId);
    throw new Error(`prepare excluded treatment rows: ${excluded.join(", ")}`);
  }

  const controlUsage = [
    ...explicitUsage.map(entry => ({ sampleId: entry.sampleId, usage: entry.usage })),
  ];
  const treatmentUsage = [
    ...explicitUsage.map(entry => ({ sampleId: entry.sampleId, usage: entry.usage })),
    ...treatmentRows.map(row => ({ sampleId: row.sampleId, usage: "train" })),
  ];

  const partitionControl = partitionBasicKindSamples(controlPrepared, {
    mode: "source_group_holdout",
    seed: PARTITION_SEED,
    evalFraction: 0.3,
    allowInSampleEval: false,
    explicitUsage: controlUsage,
  });
  if (!partitionControl.ok) {
    throw new Error(`partition rejected control: ${partitionControl.reason} ${JSON.stringify(partitionControl.details)}`);
  }
  const partitionTreatment = partitionBasicKindSamples(treatmentPrepared, {
    mode: "source_group_holdout",
    seed: PARTITION_SEED,
    evalFraction: 0.3,
    allowInSampleEval: false,
    explicitUsage: treatmentUsage,
  });
  if (!partitionTreatment.ok) {
    throw new Error(`partition rejected treatment: ${partitionTreatment.reason} ${JSON.stringify(partitionTreatment.details)}`);
  }

  auditVerificationIsolation({
    fitRequests: [
      { rows: oldRows },
      { rows: [...oldRows, ...treatmentRows] },
    ],
    verification: verificationStates,
  });

  const counts = usage => Object.fromEntries(
    [...new Set(usage.map(entry => entry.usage))].sort().map(usageName => [usageName, usage.filter(entry => entry.usage === usageName).length]),
  );
  return {
    control: { schemaVersion: 1, taskId: TASK_ID, rows: oldRows },
    treatment: { schemaVersion: 1, taskId: TASK_ID, rows: [...oldRows, ...treatmentRows] },
    dev: { rows: devRowsWithIndex },
    usage: {
      control: controlUsage,
      treatment: treatmentUsage,
      dev: devUsage,
      verification: verificationUsage,
      counts: {
        control: counts(controlUsage),
        treatment: counts(treatmentUsage),
        dev: counts(devUsage),
        verification: counts(verificationUsage),
      },
    },
    partitions: {
      control: partitionControl.partitions,
      treatment: partitionTreatment.partitions,
    },
    partition: { mode: "source_group_holdout", seed: PARTITION_SEED, evalFraction: 0.3 },
    verificationExcludedFromFit: true,
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--request", "--partition", "--train-capture", "--dev-capture", "--verification-capture", "--out-control", "--out-treatment", "--out-dev", "--usage-out"].includes(flag)) {
      throw new Error(`unknown argument ${flag}`);
    }
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate argument ${flag}`);
    values.set(flag, value);
  }
  for (const flag of ["--request", "--partition", "--train-capture", "--dev-capture", "--out-control", "--out-treatment", "--usage-out"]) {
    if (!values.has(flag)) throw new Error(`missing required ${flag}`);
  }
  return {
    request: resolve(values.get("--request")),
    partition: resolve(values.get("--partition")),
    trainCapture: resolve(values.get("--train-capture")),
    devCapture: resolve(values.get("--dev-capture")),
    verificationCapture: values.get("--verification-capture") ? resolve(values.get("--verification-capture")) : null,
    outControl: resolve(values.get("--out-control")),
    outTreatment: resolve(values.get("--out-treatment")),
    outDev: values.get("--out-dev") ? resolve(values.get("--out-dev")) : null,
    usageOut: resolve(values.get("--usage-out")),
  };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const request = readJson(args.request, "source request");
  const partition = readJson(args.partition, "partition");
  const trainCapture = readJson(args.trainCapture, "train capture");
  const devCapture = readJson(args.devCapture, "dev capture");
  const verificationCapture = args.verificationCapture ? readJson(args.verificationCapture, "verification capture") : null;
  const result = prepareExperiments({
    request,
    partition,
    trainCapture,
    devCapture,
    verificationCapture,
  });
  writeJson(args.outControl, result.control);
  writeJson(args.outTreatment, result.treatment);
  if (args.outDev !== null) writeJson(args.outDev, result.dev);
  writeJson(args.usageOut, result.usage);
  console.log(JSON.stringify({
    controlRows: result.control.rows.length,
    treatmentRows: result.treatment.rows.length,
    devRows: result.dev.rows.length,
    devRequestOut: args.outDev,
    counts: result.usage.counts,
    verificationExcludedFromFit: result.verificationExcludedFromFit,
  }));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main();
}
