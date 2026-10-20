type RectOutput = {
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

type BBoxOutput = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CTMOutput = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

const resultHost = required<HTMLElement>("#result-host");
const probeLayer = required<HTMLElement>("#probe-layer");
const measureButton = required<HTMLButtonElement>("#measure-all");
const probeButton = required<HTMLButtonElement>("#show-probes");
const outputRoot = resultHost.shadowRoot ?? resultHost.attachShadow({ mode: "open" });

outputRoot.innerHTML = `
  <style>
    :host { color: #172033; }
    * { box-sizing: border-box; }
    .panel {
      padding: 3px 6px;
      border: 1px solid #334155;
      border-radius: 4px;
      background: #ffffff;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12);
      font: 10px/14px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .row { display: flex; align-items: center; gap: 8px; min-height: 18px; }
    button {
      padding: 1px 6px;
      border: 1px solid #475569;
      border-radius: 3px;
      background: #f8fafc;
      color: #172033;
      font: 600 10px/14px ui-monospace, SFMono-Regular, Menlo, monospace;
      cursor: pointer;
    }
    #status { color: #334155; }
    pre {
      display: none;
      width: 100%;
      max-height: 360px;
      margin: 4px 0 0;
      overflow: auto;
      padding: 6px;
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      color: #172033;
      font: 10px/13px ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    pre.open { display: block; }
  </style>
  <section class="panel">
    <div class="row">
      <button id="toggle-json" type="button">Show JSON</button>
      <span id="status" aria-live="polite">UNMEASURED</span>
    </div>
    <pre id="json">Run Measure all.</pre>
  </section>
`;

const outputStatus = outputRoot.querySelector<HTMLElement>("#status");
const outputJson = outputRoot.querySelector<HTMLElement>("#json");
const toggleJson = outputRoot.querySelector<HTMLButtonElement>("#toggle-json");
if (!outputStatus || !outputJson || !toggleJson) throw new Error("Missing isolated output nodes");

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing fixture element: ${selector}`);
  return element;
}

function rectOutput(rect: DOMRect): RectOutput {
  return {
    x: rect.x,
    y: rect.y,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function pointWidthOne(left: number, top: number): RectOutput {
  return {
    x: left,
    y: top,
    left,
    top,
    width: 1,
    height: 1,
    right: left + 1,
    bottom: top + 1,
  };
}

function parseProbeSpec(value: string | undefined): Array<{ name: string; dx: number; dy: number }> {
  if (!value) return [];
  return value.split("|").map((entry) => {
    const [name, dx, dy] = entry.split(":");
    const parsedDx = Number(dx);
    const parsedDy = Number(dy);
    if (!name || !Number.isFinite(parsedDx) || !Number.isFinite(parsedDy)) {
      throw new Error(`Invalid probe spec: ${entry}`);
    }
    return { name, dx: parsedDx, dy: parsedDy };
  });
}

function elementFact(element: Element | null): Record<string, unknown> | null {
  if (!element) return null;
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    className: typeof element.className === "string" ? element.className : element.getAttribute("class"),
    rootId: element.getAttribute("data-root-id"),
    blocker: element.getAttribute("data-blocker"),
  };
}

function hitFact(x: number, y: number): Record<string, unknown> {
  return {
    elementFromPoint: elementFact(document.elementFromPoint(x, y)),
    elementsFromPoint: document.elementsFromPoint(x, y).slice(0, 8).map(elementFact),
  };
}

function rawSvgFacts(root: SVGSVGElement): Array<Record<string, unknown>> {
  return Array.from(root.querySelectorAll<SVGUseElement>("use")).map((use) => {
    const raw = use as unknown as {
      getBBox?: () => DOMRect;
      getScreenCTM?: () => DOMMatrix | null;
    };
    let bbox: BBoxOutput | null = null;
    let screenCTM: CTMOutput | null = null;
    let bboxError: string | null = null;
    let ctmError: string | null = null;

    try {
      const value = raw.getBBox?.();
      if (value) bbox = { x: value.x, y: value.y, width: value.width, height: value.height };
    } catch (error) {
      bboxError = error instanceof Error ? error.message : String(error);
    }

    try {
      const value = raw.getScreenCTM?.();
      if (value) screenCTM = { a: value.a, b: value.b, c: value.c, d: value.d, e: value.e, f: value.f };
    } catch (error) {
      ctmError = error instanceof Error ? error.message : String(error);
    }

    return {
      href: use.getAttribute("href") ?? use.getAttribute("xlink:href"),
      rect: rectOutput(use.getBoundingClientRect()),
      bbox,
      bboxError,
      screenCTM,
      ctmError,
    };
  });
}

function alignBcrBlocker(): void {
  const use = document.querySelector<SVGUseElement>("#g10-bcr-visible use");
  const blocker = document.querySelector<HTMLElement>("#g10-bcr-blocker");
  const viewport = document.querySelector<HTMLElement>('[data-root-id="g10-bcr-visible"][data-viewport]');
  if (!use || !blocker || !viewport) return;
  const useRect = use.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  blocker.style.left = `${useRect.left - viewportRect.left}px`;
  blocker.style.top = `${useRect.top - viewportRect.top}px`;
  blocker.style.width = `${useRect.width}px`;
  blocker.style.height = `${useRect.height}px`;
}

function openTopLayerDiagnostic(): Record<string, unknown> {
  const popover = document.querySelector<HTMLElement>("#g9-popover");
  if (!popover) return { present: false, supported: false, open: false, error: "missing" };
  const candidate = popover as HTMLElement & {
    showPopover?: () => void;
  };
  let error: string | null = null;
  let alreadyOpen = false;
  try {
    alreadyOpen = popover.matches(":popover-open");
  } catch {
    alreadyOpen = false;
  }
  if (!alreadyOpen) {
    try {
      candidate.showPopover?.();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  let open = false;
  try {
    open = popover.matches(":popover-open");
  } catch {
    open = false;
  }
  return {
    present: true,
    supported: typeof candidate.showPopover === "function",
    open,
    error,
    rect: rectOutput(popover.getBoundingClientRect()),
  };
}

function measuredProbes(root: SVGSVGElement, viewportRect: DOMRect): Array<Record<string, unknown>> {
  return parseProbeSpec(root.dataset.probes).map((probe) => {
    const left = viewportRect.left + probe.dx;
    const top = viewportRect.top + probe.dy;
    return {
      name: probe.name,
      dx: probe.dx,
      dy: probe.dy,
      rect: pointWidthOne(left, top),
    };
  });
}

function measuredHitProbes(root: SVGSVGElement, viewportRect: DOMRect): Array<Record<string, unknown>> {
  return parseProbeSpec(root.dataset.hitProbes).map((probe) => {
    const left = viewportRect.left + probe.dx;
    const top = viewportRect.top + probe.dy;
    return {
      name: probe.name,
      dx: probe.dx,
      dy: probe.dy,
      rect: pointWidthOne(left, top),
      ...hitFact(left, top),
    };
  });
}

function rootMeasurement(scene: HTMLElement, root: SVGSVGElement): Record<string, unknown> {
  const viewport = root.closest<HTMLElement>("[data-viewport]");
  if (!viewport) throw new Error(`Missing root viewport for ${root.id}`);
  const style = getComputedStyle(root);
  const viewportRect = viewport.getBoundingClientRect();
  return {
    rootId: root.id,
    scene: Number(root.dataset.scene),
    mode: root.dataset.mode ?? null,
    domain: root.dataset.domain ?? null,
    admission: root.dataset.admission ?? null,
    resourceStatus: root.dataset.resourceStatus ?? null,
    cellRect: rectOutput(scene.getBoundingClientRect()),
    viewportRect: rectOutput(viewportRect),
    rootRect: rectOutput(root.getBoundingClientRect()),
    computed: {
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      overflowClipMargin: style.overflowClipMargin,
      filter: style.filter,
      boxShadow: style.boxShadow,
      outline: style.outline,
      transform: style.transform,
      contain: style.contain,
      clipPath: style.clipPath,
      maskImage: style.maskImage,
      pointerEvents: style.pointerEvents,
    },
    blockers: Array.from(viewport.querySelectorAll<HTMLElement>("[data-blocker]")).map((blocker) => ({
      kind: blocker.dataset.blocker ?? null,
      rect: rectOutput(blocker.getBoundingClientRect()),
      pointerEvents: getComputedStyle(blocker).pointerEvents,
    })),
    uses: rawSvgFacts(root),
    paintProbes: measuredProbes(root, viewportRect),
    hitProbes: measuredHitProbes(root, viewportRect),
  };
}

function measureAll(): Record<string, unknown> {
  alignBcrBlocker();
  const topLayer = openTopLayerDiagnostic();
  const scenes = Array.from(document.querySelectorAll<HTMLElement>(".scene")).map((scene) => {
    const roots = Array.from(scene.querySelectorAll<SVGSVGElement>("svg.test-root"));
    return {
      scene: Number(scene.dataset.scene),
      title: scene.querySelector("h2")?.textContent ?? null,
      cellRect: rectOutput(scene.getBoundingClientRect()),
      roots: roots.map((root) => rootMeasurement(scene, root)),
    };
  });
  return {
    format: "svg-use-boundary.v1",
    coordinateSpace: "CSS pixels relative to the browser viewport, origin at top-left",
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    targetColor: { css: "#ef4444", rgb: "rgb(239, 68, 68)" },
    blockers: {
      fullRoot: "24x24 CSS-pixel wrapper domain",
      useBcr: "native getBoundingClientRect(use) result",
      partialAuto: "10x24 pointer-events:auto",
      partialNone: "10x24 pointer-events:none",
    },
    topLayer,
    resources: (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .filter((entry) => entry.name.includes("svg-use-boundary"))
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        duration: entry.duration,
        transferSize: entry.transferSize,
        decodedBodySize: entry.decodedBodySize,
        resourceStatus: "request-entry-only-not-success",
      })),
    scenes,
  };
}

function renderProbeLayer(payload: Record<string, unknown>): void {
  probeLayer.replaceChildren();
  const scenes = payload.scenes as Array<{
    roots: Array<{
      paintProbes: Array<{ name: string; rect: RectOutput }>;
      hitProbes: Array<{ name: string; rect: RectOutput }>;
    }>;
  }>;
  for (const scene of scenes) {
    for (const root of scene.roots) {
      for (const probe of [...root.paintProbes, ...root.hitProbes]) {
        const marker = document.createElement("span");
        marker.className = "probe-marker";
        marker.dataset.probe = probe.name;
        marker.style.left = `${probe.rect.left}px`;
        marker.style.top = `${probe.rect.top}px`;
        probeLayer.append(marker);
      }
    }
  }
}

let lastMeasurement: Record<string, unknown> | null = null;

measureButton.addEventListener("click", () => {
  lastMeasurement = measureAll();
  outputStatus.textContent = `MEASURED ${lastMeasurement.scenes instanceof Array ? lastMeasurement.scenes.length : 0} scenes`;
  outputJson.textContent = JSON.stringify(lastMeasurement, null, 2);
  if (probeLayer.classList.contains("visible")) renderProbeLayer(lastMeasurement);
});

probeButton.addEventListener("click", () => {
  if (!lastMeasurement) lastMeasurement = measureAll();
  const visible = probeLayer.classList.toggle("visible");
  probeButton.setAttribute("aria-pressed", String(visible));
  probeButton.textContent = visible ? "Hide probes" : "Show probes";
  if (visible) renderProbeLayer(lastMeasurement);
  else probeLayer.replaceChildren();
});

toggleJson.addEventListener("click", () => {
  const open = outputJson.classList.toggle("open");
  toggleJson.textContent = open ? "Hide JSON" : "Show JSON";
});

alignBcrBlocker();
openTopLayerDiagnostic();
