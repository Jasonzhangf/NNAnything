// F04 limited-domain real-browser matrix harness. Loads the frozen MAP
// candidate read-only, bundles the entry, opens one controlled CDP tab, runs the
// real adapter and classifier, then closes only that tab.
import { build } from "esbuild";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { DEFAULT_BASIC_KIND_PROFILE, loadBrowserWeightAsset } from "nnanything/browser-classify";

const repo = "/Volumes/Intel/playground/nnanything/browser-foundation";
const out = process.argv[2] ?? resolve("f04-live-gold.json");
const weightFile = process.argv.includes("--weight")
  ? process.argv[process.argv.indexOf("--weight") + 1]
  : "/Volumes/extension/code/NNAnything/training/weights/dom-basic-kinds/incremental-map-d5f655f7-1d16-486c-87ee-c0760b8f55e0.weight.json";
const cdp = "http://127.0.0.1:9333";

// Teacher construction labels: the expected label follows from how the element
// is built, not from any prediction. Every row here was never used in fitting,
// so the whole set is a holdout by construction.
const cases = [
  { id: "audio-controls", selector: "#audio-controls", expected: "audio", split: "holdout" },
  { id: "audio-plain", selector: "#audio-plain", expected: "audio", split: "holdout" },
  { id: "audio-preload-none", selector: "#audio-preload-none", expected: "audio", split: "holdout" },
  { id: "audio-loop-named", selector: "#audio-loop-named", expected: "audio", split: "holdout" },
  { id: "video-controls", selector: "#video-controls", expected: "video", split: "holdout" },
  { id: "video-poster", selector: "#video-poster", expected: "video", split: "holdout" },
  { id: "video-silent-inline", selector: "#video-silent-inline", expected: "video", split: "holdout" },
  { id: "video-plain", selector: "#video-plain", expected: "video", split: "holdout" },
  { id: "ignore-wrap-button", selector: "#ignore-wrap-button", expected: "ignore", split: "holdout" },
  { id: "ignore-wrap-icon", selector: "#ignore-wrap-icon", expected: "ignore", split: "holdout" },
  { id: "ignore-wrap-image", selector: "#ignore-wrap-image", expected: "ignore", split: "holdout" },
  { id: "ignore-wrap-link", selector: "#ignore-wrap-link", expected: "ignore", split: "holdout" },
];

const page = `<!doctype html><html><head><meta charset="utf-8"><title>f04</title>
<style>
  body { margin: 0; font: 16px/1.4 sans-serif; }
  .same-rect { display: block; margin: 8px 0; padding: 0; border: 0; background: none; }
  .same-rect > * { display: block; width: 120px; height: 32px; margin: 0; padding: 0; border: 0; }
  audio, video { display: block; width: 120px; height: 32px; margin: 8px 0; }
</style></head><body>
<audio id="audio-controls" controls></audio>
<audio id="audio-plain"></audio>
<audio id="audio-preload-none" preload="none"></audio>
<audio id="audio-loop-named" loop aria-label="音频"></audio>
<video id="video-controls" controls></video>
<video id="video-poster" poster="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></video>
<video id="video-silent-inline" muted playsinline></video>
<video id="video-plain"></video>
<button id="ignore-wrap-button-host">确定</button>
<div class="same-rect" id="ignore-wrap-button"><button>确定</button></div>
<div class="same-rect" id="ignore-wrap-icon"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg></div>
<div class="same-rect" id="ignore-wrap-image"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt=""></div>
<div class="same-rect" id="ignore-wrap-link"><a href="/detail/1">详情</a></div>
</body></html>`;

const useDefault = process.argv.includes("--profile") && process.argv[process.argv.indexOf("--profile") + 1] === "default";
const asset = useDefault
  ? { profile: DEFAULT_BASIC_KIND_PROFILE, config: { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 }, sourceLabel: "default profile" }
  : await loadBrowserWeightAsset({ weightFile: { sourceLabel: weightFile, readText: () => readFile(weightFile, "utf8") } });

const bundled = await build({
  entryPoints: [resolve(repo, "playground/browser/f04-live-gold-entry.ts")],
  bundle: true, format: "iife", platform: "browser", target: "chrome120",
  write: false, logLevel: "silent",
});
const code = bundled.outputFiles[0].text;

const created = await (await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" })).json();
const targetId = created.id;
const socket = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((res, rej) => { socket.addEventListener("open", res, { once: true }); socket.addEventListener("error", rej, { once: true }); });
let nextId = 1; const pending = new Map();
socket.addEventListener("message", event => { const m = JSON.parse(event.data); const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m); } });
const call = (method, params) => { const id = nextId++; socket.send(JSON.stringify({ id, method, params })); return new Promise(r => pending.set(id, r)); };

try {
  const frameTree = await call("Page.getFrameTree", {});
  await call("Page.setDocumentContent", { frameId: frameTree.result.frameTree.frame.id, html: page });
  await new Promise(r => setTimeout(r, 400));
  const setup = JSON.stringify({ cases, asset: { config: asset.config, profile: asset.profile } });
  await call("Runtime.evaluate", { expression: `(() => { const s = ${setup}; window.__f04Cases = s.cases; window.__f04Asset = s.asset; })()` });
  const evaluated = await call("Runtime.evaluate", { expression: code, returnByValue: true });
  if (evaluated.result?.exceptionDetails) throw new Error(JSON.stringify(evaluated.result.exceptionDetails));
  const raw = await call("Runtime.evaluate", { expression: "JSON.stringify(window.__f04Result ?? null)", returnByValue: true });
  const result = JSON.parse(raw.result?.result?.value ?? "null");

  const byExpected = new Map();
  for (const row of result.rows) {
    const bucket = byExpected.get(row.expected) ?? { expected: row.expected, total: 0, correct: 0, unknown: 0, conflict: 0, wrong: 0, rows: [] };
    bucket.total += 1;
    if (row.status === "judged" && row.kind === row.expected) bucket.correct += 1;
    else if (row.status === "unknown") bucket.unknown += 1;
    else if (row.status === "conflict") bucket.conflict += 1;
    else bucket.wrong += 1;
    bucket.rows.push(row);
    byExpected.set(row.expected, bucket);
  }

  const report = {
    schemaVersion: "browser-foundation-f04-live-harness.v1",
    observedAt: new Date().toISOString(),
    weightFile: useDefault ? null : weightFile,
    profileId: asset.profile.id,
    calibrated: false,
    adoption: "not_applied",
    provenance: "controlled real browser page; expected labels follow from construction; every row was never used in fitting, so all rows are a holdout by construction",
    limits: [
      "Controlled page in a real browser, not a user site.",
      "Construction labels are not human-reviewed real-site gold.",
      "Only labels, scores, statuses and counts are stored; no page text.",
      "The tab created for this run was closed; no user tab was navigated or closed.",
    ],
    matrix: Array.from(byExpected.values()),
    result,
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.matrix.map(b => ({ expected: b.expected, total: b.total, correct: b.correct, unknown: b.unknown, conflict: b.conflict, wrong: b.wrong }))));
  for (const row of result.rows) console.log(`${row.id} expected=${row.expected} status=${row.status} kind=${row.kind} score=${row.score}`);
} finally {
  socket.close();
  await fetch(`${cdp}/json/close/${targetId}`);
}