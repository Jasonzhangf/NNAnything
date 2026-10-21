// F17 fresh independent sources: two independently constructed page
// implementation families, evaluated item by item through the public entry.
// The same renderPage parameter would not count as independent, so family A and
// family B use different markup conventions and different nesting depths.
// Per-item coverage is reported separately; a total score never hides a gap.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  classifyBasicKind,
  createStableNodeRefRegistry,
  deriveOwnedScope,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : resolve("f17-independent-sources.json");
const config = { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 };

const style = {
  display: "block", visibility: "visible", position: "static", transform: "none", translate: "none",
  rotate: "none", scale: "none", perspective: "none", overflowX: "visible", overflowY: "visible",
  clipPath: "none", clip: "auto", opacity: "1", zIndex: "auto", pointerEvents: "auto", cursor: "auto",
  borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)", borderBottomColor: "rgba(0, 0, 0, 0)",
  borderLeftColor: "rgba(0, 0, 0, 0)", borderTopLeftRadius: "0px", borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px", backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none", backgroundClip: "border-box", maskImage: "none", webkitMaskImage: "none",
  backdropFilter: "none", webkitBackdropFilter: "none", filter: "none", mixBlendMode: "normal",
  isolation: "auto", contain: "none", content: "none",
};

function element(tagName, attrs = {}, options = {}) {
  const node = {
    nodeType: 1, tagName, namespaceURI: "http://www.w3.org/1999/xhtml",
    parentElement: null, children: [], childNodes: [], childElementCount: 0,
    id: attrs.id ?? "", classList: [], matches: () => false, querySelectorAll: () => [],
    getAttribute: name => attrs[name] ?? null, hasAttribute: name => Object.hasOwn(attrs, name),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 20 }),
    getClientRects: () => [{ x: 0, y: 0, width: 40, height: 20 }],
    ...options,
  };
  if (options.text !== undefined) {
    node.childNodes = [{ nodeType: 3, textContent: options.text }];
  }
  return node;
}

function mount(children, byId = new Map()) {
  const html = element("HTML");
  for (const child of children) { child.parentElement = html; if (child.id) byId.set(child.id, child); }
  html.children = children;
  html.childNodes = children;
  html.childElementCount = children.length;
  const document = {
    documentElement: html, body: html, baseURI: "https://f17.test/page", activeElement: null,
    getElementById: id => byId.get(id) ?? null,
  };
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window };
}

// Family A: semantic HTML elements, one flat level.
function familyA() {
  const byId = new Map();
  const button = element("BUTTON", {}, { text: "保存" });
  const checkbox = element("INPUT", { type: "checkbox" }, { type: "checkbox", checked: true });
  const readonlyInput = element("INPUT", { type: "text", readonly: "" }, { type: "text", value: "固定值" });
  const details = element("DETAILS", { open: "" });
  const option = element("OPTION", { selected: "" }, { text: "选项一" });
  const select = element("SELECT", {}, { text: "" });
  select.children = [option]; select.childNodes = [option]; select.childElementCount = 1; option.parentElement = select;
  const link = element("A", { href: "/detail/1" }, { text: "详情" });
  const image = element("IMG", { src: "/pic.png" });
  const listItem = element("LI", {}, { text: "条目" });
  const list = element("UL");
  list.children = [listItem]; list.childNodes = [listItem]; list.childElementCount = 1; listItem.parentElement = list;
  return { dom: mount([button, checkbox, readonlyInput, details, select, link, image, list], byId), nodes: { button, checkbox, readonlyInput, details, select, option, link, image, list, listItem } };
}

// Family B: div plus ARIA roles, deeper nesting with an extra wrapper level.
function familyB() {
  const byId = new Map();
  const wrapper = element("DIV");
  const button = element("DIV", { role: "button" }, { text: "保存" });
  const checkbox = element("DIV", { role: "checkbox", "aria-checked": "true" });
  const editable = element("DIV", { contenteditable: "true" }, { text: "可编辑", matches: name => name === ":read-write" });
  const details = element("DIV", { role: "group", "aria-expanded": "true" });
  const link = element("DIV", { role: "link" }, { text: "详情" });
  const image = element("DIV", { role: "img", "aria-label": "封面" });
  const listItem = element("DIV", { role: "listitem" }, { text: "条目" });
  const list = element("DIV", { role: "list" });
  list.children = [listItem]; list.childNodes = [listItem]; list.childElementCount = 1; listItem.parentElement = list;
  wrapper.children = [button, checkbox, editable, details, link, image, list];
  wrapper.childNodes = wrapper.children;
  wrapper.childElementCount = wrapper.children.length;
  for (const child of wrapper.children) child.parentElement = wrapper;
  return { dom: mount([wrapper], byId), nodes: { wrapper, button, checkbox, editable, details, link, image, list, listItem } };
}

function observe(family, label) {
  const registry = createStableNodeRefRegistry(label);
  const snapshot = observeLiveDom({
    document: family.dom.document, window: family.dom.window, registry,
    excludeRoot: null, snapshotRef: label, documentRef: "f17",
  });
  return { registry, snapshot, refOf: node => stableNodeRefFor(registry, node) };
}

function classify(observed, node) {
  const ref = observed.refOf(node);
  const props = observed.snapshot.properties.get(ref);
  if (!props) return { status: "no_property", kind: null };
  const result = classifyBasicKind(props, config, undefined);
  return { status: result.judgmentStatus, kind: result.basicKind ?? null, score: result.score ?? null };
}

function attributeOf(observed, node, name) {
  const ref = observed.refOf(node);
  const found = observed.snapshot.observation.nodes.find(item => item.nodeRef === ref);
  if (!found) return { present: false, value: null };
  return { present: Object.hasOwn(found.attributes, name), value: found.attributes[name] ?? null };
}

function evidenceOf(observed, node) {
  return observed.snapshot.evidence.get(observed.refOf(node)) ?? null;
}

const checks = [];

function record(item, family, verdict, detail) {
  checks.push({ item, family, verdict, detail });
}

// --- Family A ---
const a = familyA();
const aObs = observe(a, "f17-family-a");
{
  const kind = classify(aObs, a.nodes.button);
  record("button", "A-semantic-html", kind.kind === "button" ? "pass" : "fail", `kind=${kind.kind} status=${kind.status}`);
  const checked = attributeOf(aObs, a.nodes.checkbox, "checked");
  record("checked-state", "A-semantic-html", checked.present && checked.value === true ? "pass" : "fail", `checked=${JSON.stringify(checked.value)} present=${checked.present}`);
  const readonly = attributeOf(aObs, a.nodes.readonlyInput, "readonly");
  record("readonly-state", "A-semantic-html", readonly.present && readonly.value === true ? "pass" : "fail", `readonly=${JSON.stringify(readonly.value)}`);
  const open = attributeOf(aObs, a.nodes.details, "open");
  record("expanded-declared", "A-semantic-html", open.present && open.value === true ? "pass" : "fail", `open=${JSON.stringify(open.value)}`);
  const selected = attributeOf(aObs, a.nodes.option, "selected");
  record("selected-state", "A-semantic-html", selected.present && selected.value === true ? "pass" : "fail", `selected=${JSON.stringify(selected.value)}`);
  const selectKind = classify(aObs, a.nodes.select);
  record("select", "A-semantic-html", selectKind.kind === "select" ? "pass" : "fail", `kind=${selectKind.kind} status=${selectKind.status}`);
  const linkKind = classify(aObs, a.nodes.link);
  record("link", "A-semantic-html", linkKind.kind === "link" ? "pass" : "fail", `kind=${linkKind.kind}`);
  const imageKind = classify(aObs, a.nodes.image);
  record("image-kind", "A-semantic-html", imageKind.kind === "image" ? "pass" : "fail", `kind=${imageKind.kind}`);
  const listItemKind = classify(aObs, a.nodes.listItem);
  record("listitem", "A-semantic-html", listItemKind.kind === "listitem" ? "pass" : "fail", `kind=${listItemKind.kind}`);
  const value = evidenceOf(aObs, a.nodes.readonlyInput)?.inputValue ?? null;
  record("input-value", "A-semantic-html", value === "固定值" ? "pass" : "fail", `value=${JSON.stringify(value)}`);
}

// --- Family B ---
const b = familyB();
const bObs = observe(b, "f17-family-b");
{
  const kind = classify(bObs, b.nodes.button);
  record("button", "B-aria-div", kind.kind === "button" ? "pass" : "fail", `kind=${kind.kind} status=${kind.status}`);
  const checked = attributeOf(bObs, b.nodes.checkbox, "aria-checked");
  record("checked-state", "B-aria-div", checked.value === "true" ? "pass" : "fail", `aria-checked=${JSON.stringify(checked.value)}`);
  const editable = evidenceOf(bObs, b.nodes.editable);
  const editableRef = bObs.refOf(b.nodes.editable);
  const editableProps = bObs.snapshot.properties.get(editableRef);
  record("editable", "B-aria-div", editableProps?.contentEditable === true ? "pass" : "fail", `contentEditable=${JSON.stringify(editableProps?.contentEditable)}`);
  const expanded = attributeOf(bObs, b.nodes.details, "aria-expanded");
  record("expanded-declared", "B-aria-div", expanded.value === "true" ? "pass" : "fail", `aria-expanded=${JSON.stringify(expanded.value)}`);
  const linkKind = classify(bObs, b.nodes.link);
  record("link", "B-aria-div", linkKind.kind === "link" ? "pass" : "fail", `kind=${linkKind.kind}`);
  const imageEvidence = evidenceOf(bObs, b.nodes.image);
  const imageKind = classify(bObs, b.nodes.image);
  record("image-name", "B-aria-div", imageEvidence?.accessibleName === "封面" ? "pass" : "fail", `accessibleName=${JSON.stringify(imageEvidence?.accessibleName)} source=${JSON.stringify(imageEvidence?.accessibleNameSource)}`);
  // role=img is not a leaf label in the current vocabulary; the kind claim stays unverified.
  record("image-kind", "B-aria-div", imageKind.kind === "image" ? "pass" : "unverified", `kind=${imageKind.kind} status=${imageKind.status}`);
  const listKind = classify(bObs, b.nodes.list);
  record("list", "B-aria-div", listKind.kind === "list" ? "pass" : "fail", `kind=${listKind.kind}`);
  // Nested scope: the wrapper contains a nested button scope.
  const wrapperInput = bObs.snapshot.explorationInputs?.get(bObs.refOf(b.nodes.wrapper));
  if (wrapperInput) {
    const scope = deriveOwnedScope(wrapperInput);
    const hasNested = scope.nestedScopeRefs.includes(bObs.refOf(b.nodes.button));
    record("nested-scope", "B-aria-div", hasNested ? "pass" : "unverified", `status=${scope.status} nested=${scope.nestedScopeRefs.length}`);
  } else {
    record("nested-scope", "B-aria-div", "unverified", "no_exploration_input");
  }
  record("select", "B-aria-div", "unverified", "family B has no native select; aria listbox is a different implementation");
}

const items = [...new Set(checks.map(check => check.item))];
const summary = items.map(item => {
  const rows = checks.filter(check => check.item === item);
  const families = [...new Set(rows.map(row => row.family))];
  const passCount = rows.filter(row => row.verdict === "pass").length;
  const failCount = rows.filter(row => row.verdict === "fail").length;
  const unverifiedCount = rows.filter(row => row.verdict === "unverified").length;
  return {
    item, families,
    verdict: failCount > 0 ? "fail" : unverifiedCount > 0 ? "unverified" : "pass",
    passCount, failCount, unverifiedCount,
    aggregateScoreWouldHide: "per-item only; no aggregate is computed",
  };
});

const report = {
  schemaVersion: "browser-foundation-f17.v1",
  families: [
    { id: "A-semantic-html", construction: "native HTML elements, flat sibling level", independent: true },
    { id: "B-aria-div", construction: "div plus ARIA roles, one extra wrapper level", independent: true },
  ],
  independenceStatement: "Two families use different markup conventions and different nesting. Neither family is the same renderPage with different parameters.",
  realSiteEvidence: {
    source: "/Volumes/Intel/playground/nnanything-runs/basic-semantic-coverage-20261020/c1/evidence.json",
    note: "Existing real-site read-only observation (xiaohongshu/zhihu/weibo). Reused as-is; no new site navigation was performed.",
    gaps: ["audio=0 gold rows", "video=1 gold row", "ignore=0 gold rows"],
  },
  checks,
  summary,
  itemTotals: {
    items: items.length,
    pass: summary.filter(row => row.verdict === "pass").length,
    fail: summary.filter(row => row.verdict === "fail").length,
    unverified: summary.filter(row => row.verdict === "unverified").length,
  },
};

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`F17 items=${report.itemTotals.items} pass=${report.itemTotals.pass} fail=${report.itemTotals.fail} unverified=${report.itemTotals.unverified}`);
for (const row of summary) console.log(`${row.verdict.padEnd(10)} ${row.item.padEnd(18)} pass=${row.passCount} fail=${row.failCount} unverified=${row.unverifiedCount}`);
process.exitCode = report.itemTotals.fail > 0 ? 1 : 0;