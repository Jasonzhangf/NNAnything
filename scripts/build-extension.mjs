import { mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const path = (relative) => decodeURIComponent(new URL(relative, root).pathname);
for (const dir of ["artifacts/chrome-extension", "artifacts/overlay-harness"]) {
  await mkdir(path(dir), { recursive: true });
}
for (const [entry, output] of [
  ["extension/background.ts", "artifacts/chrome-extension/background.js"],
  ["extension/content.ts", "artifacts/chrome-extension/content.js"],
  ["playground/overlay/harness.ts", "artifacts/overlay-harness/harness.js"],
  ["playground/overlay/foreground-harness.ts", "artifacts/overlay-harness/foreground-harness.js"],
]) {
  await build({ entryPoints: [path(entry)], outfile: path(output), bundle: true,
    platform: "browser", target: "chrome110", format: "iife", sourcemap: true });
}
for (const [source, target] of [
  ["extension/manifest.json", "artifacts/chrome-extension/manifest.json"],
  ["playground/overlay/index.html", "artifacts/overlay-harness/index.html"],
  ["playground/overlay/style.css", "artifacts/overlay-harness/style.css"],
  ["playground/overlay/foreground.html", "artifacts/overlay-harness/foreground.html"],
  ["playground/overlay/foreground.css", "artifacts/overlay-harness/foreground.css"],
]) await copyFile(path(source), path(target));
console.log("Built artifacts/chrome-extension and artifacts/overlay-harness");
