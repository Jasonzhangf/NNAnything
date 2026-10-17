#!/usr/bin/env node

import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const extensionDistDir = resolve(rootDir, "artifacts/chrome-extension");
const harnessDistDir = resolve(rootDir, "artifacts/overlay-harness");

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function resolveFoundationEntry() {
  const candidateTs = resolve(rootDir, "lib/browser-classify.ts");
  const candidateJs = resolve(rootDir, "dist/browser-classify.js");

  if (existsSync(candidateTs)) return candidateTs;
  if (existsSync(candidateJs)) return candidateJs;

  try {
    const pkgJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
    if (pkgJson.exports && pkgJson.exports["./browser-classify"]) {
      const expPath = pkgJson.exports["./browser-classify"].import || pkgJson.exports["./browser-classify"];
      const resolved = resolve(rootDir, expPath);
      if (existsSync(resolved)) return resolved;
    }
  } catch {
    // ignore
  }

  return null;
}

async function build() {
  console.log("=== NNAnything Extension & Harness Builder ===");

  const foundationEntry = resolveFoundationEntry();
  if (!foundationEntry) {
    console.log(
      "\n[build:extension] PENDING INTEGRATION DEPENDENCY:\n" +
      "  The foundation module \"nnanything/browser-classify\" is currently being implemented\n" +
      "  by parent in the integration branch (/Volumes/Intel/playground/nnanything/browser-overlay).\n" +
      "  In accordance with project contracts, this branch codes strictly against the fixed API\n" +
      "  without fake fallback mocks. Full bundling will execute once parent merges foundation.\n"
    );
    return;
  }

  console.log(`[build:extension] Using foundation entry: ${foundationEntry}`);

  ensureDir(extensionDistDir);
  ensureDir(harnessDistDir);

  const foundationPlugin = {
    name: "foundation-resolver",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^nnanything\/browser-classify$/ }, () => {
        return { path: foundationEntry };
      });
    },
  };

  const commonOptions = {
    bundle: true,
    platform: "browser",
    target: ["chrome110", "es2022"],
    sourcemap: true,
    plugins: [foundationPlugin],
  };

  console.log("Building extension background service worker...");
  await esbuild.build({
    ...commonOptions,
    entryPoints: [resolve(rootDir, "extension/background.ts")],
    outfile: resolve(extensionDistDir, "background.js"),
    format: "iife",
  });

  console.log("Building extension content script...");
  await esbuild.build({
    ...commonOptions,
    entryPoints: [resolve(rootDir, "extension/content.ts")],
    outfile: resolve(extensionDistDir, "content.js"),
    format: "iife",
  });

  console.log("Copying extension manifest...");
  copyFileSync(
    resolve(rootDir, "extension/manifest.json"),
    resolve(extensionDistDir, "manifest.json")
  );

  console.log("Building harness bundle...");
  await esbuild.build({
    ...commonOptions,
    entryPoints: [resolve(rootDir, "playground/overlay/harness.ts")],
    outfile: resolve(harnessDistDir, "harness.js"),
    format: "iife",
  });

  console.log("Copying harness assets...");
  copyFileSync(
    resolve(rootDir, "playground/overlay/index.html"),
    resolve(harnessDistDir, "index.html")
  );
  copyFileSync(
    resolve(rootDir, "playground/overlay/style.css"),
    resolve(harnessDistDir, "style.css")
  );

  console.log("\n[build:extension] Build complete!");
  console.log(`  Extension artifact: ${extensionDistDir}`);
  console.log(`  Harness artifact:   ${harnessDistDir}`);
}

build().catch((err) => {
  console.error("[build:extension] Build error:", err);
  process.exit(1);
});
