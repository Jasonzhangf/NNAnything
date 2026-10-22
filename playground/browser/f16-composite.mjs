import {
  compareAttributeChange,
  compareObservedAttributeChanges,
} from "nnanything/browser-classify";
import { predictBrowserReceipt } from "nnanything/browser-receipt";

// F16 read-only composite consumer.
//
// The five sections keep base facts separate:
//   identity        what kind of object the member judged
//   qualification   enabled / hit / semantic eligibility facts
//   relation        directed controls, labels and other local relations
//   event           dispatch, receipt, effects and feedback facts
//   attributeChange before/after attribute comparison facts
//
// Every entry carries the subject `nodeRef`, the producing member `source`,
// the member output in `fact`, and the raw facts that backed it in `evidence`.
// This consumer never combines member scores, never infers purpose, and never
// produces a satisfaction or goal-success aggregate.

export const F16_SECTIONS = Object.freeze([
  "identity",
  "qualification",
  "relation",
  "event",
  "attributeChange",
]);

function list(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function entry(nodeRef, source, fact, evidence = [], targetRef) {
  return {
    nodeRef: nodeRef ?? null,
    source,
    fact,
    evidence,
    ...(targetRef === undefined ? {} : { targetRef }),
  };
}

function evidenceById(snapshot) {
  const byId = new Map();
  for (const item of list(snapshot?.evidence, "snapshot.evidence")) {
    if (typeof item?.id === "string") byId.set(item.id, item);
  }
  return byId;
}

function rawEvidence(byId, evidenceRefs, source) {
  return list(evidenceRefs, "element.evidenceRefs")
    .map(ref => byId.get(ref))
    .filter(item => item !== undefined && (source === undefined || item.source === source));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotNodes(side) {
  const nodes = side?.snapshot?.observation?.nodes ?? side?.snapshot?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function nodeRefFromSide(side) {
  if (isRecord(side) && typeof side.nodeRef === "string" && isRecord(side.attributes)) {
    return side.nodeRef;
  }
  if (isRecord(side?.node) && typeof side.node.nodeRef === "string") {
    return side.node.nodeRef;
  }
  const nodes = snapshotNodes(side);
  return nodes.length === 1 && typeof nodes[0]?.nodeRef === "string" ? nodes[0].nodeRef : null;
}

function resolveSideNode(side, nodeRef) {
  if (isRecord(side) && typeof side.nodeRef === "string" && isRecord(side.attributes)) {
    return side.nodeRef === nodeRef ? side : null;
  }
  if (isRecord(side?.node)) {
    return side.node.nodeRef === nodeRef ? side.node : null;
  }
  if (nodeRef === null) return null;
  return snapshotNodes(side).find(item => item?.nodeRef === nodeRef) ?? null;
}

function sideEvidenceRows(side) {
  const evidence = side?.snapshot?.evidence ?? side?.evidence;
  if (evidence instanceof Map) return [...evidence.values()];
  return Array.isArray(evidence) ? evidence : [];
}

function valueReadProvided(side, nodeRef) {
  if (nodeRef === null) return false;
  return sideEvidenceRows(side).some(item =>
    item?.nodeRef === nodeRef && Object.hasOwn(item, "inputValue"));
}

function readSideValue(side, nodeRef) {
  const row = sideEvidenceRows(side).find(item => item?.nodeRef === nodeRef);
  if (row === undefined || !Object.hasOwn(row, "inputValue") || row.inputValue === null) {
    return { status: "unavailable", value: null };
  }
  return { status: "observed", value: row.inputValue };
}

function contextFromSide(side, explicit, label) {
  const state = explicit ?? side?.state ?? side?.context;
  if (!isRecord(state)) throw new TypeError(`${label} comparison context is required`);
  return {
    documentRef: state.documentRef,
    scopeRef: state.scopeRef,
    observationId: state.observationId,
    revision: state.revision,
  };
}

function projectSnapshot(snapshot, byId, sections) {
  for (const element of list(snapshot?.elements, "snapshot.elements")) {
    const nodeRef = element.ref;
    if (typeof nodeRef !== "string") throw new TypeError("snapshot element requires a ref");

    sections.identity.push(entry(
      nodeRef,
      "browser-single-action:basicKind",
      {
        tag: element.tag ?? null,
        role: element.role ?? null,
        basicKind: element.basicKind ?? null,
        judgmentStatus: element.judgmentStatus ?? "unknown",
      },
      rawEvidence(byId, element.evidenceRefs, "dom.singleAction.element"),
    ));

    sections.qualification.push(entry(
      nodeRef,
      "browser-single-action:enabled",
      element.enabled,
      rawEvidence(byId, element.evidenceRefs, "dom.enabled"),
    ));
    sections.qualification.push(entry(
      nodeRef,
      "browser-single-action:hit",
      element.hit,
      rawEvidence(byId, element.evidenceRefs, "dom.elementsFromPoint"),
    ));
    sections.qualification.push(entry(
      nodeRef,
      "browser-single-action:buttonSemantics",
      element.buttonSemantics,
      rawEvidence(byId, element.evidenceRefs, "dom.buttonSemantics"),
    ));
    sections.qualification.push(entry(
      nodeRef,
      "browser-single-action:candidateStatus",
      { candidateStatus: element.candidateStatus },
      rawEvidence(byId, element.evidenceRefs, "dom.singleAction.element"),
    ));

    const controls = element.controls;
    if (controls !== undefined) {
      const evidence = rawEvidence(byId, element.evidenceRefs, "dom.aria-controls");
      if (controls.status === "observed" && controls.value.length > 0) {
        for (const targetRef of controls.value) {
          sections.relation.push(entry(
            nodeRef,
            "browser-single-action:controls",
            controls,
            evidence,
            targetRef,
          ));
        }
      } else {
        sections.relation.push(entry(
          nodeRef,
          "browser-single-action:controls",
          controls,
          evidence,
          null,
        ));
      }
    }
  }
}

function projectLabels(labels, sections) {
  for (const label of list(labels, "labels")) {
    if (typeof label?.nodeRef !== "string") continue;
    const refs = Array.isArray(label.labelledByRefs) ? label.labelledByRefs : [];
    // The live-DOM evidence row itself is the raw fact; keep it intact.
    const fact = label;
    if (refs.length === 0) {
      sections.relation.push(entry(
        label.nodeRef,
        "browser-classify:accessibleName",
        fact,
        [],
        null,
      ));
    } else {
      for (const targetRef of refs) {
        sections.relation.push(entry(
          label.nodeRef,
          "browser-classify:accessibleName",
          fact,
          [],
          targetRef,
        ));
      }
    }
  }
}

function projectReceipt(receipt, sections) {
  if (receipt === undefined) return;
  const prediction = predictBrowserReceipt(receipt.input, receipt.profile);
  sections.event.push(entry(
    receipt.nodeRef ?? null,
    "browser-receipt:predictBrowserReceipt",
    {
      status: prediction.status,
      head: prediction.head,
      features: prediction.features,
      logits: prediction.logits,
    },
    [{ receipt: receipt.input.receipt ?? null }],
  ));
}

function projectEpisode(episodeInput, sections) {
  const episode = episodeInput.episode;
  if (episode === undefined || episode === null) return;
  const nodeRef = episodeInput.episodeNodeRef
    ?? episode.invocation?.targetRef
    ?? episode.prediction?.proposedTargetRef
    ?? null;

  if (Object.hasOwn(episode, "dispatchState")) {
    sections.event.push(entry(
      nodeRef,
      "browser-single-action:dispatchState",
      { dispatchState: episode.dispatchState },
      [{ dispatchState: episode.dispatchState }],
    ));
  }
  if (Object.hasOwn(episode, "effectKnowledge")) {
    sections.event.push(entry(
      nodeRef,
      "browser-single-action:effectKnowledge",
      { effectKnowledge: episode.effectKnowledge },
      [{ effectKnowledge: episode.effectKnowledge }],
    ));
  }
  if (episode.receipt !== undefined && episode.receipt !== null) {
    sections.event.push(entry(
      nodeRef,
      "browser-single-action:receipt",
      episode.receipt,
      [{ receipt: episode.receipt }],
    ));
  }
  if (episode.error !== undefined && episode.error !== null) {
    sections.event.push(entry(
      nodeRef,
      "browser-single-action:error",
      episode.error,
      [{ error: episode.error }],
    ));
  }
  if (Array.isArray(episode.executionErrors) && episode.executionErrors.length > 0) {
    sections.event.push(entry(
      nodeRef,
      "browser-single-action:executionErrors",
      episode.executionErrors,
      [{ executionErrors: episode.executionErrors }],
    ));
  }
  if (episode.observationFeedback !== undefined && episode.observationFeedback !== null) {
    sections.event.push(entry(
      nodeRef,
      "browser-single-action:observationFeedback",
      episode.observationFeedback,
      [{ observationFeedback: episode.observationFeedback }],
    ));
  }
}

function projectAttributeChange(changeInput, sections) {
  if (changeInput === undefined) return;
  const before = changeInput.before ?? null;
  const after = changeInput.after ?? null;
  const nodeRef = changeInput.nodeRef ?? nodeRefFromSide(before) ?? nodeRefFromSide(after) ?? null;
  const beforeNode = resolveSideNode(before, nodeRef);
  const afterNode = resolveSideNode(after, nodeRef);
  const context = changeInput.context ?? {
    before: contextFromSide(before, changeInput.beforeContext, "attributeChange.before"),
    after: contextFromSide(after, changeInput.afterContext, "attributeChange.after"),
  };
  const beforeValueProvided = valueReadProvided(before, nodeRef);
  const afterValueProvided = valueReadProvided(after, nodeRef);
  const valueReads = changeInput.valueReads !== undefined
    ? changeInput.valueReads
    : beforeValueProvided || afterValueProvided
      ? { before: readSideValue(before, nodeRef), after: readSideValue(after, nodeRef) }
      : undefined;
  const explicit = Array.isArray(changeInput.attributes) && changeInput.attributes.length > 0;
  const changes = explicit
    ? changeInput.attributes.map(attribute =>
      compareAttributeChange(beforeNode, afterNode, attribute, context, valueReads))
    : compareObservedAttributeChanges(beforeNode, afterNode, context, valueReads);
  const source = explicit
    ? "browser-classify:compareAttributeChange"
    : "browser-classify:compareObservedAttributeChanges";
  const evidence = [{
    before: {
      attributes: beforeNode?.attributes ?? null,
      inputValue: valueReads?.before.status === "observed" ? valueReads.before.value : null,
    },
    after: {
      attributes: afterNode?.attributes ?? null,
      inputValue: valueReads?.after.status === "observed" ? valueReads.after.value : null,
    },
  }];
  for (const change of changes) {
    sections.attributeChange.push(entry(nodeRef, source, change, evidence));
  }
}

/**
 * Compose base member outputs into the F16 five-section projection.
 *
 * Input:
 *   snapshot        SingleActionSnapshot from observeBrowserSingleAction
 *   labels          optional LiveDomEvidence rows from observeLiveDom
 *   receipt         optional { nodeRef, input, profile } for the receipt member
 *   episode         optional SingleActionEpisodeResult from the event owner
 *   episodeNodeRef  optional explicit event subject when the episode has none
 *   attributeChange optional {
 *     nodeRef?, before, after, attributes?,
 *     context?, beforeContext?, afterContext?, valueReads?
 *   }
 *   Each before/after side may be an ObservationNode or a fixture with a
 *   `state` carrying the F14 control triple and a `snapshot` carrying
 *   observation nodes plus F07 evidence. The snapshot evidence inputValue is
 *   the explicit current value read; the HTML value attribute is never used.
 */
export function composeBrowserF16(input = {}) {
  const sections = {
    identity: [],
    qualification: [],
    relation: [],
    event: [],
    attributeChange: [],
  };
  if (input.snapshot !== undefined) {
    projectSnapshot(input.snapshot, evidenceById(input.snapshot), sections);
  }
  projectLabels(input.labels, sections);
  projectReceipt(input.receipt, sections);
  projectEpisode(input, sections);
  projectAttributeChange(input.attributeChange, sections);
  return sections;
}
