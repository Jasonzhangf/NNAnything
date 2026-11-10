import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runTsJsSymbolTable } from "../dist/adapters/cli/tsjs-symbol-table-adapter.js";
import { loadStepwiseEpisodeFamily } from "../dist/training/unified-student-converter.js";
import {
  loadTsJsRequestAwareAdmissionConfig,
  runTsJsRequestAwareAdmission,
  TsJsRequestAwareAdmissionError,
  TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA,
  TSJS_REQUEST_AWARE_ADMISSION_RECEIPT_SCHEMA,
  TSJS_OBSERVED_SOURCE_CLOSURE_CONTRACT,
} from "../dist/training/tsjs-request-aware-admission.js";

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, "..");
const CONFIG_PATH = resolve(
  here,
  "fixtures/tsjs-request-aware-admission-config-r1-20261110/request-aware-admission.json",
);

async function loadConfig() {
  return loadTsJsRequestAwareAdmissionConfig(CONFIG_PATH);
}

function mutateCase(config, index, patch) {
  const copy = structuredClone(config);
  copy.cases[index] = { ...copy.cases[index], ...patch };
  return copy;
}

test("loads the accepted clean DEV recipe and admits both cases through the public entry", async () => {
  const config = await loadConfig();
  assert.equal(config.schema, TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA);
  assert.equal(config.family.acceptedFamily, "a650492/94c1d81");
  assert.ok(config.family.familyRoot.endsWith("dev-runtime-helper-selector-clean-r1-20261110"));
  assert.deepEqual(config.family.acceptedRequestRefs, ["request:dv-c01", "request:dv-c02"]);
  assert.equal(config.cases.length, 2);

  const receipt = await runTsJsRequestAwareAdmission(config);
  assert.equal(receipt.schema, TSJS_REQUEST_AWARE_ADMISSION_RECEIPT_SCHEMA);
  assert.equal(receipt.admitted, true);
  assert.deepEqual(receipt.cases.map(entry => entry.caseId), ["dv-c01", "dv-c02"]);
  for (const entry of receipt.cases) {
    assert.equal(entry.admitted, true);
    assert.equal(entry.rejection, null);
    assert.equal(entry.coverageContract, TSJS_OBSERVED_SOURCE_CLOSURE_CONTRACT);
    assert.ok(entry.admittedEvidenceRefs.includes(entry.sourceReadRef));
    assert.equal(entry.workState.remainingObligationCount, 0);
    assert.equal(entry.workState.cursorState, "closed");
    assert.ok(entry.workState.basis.length > 0);
  }
  assert.ok(receipt.derivedOutput);
  assert.equal(receipt.derivedOutput.recordCount, 2);
  const derivedEpisodes = await loadStepwiseEpisodeFamily(receipt.derivedOutput.dir);
  assert.deepEqual(derivedEpisodes.map(episode => episode.sampleId), ["dv-c01", "dv-c02"]);
  const admissions = JSON.parse(await readFile(receipt.derivedOutput.admissionsPath, "utf8"));
  assert.deepEqual(admissions.familyAdmissions, [{
    sourceGroup: config.family.derivedSourceGroup,
    partition: "DEV",
    usableForTrainingSupervision: false,
  }]);
  const consumerInputs = JSON.parse(await readFile(receipt.derivedOutput.consumerInputsPath, "utf8"));
  assert.equal(consumerInputs.consumerEntry, "loadStepwiseEpisodeFamily");
  assert.equal(consumerInputs.devFamilyPath, receipt.derivedOutput.dir);
  assert.equal(consumerInputs.partition, "DEV");
});

test("rejects a request that is not in the accepted family request set", async () => {
  const config = mutateCase(await loadConfig(), 0, { requestRef: "request:rogue" });
  const receipt = await runTsJsRequestAwareAdmission(config);
  assert.equal(receipt.admitted, false);
  assert.equal(receipt.cases[0].admitted, false);
  assert.equal(receipt.cases[0].rejection.code, "request_not_accepted");
});

test("rejects an observation whose declared call site does not exist", async () => {
  const config = mutateCase(await loadConfig(), 0, {
    callSiteRef: "call:src/dv-c01-direct.ts@99:1-99:2",
  });
  const receipt = await runTsJsRequestAwareAdmission(config);
  assert.equal(receipt.cases[0].admitted, false);
  assert.equal(receipt.cases[0].rejection.code, "call_site_mismatch");
});

test("rejects a wrong source-read binding", async () => {
  const config = mutateCase(await loadConfig(), 0, {
    sourceReadRef: "source-read:call:src/elsewhere.ts@1:1-1:2",
  });
  const receipt = await runTsJsRequestAwareAdmission(config);
  assert.equal(receipt.cases[0].admitted, false);
  assert.equal(receipt.cases[0].rejection.code, "source_read_mismatch");
});

test("rejects a wrong requested role through the observed completion assessment", async () => {
  const config = mutateCase(await loadConfig(), 0, { requestedRole: "local" });
  const receipt = await runTsJsRequestAwareAdmission(config);
  assert.equal(receipt.cases[0].admitted, false);
  assert.equal(receipt.cases[0].rejection.code, "role_mismatch");
  assert.ok(receipt.cases[0].rejection.reasons.includes("requested_target_mapping_invalid"));
});

test("rejects a request whose completion contract does not match the admitted family", async () => {
  const config = mutateCase(await loadConfig(), 0, {
    coverageContract: "tsjs.unknown.closure.v1",
  });
  const receipt = await runTsJsRequestAwareAdmission(config);
  assert.equal(receipt.cases[0].admitted, false);
  assert.equal(receipt.cases[0].rejection.code, "coverage_mismatch");
});

test("rejects a case that omits work state instead of defaulting it to closed", async () => {
  const config = structuredClone(await loadConfig());
  delete config.cases[0].workState;
  const receipt = await runTsJsRequestAwareAdmission(config);
  assert.equal(receipt.cases[0].admitted, false);
  assert.equal(receipt.cases[0].rejection.code, "work_state_missing");
  assert.equal(receipt.cases[0].workState, null);
});

test("preserves explicit open work obligations instead of silently closing them", async () => {
  const config = mutateCase(await loadConfig(), 0, {
    workState: {
      basis: "public open-work control",
      remainingObligations: [
        {
          kind: "observe",
          ref: "obligation:open",
          pendingRelationRef: "relation:dv-c01",
          targetRef: null,
          informationGain: 0.5,
        },
      ],
      localCandidateCursor: {
        pendingRelationRef: "relation:dv-c01",
        state: "open",
        evidenceRefs: ["obligation:open"],
      },
    },
  });
  const receipt = await runTsJsRequestAwareAdmission(config);
  assert.equal(receipt.cases[0].admitted, false);
  assert.equal(receipt.cases[0].workState.remainingObligationCount, 1);
  assert.equal(receipt.cases[0].workState.cursorState, "open");
  assert.equal(receipt.cases[0].rejection.code, "work_state_open");
});

test("the config loader rejects malformed recipes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsjs-admission-config-"));
  try {
    const badSchema = join(dir, "bad-schema.json");
    await writeFile(badSchema, JSON.stringify({ schema: "wrong", family: {}, cases: [] }));
    await assert.rejects(
      () => loadTsJsRequestAwareAdmissionConfig(badSchema),
      (error) => error instanceof TsJsRequestAwareAdmissionError,
    );
    const missingFamily = join(dir, "missing-family.json");
    await writeFile(missingFamily, JSON.stringify({
      schema: TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA,
      cases: [],
    }));
    await assert.rejects(
      () => loadTsJsRequestAwareAdmissionConfig(missingFamily),
      (error) => error instanceof TsJsRequestAwareAdmissionError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the entry is family-agnostic and keeps other-source behavior", async () => {
  const repo = await mkdtemp(join(tmpdir(), "tsjs-admission-other-"));
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/helper.ts"), `const table = {
  a: (x: string) => x,
  b: (x: string) => x + "!",
};
export function pick(k: "a" | "b") {
  return table[k];
}
`);
    await writeFile(join(repo, "src/caller.ts"), `import { pick } from "./helper.js";
export function run(k: "a" | "b", x: string) {
  return pick(k)(x);
}
`);
    const producer = await runTsJsSymbolTable({
      repo,
      language: "typescript",
      scope: ["src"],
      files: ["src/caller.ts", "src/helper.ts"],
    });
    assert.equal(producer.status, "ok");
    const observation = producer.result.runtimeSelectorObservations[0];
    assert.ok(observation);
    const config = {
      schema: TSJS_REQUEST_AWARE_ADMISSION_CONFIG_SCHEMA,
      family: {
        familyRoot: repo,
        derivedOutputDir: null,
        sourceGroup: "tsjs-other-source",
        derivedSourceGroup: "tsjs-other-source-derived-dev",
        partition: "DEV",
        acceptedFamily: "other-source",
        acceptedRequestRefs: ["request:other"],
      },
      cases: [
        {
          caseId: "other-c01",
          entryFile: "src/caller.ts",
          files: ["src/caller.ts", "src/helper.ts"],
          requestRef: "request:other",
          pendingRelationRef: "relation:other",
          callSiteRef: observation.callSiteRef,
          sourceReadRef: observation.sourceReadRef,
          calleeName: "pick",
          requestedMemberName: "a",
          requestedRole: "member",
          stepId: "step:0",
          coverageContract: TSJS_OBSERVED_SOURCE_CLOSURE_CONTRACT,
          workState: {
            basis: "finite source-local observed-source completion",
            remainingObligations: [],
            localCandidateCursor: {
              pendingRelationRef: "relation:other",
              state: "closed",
              evidenceRefs: [],
            },
          },
        },
      ],
    };
    const receipt = await runTsJsRequestAwareAdmission(config);
    assert.equal(receipt.admitted, true);
    assert.equal(receipt.cases[0].admitted, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
