import {
  ENTRY_METADATA_OPERATIONS,
  applyEntryMetadataRequest,
  readEntryMetadataRequest,
  type EntryMetadataOperation,
} from "./entry-metadata.js";

function writeFailure(error: unknown): void {
  const candidate = error !== null && (typeof error === "object" || typeof error === "function") && "code" in error
    ? String((error as { code?: unknown }).code)
    : "EINVAL";
  const errno = candidate && candidate !== "undefined" ? candidate : "EINVAL";
  process.stderr.write(`${JSON.stringify({
    ok: false,
    errno,
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}

function requireOperation(value: string | undefined): EntryMetadataOperation {
  if (value === undefined || !ENTRY_METADATA_OPERATIONS.includes(value as EntryMetadataOperation)) {
    throw Object.assign(new TypeError("Usage: entry-metadata-helper.js <entry.mode.set|entry.owner.set|entry.times.set> < typed-json-stdin"), { code: "EINVAL" });
  }
  return value as EntryMetadataOperation;
}

async function main(): Promise<void> {
  const operation = requireOperation(process.argv[2]);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const request = readEntryMetadataRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (request.operation !== operation) {
    throw Object.assign(new TypeError(`argv operation ${operation} does not match request ${request.operation}`), { code: "EINVAL" });
  }
  const result = await applyEntryMetadataRequest(request);
  if (!result.ok) {
    throw Object.assign(new Error(result.message), { code: result.code });
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    beforeSnapshot: result.beforeSnapshot,
    afterSnapshot: result.afterSnapshot,
  })}\n`);
}

main().catch(writeFailure);
