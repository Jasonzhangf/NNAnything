import { readEntryInspectRequest, readEntrySnapshot, toObservedEntrySnapshot } from "./entry-inspection.js";

function writeFailure(error: unknown): void {
  const candidate = error !== null && (typeof error === "object" || typeof error === "function") && "code" in error
    ? String(error.code)
    : "EINVAL";
  const errno = candidate && candidate !== "undefined" ? candidate : "EINVAL";
  process.stderr.write(`${JSON.stringify({
    ok: false,
    errno,
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "entry.inspect") {
    throw Object.assign(new TypeError("Usage: entry-inspect-helper.js entry.inspect < typed-json-stdin"), { code: "EINVAL" });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const request = readEntryInspectRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const snapshot = await readEntrySnapshot(request.absolutePath, request.followSymlinks);
  if (snapshot.errno !== null && snapshot.errno !== "ENOENT") {
    throw Object.assign(new Error(`Entry inspection failed with ${snapshot.errno}`), { code: snapshot.errno });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, snapshot: toObservedEntrySnapshot(snapshot) })}\n`);
}

main().catch(writeFailure);
