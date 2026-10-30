#!/usr/bin/env node
// W0a-Prep-1A diagnostic converter.
//
// Converts three existing local observation materials into filtered-DOM prep
// packages and records the real L1 16-wire mapping through the public
// "nnanything/browser-classify" entry. The output is diagnostic/development
// only: it is never training gold and never adopts weights.
//
// Owner: contract v2.1 (research). This file only performs conversion.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  observeCandidates,
  checkCandidates,
  createFocusSpec,
  classifyBasicKind,
  classifyBasicKindBatch,
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  shapeAppearanceMeasurements,
  buildExplorationInputs,
  validateExplorationInput,
  deriveBasicKindContentRelations,
  isSafeRuleAttribute,
} from "nnanything/browser-classify";

export const CONTRACT_VERSION = "v2.1";
export const DEFAULT_SOURCE_A =
  "/Volumes/extension/code/NNAnything/research/weibo-filter/snapshot-001/nodes.json";
export const DEFAULT_SOURCE_B =
  "/Volumes/extension/code/NNAnything/training/samples/input-audit-20261017/weibo-current.inputs.json";
export const DEFAULT_SOURCE_C =
  "/Volumes/extension/code/NNAnything/training/samples/weibo-unknown-20261017/weibo-live.capture.json";

const MAX_RELATION_HOPS = 4;
const ROOT_NODE_REF = "node-0";
const USAGE_SCOPE = "diagnostic_development_only";

// Basic-kind leaf order fixed by contract section 4.1. "other" is not a leaf:
// it only receives w14 when the judgment itself is judged:other.
export const L1_KIND_ORDER = Object.freeze([
  "button",
  "input",
  "select",
  "image",
  "video",
  "audio",
  "link",
  "text",
  "container",
  "list",
  "listitem",
  "ignore",
]);

export const L1_WIRE_NAMES = Object.freeze([
  "w01_l1_judged_mask",
  ...L1_KIND_ORDER.map((kind, index) =>
    `w${String(index + 2).padStart(2, "0")}_l1_kind_${kind}`
  ),
  "w14_l1_kind_other",
  "w15_l1_status_unknown",
  "w16_l1_status_conflict",
]);

// sRGB wire name for a leaf kind.
function l1KindWire(kind) {
  const index = L1_KIND_ORDER.indexOf(kind);
  return index < 0
    ? null
    : `w${String(index + 2).padStart(2, "0")}_l1_kind_${L1_KIND_ORDER[index]}`;
}

// Contract 4.1: judged mask; one-hot leaf; judged:other w14; unknown w15;
// conflict w16. unknown/conflict always keep w14 = 0 even when basicKind is
// "other" and reasons contain "fallback_other".
export function buildL1Wires16(judgment) {
  const wires = Object.fromEntries(L1_WIRE_NAMES.map((name) => [name, 0]));
  const status = judgment?.judgmentStatus ?? null;
  const kind = judgment?.basicKind ?? null;
  wires.w01_l1_judged_mask = status === "judged" ? 1 : 0;
  if (status === "judged") {
    if (kind === "other") {
      wires.w14_l1_kind_other = 1;
    } else {
      const wire = l1KindWire(kind);
      if (wire !== null) wires[wire] = 1;
    }
  } else if (status === "unknown") {
    wires.w15_l1_status_unknown = 1;
  } else if (status === "conflict") {
    wires.w16_l1_status_conflict = 1;
  }
  return wires;
}

// Single mapping used by prep rows, the source C diagnostic and the tests.
export function describeSlotOutcome(input) {
  const candidateStatus = input?.candidateStatus ?? null;
  const excluded = candidateStatus === "skipped" || candidateStatus === "filtered_out";
  if (excluded) {
    return {
      effectiveL1: "excluded:null",
      disposition: "excluded_candidate",
      inMainClassificationInput: false,
      l1Wires16: null,
      judgmentStatus: "excluded",
      basicKind: null,
    };
  }
  const effective =
    candidateStatus === "unknown" && input.semanticDiagnostic
      ? input.semanticDiagnostic
      : input;
  const status = effective.judgmentStatus ?? "unknown";
  const kind = effective.basicKind ?? null;
  const disposition =
    status === "judged" && kind === "ignore" ? "folded_ignore_wrapper" : "active_retained";
  return {
    effectiveL1: `${status}:${kind ?? "null"}`,
    disposition,
    inMainClassificationInput: true,
    l1Wires16: buildL1Wires16({ judgmentStatus: status, basicKind: kind }),
    judgmentStatus: status,
    basicKind: kind,
  };
}

function fail(message) {
  throw new Error(`W0A_PREP1A_INVALID_INPUT: ${message}`);
}

function readJson(filePath, label) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`${label} could not be read at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function asRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function toRect(value, label) {
  const record = asRecord(value, label);
  const rect = {
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
  };
  for (const key of ["x", "y", "width", "height"]) {
    if (typeof rect[key] !== "number" || !Number.isFinite(rect[key])) {
      fail(`${label}.${key} must be a finite number`);
    }
  }
  return rect;
}

function toViewport(value, fallback) {
  const record = value === undefined || value === null ? fallback : asRecord(value, "viewport");
  return {
    x: 0,
    y: 0,
    width: record.width,
    height: record.height,
  };
}

function nodeIndex(node, position, label) {
  if (!Number.isInteger(node.index) || node.index !== position) {
    fail(`${label}[${position}].index must equal its array position`);
  }
  return node.index;
}

// A source with a real tree must carry an own parent edge on every node.
// Absence is a missing-parent error, not an implicit root.
function requireParentEdges(nodes, label) {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = asRecord(nodes[index], `${label}[${index}]`);
    if (!Object.prototype.hasOwnProperty.call(node, "parent")) {
      fail(`${label}[${index}] is missing the parent tree edge`);
    }
    const parent = node.parent;
    if (parent === null) continue;
    if (!Number.isInteger(parent) || parent < 0 || parent >= nodes.length) {
      fail(`${label}[${index}].parent must be null or an in-range node index`);
    }
  }
}

function observationNodeFor(index, parentRef, fields) {
  return {
    nodeRef: `node-${index}`,
    parentRef,
    tag: fields.tag,
    role: fields.role,
    rect: fields.rect,
    fragments: fields.fragments,
    clippedRect: null,
    foreground: "unassessed",
    attributes: fields.attributes,
  };
}

function coverageFor(fragments) {
  return {
    geometry: "assessed",
    fragments,
    clipping: "unassessed",
    foreground: "unassessed",
  };
}

function pickSafeAttributes(attrs) {
  const picked = {};
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (!isSafeRuleAttribute(name)) continue;
    if (value === undefined) continue;
    picked[name] = value;
  }
  return picked;
}

function trimRole(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function loadSourceA(filePath) {
  const raw = asRecord(readJson(filePath, "source A"), "source A");
  const nodes = raw.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) fail("source A.nodes must be a non-empty array");
  requireParentEdges(nodes, "source A.nodes");
  const refs = nodes.map((node, index) => {
    nodeIndex(node, index, "source A.nodes");
    return `node-${index}`;
  });
  const rootRefs = new Map(refs.map((ref, index) => [index, ref]));
  const observationNodes = nodes.map((node, index) => {
    const parent = node.parent;
    return observationNodeFor(index, parent === null ? null : rootRefs.get(parent), {
      tag: String(node.tag).toLowerCase(),
      role: trimRole(node.role),
      rect: toRect(node.rect, `source A.nodes[${index}].rect`),
      // Contract data-2: truncation/tag filtering means child completeness is
      // unknown; clipping and multi-fragment coverage were never measured.
      fragments: null,
      attributes: {},
    });
  });
  return {
    id: "snapshot-001",
    filePath,
    raw,
    nodes,
    viewport: toViewport(raw.viewport, { width: 1207, height: 1878 }),
    coverage: coverageFor("unassessed"),
    observationNodes,
  };
}

function sourceAItemObservation(node, index) {
  const hasText = typeof node.text === "string" && node.text.length > 0;
  const appearance = hasText
    ? shapeAppearanceMeasurements({ directText: node.text })
    : null;
  return {
    nodeRef: `node-${index}`,
    // Contract data-1: the exporter trimmed text, so "" cannot distinguish
    // "no direct text node" from "format-only text". Keep it unmeasured and
    // record the measured non-format=false fact.
    directTextPresent: hasText ? appearance.directTextPresent : null,
    nonFormatDirectTextPresent: hasText ? appearance.nonFormatDirectTextPresent : false,
    hrefPresent: null,
    inputType: null,
    contentEditable: null,
    backgroundImagePresent: null,
    pointerCursor: null,
    descendantTextPresent: null,
    childElementCount: null,
    positiveAreaChildCount: null,
    activeElementFocus: null,
    tabIndexFocus: null,
  };
}

function loadSourceB(filePath) {
  const raw = asRecord(readJson(filePath, "source B"), "source B");
  const nodes = raw.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) fail("source B.nodes must be a non-empty array");
  requireParentEdges(nodes, "source B.nodes");
  const refs = nodes.map((node, index) => {
    nodeIndex(node, index, "source B.nodes");
    return `node-${index}`;
  });
  const refsByIndex = new Map(refs.map((ref, index) => [index, ref]));
  const observationNodes = nodes.map((node, index) => {
    const parent = node.parent;
    const fragments = Array.isArray(node.fragments)
      ? node.fragments.map((fragment, position) =>
          toRect(fragment, `source B.nodes[${index}].fragments[${position}]`)
        )
      : null;
    return observationNodeFor(index, parent === null ? null : refsByIndex.get(parent), {
      tag: String(node.localName || node.tag).toLowerCase(),
      role: trimRole(node.attrs?.role),
      rect: toRect(node.rect, `source B.nodes[${index}].rect`),
      fragments,
      attributes: pickSafeAttributes(node.attrs),
    });
  });
  return {
    id: "weibo-current-inputs",
    filePath,
    raw,
    nodes,
    viewport: toViewport(raw.viewport, { width: 1222, height: 1878 }),
    coverage: coverageFor("assessed"),
    observationNodes,
  };
}

function sourceBItemObservation(node, index) {
  const attrs = node.attrs ?? {};
  const hasHref = Object.prototype.hasOwnProperty.call(attrs, "href");
  const tag = String(node.localName || node.tag).toLowerCase();
  const exploration = node.exploration ?? {};
  return {
    nodeRef: `node-${index}`,
    directTextPresent: typeof node.directText === "boolean" ? node.directText : null,
    nonFormatDirectTextPresent:
      node.directText === false
        ? false
        : node.directText === true &&
            typeof node.textToken === "string" &&
            node.textToken.length > 0
          ? true
          : null,
    // Data-3: a missing href key is not evidence of "no href".
    hrefPresent: hasHref
      ? typeof attrs.href === "string" && attrs.href.length > 0
      : null,
    inputType:
      tag === "input" && typeof attrs.type === "string" && attrs.type
        ? attrs.type
        : null,
    contentEditable: typeof node.editable === "boolean" ? node.editable : null,
    backgroundImagePresent:
      typeof exploration.backgroundImagePresent === "boolean"
        ? exploration.backgroundImagePresent
        : null,
    pointerCursor:
      exploration.cursor === "pointer"
        ? true
        : typeof exploration.cursor === "string"
          ? false
          : null,
    descendantTextPresent:
      typeof exploration.descendantTextPresent === "boolean"
        ? exploration.descendantTextPresent
        : null,
    // Alice supplement: exploration.children has no completeness credential,
    // so it never becomes a measured childElementCount.
    childElementCount: null,
    positiveAreaChildCount: null,
    activeElementFocus: null,
    tabIndexFocus: null,
  };
}

function mergeContentRelations(item, relations) {
  return {
    ...item,
    ...(relations.shallowStructuralPeerRatio !== null
      ? { shallowStructuralPeerRatio: relations.shallowStructuralPeerRatio }
      : {}),
    ...(relations.coincidentChildPairRatio !== null
      ? { coincidentChildPairRatio: relations.coincidentChildPairRatio }
      : {}),
    ...(relations.graphicDescendantPresent !== null
      ? { graphicDescendantPresent: relations.graphicDescendantPresent }
      : {}),
  };
}

// Contract 2.2 four-step order:
// build -> derive/merge -> build/validate -> observe/check/classify.
export function runFilterPipeline(observation, initialItemObservations) {
  const initialExpMap = buildExplorationInputs({
    observation,
    itemObservations: initialItemObservations,
    maxRelationHops: MAX_RELATION_HOPS,
    directChildrenStatus: "unknown",
    rootNodeRef: ROOT_NODE_REF,
  });
  const enrichedItemObservations = initialItemObservations.map((item) => {
    const exp = initialExpMap.get(item.nodeRef);
    if (!exp) fail(`missing initial ExplorationInputV1 for ${item.nodeRef}`);
    return mergeContentRelations(item, deriveBasicKindContentRelations(exp));
  });
  const finalExpMap = buildExplorationInputs({
    observation,
    itemObservations: enrichedItemObservations,
    maxRelationHops: MAX_RELATION_HOPS,
    directChildrenStatus: "unknown",
    rootNodeRef: ROOT_NODE_REF,
  });
  for (const exp of finalExpMap.values()) validateExplorationInput(exp);
  const checkedBatch = checkCandidates(
    observeCandidates({ observation }),
    createFocusSpec(),
  );
  const basicKindBatch = classifyBasicKindBatch(
    { ...checkedBatch, itemObservations: enrichedItemObservations },
    DEFAULT_BASIC_KIND_CONFIG,
    DEFAULT_BASIC_KIND_PROFILE,
  );
  return {
    initialExpMap,
    enrichedItemObservations,
    finalExpMap,
    checkedBatch,
    basicKindBatch,
  };
}

function countBy(items, pick) {
  const counts = {};
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sortedCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildPrepSlots(sourceKind, source, pipeline) {
  const slots = pipeline.basicKindBatch.slots;
  const observationByRef = new Map(
    source.observationNodes.map((node) => [node.nodeRef, node]),
  );
  const itemByRef = new Map(
    pipeline.enrichedItemObservations.map((item) => [item.nodeRef, item]),
  );
  const rows = slots.map((slot, index) => {
    const outcome = describeSlotOutcome(slot);
    const rawNode = source.nodes[index];
    const observationNode = observationByRef.get(slot.nodeRef);
    const explorationInput = pipeline.finalExpMap.get(slot.nodeRef);
    if (!observationNode) fail(`missing ObservationNode for ${slot.nodeRef}`);
    if (!explorationInput) fail(`missing final ExplorationInputV1 for ${slot.nodeRef}`);
    const diagnosticEvidence =
      sourceKind === "source-b"
        ? {
            observedChildrenCountWithoutCompletenessProof: Array.isArray(
              rawNode.exploration?.children,
            )
              ? rawNode.exploration.children.length
              : null,
          }
        : {};
    return {
      slotIndex: index,
      index,
      nodeRef: slot.nodeRef,
      rawParentRef: observationNode.parentRef,
      observationNode,
      itemObservation: itemByRef.get(slot.nodeRef),
      explorationInput,
      candidateStatus: slot.candidateStatus,
      candidateReasons: [...slot.candidateReasons],
      judgmentStatus: outcome.judgmentStatus,
      basicKind: outcome.basicKind,
      effectiveL1: outcome.effectiveL1,
      disposition: outcome.disposition,
      inMainClassificationInput: outcome.inMainClassificationInput,
      l1Wires16: outcome.l1Wires16,
      rawJudgment: {
        judgmentStatus: slot.judgmentStatus,
        basicKind: slot.basicKind,
        reasons: [...slot.reasons],
      },
      ...(slot.semanticDiagnostic === undefined
        ? {}
        : { semanticDiagnostic: slot.semanticDiagnostic }),
      diagnosticEvidence,
    };
  });

  return { rows, retainedNodes: computeRetainedNodes(rows) };
}

// Contract 4.2: active rows stay, folded/excluded rows bridge their children
// to the nearest active retained ancestor. The walk never deletes a row.
export function computeRetainedNodes(rows) {
  const byRef = new Map(rows.map((row) => [row.nodeRef, row]));
  const retainedNodes = [];
  for (const row of rows) {
    if (row.disposition !== "active_retained") continue;
    const bridgedIntermediateNodeRefs = [];
    const seen = new Set([row.nodeRef]);
    let cursor = row.rawParentRef;
    let effectiveRetainedAncestorRef = null;
    while (cursor !== null) {
      if (seen.has(cursor)) fail(`retained ancestor cycle at ${row.nodeRef}`);
      seen.add(cursor);
      const current = byRef.get(cursor);
      if (!current) break;
      if (current.disposition === "active_retained") {
        effectiveRetainedAncestorRef = cursor;
        break;
      }
      bridgedIntermediateNodeRefs.push(cursor);
      cursor = current.rawParentRef;
    }
    retainedNodes.push({
      slotIndex: row.slotIndex,
      index: row.index,
      nodeRef: row.nodeRef,
      rawParentRef: row.rawParentRef,
      effectiveRetainedAncestorRef,
      bridgedIntermediateNodeRefs,
      collapsedWrapperHopCount: bridgedIntermediateNodeRefs.length,
      effectiveL1: row.effectiveL1,
      judgmentStatus: row.judgmentStatus,
      basicKind: row.basicKind,
      l1Wires16: row.l1Wires16,
    });
  }
  return retainedNodes;
}

function prepCounts(rows, retainedNodes) {
  return {
    slots: rows.length,
    candidateStatus: sortedCounts(countBy(rows, (row) => row.candidateStatus)),
    effectiveL1: sortedCounts(countBy(rows, (row) => row.effectiveL1)),
    dispositions: sortedCounts(countBy(rows, (row) => row.disposition)),
    activeRetained: retainedNodes.length,
    inMainClassificationInput: rows.filter((row) => row.inMainClassificationInput).length,
  };
}

function commonFlags() {
  return {
    usageScope: USAGE_SCOPE,
    trainingEligible: false,
    autoGold: false,
    filterRecallStatus: "UNVERIFIED",
  };
}

export function convertSourceA(filePath = DEFAULT_SOURCE_A) {
  const source = loadSourceA(filePath);
  const observation = {
    viewport: source.viewport,
    nodes: source.observationNodes,
    coverage: source.coverage,
  };
  const initialItemObservations = source.nodes.map(sourceAItemObservation);
  const pipeline = runFilterPipeline(observation, initialItemObservations);
  const { rows, retainedNodes } = buildPrepSlots("source-a", source, pipeline);
  return {
    kind: "nnanything.w0a-prep1a.prep.v1",
    contractVersion: CONTRACT_VERSION,
    sourceId: source.id,
    sourcePath: source.filePath,
    ...commonFlags(),
    source: {
      capturedAt: source.raw.capturedAt ?? null,
      url: source.raw.url ?? null,
      viewport: source.viewport,
      scope: source.raw.scope ?? null,
      nodeCount: source.nodes.length,
    },
    counts: prepCounts(rows, retainedNodes),
    slots: rows,
    retainedNodes,
  };
}

export function convertSourceB(filePath = DEFAULT_SOURCE_B) {
  const source = loadSourceB(filePath);
  const observation = {
    viewport: source.viewport,
    nodes: source.observationNodes,
    coverage: source.coverage,
  };
  const initialItemObservations = source.nodes.map(sourceBItemObservation);
  const pipeline = runFilterPipeline(observation, initialItemObservations);
  const { rows, retainedNodes } = buildPrepSlots("source-b", source, pipeline);
  return {
    kind: "nnanything.w0a-prep1a.prep.v1",
    contractVersion: CONTRACT_VERSION,
    sourceId: source.id,
    sourcePath: source.filePath,
    ...commonFlags(),
    source: {
      capturedAt: source.raw.capturedAt ?? null,
      page: source.raw.page ?? null,
      viewport: source.viewport,
      captureMode: source.raw.captureMode ?? null,
      nodeCount: source.nodes.length,
    },
    counts: prepCounts(rows, retainedNodes),
    slots: rows,
    retainedNodes,
  };
}

export function convertSourceC(filePath = DEFAULT_SOURCE_C) {
  const raw = asRecord(readJson(filePath, "source C"), "source C");
  const rows = raw.trainingRequest?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    fail("source C.trainingRequest.rows must be a non-empty array");
  }
  const diagnostics = rows.map((row, index) => {
    const record = asRecord(row, `source C.trainingRequest.rows[${index}]`);
    if (!record.properties) fail(`source C row ${index} is missing properties`);
    if (!record.explorationInput) fail(`source C row ${index} is missing explorationInput`);
    const explorationInput = validateExplorationInput(record.explorationInput);
    const relations = deriveBasicKindContentRelations(explorationInput);
    const currentReclassification = classifyBasicKind(
      { ...record.properties, ...relations },
      DEFAULT_BASIC_KIND_CONFIG,
      DEFAULT_BASIC_KIND_PROFILE,
    );
    const outcome = describeSlotOutcome({
      candidateStatus: "ok",
      ...currentReclassification,
    });
    return {
      slotIndex: index,
      index,
      sampleId: record.sampleId ?? null,
      inputRef: record.inputRef ?? null,
      historicalProposal: record.proposal ?? null,
      currentReclassification,
      l1Wires16: outcome.l1Wires16,
      effectiveL1: outcome.effectiveL1,
      explorationInput,
      properties: record.properties,
      candidateQualification: record.candidateQualification ?? null,
      captureCoverage: record.captureCoverage ?? null,
    };
  });
  return {
    kind: "nnanything.w0a-prep1a.capture-diagnostic.v1",
    contractVersion: CONTRACT_VERSION,
    sourceId: "weibo-live-capture",
    sourcePath: filePath,
    ...commonFlags(),
    source: {
      kind: raw.kind ?? null,
      createdAt: raw.createdAt ?? null,
      currentContextRef: raw.currentContextRef ?? null,
      rowCount: diagnostics.length,
    },
    counts: {
      rows: diagnostics.length,
      historicalProposal: sortedCounts(
        countBy(diagnostics, (row) =>
          JSON.stringify(row.historicalProposal?.status ?? null),
        ),
      ),
      currentReclassification: sortedCounts(
        countBy(
          diagnostics,
          (row) =>
            `${row.currentReclassification.judgmentStatus}:${row.currentReclassification.basicKind ?? "null"}`,
        ),
      ),
    },
    rows: diagnostics,
  };
}

function summarize(sources) {
  return {
    kind: "nnanything.w0a-prep1a.summary.v1",
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    ...commonFlags(),
    sources: {
      sourceA: {
        file: "snapshot-001.prep.json",
        sourcePath: sources.sourceA.sourcePath,
        nodeCount: sources.sourceA.source.nodeCount,
        counts: sources.sourceA.counts,
      },
      sourceB: {
        file: "weibo-current-inputs.prep.json",
        sourcePath: sources.sourceB.sourcePath,
        nodeCount: sources.sourceB.source.nodeCount,
        counts: sources.sourceB.counts,
      },
      sourceC: {
        file: "weibo-live-capture.diagnostic.json",
        sourcePath: sources.sourceC.sourcePath,
        rowCount: sources.sourceC.source.rowCount,
        counts: sources.sourceC.counts,
      },
    },
    limits: {
      maxRelationHops: MAX_RELATION_HOPS,
      directChildrenStatus: "unknown",
      childElementCount: "null_unmeasured_no_completeness_proof",
      clippedRect: "null_unmeasured",
      filterRecallStatus: "UNVERIFIED",
    },
  };
}

export function runConversion({
  outDir,
  sourceA = DEFAULT_SOURCE_A,
  sourceB = DEFAULT_SOURCE_B,
  sourceC = DEFAULT_SOURCE_C,
} = {}) {
  if (typeof outDir !== "string" || outDir.length === 0) {
    fail("--out-dir must be a non-empty path");
  }
  const convertedA = convertSourceA(sourceA);
  const convertedB = convertSourceB(sourceB);
  const convertedC = convertSourceC(sourceC);
  const summary = summarize({
    sourceA: convertedA,
    sourceB: convertedB,
    sourceC: convertedC,
  });
  mkdirSync(outDir, { recursive: true });
  const files = [
    ["snapshot-001.prep.json", convertedA],
    ["weibo-current-inputs.prep.json", convertedB],
    ["weibo-live-capture.diagnostic.json", convertedC],
    ["prep1a-summary.json", summary],
  ];
  const written = files.map(([name, payload]) => {
    const filePath = join(outDir, name);
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return {
      file: name,
      path: filePath,
      slots: payload.slots?.length ?? null,
      rows: payload.rows?.length ?? null,
    };
  });
  return { summary, written };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      options.outDir = argv[index + 1];
      index += 1;
    } else if (arg === "--source-a") {
      options.sourceA = argv[index + 1];
      index += 1;
    } else if (arg === "--source-b") {
      options.sourceB = argv[index + 1];
      index += 1;
    } else if (arg === "--source-c") {
      options.sourceC = argv[index + 1];
      index += 1;
    } else {
      fail(`unsupported argument ${arg}`);
    }
  }
  if (!options.outDir) fail("--out-dir is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runConversion(options);
  for (const item of result.written) {
    console.log(`${item.file} slots=${item.slots ?? "-"} rows=${item.rows ?? "-"}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
