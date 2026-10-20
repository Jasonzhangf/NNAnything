import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASIC_KIND_FAMILIES,
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  LEAF_SUPPORT_WIRES,
  basicKindLeafSupportGate,
  classifyBasicKind,
  extractBasicKindWires,
  migrateBasicKindProfile,
  validateBasicKindProfile,
  validateBasicKindProperties,
} from "nnanything/browser";

const handwiredRoot = "/Volumes/extension/code/handwired";
const wire = "neutral_child_multiplicity";
const toleranced = (actual, expected, label) => assert.ok(
  Math.abs(actual - expected) < 1e-12,
  `${label}: ${actual} != ${expected}`,
);

const neutralDiv = {
  tag: "div",
  role: null,
  inputType: null,
  hrefPresent: false,
  contentEditable: false,
  directTextPresent: false,
  nonFormatDirectTextPresent: false,
  beforeContentPresent: false,
  afterContentPresent: false,
  backgroundImagePresent: false,
  maskImagePresent: false,
  childElementCount: null,
  positiveAreaChildCount: null,
  repeatedChildGeometry: false,
  inVerifiedListParent: false,
  svgGraphicChildren: false,
  pointerCursor: false,
  parentPointerCursor: false,
  tabIndexFocus: false,
  activeElementFocus: false,
  borderPresent: false,
  aspectRatio: 0.4,
  descendantTextPresent: true,
  directListChildPresent: false,
  singleChildTag: null,
  singleChildSameRect: false,
  withinControlAncestor: false,
  inSvgAncestor: false,
  shallowStructuralPeerRatio: 1,
  coincidentChildPairRatio: 0,
  ownLabelPresent: false,
  graphicDescendantPresent: false,
  disabled: false,
  hidden: false,
};
const properties = fields => validateBasicKindProperties({ ...neutralDiv, ...fields });
const wiresOf = fields => extractBasicKindWires(properties(fields));
const multiplicity = fields => wiresOf(fields)[wire];

// The three real development vectors differ only in shallow repetition facts.
// Their site-specific evidence stays out of the fixture; only measured scalars
// that already exist on the student input are reproduced here.
const threeRealVectors = [
  { id: "A", expectedLabel: "container", childElementCount: 3, positiveAreaChildCount: 2, shallowStructuralPeerRatio: 1 },
  { id: "B", expectedLabel: "list", childElementCount: 6, positiveAreaChildCount: 6, shallowStructuralPeerRatio: 5 / 6 },
  { id: "C", expectedLabel: "container", childElementCount: 4, positiveAreaChildCount: 4, shallowStructuralPeerRatio: 3 / 4 },
].map(row => ({
  ...row,
  properties: properties({
    childElementCount: row.childElementCount,
    positiveAreaChildCount: row.positiveAreaChildCount,
    shallowStructuralPeerRatio: row.shallowStructuralPeerRatio,
  }),
}));

const differingWires = new Set(["neutral_structural_peers", "neutral_structural_heterogeneity", wire]);

const emptyRows = names => Object.fromEntries(names.map(name => [name, {}]));
const emptyProfile = id => ({
  id,
  familyWeights: emptyRows(Object.keys(BASIC_KIND_FAMILIES)),
  leafWeights: emptyRows([...new Set(Object.values(BASIC_KIND_FAMILIES).flat())]),
});

test("the three real vectors are collinear on the old wires and split only on repetition facts", () => {
  const [a, b, c] = threeRealVectors.map(row => extractBasicKindWires(row.properties));
  for (const name of Object.keys(a)) {
    if (differingWires.has(name)) continue;
    assert.equal(b[name], a[name], `${name} B vs A`);
    assert.equal(c[name], a[name], `${name} C vs A`);
  }
  assert.equal(a.neutral_structural_peers, 1);
  assert.equal(b.neutral_structural_peers, 5 / 6);
  assert.equal(c.neutral_structural_peers, 3 / 4);
  toleranced(a.neutral_structural_heterogeneity, 0, "A heterogeneity");
  toleranced(b.neutral_structural_heterogeneity, 1 / 6, "B heterogeneity");
  toleranced(c.neutral_structural_heterogeneity, 1 / 4, "C heterogeneity");

  for (const name of Object.keys(a)) {
    if (name === wire) continue;
    const expected = a[name] / 3 + (c[name] * 2) / 3;
    toleranced(b[name], expected, `old convex ${name}`);
  }
});

test("the new multiplicity wire separates the middle vector from the container convex mix", () => {
  const [a, b, c] = threeRealVectors.map(row => extractBasicKindWires(row.properties));
  assert.equal(a[wire], 0.5);
  assert.equal(b[wire], 5 / 6);
  assert.equal(c[wire], 3 / 4);
  const convex = a[wire] / 3 + (c[wire] * 2) / 3;
  assert.ok(Math.abs(b[wire] - convex) > 0.1, `middle ${b[wire]} stays at convex ${convex}`);
});

test("neutral_child_multiplicity is bounded by count and never invents a zero", () => {
  assert.equal(multiplicity({ positiveAreaChildCount: 0 }), 0);
  assert.equal(multiplicity({ positiveAreaChildCount: 1 }), 0);
  assert.equal(multiplicity({ positiveAreaChildCount: 2 }), 0.5);
  assert.equal(multiplicity({ positiveAreaChildCount: 4 }), 0.75);
  assert.equal(multiplicity({ positiveAreaChildCount: 6 }), 5 / 6);
  assert.ok(multiplicity({ positiveAreaChildCount: 8 }) > multiplicity({ positiveAreaChildCount: 6 }));
  assert.equal(multiplicity({ positiveAreaChildCount: null }), null);

  // Only the positive-area direct-child count matters; zero-area siblings do not change it.
  assert.equal(
    multiplicity({ childElementCount: 4, positiveAreaChildCount: 2 }),
    multiplicity({ childElementCount: 12, positiveAreaChildCount: 2 }),
  );

  // A known non-neutral host is inapplicable, not an unknown measurement.
  assert.equal(multiplicity({ tag: "article", positiveAreaChildCount: 6 }), 0);
  assert.equal(multiplicity({ childElementCount: null }), null);
});

test("child multiplicity is not support and cannot open list by count alone", () => {
  assert.equal(LEAF_SUPPORT_WIRES.list.includes(wire), false);
  const countOnly = wiresOf({ positiveAreaChildCount: 6, shallowStructuralPeerRatio: null });
  assert.equal(countOnly[wire], 5 / 6);
  assert.equal(basicKindLeafSupportGate(countOnly, "list"), 0);
});

test("the plan witness profile judges container/list/container for the three vectors", () => {
  const familyWeights = emptyRows(Object.keys(BASIC_KIND_FAMILIES));
  const leafWeights = emptyRows([...new Set(Object.values(BASIC_KIND_FAMILIES).flat())]);
  familyWeights.structure = { nat_div: 0.8, div_multi_child: 0.45, composite_descendant_text: 0.3 };
  leafWeights.list = { [wire]: 1, neutral_structural_peers: 1, neutral_multi_child: -0.85 };
  leafWeights.container = {
    [wire]: -1,
    neutral_structural_heterogeneity: 1,
    nat_div: 0.3674514889717102,
    div_multi_child: 0.3441799581050873,
    composite_descendant_text: 0.00433575501665473,
    neutral_multi_child: 0.6090327979065478,
  };
  const witness = validateBasicKindProfile({
    id: "child-multiplicity-witness",
    topology: "priority_staged_v1",
    familyWeights,
    leafWeights,
  });

  const results = threeRealVectors.map(row => classifyBasicKind(row.properties, DEFAULT_BASIC_KIND_CONFIG, witness));
  assert.deepEqual(results.map(result => result.basicKind), ["container", "list", "container"]);
  for (const result of results) {
    assert.equal(result.judgmentStatus, "judged");
    assert.ok(result.margin >= DEFAULT_BASIC_KIND_CONFIG.minMargin);
  }
  assert.ok(results[1].evidence.activeTerms.some(term =>
    term.stage === "leaf" && term.target === "list" && term.wire === wire && term.weight === 1));
});

test("migration adds only the two leaf zero addresses and preserves existing values", () => {
  const source = {
    ...emptyProfile("child-multiplicity-migration-fixture"),
    familyWeights: { ...emptyRows(Object.keys(BASIC_KIND_FAMILIES)), structure: { nat_div: 0.25, div_multi_child: 0.45 } },
    leafWeights: {
      ...emptyRows([...new Set(Object.values(BASIC_KIND_FAMILIES).flat())]),
      list: { neutral_structural_peers: 0.4, nat_list: 0.85 },
      container: { nat_div: 0.7, div_multi_child: -0.3 },
    },
  };
  const before = structuredClone(source);
  const migrated = migrateBasicKindProfile(source);

  assert.equal(migrated.leafWeights.list[wire], 0);
  assert.equal(migrated.leafWeights.container[wire], 0);
  assert.equal(migrated.leafWeights.list.neutral_structural_peers, 0.4);
  assert.equal(migrated.leafWeights.container.nat_div, 0.7);
  assert.equal(migrated.leafWeights.container.div_multi_child, -0.3);

  assert.equal(Object.hasOwn(migrated.familyWeights.structure, wire), false);
  assert.equal(Object.hasOwn(migrated.leafWeights.text, wire), false);
  assert.equal(Object.hasOwn(migrated.leafWeights.listitem, wire), false);

  // Name-based migration is pure and never shifts values by array position.
  assert.deepEqual(source, before);
  assert.deepEqual(before.leafWeights.list, { neutral_structural_peers: 0.4, nat_list: 0.85 });
});

test("a default zero address leaves existing classification unchanged", () => {
  const migrated = migrateBasicKindProfile(DEFAULT_BASIC_KIND_PROFILE);
  const sample = properties({ positiveAreaChildCount: 6, shallowStructuralPeerRatio: 5 / 6 });
  const before = classifyBasicKind(sample, DEFAULT_BASIC_KIND_CONFIG, DEFAULT_BASIC_KIND_PROFILE);
  const after = classifyBasicKind(sample, DEFAULT_BASIC_KIND_CONFIG, migrated);

  assert.equal(migrated.leafWeights.list[wire], 0);
  assert.equal(migrated.leafWeights.container[wire], 0);
  assert.equal(after.basicKind, before.basicKind);
  assert.equal(after.judgmentStatus, before.judgmentStatus);
  assert.equal(after.score, before.score);
  assert.equal(after.margin, before.margin);
  assert.deepEqual(after.familyScores, before.familyScores);
  assert.deepEqual(after.leafScores, before.leafScores);
});

test("the public numeric backend binds both new leaf cells", async () => {
  const { inspectBasicKindNumericSample } = await import("nnanything/training");
  const profile = migrateBasicKindProfile(DEFAULT_BASIC_KIND_PROFILE);
  const inspected = await inspectBasicKindNumericSample({
    handwiredRoot,
    properties: threeRealVectors[1].properties,
    expectedLabel: "list",
    profile,
  });
  assert.equal(Object.hasOwn(inspected.leafGradients.list, wire), true);
  assert.equal(Object.hasOwn(inspected.leafGradients.container, wire), true);
  assert.equal(typeof inspected.leafGradients.list[wire], "number");
});
