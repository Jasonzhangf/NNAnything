// Read-only re-observation harness: attaches to an already open page over CDP,
// runs the real adapter through the bundled entry and writes one capture file.
// It never navigates, scrolls, clicks or closes the page.
import { build } from "esbuild";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repo = "/Volumes/Intel/playground/nnanything/browser-foundation";
const cdp = "http://127.0.0.1:9333";
const arg = name => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1]; };
const out = resolve(arg("--out") ?? "reobserve.json");
const targetId = arg("--target");
const match = arg("--match");

const targets = await (await fetch(`${cdp}/json/list`)).json();
const target = targetId
  ? targets.find(item => item.id === targetId)
  : targets.find(item => item.type === "page" && String(item.url).includes(match ?? ""));
if (target === undefined) throw new Error(`no matching page target for ${targetId ?? match}`);

const bundled = await build({
  entryPoints: [resolve(repo, "playground/browser/reobserve-live-entry.ts")],
  bundle: true, format: "iife", platform: "browser", target: "chrome120",
  write: false, logLevel: "silent",
});
const code = bundled.outputFiles[0].text;

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { socket.addEventListener("open", res, { once: true }); socket.addEventListener("error", rej, { once: true }); });
let nextId = 1; const pending = new Map();
socket.addEventListener("message", event => { const m = JSON.parse(event.data); const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m); } });
const call = (method, params) => { const id = nextId++; socket.send(JSON.stringify({ id, method, params })); return new Promise(r => pending.set(id, r)); };

try {
  await call("Runtime.enable", {});
  const evaluated = await call("Runtime.evaluate", {
    expression: `${code}\n;JSON.stringify(window.__reobserveResult)`,
    returnByValue: true, awaitPromise: true,
  });
  const message = evaluated.result;
  if (message.exceptionDetails !== undefined) throw new Error(JSON.stringify(message.exceptionDetails).slice(0, 400));
  const value = JSON.parse(message.result.value);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(value, null, 1));
  console.log(JSON.stringify({ out, origin: value.origin, path: value.path, rows: value.rows.length, viewport: value.viewport, coverage: value.coverage }));
} finally {
  socket.close();
}
