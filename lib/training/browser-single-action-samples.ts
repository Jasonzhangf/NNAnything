import type {
  ActionObservation,
  SingleActionCapability,
  SingleActionElement,
  SingleActionRegion,
  SingleActionSnapshot,
  SingleActionTeacherEpisode,
} from "../adapters/browser/single-action-contract.js";
import { readSingleActionRequest } from "../adapters/browser/single-action-observation.js";
import {
  singleActionCapabilityFeatures,
  singleActionRelationFeatures,
} from "../filters/browser-single-action-policy.js";
import { expectArray, expectRecord } from "../core/schema.js";

export const BROWSER_SINGLE_ACTION_TRAIN_FAMILIES = [
  "train-native-caption",
  "train-role-nested",
  "train-sibling-toolbar",
] as const;
export const BROWSER_SINGLE_ACTION_DEVELOPMENT_FAMILIES = [
  "development-dual-panel",
] as const;

export interface BrowserSingleActionPartitions {
  readonly contract: "browser.single-action-training-partitions.v1";
  readonly train: readonly SingleActionTeacherEpisode[];
  readonly development: readonly SingleActionTeacherEpisode[];
  readonly trainFamilies: readonly string[];
  readonly developmentFamilies: readonly string[];
}

type Family = Readonly<{
  id: string;
  partition: "train" | "development";
  tag: "button" | "div";
  role: string | null;
  nesting: 0 | 1 | 2;
  captionInControl: boolean;
}>;

const FAMILIES: readonly Family[] = Object.freeze([
  Object.freeze({
    id: BROWSER_SINGLE_ACTION_TRAIN_FAMILIES[0],
    partition: "train",
    tag: "button",
    role: null,
    nesting: 0,
    captionInControl: false,
  }),
  Object.freeze({
    id: BROWSER_SINGLE_ACTION_TRAIN_FAMILIES[1],
    partition: "train",
    tag: "div",
    role: "button",
    nesting: 1,
    captionInControl: true,
  }),
  Object.freeze({
    id: BROWSER_SINGLE_ACTION_TRAIN_FAMILIES[2],
    partition: "train",
    tag: "button",
    role: null,
    nesting: 2,
    captionInControl: false,
  }),
  Object.freeze({
    id: BROWSER_SINGLE_ACTION_DEVELOPMENT_FAMILIES[0],
    partition: "development",
    tag: "button",
    role: null,
    nesting: 1,
    captionInControl: true,
  }),
]);

const RELATION_CONTROLS_KNOWN = 1;
const RELATION_ENABLED_KNOWN = 3;
const RELATION_HIT_KNOWN = 5;

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function stringArray(value: unknown, label: string): readonly string[] {
  const result = expectArray(value, label).map((entry, index) =>
    nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicate values`);
  return Object.freeze(result);
}

function teacherSource(value: unknown): "synthetic_projection" | "observed_episode" {
  if (value !== "synthetic_projection" && value !== "observed_episode") {
    throw new TypeError("teacher.source must be synthetic_projection or observed_episode");
  }
  return value;
}

function capability(value: unknown): SingleActionCapability {
  if (value !== "CLICK" && value !== "NOOP" && value !== "DEFER") {
    throw new TypeError("teacher.capability is invalid");
  }
  return value;
}

function readEpisode(value: unknown, index: number): SingleActionTeacherEpisode {
  const input = expectRecord(value, `browser single action episode ${index}`);
  exactKeys(input, ["id", "family", "partition", "request", "teacher"], `browser single action episode ${index}`);
  if (!["train", "development", "verification"].includes(String(input.partition))) {
    throw new TypeError(`browser single action episode ${index}.partition is invalid`);
  }
  const request = readSingleActionRequest(input.request);
  const teacher = expectRecord(input.teacher, `browser single action episode ${index}.teacher`);
  exactKeys(teacher, ["providerRefs", "unknownRefs", "capability", "source", "evidenceRefs"], `browser single action episode ${index}.teacher`);
  const providerRefs = stringArray(teacher.providerRefs, `browser single action episode ${index}.teacher.providerRefs`);
  const unknownRefs = stringArray(teacher.unknownRefs, `browser single action episode ${index}.teacher.unknownRefs`);
  const evidenceRefs = stringArray(teacher.evidenceRefs, `browser single action episode ${index}.teacher.evidenceRefs`);
  const refs = new Set(request.state.elements.map(element => element.ref));
  for (const ref of [...providerRefs, ...unknownRefs]) {
    if (!refs.has(ref)) throw new TypeError(`browser single action episode ${index} teacher references unknown element ${ref}`);
  }
  for (const ref of providerRefs) {
    if (unknownRefs.includes(ref)) throw new TypeError(`browser single action episode ${index} teacher ref ${ref} is both provider and unknown`);
    const element = request.state.elements.find(candidate => candidate.ref === ref)!;
    if (element.controls.status !== "observed"
      || !element.controls.value.includes(request.goal.regionRef)
      || element.enabled.status !== "observed"
      || element.enabled.value !== true
      || element.hit.status !== "observed"
      || element.hit.value !== true) {
      throw new TypeError(`browser single action episode ${index} provider ${ref} lacks decisive target/enabled/hit facts`);
    }
  }
  return Object.freeze({
    id: nonEmptyString(input.id, `browser single action episode ${index}.id`),
    family: nonEmptyString(input.family, `browser single action episode ${index}.family`),
    partition: input.partition as SingleActionTeacherEpisode["partition"],
    request,
    teacher: Object.freeze({
      providerRefs,
      unknownRefs,
      capability: capability(teacher.capability),
      source: teacherSource(teacher.source),
      evidenceRefs,
    }),
  });
}

export function readBrowserSingleActionTeacherEpisodes(
  value: unknown,
  options: Readonly<{ allowVerification?: boolean }> = {},
): readonly SingleActionTeacherEpisode[] {
  const episodes = expectArray(value, "browser single action episodes").map(readEpisode);
  if (episodes.length === 0) throw new TypeError("browser single action episodes must not be empty");
  if (!options.allowVerification && episodes.some(episode => episode.partition === "verification")) {
    throw new TypeError("browser single action training input rejects verification episodes");
  }
  const ids = new Set<string>();
  const familyPartition = new Map<string, SingleActionTeacherEpisode["partition"]>();
  for (const episode of episodes) {
    if (ids.has(episode.id)) throw new TypeError(`duplicate browser single action episode id ${episode.id}`);
    ids.add(episode.id);
    const previous = familyPartition.get(episode.family);
    if (previous !== undefined && previous !== episode.partition) {
      throw new TypeError(`browser single action family ${episode.family} crosses partitions`);
    }
    familyPartition.set(episode.family, episode.partition);
  }
  return Object.freeze(episodes);
}

function teacherRelations(episode: SingleActionTeacherEpisode) {
  const providers = new Set(episode.teacher.providerRefs);
  const unknown = new Set(episode.teacher.unknownRefs);
  return episode.request.state.elements.map(element => {
    const features = singleActionRelationFeatures(episode.request, element);
    const judgment = unknown.has(element.ref)
      ? "unknown" as const
      : providers.has(element.ref)
        ? "actionable_provider" as const
        : "not_provider" as const;
    return Object.freeze({
      ref: element.ref,
      features,
      scores: Object.freeze(judgment === "actionable_provider" ? [1, 0] : judgment === "not_provider" ? [0, 1] : [0, 0]),
      judgment,
    });
  });
}

function assertFeatureCollisions(episodes: readonly SingleActionTeacherEpisode[]): void {
  const relationRows = new Map<string, boolean>();
  const capabilityRows = new Map<string, SingleActionCapability>();
  for (const episode of episodes) {
    const providers = new Set(episode.teacher.providerRefs);
    const unknown = new Set(episode.teacher.unknownRefs);
    for (const element of episode.request.state.elements) {
      const features = singleActionRelationFeatures(episode.request, element);
      if (unknown.has(element.ref)
        || features[RELATION_CONTROLS_KNOWN] !== 1
        || features[RELATION_ENABLED_KNOWN] !== 1
        || features[RELATION_HIT_KNOWN] !== 1) continue;
      const expected = providers.has(element.ref);
      const key = JSON.stringify(features);
      const previous = relationRows.get(key);
      if (previous !== undefined && previous !== expected) {
        throw new TypeError(`browser single action relation feature collision: ${episode.id}/${element.ref}`);
      }
      relationRows.set(key, expected);
    }
    const features = singleActionCapabilityFeatures(episode.request, teacherRelations(episode));
    const key = JSON.stringify(features);
    const previous = capabilityRows.get(key);
    if (previous !== undefined && previous !== episode.teacher.capability) {
      throw new TypeError(`browser single action capability feature collision: ${episode.id}`);
    }
    capabilityRows.set(key, episode.teacher.capability);
  }
}

export function partitionBrowserSingleActionSamples(value: unknown): BrowserSingleActionPartitions {
  const episodes = readBrowserSingleActionTeacherEpisodes(value);
  const train = episodes.filter(episode => episode.partition === "train");
  const development = episodes.filter(episode => episode.partition === "development");
  if (train.length === 0 || development.length === 0) {
    throw new TypeError("browser single action samples require train and development episodes");
  }
  assertFeatureCollisions(episodes);
  return Object.freeze({
    contract: "browser.single-action-training-partitions.v1",
    train: Object.freeze(train),
    development: Object.freeze(development),
    trainFamilies: Object.freeze([...new Set(train.map(episode => episode.family))]),
    developmentFamilies: Object.freeze([...new Set(development.map(episode => episode.family))]),
  });
}

export function readBrowserSingleActionPartitions(value: unknown): BrowserSingleActionPartitions {
  const input = expectRecord(value, "browser single action partitions");
  exactKeys(input, ["contract", "train", "development", "trainFamilies", "developmentFamilies"], "browser single action partitions");
  if (input.contract !== "browser.single-action-training-partitions.v1") {
    throw new TypeError("browser single action partitions contract is invalid");
  }
  const train = readBrowserSingleActionTeacherEpisodes(input.train);
  const development = readBrowserSingleActionTeacherEpisodes(input.development);
  if (train.some(episode => episode.partition !== "train") || development.some(episode => episode.partition !== "development")) {
    throw new TypeError("browser single action partitions contain the wrong partition");
  }
  const trainFamilies = stringArray(input.trainFamilies, "browser single action partitions.trainFamilies");
  const developmentFamilies = stringArray(input.developmentFamilies, "browser single action partitions.developmentFamilies");
  const actualTrainFamilies = [...new Set(train.map(episode => episode.family))];
  const actualDevelopmentFamilies = [...new Set(development.map(episode => episode.family))];
  if (JSON.stringify(trainFamilies) !== JSON.stringify(actualTrainFamilies)
    || JSON.stringify(developmentFamilies) !== JSON.stringify(actualDevelopmentFamilies)) {
    throw new TypeError("browser single action partition family summaries do not match episodes");
  }
  assertFeatureCollisions([...train, ...development]);
  return Object.freeze({
    contract: "browser.single-action-training-partitions.v1",
    train: Object.freeze(train),
    development: Object.freeze(development),
    trainFamilies,
    developmentFamilies,
  });
}

function observed<T>(value: T, evidenceRefs: readonly string[]): ActionObservation<T> {
  return Object.freeze({ status: "observed", value, evidenceRefs: Object.freeze([...evidenceRefs]) });
}

function unknown<T>(reason: string): ActionObservation<T> {
  return Object.freeze({ status: "unknown", reason });
}

type ElementInput = Readonly<{
  ref: string;
  parentRef: string | null;
  tag: string;
  role: string | null;
  basicKind: SingleActionElement["basicKind"];
  controls: ActionObservation<readonly string[]>;
  enabled: ActionObservation<boolean>;
  hit: ActionObservation<boolean>;
  buttonSemantics: ActionObservation<boolean>;
  point: ActionObservation<{ readonly x: number; readonly y: number }>;
  evidenceRefs: readonly string[];
}>;

function makeEpisode(family: Family, variant: number): SingleActionTeacherEpisode {
  const id = `${family.id}-${String(variant).padStart(2, "0")}`;
  const observationId = `${id}:pre`;
  const evidence: { id: string; observationId: string; source: string; fact: unknown }[] = [];
  const addEvidence = (source: string, fact: unknown): string => {
    const id = `${observationId}:evidence:${evidence.length}`;
    evidence.push({ id, observationId, source, fact });
    return id;
  };
  const binding = { documentRef: "fixture-document", observationId, revision: 7 + variant };
  const goalRegionRef = variant === 1 ? "region-b" : "region-a";
  const adjacentRegionRef = goalRegionRef === "region-a" ? "region-b" : "region-a";
  const expandedValue = variant === 2 ? true : false;
  const expandedUnknown = variant === 3 || variant === 7;

  const scopeEvidence = addEvidence("fixture.scope", binding);
  const wrapperAEvidence = addEvidence("fixture.wrapper", { binding, ref: "wrapper-a" });
  const wrapperBEvidence = addEvidence("fixture.wrapper", { binding, ref: "wrapper-b" });
  const toolbarEvidence = addEvidence("fixture.wrapper", { binding, ref: "toolbar" });
  const textEvidence = addEvidence("fixture.text", binding);
  const disabledEvidence = addEvidence("fixture.disabled", binding);

  const regionEvidence = new Map<string, string>();
  for (const ref of ["region-a", "region-b"]) {
    regionEvidence.set(ref, addEvidence("fixture.region", { binding, ref }));
  }
  const expandedEvidence = new Map<string, string>();
  for (const ref of ["control-target", "control-neighbor", "control-alternate"]) {
    expandedEvidence.set(ref, addEvidence("fixture.aria-expanded", {
      binding,
      ref,
      value: expandedUnknown ? null : expandedValue,
    }));
  }
  const controlEvidence = new Map<string, string>();
  for (const ref of ["control-target", "control-neighbor", "control-alternate", "control-disabled"]) {
    controlEvidence.set(ref, addEvidence("fixture.control", { binding, ref }));
  }
  const pointEvidence = new Map<string, string>();
  for (const ref of ["control-target", "control-neighbor", "control-alternate"]) {
    pointEvidence.set(ref, addEvidence("fixture.point", { binding, ref }));
  }

  const controlTag = family.tag.toUpperCase();
  const controlsFor = (ref: string, target: string | null, forcedUnknown = false): ActionObservation<readonly string[]> =>
    forcedUnknown
      ? unknown("aria_controls_unresolved")
      : observed(target === null ? [] : [target], [controlEvidence.get(ref)!]);
  const enabledFor = (value: boolean | null, ref: string): ActionObservation<boolean> =>
    value === null
      ? unknown("enabled_not_applicable")
      : observed(value, [controlEvidence.get(ref)!]);
  const hitFor = (value: boolean | null, ref: string): ActionObservation<boolean> =>
    value === null
      ? unknown("native_hit_unmeasured")
      : observed(value, [controlEvidence.get(ref)!]);
  const pointFor = (ref: string, hit: ActionObservation<boolean>): ActionObservation<{ readonly x: number; readonly y: number }> =>
    hit.status === "observed" && hit.value
      ? observed({ x: 40 + variant * 5, y: 24 }, [pointEvidence.get(ref)!])
      : unknown("no_hit_point");
  const semanticsFor = (value: boolean, ref: string): ActionObservation<boolean> =>
    observed(value, [controlEvidence.get(ref)!]);

  const targetControlsUnknown = variant === 7;
  const targetHit = variant === 8 ? null : variant === 9 ? false : true;
  const targetEnabled = variant === 4 || variant === 5 ? false : true;
  const target = controlsFor("control-target", goalRegionRef, targetControlsUnknown);
  const targetHitObservation = hitFor(targetHit, "control-target");
  const targetEnabledObservation = enabledFor(targetEnabled, "control-target");
  const targetPoint = pointFor("control-target", targetHitObservation);
  const targetElement: ElementInput = {
    ref: "control-target",
    parentRef: family.nesting === 0 ? "scope" : family.nesting === 1 ? "wrapper-a" : "wrapper-b",
    tag: family.tag,
    role: family.role,
    basicKind: "button",
    controls: target,
    enabled: targetEnabledObservation,
    hit: targetHitObservation,
    buttonSemantics: semanticsFor(true, "control-target"),
    point: targetPoint,
    evidenceRefs: [controlEvidence.get("control-target")!, ...(target.status === "observed" ? target.evidenceRefs : [])],
  };

  const neighbor = controlsFor("control-neighbor", adjacentRegionRef);
  const neighborHit = hitFor(true, "control-neighbor");
  const neighborElement: ElementInput = {
    ref: "control-neighbor",
    parentRef: "toolbar",
    tag: "button",
    role: null,
    basicKind: "button",
    controls: neighbor,
    enabled: enabledFor(true, "control-neighbor"),
    hit: neighborHit,
    buttonSemantics: semanticsFor(true, "control-neighbor"),
    point: pointFor("control-neighbor", neighborHit),
    evidenceRefs: [controlEvidence.get("control-neighbor")!],
  };

  const alternate = controlsFor("control-alternate", variant === 6 ? goalRegionRef : adjacentRegionRef);
  const alternateHit = hitFor(true, "control-alternate");
  const alternateElement: ElementInput = {
    ref: "control-alternate",
    parentRef: "toolbar",
    tag: "button",
    role: null,
    basicKind: "button",
    controls: alternate,
    enabled: enabledFor(true, "control-alternate"),
    hit: alternateHit,
    buttonSemantics: semanticsFor(true, "control-alternate"),
    point: pointFor("control-alternate", alternateHit),
    evidenceRefs: [controlEvidence.get("control-alternate")!],
  };

  const disabledElement: ElementInput = {
    ref: "control-disabled",
    parentRef: "toolbar",
    tag: "button",
    role: null,
    basicKind: "button",
    controls: controlsFor("control-disabled", goalRegionRef),
    enabled: enabledFor(false, "control-disabled"),
    hit: hitFor(true, "control-disabled"),
    buttonSemantics: semanticsFor(true, "control-disabled"),
    point: observed({ x: 220, y: 24 }, [pointEvidence.get("control-neighbor")!]),
    evidenceRefs: [disabledEvidence],
  };

  const textElement: ElementInput = {
    ref: "caption",
    parentRef: family.captionInControl ? "control-target" : "toolbar",
    tag: "span",
    role: null,
    basicKind: "text",
    controls: observed([], [textEvidence]),
    enabled: unknown("enabled_not_applicable"),
    hit: unknown("hit_not_required_for_text"),
    buttonSemantics: observed(false, [textEvidence]),
    point: unknown("no_hit_point"),
    evidenceRefs: [textEvidence],
  };
  const wrapperA: ElementInput = {
    ref: "wrapper-a",
    parentRef: "scope",
    tag: "div",
    role: null,
    basicKind: "container",
    controls: observed([], [wrapperAEvidence]),
    enabled: unknown("enabled_not_applicable"),
    hit: unknown("hit_not_required_for_wrapper"),
    buttonSemantics: observed(false, [wrapperAEvidence]),
    point: unknown("no_hit_point"),
    evidenceRefs: [wrapperAEvidence],
  };
  const wrapperB: ElementInput = {
    ref: "wrapper-b",
    parentRef: "wrapper-a",
    tag: "div",
    role: null,
    basicKind: "container",
    controls: observed([], [wrapperBEvidence]),
    enabled: unknown("enabled_not_applicable"),
    hit: unknown("hit_not_required_for_wrapper"),
    buttonSemantics: observed(false, [wrapperBEvidence]),
    point: unknown("no_hit_point"),
    evidenceRefs: [wrapperBEvidence],
  };
  const toolbar: ElementInput = {
    ref: "toolbar",
    parentRef: "scope",
    tag: "div",
    role: "toolbar",
    basicKind: "container",
    controls: observed([], [toolbarEvidence]),
    enabled: unknown("enabled_not_applicable"),
    hit: unknown("hit_not_required_for_wrapper"),
    buttonSemantics: observed(false, [toolbarEvidence]),
    point: unknown("no_hit_point"),
    evidenceRefs: [toolbarEvidence],
  };
  const scope: ElementInput = {
    ref: "scope",
    parentRef: null,
    tag: "main",
    role: null,
    basicKind: "container",
    controls: observed([], [scopeEvidence]),
    enabled: unknown("enabled_not_applicable"),
    hit: unknown("hit_not_required_for_wrapper"),
    buttonSemantics: observed(false, [scopeEvidence]),
    point: unknown("no_hit_point"),
    evidenceRefs: [scopeEvidence],
  };
  const regionElement = (ref: string): ElementInput => ({
    ref,
    parentRef: "scope",
    tag: "section",
    role: "region",
    basicKind: "container",
    controls: observed([], [regionEvidence.get(ref)!]),
    enabled: unknown("enabled_not_applicable"),
    hit: unknown("region_presentation_state"),
    buttonSemantics: observed(false, [regionEvidence.get(ref)!]),
    point: unknown("no_hit_point"),
    evidenceRefs: [regionEvidence.get(ref)!],
  });

  const elements: SingleActionElement[] = [
    scope,
    wrapperA,
    wrapperB,
    toolbar,
    targetElement,
    textElement,
    neighborElement,
    alternateElement,
    disabledElement,
    regionElement("region-a"),
    regionElement("region-b"),
  ].map(item => ({
    ...item,
    judgmentStatus: "judged" as const,
    candidateStatus: "ok" as const,
    controls: item.controls,
    enabled: item.enabled,
    hit: item.hit,
    buttonSemantics: item.buttonSemantics,
    point: item.point,
    evidenceRefs: Object.freeze([...new Set(item.evidenceRefs)]),
  }));

  const regions: SingleActionRegion[] = [goalRegionRef, adjacentRegionRef].map((ref, index) => ({
    ref,
    expanded: expandedUnknown
      ? unknown("expanded_evidence_unavailable")
      : observed(index === 0 ? expandedValue : false, [
        expandedEvidence.get(index === 0 ? "control-target" : "control-neighbor")!,
      ]),
    rendered: observed(index === 0 ? expandedValue : false, [regionEvidence.get(ref)!]),
  }));

  const snapshot: SingleActionSnapshot = {
    ...binding,
    scopeRef: "scope",
    regions,
    elements,
    evidence,
  };
  const providerRefs = variant === 6
    ? ["control-target", "control-alternate"]
    : variant === 4 || variant === 5 || variant === 7 || variant === 8 || variant === 9
      ? []
      : ["control-target"];
  const unknownRefs = [
    "scope",
    "wrapper-a",
    "wrapper-b",
    "toolbar",
    "caption",
    "region-a",
    "region-b",
    ...(variant === 7 ? ["control-target"] : []),
  ];
  const expectedCapability: SingleActionCapability = variant === 2
    ? "NOOP"
    : variant === 0 || variant === 1
      ? "CLICK"
      : "DEFER";
  return Object.freeze({
    id,
    family: family.id,
    partition: family.partition,
    request: Object.freeze({
      goal: Object.freeze({ kind: "SetExpanded", regionRef: goalRegionRef, desired: true }),
      satisfactionThreshold: 100,
      state: snapshot,
    }),
    teacher: Object.freeze({
      providerRefs: Object.freeze(providerRefs),
      unknownRefs: Object.freeze(unknownRefs),
      capability: expectedCapability,
      source: "synthetic_projection",
      evidenceRefs: Object.freeze(evidence.map(item => item.id)),
    }),
  });
}

export function makeBrowserSingleActionSamples(): readonly SingleActionTeacherEpisode[] {
  const episodes = FAMILIES.flatMap(family =>
    Array.from({ length: 10 }, (_, variant) => makeEpisode(family, variant)));
  return readBrowserSingleActionTeacherEpisodes(episodes);
}
