// F06/P1#1 capture end-to-end harness. Opens one controlled CDP tab with a
// password field, runs the real capture consumer in page context, then checks
// that the exported bundle carries no value and closes only that tab.
import { build } from "esbuild";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repo = "/Volumes/Intel/playground/nnanything/browser-foundation";
const out = process.argv[2] ?? resolve("f06-capture-live.json");
const cdp = "http://127.0.0.1:9333";

const secret = "capture-e2e-sentinel-not-a-real-secret";
const page = `<!doctype html><html><head><meta charset="utf-8"><title>f06-capture</title>
<style>body{margin:0;font:16px/1.4 sans-serif}button{display:block;width:120px;height:32px;margin:8px}</style>
</head><body>
<button id="go">确定</button>
<input id="secret" type="password" value="${secret}">
<div id="wrap"><span>说明文字</span></div>
</body></html>`;

const bundled = await build({
  entryPoints: [resolve(repo, "playground/browser/f06-capture-live-entry.ts")],
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
  await call("Runtime.evaluate", { expression: `window.__f06Secret = ${JSON.stringify(secret)}` });
  const evaluated = await call("Runtime.evaluate", { expression: code, returnByValue: true });
  if (evaluated.result?.exceptionDetails) throw new Error(JSON.stringify(evaluated.result.exceptionDetails));
  const raw = await call("Runtime.evaluate", { expression: "JSON.stringify(window.__f06CaptureResult ?? null)", returnByValue: true });
  const result = JSON.parse(raw.result?.result?.value ?? "null");
  const report = {
    schemaVersion: "browser-foundation-f06-capture-live.v1",
    observedAt: new Date().toISOString(),
    scope: "real browser, controlled page, real capture consumer",
    limits: [
      "Controlled page in a real browser, not a user site.",
      "The sentinel value is a test string, not a real password.",
      "The tab created for this run was closed; no user tab was navigated or closed.",
    ],
    result,
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(result));
  if (result === null || result.sidecarOwnsInputValue !== false || result.serializedContainsSecret !== false) {
    throw new Error("capture export leaked the value");
  }
} finally {
  socket.close();
  await fetch(`${cdp}/json/close/${targetId}`);
}