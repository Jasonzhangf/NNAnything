import { readFile, writeFile } from "node:fs/promises";
import { extractTrainingRequestFromBundle } from "nnanything/browser-classify";

const [inputFlag, input, outputFlag, output, ...extra] = process.argv.slice(2);
if (inputFlag !== "--input" || !input || outputFlag !== "--out" || !output || extra.length) {
  throw new Error("Usage: node playground/overlay/extract-training.mjs --input <bundle.json> --out <new-request.json>");
}
const request = extractTrainingRequestFromBundle(JSON.parse(await readFile(input, "utf8")));
await writeFile(output, JSON.stringify(request, null, 2), { flag: "wx" });
console.log(`Extracted ${request.rows.length} rows to ${output}`);
