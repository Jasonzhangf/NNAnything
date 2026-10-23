// Public retention consumer harness. It bundles f04-retention-entry.ts, opens
// one controlled CDP tab, runs observeLiveDom -> candidate chain ->
// classifyBasicKindBatch, and verifies default addressability, ref stability
// across re-observation, and descendant independence under an ignore parent.
// The presentation/overlay layer is never used.
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_BASIC_KIND_PROFILE, loadBrowserWeightAsset } from "nnanything/browser-classify";
import { summarizeRetentionChecks } from "./f04-retention-checks.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const positional = [];
  const values = { out: null, weight: null, profile: null, cdp: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (["--weight", "--profile", "--out", "--cdp"].includes(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
      values[flag.slice(2)] = value;
      index += 1;
      continue;
    }
    if (flag.startsWith("--")) throw new Error(`unknown argument ${flag}`);
    positional.push(flag);
  }
  return {
    out: values.out ?? positional[0] ?? null,
    weight: values.weight,
    profile: values.profile,
    cdp: values.cdp ?? "http://127.0.0.1:9333",
  };
}

const args = parseArgs(process.argv.slice(2));
const out = args.out === null ? resolve("f04-retention.json") : resolve(args.out);
const cdp = args.cdp;
const useDefault = args.profile === "default";
if (args.weight === null && !useDefault) {
  throw new Error("--weight <candidate weight json> is required unless --profile default is passed");
}

const cases = [
  { id: "standalone-container", parentSelector: "#retention-standalone", descendantSelector: "#retention-standalone-child" },
  { id: "ignore-wrap-button", parentSelector: "#retention-wrap-button", descendantSelector: "#retention-wrap-button button" },
  { id: "ignore-wrap-link", parentSelector: "#retention-wrap-link", descendantSelector: "#retention-wrap-link a" },
];

const page = `<!doctype html><html><head><meta charset="utf-8"><title>f04-retention</title>
<style>
  body { margin: 0; font: 16px/1.4 sans-serif; }
  .standalone { display: block; margin: 8px 0; padding: 0; border: 0; }
  .standalone > * { display: block; width: 160px; height: 40px; margin: 0; padding: 0; border: 0; }
  .same-rect { display: block; margin: 8px 0; padding: 0; border: 0; background: none; }
  .same-rect > * { display: block; width: 120px; height: 32px; margin: 0; padding: 0; border: 0; }
</style></head><body>
<div class="standalone" id="retention-standalone" tabindex="0"><span id="retention-standalone-child">动作</span></div>
<div class="same-rect" id="retention-wrap-button"><button>确定</button></div>
<div class="same-rect" id="retention-wrap-link"><a href="/detail/1">详情</a></div>
</body></html>`;

const asset = useDefault
  ? { profile: DEFAULT_BASIC_KIND_PROFILE, config: { taskId: "dom.basic-kinds.v1", minScore: 0.6, minMargin: 0.15 }, sourceLabel: "default profile" }
  : await loadBrowserWeightAsset({ weightFile: { sourceLabel: args.weight, readText: () => readFile(args.weight, "utf8") } });

const bundled = await build({
  entryPoints: [resolve(repo, "playground/browser/f04-retention-entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  write: false,
  logLevel: "silent",
});
const code = bundled.outputFiles[0].text;

const created = await (await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" })).json();
const targetId = created.id;
const socket = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  socket.addEventListener("open", res, { once: true });
  socket.addEventListener("error", rej, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (waiter !== undefined) {
    pending.delete(message.id);
    waiter(message);
  }
});
const call = (method, params) => {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise(resolveCall => pending.set(id, resolveCall));
};

try {
  const frameTree = await call("Page.getFrameTree", {});
  await call("Page.setDocumentContent", {
    frameId: frameTree.result.frameTree.frame.id,
    html: page,
  });
  await new Promise(resolveWait => setTimeout(resolveWait, 400));
  const setup = JSON.stringify({ cases, asset: { config: asset.config, profile: asset.profile } });
  await call("Runtime.evaluate", {
    expression: `(() => { const s = ${setup}; window.__retentionCases = s.cases; window.__retentionAsset = s.asset; })()`,
  });
  const evaluated = await call("Runtime.evaluate", { expression: code, returnByValue: true });
  if (evaluated.result?.exceptionDetails) throw new Error(JSON.stringify(evaluated.result.exceptionDetails));
  const raw = await call("Runtime.evaluate", {
    expression: "JSON.stringify(window.__f04RetentionResult ?? null)",
    returnByValue: true,
  });
  const result = JSON.parse(raw.result?.result?.value ?? "null");

  const rows = result.rows ?? [];
  const checks = summarizeRetentionChecks(rows);
  const report = {
    schemaVersion: "browser-foundation-f04-retention-harness.v1",
    observedAt: new Date().toISOString(),
    weightFile: useDefault ? null : args.weight,
    profileId: asset.profile.id,
    calibrated: false,
    adoption: "not_applied",
    provenance: "controlled real browser page; public chain is observeLiveDom -> observeCandidates -> checkCandidates -> classifyBasicKindBatch; no presentation/overlay layer",
    checks,
    cases: rows,
    limits: [
      "Controlled page in a real browser, not a user site.",
      "Expected parent kinds come from construction, not from a human-labeled site.",
      "The tab created for this run was closed; no user tab was navigated or closed.",
    ],
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ checks, rows: rows.length }));
} finally {
  socket.close();
  await fetch(`${cdp}/json/close/${targetId}`);
}
