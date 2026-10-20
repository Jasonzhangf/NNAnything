import { createServer } from "node:http";

const CASE_IDS = [
  "native-button",
  "role-button",
  "adjacent-control",
  "expanded",
  "disabled",
  "ambiguous",
  "missing-effect",
  "target-swap",
];

function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!["--host", "--port"].includes(name) || value === undefined || values.has(name)) {
      throw new Error("Usage: fixture-server.mjs [--host HOST] [--port PORT]");
    }
    values.set(name, value);
  }
  return values;
}

function selectedCases(url) {
  const params = url.searchParams, raw = params.get("cases") ?? params.get("case");
  if (raw === null || raw.length === 0) return [...CASE_IDS];
  const values = raw.split(",").map(value => value.trim()).filter(Boolean);
  const invalid = values.filter(value => !CASE_IDS.includes(value));
  if (invalid.length) throw new Error(`Unknown cases: ${invalid.join(", ")}`);
  return [...new Set(values)];
}

function controlMarkup(caseId, id, regionId, label, kind, disabled = false, expanded = false) {
  const uniqueId = `${caseId}-${id}`;
  const uniqueRegion = `${caseId}-${regionId}`;
  const attrs = [
    `id="${uniqueId}"`,
    `class="toggle ${kind === "role" ? "role-control" : "native-control"}"`,
    `aria-controls="${uniqueRegion}"`,
    `aria-expanded="${expanded ? "true" : "false"}"`,
    `data-label="${label}"`,
  ];
  if (disabled) attrs.push(`data-disabled="true"`);
  if (kind === "role") {
    attrs.push(`role="button"`, `tabindex="0"`);
    return `<div ${attrs.join(" ")}><span class="caption">${label}</span></div>`;
  }
  if (disabled) attrs.push("disabled");
  return `<button ${attrs.join(" ")}>${label}</button>`;
}

function caseMarkup(caseId) {
  const primaryRegion = caseId === "target-swap" ? "region-b" : "region-a";
  // The adjacent control targets the same range only in the ambiguity case.
  const adjacentRegion = caseId === "ambiguous" ? "region-a" : "region-b";
  const expanded = caseId === "expanded";
  const disabled = caseId === "disabled";
  const kind = caseId === "role-button" ? "role" : "native";
  const primary = controlMarkup(caseId, "control-primary", primaryRegion, "Open target", kind, disabled, expanded);
  const adjacent = caseId === "adjacent-control" || caseId === "ambiguous" || caseId === "target-swap"
    ? controlMarkup(
      caseId,
      "control-adjacent",
      adjacentRegion,
      "Open adjacent",
      "native",
    )
    : "";
  return `
    <section class="fixture-case" data-case="${caseId}" data-target-region="${primaryRegion}">
      <header>
        <h2>${caseId}</h2>
        <p class="state" id="state-${caseId}">before: ${expanded ? "expanded" : "collapsed"}</p>
      </header>
      <div class="card" id="wrapper-${caseId}">
        <div class="toolbar">
          ${primary}
          ${adjacent}
          ${controlMarkup(caseId, "control-disabled", "region-a", "Disabled", "native", true)}
          <span class="caption">Independent caption</span>
        </div>
        <div class="regions">
          <section id="${caseId}-region-a" class="region" role="region" aria-label="Target region" ${expanded ? "" : "hidden"}>
            <p>Target region is expanded.</p>
          </section>
          <section id="${caseId}-region-b" class="region" role="region" aria-label="Adjacent region" hidden>
            <p>Adjacent region content.</p>
          </section>
        </div>
      </div>
    </section>`;
}

function page(cases) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Single action fixtures</title>
  <style>
    :root { color-scheme: light; font: 16px/1.4 ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: #f4f7f8; color: #172126; }
    main { display: grid; gap: 18px; max-width: 980px; }
    .fixture-case { border: 1px solid #b8c4c9; background: #fff; padding: 16px; }
    .fixture-case h2 { margin: 0; font-size: 20px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
    .state { margin: 0; color: #315a66; font-variant-numeric: tabular-nums; }
    .toolbar { display: flex; min-height: 52px; gap: 10px; align-items: center; padding: 10px 0; }
    button, .role-control { min-width: 116px; min-height: 40px; padding: 8px 12px; border: 1px solid #60747c; border-radius: 4px; background: #e8f1f4; color: #172126; cursor: pointer; }
    .role-control { display: inline-flex; align-items: center; justify-content: center; }
    button[disabled], [data-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
    .caption { color: #50636a; }
    .region { min-height: 72px; padding: 12px; border-left: 4px solid #0f7b68; background: #e8f5f1; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>${cases.map(caseMarkup).join("")}</main>
  <script>
    for (const fixture of document.querySelectorAll(".fixture-case")) {
      const caseId = fixture.dataset.case;
      const state = fixture.querySelector(\`.state\`);
      for (const control of fixture.querySelectorAll(".toggle")) {
        const activate = () => {
          if (control.disabled || control.dataset.disabled === "true") return;
          const region = document.getElementById(control.getAttribute("aria-controls"));
          if (!region) return;
          if (caseId === "missing-effect") {
            state.textContent = "after: click handled, presentation unchanged";
            return;
          }
          const next = control.getAttribute("aria-expanded") !== "true";
          for (const peer of fixture.querySelectorAll(\`.toggle[aria-controls='\${region.id}']\`)) {
            peer.setAttribute("aria-expanded", String(next));
          }
          region.hidden = !next;
          state.textContent = next ? "after: expanded" : "after: collapsed";
        };
        control.addEventListener("click", activate);
        control.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") activate();
        });
      }
    }
  </script>
</body>
</html>`;
}

const options = parseOptions(process.argv.slice(2));
const host = options.get("--host") ?? "127.0.0.1";
const port = Number(options.get("--port") ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer from 0 to 65535");

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  try {
    if (url.pathname === "/api/cases") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        cases: selectedCases(url),
        available: CASE_IDS,
        structures: {
          native: ["native-button", "adjacent-control", "expanded", "disabled", "ambiguous", "missing-effect", "target-swap"],
          role: ["role-button"],
        },
      }));
      return;
    }
    if (url.pathname !== "/") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    });
    response.end(page(selectedCases(url)));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, host, () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture server did not expose a TCP address");
  console.log(JSON.stringify({ pid: process.pid, host, port: address.port, cases: CASE_IDS }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
