// Focused regression for the CD-1 text-hit expansion contract. The secondary
// file.read is injected as a failed receipt so the failure branch is exercised
// deterministically without changing the public call-depth entry.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expandTextHit,
  recordTextExpansionFailure,
  textCoverageStatus,
} from "../dist/adapters/cli/call-depth-text.js";

function hit() {
  return {
    kind: "current_hit",
    historical: false,
    identityKey: { path: "/repo/src/partial.ts", dev: 1, ino: 2, size: 12, sessionRevision: 0 },
    fileRef: {
      kind: "cli.file",
      scenarioId: "scenario",
      sessionId: "session",
      type: "regular",
      identity: { dev: 1, ino: 2 },
      sourceRun: "run-search",
      sessionRevision: 0,
      absolutePath: "/repo/src/partial.ts",
    },
    path: "/repo/src/partial.ts",
    needle: "entry",
    byteSpan: { start: 0, end: 5 },
    line: 1,
    column: 1,
    size: 12,
    bytesRead: 12,
    scanComplete: true,
  };
}

function failedReadSandbox() {
  return {
    async execute(call) {
      return {
        call,
        status: "failed",
        session_before: null,
        session_after: null,
        execution: {
          status: "failed",
          runId: "run-failed",
          executorInvoked: false,
          error: { operation: "file.read", stage: "observe", code: "EIO", message: "simulated read failure" },
        },
      };
    },
  };
}

test("secondary read failure retains the fallback candidate and reports the failure", async () => {
  const expansion = await expandTextHit("/repo", hit(), failedReadSandbox());
  assert.equal(expansion.candidates.length, 1);
  assert.equal(expansion.candidates[0].filePath, "src/partial.ts");
  assert.equal(expansion.candidates[0].matchedNeedle, "entry");
  assert.equal(expansion.candidates[0].preview, "");
  assert.notEqual(expansion.failure, null);
  assert.equal(expansion.failure.filePath, "src/partial.ts");
  assert.match(expansion.failure.message, /src\/partial\.ts:EIO/);
});

test("expansion failure marks coverage partial and appends the failed path", () => {
  const errors = [];
  const unreadFiles = [];
  const complete = recordTextExpansionFailure(
    true,
    errors,
    unreadFiles,
    { filePath: "src/partial.ts", message: "src/partial.ts:EIO" },
  );
  assert.equal(complete, false);
  assert.deepEqual(errors, ["src/partial.ts:EIO"]);
  assert.deepEqual(unreadFiles, ["src/partial.ts"]);
  assert.equal(textCoverageStatus(complete, true), "partial");
});

test("expansion failure without any successful search is failed coverage", () => {
  const errors = [];
  const unreadFiles = [];
  const complete = recordTextExpansionFailure(
    true,
    errors,
    unreadFiles,
    { filePath: "src/partial.ts", message: "src/partial.ts:EIO" },
  );
  assert.equal(textCoverageStatus(complete, false), "failed");
});
