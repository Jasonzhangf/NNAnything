import { mkdir, copyFile, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { parseBrowserWeightAsset } from "../dist/browser-classify.js";

const root = new URL("../", import.meta.url);
const path = (relative) => decodeURIComponent(new URL(relative, root).pathname);

const { values } = parseArgs({
  options: {
    "weight-file": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

let initialWeight;
let weightFile;
if (values["weight-file"] !== undefined) {
  weightFile = resolve(values["weight-file"]);
  try {
    const raw = await readFile(weightFile, "utf8");
    initialWeight = parseBrowserWeightAsset(raw, basename(weightFile));
  } catch (error) {
    throw new Error(
      `Cannot load --weight-file ${weightFile}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

for (const dir of ["artifacts/chrome-extension", "artifacts/overlay-harness"]) {
  await mkdir(path(dir), { recursive: true });
}
for (const [entry, output] of [
  ["extension/background.ts", "artifacts/chrome-extension/background.js"],
  ["extension/content.ts", "artifacts/chrome-extension/content.js"],
  ["playground/overlay/harness.ts", "artifacts/overlay-harness/harness.js"],
  ["playground/overlay/foreground-harness.ts", "artifacts/overlay-harness/foreground-harness.js"],
  ["playground/overlay/refresh-harness.ts", "artifacts/overlay-harness/refresh-harness.js"],
]) {
  const options = {
    entryPoints: [path(entry)], outfile: path(output), bundle: true,
    platform: "browser", target: "chrome110", format: "iife", sourcemap: true,
  };
  if (entry === "extension/content.ts") {
    options.define = {
      __NNANYTHING_BROWSER_WEIGHT_ASSET__: initialWeight === undefined ? "undefined" : JSON.stringify(initialWeight),
    };
  }
  await build(options);
}
for (const [source, target] of [
  ["extension/manifest.json", "artifacts/chrome-extension/manifest.json"],
  ["playground/overlay/index.html", "artifacts/overlay-harness/index.html"],
  ["playground/overlay/style.css", "artifacts/overlay-harness/style.css"],
  ["playground/overlay/foreground.html", "artifacts/overlay-harness/foreground.html"],
  ["playground/overlay/foreground.css", "artifacts/overlay-harness/foreground.css"],
  ["playground/overlay/refresh.html", "artifacts/overlay-harness/refresh.html"],
]) await copyFile(path(source), path(target));
console.log(
  initialWeight === undefined
    ? "Built artifacts/chrome-extension and artifacts/overlay-harness with handwritten baseline"
    : `Built artifacts/chrome-extension and artifacts/overlay-harness with weight file ${basename(weightFile)} (profile ${initialWeight.profile.id})`,
);
