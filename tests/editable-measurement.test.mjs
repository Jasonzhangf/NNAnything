import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStableNodeRefRegistry,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const style = {
  display: "block",
  visibility: "visible",
  position: "static",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  opacity: "1",
  zIndex: "auto",
  pointerEvents: "auto",
  cursor: "auto",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopStyle: "none",
  borderRightStyle: "none",
  borderBottomStyle: "none",
  borderLeftStyle: "none",
  borderTopColor: "rgba(0, 0, 0, 0)",
  borderRightColor: "rgba(0, 0, 0, 0)",
  borderBottomColor: "rgba(0, 0, 0, 0)",
  borderLeftColor: "rgba(0, 0, 0, 0)",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  maskImage: "none",
  webkitMaskImage: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
  filter: "none",
  mixBlendMode: "normal",
  isolation: "auto",
  contain: "none",
  content: "none",
};

function fixtureElement({
  tagName,
  parent = null,
  namespaceURI = XHTML_NAMESPACE,
  attributes = {},
  nativeEditable,
  matches,
  namespaceUnreadable = false,
}) {
  const element = {
    nodeType: 1,
    tagName,
    namespaceURI,
    parentElement: parent,
    children: [],
    childNodes: [],
    childElementCount: 0,
    id: "",
    classList: [],
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name);
    },
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 200, height: 40 }),
    getClientRects: () => [{ x: 10, y: 10, width: 200, height: 40 }],
    querySelectorAll: () => [],
  };
  if (nativeEditable !== undefined) {
    Object.defineProperty(element, "isContentEditable", {
      configurable: true,
      get: nativeEditable === "throw" ? () => { throw new Error("unreadable"); } : () => nativeEditable,
    });
  }
  if (namespaceUnreadable) {
    Object.defineProperty(element, "namespaceURI", {
      configurable: true,
      get: () => { throw new Error("unreadable namespace"); },
    });
  }
  if (matches !== undefined) {
    if (matches.kind === "unreadable") {
      Object.defineProperty(element, "matches", {
        configurable: true,
        get: () => { throw new Error("unreadable matches"); },
      });
    } else if (matches.kind !== "missing") {
      element.matches = (selector) => {
        matches.calls.push(selector);
        if (matches.kind === "throw") throw new Error("unsupported selector");
        if (matches.kind === "nonboolean") return "read-write";
        return matches.value;
      };
    }
  }
  return element;
}

function selectorProbe(value) {
  return { kind: "boolean", value, calls: [] };
}

function selectorFailure(kind) {
  return { kind, calls: [] };
}

function editableDom({
  targetAttributes = {},
  targetNativeEditable,
  targetTagName = "DIV",
  targetMatches,
  rootAttributes = {},
  designMode = "off",
  ancestors = [],
  rootNamespace = XHTML_NAMESPACE,
} = {}) {
  const html = fixtureElement({ tagName: "HTML", namespaceURI: rootNamespace, attributes: rootAttributes });
  let parent = html;
  const createdAncestors = [];
  for (const ancestor of ancestors) {
    const node = fixtureElement({
      tagName: ancestor.tagName ?? "DIV",
      parent,
      namespaceURI: ancestor.namespaceURI ?? XHTML_NAMESPACE,
      attributes: ancestor.attributes ?? {},
      nativeEditable: ancestor.nativeEditable,
      namespaceUnreadable: ancestor.namespaceUnreadable,
    });
    parent.children = [node];
    parent.childNodes = [node];
    parent.childElementCount = 1;
    createdAncestors.push(node);
    parent = node;
  }
  const target = fixtureElement({
    tagName: targetTagName,
    parent,
    attributes: targetAttributes,
    nativeEditable: targetNativeEditable,
    matches: targetMatches,
  });
  parent.children = [target];
  parent.childNodes = [target];
  parent.childElementCount = 1;
  const document = {
    documentElement: html,
    body: html,
    baseURI: "https://fixture.test/page",
    activeElement: target,
  };
  if (designMode === "unknown") {
    // No designMode property: the fixture models an unreadable document state.
  } else if (designMode === "throw") {
    Object.defineProperty(document, "designMode", {
      configurable: true,
      get: () => { throw new Error("unreadable designMode"); },
    });
  } else if (designMode !== undefined) {
    document.designMode = designMode;
  }
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style };
  return { document, window, html, target, ancestors: createdAncestors };
}

function contentEditable(dom) {
  const registry = createStableNodeRefRegistry("editable");
  const snapshot = observeLiveDom({
    document: dom.document,
    window: dom.window,
    registry,
    excludeRoot: null,
    snapshotRef: "editable",
    documentRef: "fixture",
  });
  return snapshot.properties.get(stableNodeRefFor(registry, dom.target)).contentEditable;
}

test("unavailable native getter falls back to an explicit HTML contenteditable declaration", () => {
  const dom = editableDom({ targetAttributes: { contenteditable: "true" } });
  assert.equal(contentEditable(dom), true);
});

test("unavailable native getter with no declaration or designMode stays null", () => {
  const dom = editableDom({ designMode: "unknown" });
  assert.equal(contentEditable(dom), null);
});

test("native Boolean measurements take precedence over declarations and selectors", () => {
  const contradicted = selectorProbe(true);
  assert.equal(contentEditable(editableDom({
    targetNativeEditable: false,
    targetAttributes: { contenteditable: "true" },
    designMode: "on",
    targetMatches: contradicted,
  })), false);
  assert.equal(contradicted.calls.length, 0);
  assert.equal(contentEditable(editableDom({
    targetNativeEditable: true,
    targetAttributes: { contenteditable: "false" },
    designMode: "off",
    targetMatches: selectorProbe(false),
  })), true);
  assert.equal(contentEditable(editableDom({
    targetNativeEditable: true,
    targetAttributes: { contenteditable: "false" },
    rootNamespace: SVG_NAMESPACE,
  })), true);
});

test("designMode on overrides own and ancestor false declarations", () => {
  assert.equal(contentEditable(editableDom({
    targetAttributes: { contenteditable: "false" },
    designMode: "on",
  })), true);

  const blocked = editableDom({
    ancestors: [{ attributes: { contenteditable: "false" } }],
    designMode: "on",
  });
  assert.equal(contentEditable(blocked), true);
});

test("false declarations under known off stay false while a nearer true overrides", () => {
  assert.equal(contentEditable(editableDom({
    targetAttributes: { contenteditable: "false" },
    designMode: "off",
  })), false);
  assert.equal(contentEditable(editableDom({
    ancestors: [{ attributes: { contenteditable: "false" } }],
    designMode: "off",
  })), false);

  const nestedTrue = editableDom({
    ancestors: [{ attributes: { contenteditable: "false" } }],
    targetAttributes: { contenteditable: "true" },
    designMode: "off",
  });
  assert.equal(contentEditable(nestedTrue), true);
});

test("false declarations under unknown designMode without a selector stay null", () => {
  assert.equal(contentEditable(editableDom({
    targetAttributes: { contenteditable: "false" },
    designMode: "unknown",
    targetMatches: selectorFailure("missing"),
  })), null);
  assert.equal(contentEditable(editableDom({
    ancestors: [{ attributes: { contenteditable: "false" } }],
    designMode: "unknown",
    targetMatches: selectorFailure("missing"),
  })), null);
});

test("safe positive declarations prove editability under unknown designMode", () => {
  for (const attributes of [
    { contenteditable: "true" },
    { contenteditable: "" },
    { contenteditable: "plaintext-only" },
  ]) {
    assert.equal(contentEditable(editableDom({
      targetAttributes: attributes,
      designMode: "unknown",
      targetMatches: selectorFailure("missing"),
    })), true, JSON.stringify(attributes));
  }
  assert.equal(contentEditable(editableDom({
    ancestors: [{ attributes: { contenteditable: "true" } }],
    targetAttributes: { contenteditable: "false" },
    designMode: "unknown",
    targetMatches: selectorFailure("missing"),
  })), null);
});

test("native browser evidence: designMode on overrides a nonroot false declaration", () => {
  // The disposable native-browser matrix records isContentEditable=true and
  // :read-write=true for this case. It contradicts the earlier fallback rule.
  assert.equal(contentEditable(editableDom({
    targetAttributes: { contenteditable: "false" },
    designMode: "on",
  })), true);
});

test("trusted native selector Booleans substitute before declaration fallback", () => {
  for (const value of [false, true]) {
    const probe = selectorProbe(value);
    assert.equal(contentEditable(editableDom({
      designMode: "unknown",
      targetMatches: probe,
    })), value, `no declaration, selector ${value}`);
    assert.deepEqual(probe.calls, [":read-write"]);

    assert.equal(contentEditable(editableDom({
      targetAttributes: { contenteditable: "false" },
      designMode: "unknown",
      targetMatches: selectorProbe(value),
    })), value, `own false, selector ${value}`);
    assert.equal(contentEditable(editableDom({
      ancestors: [{ attributes: { contenteditable: "false" } }],
      designMode: "unknown",
      targetMatches: selectorProbe(value),
    })), value, `ancestor false, selector ${value}`);
  }
});

test("untrusted selector results are not coerced to false", () => {
  for (const failure of [
    selectorFailure("missing"),
    selectorFailure("unreadable"),
    selectorFailure("throw"),
    selectorFailure("nonboolean"),
  ]) {
    const suffix = failure.kind;
    assert.equal(contentEditable(editableDom({
      designMode: "unknown",
      targetMatches: failure,
    })), null, suffix);
    assert.equal(contentEditable(editableDom({
      targetAttributes: { contenteditable: "false" },
      designMode: "unknown",
      targetMatches: failure,
    })), null, suffix);
  }
});

test("selector failures still use independently sufficient designMode evidence", () => {
  for (const failure of [
    selectorFailure("missing"),
    selectorFailure("unreadable"),
    selectorFailure("throw"),
    selectorFailure("nonboolean"),
  ]) {
    const suffix = failure.kind;
    assert.equal(contentEditable(editableDom({
      targetAttributes: { contenteditable: "false" },
      designMode: "on",
      targetMatches: failure,
    })), true, suffix);
    assert.equal(contentEditable(editableDom({
      targetAttributes: { contenteditable: "false" },
      designMode: "off",
      targetMatches: failure,
    })), false, suffix);
  }
});

test("form controls are excluded from selector substitution but keep native Booleans", () => {
  for (const tagName of ["INPUT", "TEXTAREA"]) {
    const probe = selectorProbe(true);
    assert.equal(contentEditable(editableDom({
      targetTagName: tagName,
      designMode: "unknown",
      targetMatches: probe,
    })), null, tagName);
    assert.deepEqual(probe.calls, [], tagName);
    assert.equal(contentEditable(editableDom({
      targetTagName: tagName,
      targetNativeEditable: true,
      designMode: "off",
      targetMatches: selectorProbe(false),
    })), true, tagName);
  }
});

test("exact editable tokens are case-insensitive and padded invalid tokens inherit", () => {
  for (const value of ["", "true", "TRUE", "plaintext-only", "PLAINTEXT-ONLY"]) {
    assert.equal(contentEditable(editableDom({
      targetAttributes: { contenteditable: value },
      designMode: "off",
    })), true, value);
  }
  assert.equal(contentEditable(editableDom({
    targetAttributes: { contenteditable: " true " },
    designMode: "off",
  })), false);
  assert.equal(contentEditable(editableDom({
    ancestors: [{ attributes: { contenteditable: "true" } }],
    targetAttributes: { contenteditable: " false " },
    designMode: "off",
  })), true);
});

test("root true overrides designMode and other root declarations use designMode", () => {
  assert.equal(contentEditable(editableDom({
    rootAttributes: { contenteditable: "true" },
    designMode: "off",
  })), true);
  assert.equal(contentEditable(editableDom({
    rootAttributes: { contenteditable: "false" },
    designMode: "on",
  })), true);
  assert.equal(contentEditable(editableDom({ designMode: "off" })), false);
  assert.equal(contentEditable(editableDom({ designMode: "unavailable" })), null);
  assert.equal(contentEditable(editableDom({
    rootAttributes: { contenteditable: "false" },
    designMode: "unknown",
    targetMatches: selectorFailure("missing"),
  })), null);
});

test("namespace, incomplete ancestry and unread facts stay null", () => {
  assert.equal(contentEditable(editableDom({
    targetAttributes: { contenteditable: "true" },
    rootNamespace: SVG_NAMESPACE,
    targetMatches: selectorProbe(true),
  })), null);
  assert.equal(contentEditable(editableDom({
    ancestors: [{ namespaceURI: SVG_NAMESPACE }],
    targetAttributes: { contenteditable: "true" },
    targetMatches: selectorProbe(true),
  })), null);
  assert.equal(contentEditable(editableDom({
    ancestors: [{ namespaceUnreadable: true }],
    targetMatches: selectorProbe(true),
  })), null);

  const detached = editableDom({
    targetAttributes: { contenteditable: "true" },
    targetMatches: selectorProbe(true),
  });
  detached.target.parentElement = null;
  assert.equal(contentEditable(detached), null);

  assert.equal(contentEditable(editableDom({
    targetAttributes: { contenteditable: "true" },
    targetNativeEditable: "throw",
    targetMatches: selectorProbe(true),
  })), null);
  assert.equal(contentEditable(editableDom({ designMode: "throw" })), null);
});
