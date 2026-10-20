import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export async function buildBrowserSingleActionCollectorSource() {
  const globalName = "__singleActionCollectorBundle";
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./collector-entry.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName,
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const bundle = result.outputFiles[0].text.trimEnd();
  return Object.freeze({
    format: "callable-expression",
    exportName: "collectBrowserSingleAction",
    // The named export is retained inside the outer function scope, so the
    // bundle can be evaluated read-only without writing a page global.
    source: `(() => {\n${bundle}\nreturn ${globalName}.collectBrowserSingleAction;\n})()`,
  });
}
