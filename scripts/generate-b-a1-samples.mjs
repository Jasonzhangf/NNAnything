// B-A1 real sample generation (Henry, task
// b-a1-real-sample-generation-henry-20261107).
//
// Read-only harness. It serves the three real page renderers (family A
// search-cases, family B, family C dev grid) plus two harness fixture pages,
// observes them through headless Chrome over CDP, records typed candidate
// facts and the coverage/currentness envelope, then hands the records to the
// B-A1 sample converter. It writes sample rows, a manifest and receipts into an
// explicit output directory outside the repository.
//
// It performs no training, no fitting, no weight/gold/threshold/adoption
// change, no product wiring and no install.

import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BA1_HARNESS_OBSERVATION_SCHEMA,
  convertObservations,
} from "../dist/training/b-a1-sample-converter.js";
import {
  loadBA1StudentRowsFile,
  loadBA1SupervisionRowsFile,
} from "../dist/training/b-a1-training-entry.js";
import { renderPage } from "../playground/browser/search-fixture/page.mjs";
import { renderFamilyBPage } from "../playground/browser/search-fixture/family-b/page.mjs";
import { renderFamilyCDevSearchPage } from "../playground/browser/search-fixture/family-c-dev/page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

function argAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

const outDir = resolve(argAfter("--out", resolve(process.cwd(), "b-a1-real-sample-generation")));
const chromeBin = argAfter("--chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const cdpPort = Number(argAfter("--cdp-port", "9583"));
const fixturePort = Number(argAfter("--fixture-port", "4531"));

const FIXTURE_PAGES = {
  "/harness/duplicate-search": `<!doctype html><html lang="zh"><meta charset="utf-8"><title>harness duplicate</title>
    <form id="top-form"><input id="top-search" type="text" placeholder="搜索"><button id="top-submit" type="submit">搜索</button></form>
    <form id="bottom-form"><input id="bottom-search" type="text" placeholder="搜索"><button id="bottom-submit" type="submit">搜索</button></form></html>`,
  "/harness/non-search": `<!doctype html><html lang="zh"><meta charset="utf-8"><title>harness non-search</title>
    <p><label for="nick">昵称<input id="nick" type="text" placeholder="昵称"></label></p></html>`,
  "/harness/unknown-single": `<!doctype html><html lang="zh"><meta charset="utf-8"><title>harness unknown</title>
    <p><input id="mystery" value="x"></p></html>`,
};

const CASES = [
  {
    caseId: "family-a-selected-single",
    sourceFamily: "family-a",
    sampleFamily: "model-semantic",
    partition: "TRAIN",
    page: "/?profile=search-cases&scenario=normal",
    allowedScopeSelector: "body",
    candidates: ["#query", "#notes"],
    supervision: {
      kind: "model-semantic",
      supervisionStatus: "labeled_selected",
      goldAllowedCandidateRefs: ["family-a-selected-single:query"],
      labelAuthority: "independent-teacher:family-a-search-host",
      oracleKind: "search-input-host-single",
    },
  },
  {
    caseId: "family-b-selected-single",
    sourceFamily: "family-b",
    sampleFamily: "model-semantic",
    partition: "TRAIN",
    page: "/family-b/",
    allowedScopeSelector: "body",
    candidates: ["#query", "#notes"],
    supervision: {
      kind: "model-semantic",
      supervisionStatus: "labeled_selected",
      goldAllowedCandidateRefs: ["family-b-selected-single:query"],
      labelAuthority: "independent-teacher:family-b-search-host",
      oracleKind: "search-input-host-single",
    },
  },
  {
    caseId: "family-a-ambiguous-duplicate",
    sourceFamily: "family-a",
    sampleFamily: "model-semantic",
    partition: "TRAIN",
    page: "/harness/duplicate-search",
    allowedScopeSelector: "body",
    candidates: ["#top-search", "#bottom-search"],
    supervision: {
      kind: "model-semantic",
      supervisionStatus: "labeled_ambiguous",
      goldAllowedCandidateRefs: [
        "family-a-ambiguous-duplicate:top-search",
        "family-a-ambiguous-duplicate:bottom-search",
      ],
      labelAuthority: "independent-teacher:duplicate-search-hosts",
      oracleKind: "search-input-host-ambiguous",
    },
  },
  {
    caseId: "family-a-none-non-search",
    sourceFamily: "family-a",
    sampleFamily: "model-semantic",
    partition: "DEV",
    page: "/harness/non-search",
    allowedScopeSelector: "body",
    candidates: ["#nick"],
    supervision: {
      kind: "model-semantic",
      supervisionStatus: "labeled_none",
      goldAllowedCandidateRefs: [],
      labelAuthority: "independent-teacher:non-search-only",
      oracleKind: "search-input-host-none",
    },
  },
  {
    caseId: "family-b-insufficient-unknown",
    sourceFamily: "family-b",
    sampleFamily: "model-semantic",
    partition: "DEV",
    page: "/harness/unknown-single",
    allowedScopeSelector: "body",
    candidates: ["#mystery"],
    unmeasured: { "#mystery": ["type"] },
    supervision: {
      kind: "model-semantic",
      supervisionStatus: "observation_missing",
      goldAllowedCandidateRefs: [],
      labelAuthority: "independent-teacher:unmeasured-host-type",
      oracleKind: "search-input-host-insufficient",
    },
  },
  {
    caseId: "new-independent-selected-grid",
    sourceFamily: "new-independent",
    sampleFamily: "model-semantic",
    partition: "VERIFICATION",
    page: "/family-c/",
    allowedScopeSelector: "body",
    candidates: ["#search-input", "#secondary-tag-filter"],
    supervision: {
      kind: "model-semantic",
      supervisionStatus: "labeled_selected",
      goldAllowedCandidateRefs: ["new-independent-selected-grid:search-input"],
      labelAuthority: "independent-teacher:family-c-grid-search",
      oracleKind: "search-input-host-single",
    },
  },
  {
    caseId: "new-independent-none-filter-only",
    sourceFamily: "new-independent",
    sampleFamily: "model-semantic",
    partition: "VERIFICATION",
    page: "/family-c/?variant=filter-only",
    allowedScopeSelector: "body",
    candidates: ["#secondary-tag-filter"],
    supervision: {
      kind: "model-semantic",
      supervisionStatus: "labeled_none",
      goldAllowedCandidateRefs: [],
      labelAuthority: "independent-teacher:family-c-filter-only",
      oracleKind: "search-input-host-none",
    },
  },
  {
    caseId: "contract-gate-outside-scope",
    sourceFamily: "family-a",
    sampleFamily: "contract-gate",
    partition: "DEV",
    page: "/?profile=search-cases&scenario=normal",
    allowedScopeSelector: "main#search-app",
    corrupt: "outside-scope",
    candidates: ["#query"],
    supervision: { kind: "contract-gate", reason: "outside_scope" },
  },
  {
    caseId: "contract-gate-unverified-coverage",
    sourceFamily: "family-b",
    sampleFamily: "contract-gate",
    partition: "DEV",
    page: "/family-b/",
    allowedScopeSelector: "body",
    corrupt: "partial-coverage",
    candidates: [],
    supervision: { kind: "contract-gate", reason: "unverified_coverage" },
  },
  {
    caseId: "contract-gate-access-unknown",
    sourceFamily: "new-independent",
    sampleFamily: "contract-gate",
    partition: "DEV",
    page: "/family-c/",
    allowedScopeSelector: "body",
    corrupt: "access-unknown",
    candidates: ["#search-input"],
    supervision: { kind: "contract-gate", reason: "access_unknown" },
  },
  {
    caseId: "contract-gate-unsupported-role",
    sourceFamily: "family-a",
    sampleFamily: "contract-gate",
    partition: "DEV",
    page: "/harness/non-search",
    allowedScopeSelector: "body",
    requestedRole: "button-click",
    candidates: [],
    supervision: { kind: "contract-gate", reason: "unsupported_requested_role" },
  },
  {
    caseId: "contract-gate-stale-candidate",
    sourceFamily: "family-b",
    sampleFamily: "contract-gate",
    partition: "DEV",
    page: "/family-b/",
    allowedScopeSelector: "body",
    corrupt: "stale-envelope",
    candidates: ["#query"],
    supervision: { kind: "contract-gate", reason: "stale_candidate" },
  },
];

const AGGREGATOR_CASES = [
  {
    caseId: "aggregator-single-over-threshold",
    expectedState: "selected",
    injectedScores: [0.8, 0.2],
    sourceFamily: "family-a",
  },
  {
    caseId: "aggregator-all-low",
    expectedState: "insufficient_observation",
    injectedScores: [0.2, 0.3],
    sourceFamily: "family-a",
  },
  {
    caseId: "aggregator-two-over-unequal",
    expectedState: "ambiguous",
    injectedScores: [0.8, 0.7],
    sourceFamily: "family-b",
  },
  {
    caseId: "aggregator-single-under-threshold",
    expectedState: "none",
    injectedScores: [0.2],
    sourceFamily: "family-b",
  },
];

const OBSERVE_FN = `(() => {
  const SPEC = __SPEC__;
  const allowedRoot = document.querySelector(SPEC.allowedScopeSelector) || document.body;
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (el.hasAttribute("hidden")) return false;
    return rect.width > 0 && rect.height > 0;
  };
  const intersectsViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  };
  const eligibleHosts = () =>
    [...allowedRoot.querySelectorAll("input, textarea, [contenteditable='true'], [contenteditable='']")]
      .filter(el => visible(el) && el.disabled !== true);
  const labelText = (el) => {
    const id = el.getAttribute("id");
    const explicit = id ? document.querySelector('label[for="' + id + '"]') : null;
    const ancestor = el.closest("label");
    return ((explicit?.textContent || ancestor?.textContent || "")).trim();
  };
  const depthOf = (el) => {
    let depth = 0;
    let node = el;
    while (node.parentElement && node !== allowedRoot) { depth += 1; node = node.parentElement; }
    return depth;
  };
  const SEARCH_TOKENS = ["\\u641c\\u7d22", "search", "query", "\\u67e5\\u627e", "\\u67e5\\u8be2"];
  const NON_SEARCH_TOKENS = ["\\u5907\\u6ce8", "\\u6635\\u79f0", "\\u8bc4\\u8bba", "tag", "filter", "optional", "note", "bio"];
  const hostOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return "input";
    if (tag === "textarea") return "textarea";
    return "contenteditable";
  };
  const typeOf = (el) => {
    const raw = (el.getAttribute("type") || "text").toLowerCase();
    return ["text","search","tel","email","url","number"].includes(raw) ? raw : "other";
  };
  const tabIndexKindOf = (el) => {
    if (!el.hasAttribute("tabindex")) return "absent";
    const raw = el.getAttribute("tabindex");
    if (!/^-?\\d+$/.test(raw)) return "invalid";
    return Number(raw) < 0 ? "negative" : "nonnegative";
  };
  const nameChannels = (el) => {
    const label = labelText(el);
    const placeholder = el.getAttribute("placeholder") || "";
    const aria = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || "";
    return { label, placeholder, aria };
  };
  const textLenOf = (el) => {
    const { label, placeholder, aria } = nameChannels(el);
    const text = (placeholder || aria || label || "").trim();
    if (text.length === 0) return 0;
    return text.length <= 12 ? 1 : 2;
  };
  const markerHitOf = (el) => {
    const { label, placeholder, aria } = nameChannels(el);
    const text = (label + " " + placeholder + " " + aria).toLowerCase();
    return SEARCH_TOKENS.some(t => text.includes(t.toLowerCase()));
  };
  const nonSearchMarkerOf = (el) => {
    const { label, placeholder, aria } = nameChannels(el);
    const text = (label + " " + placeholder + " " + aria).toLowerCase();
    return NON_SEARCH_TOKENS.some(t => text.includes(t.toLowerCase()));
  };
  const submitInForm = (el) => {
    const form = el.form || el.closest("form");
    if (!form) return false;
    return [...form.querySelectorAll("button, input")].some(node => {
      const tag = node.tagName.toLowerCase();
      const type = (node.getAttribute("type") || (tag === "button" ? "submit" : "")).toLowerCase();
      return (type === "submit" || type === "image") && node.disabled !== true;
    });
  };
  const observed = SPEC.candidates.map(ref => {
    const el = document.querySelector(ref);
    if (!el) return { candidateRef: ref, missing: true };
    const host = hostOf(el);
    const type = typeOf(el);
    const unmeasured = (SPEC.unmeasured && SPEC.unmeasured[ref]) || [];
    const features = {
      host,
      type: unmeasured.includes("type") ? null : type,
      editable: !(el.disabled === true) && !(el.readOnly === true),
      disabled: el.disabled === true,
      readOnly: el.readOnly === true,
      cssHidden: !visible(el),
      intersectsViewport: intersectsViewport(el),
      explicitTabIndexKind: tabIndexKindOf(el),
      tabIndexFocus: el.tabIndex >= 0,
      inForm: (el.form || el.closest("form")) !== null,
      formRoleSearch: ((el.form || el.closest("form"))?.getAttribute("role") || "") === "search",
      nearbySubmit: submitInForm(el),
      depthBand: depthOf(el) <= 3 ? "shallow" : depthOf(el) <= 6 ? "middle" : "deep",
      hasLabel: labelText(el).length > 0,
      hasPlaceholder: el.hasAttribute("placeholder"),
      hasAria: el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") || el.getAttribute("role") === "searchbox",
      markerHit: markerHitOf(el),
      nonSearchMarker: unmeasured.includes("nonSearchMarker") ? null : nonSearchMarkerOf(el),
      textLenBand: textLenOf(el),
      access: SPEC.accessOutcome || "available",
    };
    return { candidateRef: ref, blockRef: ref, features, unmeasured };
  });
  return {
    documentRef: SPEC.documentRef,
    evaluatedCount: eligibleHosts().length,
    observed,
  };
})()`;

function createHarnessServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (html) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(html);
    };
    if (url.pathname === "/family-b/") return send(renderFamilyBPage({}));
    if (url.pathname === "/family-c/") {
      const filterOnly = url.searchParams.get("variant") === "filter-only";
      return send(renderFamilyCDevSearchPage(filterOnly
        ? { inputType: "text", includeSecondaryFilter: true, inputValue: "", inputDisabled: true }
        : { inputType: "text", includeSecondaryFilter: true }));
    }
    if (url.pathname === "/") {
      return send(renderPage(
        {
          id: "search-cases",
          label: "搜索关联主结果",
          layout: { columns: 1, maxWidth: 1060, cardBorder: true, fieldOrder: [], wrapperDepth: 0 },
          input: { tag: "input", type: "text", placeholder: "旧推荐词：城市散步路线" },
          groups: [],
        },
        "normal",
        [{ id: "search-cases" }],
        { query: "", scenarios: ["normal"], placeholder: undefined, readonly: false },
      ));
    }
    if (FIXTURE_PAGES[url.pathname]) return send(FIXTURE_PAGES[url.pathname]);
    response.writeHead(404);
    response.end("not found");
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve: resolveCall, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolveCall(message.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }
}

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error(`websocket error for ${url}`)), { once: true });
  });
  return socket;
}

async function observePage(cdp, sessionId, url, spec) {
  await cdp.send("Page.enable", {}, sessionId);
  const loaded = new Promise(resolveLoad => {
    const listener = event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Page.loadEventFired") {
        cdp.socket.removeEventListener("message", listener);
        resolveLoad();
      }
    };
    cdp.socket.addEventListener("message", listener);
  });
  await cdp.send("Page.navigate", { url }, sessionId);
  await loaded;
  const script = OBSERVE_FN.replace("__SPEC__", JSON.stringify(spec));
  const result = await cdp.send("Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: false,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`observation script failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result.value;
}

function buildObservationRecord(caseSpec, observed, revision) {
  const observedByRef = new Map((observed.observed || []).map(entry => [entry.candidateRef, entry]));
  const candidates = caseSpec.candidates.map(candidateRef => {
    const entry = observedByRef.get(candidateRef);
    if (!entry || entry.missing) throw new Error(`candidate ${candidateRef} was not observed for ${caseSpec.caseId}`);
    return {
      candidateRef: `${caseSpec.caseId}:${candidateRef.replace(/^#/, "")}`,
      scopeRef: caseSpec.corrupt === "outside-scope"
        ? `${caseSpec.caseId}-outside-scope`
        : `${caseSpec.caseId}-scope`,
      documentRef: observed.documentRef,
      observationId: `${caseSpec.caseId}-obs-${revision}`,
      revision,
      unmeasured: entry.unmeasured ?? [],
      features: entry.features,
    };
  });
  const goldAllowedCandidateRefs = caseSpec.supervision.kind === "model-semantic"
    ? caseSpec.supervision.goldAllowedCandidateRefs.map(ref => `${caseSpec.caseId}:${ref.split(":")[1]}`)
    : [];
  const expectedCount = caseSpec.corrupt === "partial-coverage"
    ? observed.evaluatedCount + 2
    : observed.evaluatedCount;
  const coverageStatus = caseSpec.corrupt === "partial-coverage" ? "partial" : "complete";
  const access = caseSpec.corrupt === "access-unknown" ? "unknown" : (caseSpec.accessOutcome || "available");
  const currentControlRevision = caseSpec.corrupt === "stale-envelope" ? revision + 1 : revision;
  return {
    schema: BA1_HARNESS_OBSERVATION_SCHEMA,
    caseId: caseSpec.caseId,
    sourceFamily: caseSpec.sourceFamily,
    sampleFamily: caseSpec.sampleFamily,
    partition: caseSpec.partition,
    queryText: caseSpec.queryText ?? "搜索",
    requestedRole: caseSpec.requestedRole ?? "search-input-host",
    allowedScopeRef: `${caseSpec.caseId}-scope`,
    sourceGroup: caseSpec.sourceFamily,
    sampleId: caseSpec.caseId,
    stepContextRef: `${caseSpec.caseId}-step`,
    candidateGroupRef: `${caseSpec.caseId}-group`,
    observation: {
      documentRef: observed.documentRef,
      observationId: `${caseSpec.caseId}-obs-${revision}`,
      revision,
      coverage: {
        status: coverageStatus,
        scopeRef: `${caseSpec.caseId}-scope`,
        documentRef: observed.documentRef,
        observationId: `${caseSpec.caseId}-obs-${revision}`,
        revision,
        evaluatedCount: observed.evaluatedCount,
        expectedCount,
        unassessedIframeCount: 0,
        unassessedObjectCount: 0,
        unassessedOpenShadowRootCount: 0,
        evidenceRefs: [`${caseSpec.caseId}-coverage`],
      },
      currentControl: {
        documentRef: caseSpec.corrupt === "stale-envelope"
          ? `${caseSpec.caseId}-stale-doc`
          : observed.documentRef,
        observationId: `${caseSpec.caseId}-obs-${revision}`,
        revision: currentControlRevision,
      },
      candidateGroupEnumerationComplete: coverageStatus === "complete",
    },
    candidates,
    supervision: caseSpec.supervision.kind === "model-semantic"
      ? { ...caseSpec.supervision, goldAllowedCandidateRefs }
      : caseSpec.supervision,
  };
}

async function writeJsonl(path, rows) {
  const text = rows.length === 0 ? "" : `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(path, text);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const server = createHarnessServer();
  await new Promise(resolveListen => server.listen(fixturePort, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${fixturePort}`;
  const chromeProfile = resolve(outDir, "chrome-profile");
  await mkdir(chromeProfile, { recursive: true });
  const { spawn } = await import("node:child_process");
  const chrome = spawn(chromeBin, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-crash-reporter",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeProfile}`,
    "about:blank",
  ], { stdio: "ignore" });
  await writeFile(resolve(outDir, "processes.json"), `${JSON.stringify({
    fixtureServerPid: process.pid,
    chromePid: chrome.pid,
    fixturePort,
    cdpPort,
  }, null, 2)}\n`);

  let cdp;
  let sessionId;
  try {
    let version = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`);
        break;
      } catch {
        await new Promise(r => setTimeout(r, 250));
      }
    }
    if (!version) throw new Error("headless Chrome did not expose the CDP endpoint");
    const socket = await openSocket(version.webSocketDebuggerUrl);
    cdp = new Cdp(socket);
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    sessionId = attached.sessionId;

    const observations = [];
    let revision = 3;
    for (const caseSpec of CASES) {
      const spec = {
        caseId: caseSpec.caseId,
        documentRef: `${caseSpec.caseId}-doc`,
        allowedScopeSelector: caseSpec.allowedScopeSelector,
        candidates: caseSpec.candidates,
        unmeasured: caseSpec.unmeasured ?? {},
        accessOutcome: caseSpec.corrupt === "access-unknown"
          ? "unknown"
          : "available",
      };
      const observed = await observePage(cdp, sessionId, `${origin}${caseSpec.page}`, spec);
      if (caseSpec.corrupt === "outside-scope") {
        for (const candidate of observed.observed || []) candidate.features = { ...candidate.features };
      }
      observations.push(buildObservationRecord(caseSpec, observed, revision));
      revision += 1;
    }
    for (const aggregator of AGGREGATOR_CASES) {
      observations.push({
        schema: BA1_HARNESS_OBSERVATION_SCHEMA,
        caseId: aggregator.caseId,
        sourceFamily: aggregator.sourceFamily,
        sampleFamily: "aggregator-test",
        partition: "DEV",
        queryText: "搜索",
        requestedRole: "search-input-host",
        allowedScopeRef: `${aggregator.caseId}-scope`,
        sourceGroup: aggregator.sourceFamily,
        sampleId: aggregator.caseId,
        stepContextRef: `${aggregator.caseId}-step`,
        candidateGroupRef: `${aggregator.caseId}-group`,
        observation: {
          documentRef: `${aggregator.caseId}-doc`,
          observationId: `${aggregator.caseId}-obs`,
          revision,
          coverage: {
            status: "complete",
            scopeRef: `${aggregator.caseId}-scope`,
            documentRef: `${aggregator.caseId}-doc`,
            observationId: `${aggregator.caseId}-obs`,
            revision,
            evaluatedCount: aggregator.injectedScores.length,
            expectedCount: aggregator.injectedScores.length,
            unassessedIframeCount: 0,
            unassessedObjectCount: 0,
            unassessedOpenShadowRootCount: 0,
            evidenceRefs: [`${aggregator.caseId}-injected-scores`],
          },
          currentControl: {
            documentRef: `${aggregator.caseId}-doc`,
            observationId: `${aggregator.caseId}-obs`,
            revision,
          },
          candidateGroupEnumerationComplete: true,
        },
        candidates: [],
        supervision: {
          kind: "aggregator-test",
          injectedScores: aggregator.injectedScores,
          expectedState: aggregator.expectedState,
        },
      });
      revision += 1;
    }

    await writeFile(resolve(outDir, "observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
    const converted = convertObservations(observations, { generatedAt: new Date().toISOString() });
    await mkdir(resolve(outDir, "train"), { recursive: true });
    await mkdir(resolve(outDir, "dev"), { recursive: true });
    await mkdir(resolve(outDir, "verification"), { recursive: true });
    await mkdir(resolve(outDir, "contract-gate"), { recursive: true });
    await mkdir(resolve(outDir, "aggregator-test"), { recursive: true });
    await mkdir(resolve(outDir, "observation-missing"), { recursive: true });
    await writeJsonl(resolve(outDir, "train/student-rows.jsonl"), converted.trainStudentRows);
    await writeJsonl(resolve(outDir, "train/supervision-rows.jsonl"), converted.trainSupervisionRows);
    await writeJsonl(resolve(outDir, "dev/student-rows.jsonl"), converted.devStudentRows);
    await writeJsonl(resolve(outDir, "dev/supervision-rows.jsonl"), converted.devSupervisionRows);
    await writeJsonl(resolve(outDir, "verification/student-rows.jsonl"), converted.verificationStudentRows);
    await writeJsonl(resolve(outDir, "verification/supervision-rows.jsonl"), converted.verificationSupervisionRows);
    await writeJsonl(resolve(outDir, "contract-gate/rows.jsonl"), converted.contractGateRows);
    await writeJsonl(resolve(outDir, "aggregator-test/rows.jsonl"), converted.aggregatorTestRows);
    await writeJsonl(resolve(outDir, "observation-missing/rows.jsonl"), converted.observationMissingRows);
    await writeFile(resolve(outDir, "manifest.json"), `${JSON.stringify(converted.manifest, null, 2)}\n`);

    const trainGroups = await loadBA1StudentRowsFile(resolve(outDir, "train/student-rows.jsonl"));
    const trainSupervision = await loadBA1SupervisionRowsFile(resolve(outDir, "train/supervision-rows.jsonl"));
    const readiness = {
      trainEntry: "nnanything.b-a1-training-entry",
      studentRowsPath: "train/student-rows.jsonl",
      supervisionRowsPath: "train/supervision-rows.jsonl",
      studentGroupCount: trainGroups.length,
      supervisionRowCount: trainSupervision.length,
      consumable: trainGroups.length > 0 && trainSupervision.length === trainGroups.length,
    };
    await writeFile(resolve(outDir, "train-entry-readiness.json"), `${JSON.stringify(readiness, null, 2)}\n`);
    console.log(JSON.stringify({
      outDir,
      manifest: converted.manifest,
      readiness,
    }, null, 2));
  } finally {
    server.close();
    chrome.kill("SIGTERM");
    if (cdp?.socket) cdp.socket.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { CASES, AGGREGATOR_CASES, buildObservationRecord };
