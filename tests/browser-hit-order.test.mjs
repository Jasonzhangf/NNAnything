import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkCandidates,
  createFocusSpec,
  createStableNodeRefRegistry,
  observeCandidates,
  observeLiveDom,
  stableNodeRefFor,
} from "nnanything/browser-classify";

const viewport = { x: 0, y: 0, width: 1400, height: 1878 };
const baseStyle = {
  display: "block",
  visibility: "visible",
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  overflowX: "visible",
  overflowY: "visible",
  clipPath: "none",
  clip: "auto",
  position: "static",
  zIndex: "auto",
  opacity: "1",
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
  pointerEvents: "auto",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderBottomRightRadius: "0px",
};

function htmlElement(overrides = {}) {
  return {
    nodeType: 1,
    tagName: "HTML",
    parentElement: null,
    children: [],
    childNodes: [],
    childElementCount: 0,
    id: "",
    classList: [],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ ...viewport }),
    getClientRects: () => [{ ...viewport }],
    querySelectorAll: () => [],
    ...overrides,
  };
}

function observeTarget(refs, hitStacks, perElementStyle = {}, options = {}) {
  const registry = createStableNodeRefRegistry("hit-order");
  // Each fixture declares the front-to-back order. Rectangles determine which
  // members are hit at the additional corner probes used by the public reader.
  const order = Object.values(hitStacks).reduce((best, stack) => stack.length > best.length ? stack : best, []);
  const activeViewport = options.viewport ?? viewport;
  const elementsFromPoint = options.elementsFromPoint ?? ((x, y) => hitStacks[`${x},${y}`] ?? order.filter(element => {
    const r = element.getBoundingClientRect();
    return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
  }));
  const snapshot = observeLiveDom({
    document: {
      documentElement: refs.html,
      body: refs.html,
      baseURI: "https://fixture.test/page",
      ...(options.document ?? {}),
      elementsFromPoint,
    },
    window: {
      innerWidth: activeViewport.width,
      innerHeight: activeViewport.height,
      ...(options.window ?? {}),
      getComputedStyle: (element, pseudo) => {
        if (pseudo) return { content: "none" };
        return { ...baseStyle, ...(perElementStyle[element.refKey] ?? {}) };
      },
    },
    registry,
    excludeRoot: null,
    snapshotRef: "hit-order",
    documentRef: "fixture",
  });
  const nodeFor = (element) => snapshot.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(registry, element));
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  return { snapshot, nodeFor, registry, candidates };
}

const nativeBoundaryEnvironment = {
  devicePixelRatio: 1,
  visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 },
};

function boundaryFixture({
  targetRect,
  targetStyle = {},
  targetAttributes = {},
  coverRect = null,
  coverStyle = {},
  activeElement = null,
}) {
  const activeViewport = { x: 0, y: 0, width: 1280, height: 720 };
  const style = {
    boxShadow: "none",
    textShadow: "none",
    borderImageSource: "none",
    outlineStyle: "none",
    outlineWidth: "0px",
    backgroundColor: "rgba(0, 0, 0, 0)",
    ...targetStyle,
  };
  const html = htmlElement({
    namespaceURI: "http://www.w3.org/1999/xhtml",
    getBoundingClientRect: () => ({ ...activeViewport }),
    getClientRects: () => [{ ...activeViewport }],
  });
  const target = htmlElement({
    namespaceURI: "http://www.w3.org/1999/xhtml",
    refKey: "target",
    tagName: "DIV",
    parentElement: html,
    childNodes: [{ nodeType: 3, textContent: "target" }],
    getAttribute: key => targetAttributes[key] ?? null,
    hasAttribute: key => Object.hasOwn(targetAttributes, key),
    getBoundingClientRect: () => ({ ...targetRect }),
    getClientRects: () => [{ ...targetRect }],
  });
  const cover = coverRect === null ? null : htmlElement({
    namespaceURI: "http://www.w3.org/1999/xhtml",
    refKey: "cover",
    tagName: "DIV",
    parentElement: html,
    getBoundingClientRect: () => ({ ...coverRect }),
    getClientRects: () => [{ ...coverRect }],
  });
  const children = cover === null ? [target] : [target, cover];
  html.children = children;
  html.childNodes = children;
  html.childElementCount = children.length;
  return {
    refs: { html, target, ...(cover === null ? {} : { cover }) },
    styles: {
      target: style,
      ...(cover === null ? {} : { cover: {
        boxShadow: "none",
        textShadow: "none",
        borderImageSource: "none",
        outlineStyle: "none",
        outlineWidth: "0px",
        backgroundColor: "rgb(40, 40, 40)",
        ...coverStyle,
      } }),
    },
    viewport: activeViewport,
    document: activeElement === null ? {} : { activeElement },
  };
}

test("non-overlapping targets do not spend ancestry reads on every pair", () => {
  for (const count of [40, 80, 160]) {
    const html = htmlElement();
    let parentReads = 0, targetPhase = false;
    Object.defineProperty(html, "parentElement", { get: () => { if (targetPhase) parentReads++; return null; } });
    const buttons = Array.from({ length: count }, (_, index) => {
      const box = { x: 20 + index % 10 * 130, y: 20 + Math.floor(index / 10) * 80, width: 100, height: 30 };
      const button = htmlElement({ tagName: "BUTTON", getBoundingClientRect: () => ({ ...box }), getClientRects: () => [{ ...box }] });
      Object.defineProperty(button, "parentElement", { get: () => { if (targetPhase) parentReads++; return html; } });
      return button;
    });
    html.children = buttons;
    const registry = createStableNodeRefRegistry("non-overlap-cost");
    const snapshot = observeLiveDom({
      document: { documentElement: html, body: html, baseURI: "https://fixture.test/cost",
        elementsFromPoint: (x, y) => {
          const button = buttons.find(b => { const r = b.getBoundingClientRect(); return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height; });
          return button ? [button, html] : [html];
        },
      },
      window: { innerWidth: viewport.width, innerHeight: viewport.height, getComputedStyle: (element, pseudo) => pseudo ? { content: "none" } : {
        ...baseStyle, boxShadow: "none", textShadow: "none", borderImageSource: "none", outlineStyle: "none", outlineWidth: "0px",
        backgroundColor: element === html ? "rgba(0,0,0,0)" : "rgb(220,224,230)",
      } },
      registry, excludeRoot: null, snapshotRef: "non-overlap-cost", documentRef: "fixture",
      diagnostic: { selectedRefs: new Set(buttons.map(b => stableNodeRefFor(registry, b))), callback: event => {
        if (event.phase === "initial") targetPhase = true;
      } },
    });
    assert.ok(parentReads <= 40 * count, `${count} targets needed ${parentReads} target-phase parent reads`);
    assert.equal(snapshot.observation.nodes.length, count + 1);
    assert.equal(snapshot.properties.size, count + 1);
    assert.equal(snapshot.evidence.size, count + 1);
    assert.equal(snapshot.itemObservations.length, count + 1);
    assert.deepEqual(snapshot.observation.nodes.map(n => n.nodeRef), [html, ...buttons].map(e => stableNodeRefFor(registry, e)));
    assert.ok(snapshot.observation.nodes.every(n => n.foreground === "visible"));
    const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
    assert.equal(candidates.candidateRefs.length, count + 1);
  }
});

test("bounded native witness exposes target-only edge, right, corner and read slices", async (t) => {
  const cases = [
    { name: "edge", rect: { x: 132.5, y: 719.828125, width: 694, height: 241.1875 }, point: [479.5, 719] },
    { name: "right", rect: { x: 1279.828125, y: 200, width: 80, height: 60 }, point: [1279, 230] },
    { name: "corner", rect: { x: 1279.828125, y: 719.828125, width: 80, height: 60 }, point: [1279, 719] },
    {
      name: "read-target",
      rect: { x: 132.5, y: 719.828125, width: 694, height: 241.1875 },
      point: [479.5, 719],
      attributes: { tabindex: "-1" },
    },
  ];
  for (const scene of cases) {
    await t.test(scene.name, () => {
      const fixture = boundaryFixture({
        targetRect: scene.rect,
        targetAttributes: scene.attributes ?? {},
      });
      const queries = [];
      const result = observeTarget(fixture.refs, {}, fixture.styles, {
        viewport: fixture.viewport,
        window: nativeBoundaryEnvironment,
        document: fixture.document,
        elementsFromPoint: (x, y) => {
          queries.push([x, y]);
          if (x === 0 && y === 0) return [fixture.refs.html];
          if (x === scene.point[0] && y === scene.point[1]) return [fixture.refs.target, fixture.refs.html];
          return [];
        },
      });
      const node = result.nodeFor(fixture.refs.target);
      assert.equal(node.foreground, "visible", `${scene.name} foreground=${node.foreground}`);
      assert.deepEqual(node.rect, scene.rect);
      assert.deepEqual(node.exposedRects, [{
        ...scene.rect,
        width: scene.name === "right" || scene.name === "corner" ? 0.171875 : scene.rect.width,
        height: scene.name === "right" ? scene.rect.height : 0.171875,
      }]);
      assert.ok(queries.some(([x, y]) => x === scene.point[0] && y === scene.point[1]), JSON.stringify(queries));
    });
  }
});

test("bounded native witness preserves coverage, unrelated, focus and missing-environment negatives", async (t) => {
  const targetRect = { x: 132.5, y: 719.828125, width: 694, height: 241.1875 };

  for (const rect of [
    { x: 132.5, y: 700, width: 694, height: 19.8 },
    { x: 132.5, y: 719.75, width: 694, height: 0.1 },
  ]) await t.test(`region ending at ${rect.y + rect.height} does not reach the boundary`, () => {
    const fixture = boundaryFixture({ targetRect: rect });
    const queries = [];
    const result = observeTarget(fixture.refs, {}, fixture.styles, {
      viewport: fixture.viewport, window: nativeBoundaryEnvironment, document: fixture.document,
      elementsFromPoint: (x, y) => {
        queries.push([x, y]);
        if (x === 0 && y === 0) return [fixture.refs.html];
        return y === 719 ? [fixture.refs.target, fixture.refs.html] : [];
      },
    });
    assert.equal(result.nodeFor(fixture.refs.target).foreground, "unassessed");
    assert.equal(queries.some(([, y]) => y === 719), false);
  });

  await t.test("fully opaque cover wins over a later target hit", () => {
    const fixture = boundaryFixture({
      targetRect,
      coverRect: { ...targetRect },
      coverStyle: { position: "relative", zIndex: "2" },
    });
    const result = observeTarget(fixture.refs, {}, fixture.styles, {
      viewport: fixture.viewport,
      window: nativeBoundaryEnvironment,
      document: fixture.document,
      elementsFromPoint: (x, y) => {
        if (x === 0 && y === 0) return [fixture.refs.html];
        if (y === 719) return [fixture.refs.cover, fixture.refs.target, fixture.refs.html];
        return [];
      },
    });
    const node = result.nodeFor(fixture.refs.target);
    assert.equal(node.foreground, "occluded", `foreground=${node.foreground}`);
    assert.deepEqual(node.exposedRects, []);
  });

  await t.test("pointer-none cover remains explicit geometric coverage", () => {
    const fixture = boundaryFixture({
      targetRect,
      coverRect: { ...targetRect },
      coverStyle: { position: "relative", zIndex: "2", pointerEvents: "none" },
    });
    const result = observeTarget(fixture.refs, {}, fixture.styles, {
      viewport: fixture.viewport,
      window: nativeBoundaryEnvironment,
      document: fixture.document,
      elementsFromPoint: (x, y) => {
        if (x === 0 && y === 0) return [fixture.refs.html];
        if (y === 719) return [fixture.refs.target, fixture.refs.html];
        return [];
      },
    });
    const node = result.nodeFor(fixture.refs.target);
    assert.equal(node.foreground, "occluded", `foreground=${node.foreground}`);
    assert.deepEqual(node.exposedRects, []);
  });

  await t.test("partial cover exposes only the deducted CSS strip", () => {
    const split = 479.5;
    const coverRect = { x: split, y: targetRect.y, width: 347, height: targetRect.height };
    const fixture = boundaryFixture({
      targetRect,
      coverRect,
      coverStyle: { position: "relative", zIndex: "2" },
    });
    const result = observeTarget(fixture.refs, {}, fixture.styles, {
      viewport: fixture.viewport,
      window: nativeBoundaryEnvironment,
      document: fixture.document,
      elementsFromPoint: (x, y) => {
        if (x === 0 && y === 0) return [fixture.refs.html];
        if (y === 719) {
          return x >= split
            ? [fixture.refs.cover, fixture.refs.target, fixture.refs.html]
            : [fixture.refs.target, fixture.refs.html];
        }
        return [];
      },
    });
    const node = result.nodeFor(fixture.refs.target);
    assert.equal(node.foreground, "visible", `foreground=${node.foreground}`);
    assert.equal(node.exposedRects.length, 1, JSON.stringify(node.exposedRects));
    assert.deepEqual(node.exposedRects, [{
      x: targetRect.x,
      y: targetRect.y,
      width: split - targetRect.x,
      height: 720 - targetRect.y,
    }]);
  });

  await t.test("unrelated boundary stack is not target evidence", () => {
    const fixture = boundaryFixture({ targetRect });
    const unrelated = htmlElement({ refKey: "unrelated", tagName: "DIV", parentElement: fixture.refs.html });
    const result = observeTarget(fixture.refs, {}, fixture.styles, {
      viewport: fixture.viewport,
      window: nativeBoundaryEnvironment,
      document: fixture.document,
      elementsFromPoint: (x, y) => {
        if (x === 0 && y === 0) return [fixture.refs.html];
        if (y === 719) return [unrelated, fixture.refs.html];
        return [];
      },
    });
    const node = result.nodeFor(fixture.refs.target);
    assert.equal(node.foreground, "unassessed", `foreground=${node.foreground}`);
    assert.equal(node.exposedRects, null);
  });

  await t.test("focus cannot replace target-native evidence", () => {
    const fixture = boundaryFixture({
      targetRect,
      targetAttributes: { tabindex: "0" },
      activeElement: null,
    });
    fixture.document.activeElement = fixture.refs.target;
    const result = observeTarget(fixture.refs, {}, fixture.styles, {
      viewport: fixture.viewport,
      window: nativeBoundaryEnvironment,
      document: fixture.document,
      elementsFromPoint: (x, y) => {
        if (x === 0 && y === 0) return [fixture.refs.html];
        if (y === 719) return [fixture.refs.html];
        return [];
      },
    });
    const node = result.nodeFor(fixture.refs.target);
    assert.equal(node.foreground, "unassessed", `foreground=${node.foreground}`);
    assert.equal(node.exposedRects, null);
    assert.equal(result.snapshot.properties.get(node.nodeRef).activeElementFocus, true);
    assert.equal(result.snapshot.properties.get(node.nodeRef).tabIndexFocus, true);
  });

  await t.test("missing environment facts disable the supplemental witness", () => {
    const fixture = boundaryFixture({ targetRect });
    let boundaryQueries = 0;
    const result = observeTarget(fixture.refs, {}, fixture.styles, {
      viewport: fixture.viewport,
      document: fixture.document,
      elementsFromPoint: (x, y) => {
        if (x === 0 && y === 0) return [fixture.refs.html];
        if (y === 719) boundaryQueries++;
        return [];
      },
    });
    const node = result.nodeFor(fixture.refs.target);
    assert.equal(node.foreground, "unassessed", `foreground=${node.foreground}`);
    assert.equal(node.exposedRects, null);
    assert.equal(boundaryQueries, 0);
  });

  await t.test("null and non-empty wrong stacks do not search another point", () => {
    const fixture = boundaryFixture({ targetRect, coverRect: { ...targetRect }, coverStyle: { position: "relative", zIndex: "2" } });
    for (const wrong of [null, [fixture.refs.cover]]) {
      let boundaryQueries = 0;
      const result = observeTarget(fixture.refs, {}, fixture.styles, {
        viewport: fixture.viewport,
        window: nativeBoundaryEnvironment,
        document: fixture.document,
        elementsFromPoint: (x, y) => {
          if (x === 0 && y === 0) return [fixture.refs.html];
          if (y === 719) boundaryQueries++;
          return wrong;
        },
      });
      const node = result.nodeFor(fixture.refs.target);
      assert.notEqual(node.foreground, "visible", `foreground=${node.foreground}`);
      assert.ok(node.exposedRects === null || node.exposedRects.length === 0);
      assert.equal(boundaryQueries, 0, `wrong=${wrong === null ? "null" : "cover"} boundaryQueries=${boundaryQueries}`);
    }
  });

  await t.test("unproven rounded target geometry stays unknown", () => {
    const fixture = boundaryFixture({
      targetRect,
      targetStyle: { borderTopLeftRadius: "20px", borderTopRightRadius: "20px" },
    });
    const result = observeTarget(fixture.refs, {}, fixture.styles, {
      viewport: fixture.viewport,
      window: nativeBoundaryEnvironment,
      document: fixture.document,
      elementsFromPoint: (x, y) => {
        if (x === 0 && y === 0) return [fixture.refs.html];
        if (y === 719) return [fixture.refs.target, fixture.refs.html];
        return [];
      },
    });
    const node = result.nodeFor(fixture.refs.target);
    assert.equal(node.foreground, "unassessed", `foreground=${node.foreground}`);
    assert.equal(node.exposedRects, null);
  });
});

test("partially ordered bounded image retains the exposed top strip", () => {
  const html = htmlElement();
  const rect = { x: 1157, y: 12.5, width: 30, height: 30 };
  const imageRect = { x: 1153, y: 13.5, width: 34, height: 34 };
  const target = htmlElement({ refKey: "target", tagName: "DIV", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  const img = htmlElement({ refKey: "img", tagName: "IMG", parentElement: html,
    getBoundingClientRect: () => ({ ...imageRect }), getClientRects: () => [{ ...imageRect }] });
  html.children = [target, img]; html.childNodes = [target, img]; html.childElementCount = 2;
  const stacks = { "1172,28": [img, target, html], "1172,13": [target, html],
    "1158,14.5": [target, html], "1186,14.5": [target, html] };
  const style = { boxShadow: "none", outlineStyle: "none", outlineWidth: "0px", borderImageSource: "none" };
  const result = observeTarget({ html, target, img }, stacks, { img: style });
  assert.equal(result.nodeFor(target).foreground, "visible");
  assert.deepEqual(result.nodeFor(target).exposedRects, [{ x: 1157, y: 12.5, width: 30, height: 1 }]);
  const escaping = observeTarget({ html, target, img }, stacks, { img: { ...style, filter: "blur(2px)" } });
  assert.equal(escaping.nodeFor(target).foreground, "unassessed");
});

test("interior probes avoid a rounded-up scrollbar edge hit", () => {
  const html = htmlElement();
  const rect = { x: 0, y: 0, width: viewport.width, height: 62 };
  const target = htmlElement({ refKey: "target", tagName: "DIV", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  const cover = htmlElement({ refKey: "cover", tagName: "HEADER", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  html.children = [target, cover]; html.childNodes = [target, cover]; html.childElementCount = 2;
  const result = observeTarget({ html, target, cover }, {
    [`${viewport.width / 2},31`]: [cover, target, html],
    [`${viewport.width - 0.5},0.5`]: [],
    [`${viewport.width - 0.5},61.5`]: [],
  }, { cover: { backgroundColor: "rgb(255, 255, 255)", position: "relative", zIndex: "100" } });
  assert.equal(result.nodeFor(target).foreground, "occluded");
});

test("subpixel overlap stays uncertain when interior corner hits are unavailable", () => {
  const html = htmlElement();
  const rect = { x: 100, y: 100, width: 0.4, height: 0.4 };
  const target = htmlElement({ refKey: "target", tagName: "DIV", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  const cover = htmlElement({ refKey: "cover", tagName: "HEADER", parentElement: html,
    getBoundingClientRect: () => ({ ...rect }), getClientRects: () => [{ ...rect }] });
  html.children = [target, cover]; html.childNodes = [target, cover]; html.childElementCount = 2;
  const center = rect.x + rect.width / 2, near = rect.x + rect.width / 4, far = rect.x + rect.width * 3 / 4;
  const result = observeTarget({ html, target, cover }, {
    [`${center},${center}`]: [cover, target, html],
    [`${near},${near}`]: [], [`${far},${near}`]: [],
    [`${near},${far}`]: [], [`${far},${far}`]: [],
  }, { cover: { backgroundColor: "rgb(255, 255, 255)", position: "relative", zIndex: "100" } });
  assert.equal(result.nodeFor(target).foreground, "unassessed");
});

function targetStatus(refs, result, element) {
  const node = result.nodeFor(element);
  const slot = result.candidates.slots.find(slot => slot.nodeRef === node.nodeRef);
  return { foreground: node.foreground, exposedRects: node.exposedRects, candidateStatus: slot?.status, reasons: slot?.reasons };
}

// Live evidence: a transparent native TEXTAREA hit first, then a white clone at
// opacity 0.00001 with aria-hidden sits behind it as the first "opaque" surface.
test("transparent target hit before white clone remains visible, not unassessed", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "TEXTAREA", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 286, y: 83, width: 814, height: 40 }),
    getClientRects: () => [{ x: 286, y: 83, width: 814, height: 40 }],
  });
  const wrapper = htmlElement({ refKey: "wrapper", tagName: "DIV", parentElement: html, children: [target], childNodes: [target], childElementCount: 1 });
  target.parentElement = wrapper;
  const clone = htmlElement({
    refKey: "clone", tagName: "TEXTAREA", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 286, y: 83, width: 814, height: 40 }),
    getClientRects: () => [{ x: 286, y: 83, width: 814, height: 40 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [wrapper, clone], childNodes: [wrapper, clone], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    clone: { backgroundColor: "rgb(255, 255, 255)", opacity: "1e-05", zIndex: "-1" },
  };
  const center = "693,103";
  const result = observeTarget(
    { html, target, wrapper, clone, search },
    { [center]: [target, wrapper, clone, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
  assert.ok(Array.isArray(status.exposedRects) && status.exposedRects.length > 0, JSON.stringify(status.exposedRects));
  assert.equal(status.candidateStatus, "ok", `candidate=${status.candidateStatus} reasons=${JSON.stringify(status.reasons)}`);
});

// Live evidence: the real target container is the first hit; an unrelated IMG
// behind it becomes firstOpaque and must not demote the foreground.
test("target hit before unrelated image remains visible, not unassessed", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 1158, y: 1766, width: 40, height: 88 }),
    getClientRects: () => [{ x: 1158, y: 1766, width: 40, height: 88 }],
  });
  const link = htmlElement({ refKey: "link", tagName: "A", parentElement: html, children: [target], childNodes: [target], childElementCount: 1 });
  target.parentElement = link;
  const img = htmlElement({ refKey: "img", tagName: "IMG", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 1158, y: 1766, width: 40, height: 88 }),
    getClientRects: () => [{ x: 1158, y: 1766, width: 40, height: 88 }],
  });
  const section = htmlElement({ refKey: "section", tagName: "SECTION", parentElement: html, children: [link, img], childNodes: [link, img], childElementCount: 2 });
  link.parentElement = section;
  img.parentElement = section;
  html.children = [section];
  html.childNodes = [section];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    img: { backgroundColor: "rgb(255, 255, 255)", opacity: "1" },
  };
  const center = "1178,1810";
  const result = observeTarget(
    { html, target, link, img, section },
    { [center]: [target, link, img, section, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
  assert.ok(Array.isArray(status.exposedRects) && status.exposedRects.length > 0, JSON.stringify(status.exposedRects));
  assert.equal(status.candidateStatus, "ok", `candidate=${status.candidateStatus} reasons=${JSON.stringify(status.reasons)}`);
});

// A transparent descendant hit before the later opaque owner proves the target
// rect is exposed through its own subtree, not just an ancestor chain.
test("transparent descendant hit before opaque owner exposes parent target", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const descendant = htmlElement({ refKey: "descendant", tagName: "SPAN", parentElement: target, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 120, y: 120, width: 100, height: 20 }),
    getClientRects: () => [{ x: 120, y: 120, width: 100, height: 20 }],
  });
  target.children = [descendant];
  target.childNodes = [descendant];
  target.childElementCount = 1;
  const owner = htmlElement({ refKey: "owner", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, owner], childNodes: [target, owner], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    descendant: { backgroundColor: "rgba(0, 0, 0, 0)" },
    owner: { backgroundColor: "rgb(20, 20, 24)", opacity: "1" },
  };
  const center = "200,130";
  const result = observeTarget(
    { html, target, descendant, owner, search },
    { [center]: [descendant, target, owner, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
  assert.ok(Array.isArray(status.exposedRects) && status.exposedRects.length > 0, JSON.stringify(status.exposedRects));
});

// A proven opaque overlay in front of the target keeps it occluded; the later
// target hit must not rescue a covered rect.
test("proven opaque overlay in front keeps target occluded", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "hidden" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay], childNodes: [target, overlay], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgb(20, 20, 24)", opacity: "1", zIndex: "5", position: "relative" },
  };
  const center = "200,130";
  const result = observeTarget(
    { html, target, overlay, search },
    { [center]: [overlay, target, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "occluded", `foreground=${status.foreground}`);
});

// A partial opaque overlay only subtracts its covered area; the exposed sides
// stay visible and the new condition must not restore the blocked strip.
test("partial opaque overlay subtracts covered strip only", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "split" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 180, y: 100, width: 40, height: 60 }),
    getClientRects: () => [{ x: 180, y: 100, width: 40, height: 60 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay], childNodes: [target, overlay], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgb(20, 20, 24)", opacity: "1", zIndex: "5", position: "relative" },
  };
  const leftCenter = "150,130";
  const rightCenter = "250,130";
  const blockedCenter = "200,130";
  const result = observeTarget(
    { html, target, overlay, search },
    { [leftCenter]: [target, search, html], [rightCenter]: [target, search, html], [blockedCenter]: [overlay, target, search, html] },
    elementStyle,
  );
  const node = result.nodeFor(target);
  assert.equal(node.foreground, "visible", `foreground=${node.foreground}`);
  assert.ok(node.exposedRects.length === 2, JSON.stringify(node.exposedRects));
  for (const rect of node.exposedRects) {
    assert.ok(rect.x + rect.width <= 180 || rect.x >= 220, JSON.stringify(rect));
  }
});

// A non-interactive transparent read target hit before a background owner must
// stay visible; the fix does not require clickability or event listeners.
test("transparent non-interactive read target before background stays visible", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "status text" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 160, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 160, height: 40 }],
  });
  const owner = htmlElement({ refKey: "owner", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 160, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 160, height: 40 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, owner], childNodes: [target, owner], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    owner: { backgroundColor: "rgb(25, 25, 30)", opacity: "1" },
  };
  const center = "180,120";
  const result = observeTarget(
    { html, target, owner, search },
    { [center]: [target, owner, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
  assert.ok(Array.isArray(status.exposedRects) && status.exposedRects.length > 0, JSON.stringify(status.exposedRects));
});

// A transparent overlay in front of a transparent read target, with the real
// background owner behind the target, must not be treated as opaque occlusion.
test("transparent overlay before target with later background stays visible", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "read" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 120, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 120, height: 40 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 120, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 120, height: 40 }],
  });
  const owner = htmlElement({ refKey: "owner", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 120, height: 40 }),
    getClientRects: () => [{ x: 100, y: 100, width: 120, height: 40 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay, owner], childNodes: [target, overlay, owner], childElementCount: 3 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgba(0, 0, 0, 0)" },
    owner: { backgroundColor: "rgb(25, 25, 30)", opacity: "1" },
  };
  const center = "160,120";
  const result = observeTarget(
    { html, target, overlay, owner, search },
    { [center]: [overlay, target, owner, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "visible", `foreground=${status.foreground}`);
});

// A pointer-none opaque overlay absent from the native hit stack but proven in
// front by paint order still excludes the fully covered target.
test("pointer-none opaque overlay proven in front occludes target", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "covered" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 180, height: 50 }),
    getClientRects: () => [{ x: 100, y: 100, width: 180, height: 50 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 180, height: 50 }),
    getClientRects: () => [{ x: 100, y: 100, width: 180, height: 50 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay], childNodes: [target, overlay], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgb(20, 20, 24)", opacity: "1", zIndex: "4", position: "relative", pointerEvents: "none" },
  };
  const center = "190,125";
  const result = observeTarget(
    { html, target, overlay, search },
    { [center]: [target, search, html] },
    elementStyle,
  );
  const status = targetStatus({ html }, result, target);
  assert.equal(status.foreground, "occluded", `foreground=${status.foreground}`);
});

// A pointer-none opaque overlay partially in front only subtracts its strip,
// keeping the unblocked sides visible.
test("pointer-none partial opaque overlay subtracts covered strip only", () => {
  const html = htmlElement();
  const target = htmlElement({
    refKey: "target", tagName: "DIV", parentElement: html, children: [], childNodes: [{ nodeType: 3, textContent: "split" }], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height: 60 }),
    getClientRects: () => [{ x: 100, y: 100, width: 200, height: 60 }],
  });
  const overlay = htmlElement({ refKey: "overlay", tagName: "DIV", parentElement: html, children: [], childNodes: [], childElementCount: 0,
    getBoundingClientRect: () => ({ x: 170, y: 100, width: 60, height: 60 }),
    getClientRects: () => [{ x: 170, y: 100, width: 60, height: 60 }],
  });
  const search = htmlElement({ refKey: "search", tagName: "DIV", parentElement: html, children: [target, overlay], childNodes: [target, overlay], childElementCount: 2 });
  html.children = [search];
  html.childNodes = [search];
  html.childElementCount = 1;
  const elementStyle = {
    target: { backgroundColor: "rgba(0, 0, 0, 0)" },
    overlay: { backgroundColor: "rgb(20, 20, 24)", opacity: "1", zIndex: "4", position: "relative", pointerEvents: "none" },
  };
  const leftCenter = "150,130";
  const rightCenter = "250,130";
  const blockedCenter = "200,130";
  const result = observeTarget(
    { html, target, overlay, search },
    { [leftCenter]: [target, search, html], [rightCenter]: [target, search, html], [blockedCenter]: [target, search, html] },
    elementStyle,
  );
  const node = result.nodeFor(target);
  assert.equal(node.foreground, "visible", `foreground=${node.foreground}`);
  assert.ok(node.exposedRects.length === 2, JSON.stringify(node.exposedRects));
  for (const rect of node.exposedRects) {
    assert.ok(rect.x + rect.width <= 170 || rect.x >= 230, JSON.stringify(rect));
  }
});

// The union bounding box center of a two-line inline SPAN falls in the line
// gap. These fixtures keep the target order evidence tied to the two clipped
// fragments and to the existing corner / paint-order checks.
function multilineSpanFixture({
  line1 = { x: 100, y: 100, width: 72, height: 20 },
  line2 = { x: 100, y: 130, width: 72, height: 20 },
  coverRect,
  targetStyle = {},
  coverStyle = {},
} = {}) {
  const activeViewport = { x: 0, y: 0, width: 1280, height: 720 };
  const left = Math.min(line1.x, line2.x);
  const top = Math.min(line1.y, line2.y);
  const right = Math.max(line1.x + line1.width, line2.x + line2.width);
  const bottom = Math.max(line1.y + line1.height, line2.y + line2.height);
  const bbox = { x: left, y: top, width: right - left, height: bottom - top };
  const base = {
    boxShadow: "none",
    textShadow: "none",
    borderImageSource: "none",
    outlineStyle: "none",
    outlineWidth: "0px",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };
  const html = htmlElement({
    namespaceURI: "http://www.w3.org/1999/xhtml",
    getBoundingClientRect: () => ({ ...activeViewport }),
    getClientRects: () => [{ ...activeViewport }],
  });
  const target = htmlElement({
    namespaceURI: "http://www.w3.org/1999/xhtml",
    refKey: "target",
    tagName: "SPAN",
    parentElement: html,
    childNodes: [{ nodeType: 3, textContent: "two line label" }],
    getBoundingClientRect: () => ({ ...bbox }),
    getClientRects: () => [{ ...line1 }, { ...line2 }],
  });
  const cover = htmlElement({
    namespaceURI: "http://www.w3.org/1999/xhtml",
    refKey: "cover",
    tagName: "DIV",
    parentElement: html,
    getBoundingClientRect: () => ({ ...coverRect }),
    getClientRects: () => [{ ...coverRect }],
  });
  html.children = [target, cover];
  html.childNodes = [target, cover];
  html.childElementCount = 2;
  return {
    refs: { html, target, cover },
    styles: {
      target: { ...base, display: "inline", ...targetStyle },
      cover: { ...base, backgroundColor: "rgb(40, 40, 40)", ...coverStyle },
    },
    viewport: activeViewport,
    bbox,
    line1,
    line2,
  };
}

function spanNativeStack(fixture, x, y) {
  const inRect = rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  const targetHere = inRect(fixture.line1) || inRect(fixture.line2);
  const coverHere = inRect(fixture.refs.cover.getBoundingClientRect());
  const { target, cover, html } = fixture.refs;
  if (coverHere && targetHere) return [cover, target, html];
  if (coverHere) return [cover, html];
  if (targetHere) return [target, html];
  return [html];
}

const spanFullCover = { x: 96, y: 96, width: 88, height: 60 };

function observeSpan(fixture, elementsFromPoint) {
  const queries = [];
  const targetQueries = [];
  const registry = createStableNodeRefRegistry("hit-order");
  const targetRef = stableNodeRefFor(registry, fixture.refs.target);
  let assessingTarget = false;
  const snapshot = observeLiveDom({
    document: {
      documentElement: fixture.refs.html,
      body: fixture.refs.html,
      baseURI: "https://fixture.test/page",
      elementsFromPoint: (x, y) => {
        queries.push([x, y]);
        if (assessingTarget) targetQueries.push([x, y]);
        if (x === 0 && y === 0) return [fixture.refs.html];
        return elementsFromPoint(x, y);
      },
    },
    window: {
      innerWidth: fixture.viewport.width,
      innerHeight: fixture.viewport.height,
      getComputedStyle: (element, pseudo) => {
        if (pseudo) return { content: "none" };
        return { ...baseStyle, ...(fixture.styles[element.refKey] ?? {}) };
      },
    },
    registry,
    excludeRoot: null,
    snapshotRef: "hit-order",
    documentRef: "fixture",
    diagnostic: {
      selectedRefs: new Set([targetRef]),
      callback(event) {
        if (event.targetRef !== targetRef) return;
        if (event.phase === "initial") assessingTarget = true;
        if (event.phase === "final") assessingTarget = false;
      },
    },
  });
  const nodeFor = element => snapshot.observation.nodes.find(node => node.nodeRef === stableNodeRefFor(registry, element));
  const candidates = checkCandidates(observeCandidates({ observation: snapshot.observation }), createFocusSpec());
  return { snapshot, nodeFor, registry, candidates, queries, targetQueries, targetRef };
}

test("multiline SPAN gap center recovers actual fragment order behind full cover", () => {
  const fixture = multilineSpanFixture({
    coverRect: spanFullCover,
    coverStyle: { position: "relative", zIndex: "2" },
  });
  const result = observeSpan(fixture, (x, y) => spanNativeStack(fixture, x, y));
  const node = result.nodeFor(fixture.refs.target);

  assert.equal(node.foreground, "occluded", `foreground=${node.foreground}`);
  assert.deepEqual(node.exposedRects, []);
  assert.deepEqual(node.rect, fixture.bbox);
  assert.deepEqual(node.fragments, [fixture.line1, fixture.line2]);
  for (const fragment of [fixture.line1, fixture.line2]) {
    const center = [fragment.x + fragment.width / 2, fragment.y + fragment.height / 2];
    const count = result.targetQueries.filter(([x, y]) => x === center[0] && y === center[1]).length;
    assert.equal(count, 1, `fragment center ${center} queries=${count}`);
  }
  const slot = result.candidates.slots.find(candidate => candidate.nodeRef === node.nodeRef);
  assert.equal(slot.status, "filtered_out");
  assert.deepEqual(slot.reasons, ["occluded"]);
});

test("multiline SPAN reverse order at a fragment rejects the bounded seed", () => {
  const fixture = multilineSpanFixture({
    coverRect: spanFullCover,
    coverStyle: { position: "relative", zIndex: "2" },
  });
  const line2Center = [fixture.line2.x + fixture.line2.width / 2, fixture.line2.y + fixture.line2.height / 2];
  const result = observeSpan(fixture, (x, y) => x === line2Center[0] && y === line2Center[1]
    ? [fixture.refs.target, fixture.refs.cover, fixture.refs.html]
    : spanNativeStack(fixture, x, y));
  const node = result.nodeFor(fixture.refs.target);

  assert.notEqual(node.foreground, "occluded", `foreground=${node.foreground}`);
  assert.deepEqual(node.exposedRects, [fixture.line2]);
});

test("multiline SPAN target-absent samples supply no bounded witness", () => {
  const fixture = multilineSpanFixture({
    coverRect: spanFullCover,
    coverStyle: { position: "relative", zIndex: "2" },
  });
  const result = observeSpan(fixture, (x, y) => {
    const inCover = x >= spanFullCover.x && x < spanFullCover.x + spanFullCover.width
      && y >= spanFullCover.y && y < spanFullCover.y + spanFullCover.height;
    return inCover ? [fixture.refs.cover, fixture.refs.html] : [fixture.refs.html];
  });
  const node = result.nodeFor(fixture.refs.target);

  assert.equal(node.foreground, "unassessed", `foreground=${node.foreground}`);
  assert.equal(node.exposedRects, null);
});

test("multiline SPAN recovered seed still requires the corner order probes", () => {
  const fixture = multilineSpanFixture({
    coverRect: spanFullCover,
    coverStyle: { position: "relative", zIndex: "2" },
  });
  const failingCorner = [fixture.line1.x + 1, fixture.line1.y + 1];
  const result = observeSpan(fixture, (x, y) => x === failingCorner[0] && y === failingCorner[1]
    ? [fixture.refs.target, fixture.refs.html]
    : spanNativeStack(fixture, x, y));
  const node = result.nodeFor(fixture.refs.target);

  assert.equal(node.foreground, "unassessed", `foreground=${node.foreground}`);
  assert.equal(node.exposedRects, null);
});

test("multiline SPAN partial cover keeps the uncovered fragment exposed", () => {
  const line1 = { x: 100, y: 100, width: 72, height: 20 };
  const line2 = { x: 100, y: 130, width: 72, height: 20 };
  const fixture = multilineSpanFixture({
    line1,
    line2,
    coverRect: line1,
    coverStyle: { position: "relative", zIndex: "2" },
  });
  const result = observeSpan(fixture, (x, y) => spanNativeStack(fixture, x, y));
  const node = result.nodeFor(fixture.refs.target);

  assert.equal(node.foreground, "visible", `foreground=${node.foreground}`);
  assert.deepEqual(node.exposedRects, [fixture.line2]);
});

