import {
  ENTRY_MUTATION_OPERATIONS,
  executeEntryMutation,
  readEntryMutationRequest,
} from "./entry-mutation.js";

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
  if (process.argv.length !== 3
    || !ENTRY_MUTATION_OPERATIONS.includes(process.argv[2] as typeof ENTRY_MUTATION_OPERATIONS[number])) {
    throw Object.assign(new TypeError("Usage: entry-mutation-helper.js <operation> < typed-json-stdin"), {
      code: "EINVAL",
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const request = readEntryMutationRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (request.operation !== process.argv[2]) {
    throw Object.assign(new TypeError("Entry mutation operation does not match the helper argument"), {
      code: "EINVAL",
    });
  }
  const receipt = await executeEntryMutation(request);
  process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
}

main().catch(writeFailure);
