import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DEFAULT_OLD_DEV_FAMILY_ROOT,
  DEFAULT_OLD_DEV_REQUEST_SOURCE,
  generateOldDevStepwise,
} from "../playground/training/carol-r2-stepwise-corpus/generate-fixed-stepwise.mjs";
import {
  FIXED_STEPWISE_STUDENT_SCHEMA,
  loadStepwiseEpisodeFamily,
} from "../dist/training/unified-student-converter.js";
import { loadGoldFamily } from "../dist/training/unified-supervision-converter.js";
import { assertStudentInputIsolated } from "../dist/training/unified-runner-evaluate.js";

const EXPECTED_SAMPLE_IDS = [
  "c-dev-negative-same-name-other",
  "c-dev-positive-factory-call",
  "c-dev-unknown-dynamic-property",
];

async function readJsonl(file) {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function makeFamilyCopy() {
  const root = await mkdtemp(join(tmpdir(), "tsjs-old-dev-producer-"));
  const familyRoot = join(root, "dev-closure-shadow-b");
  await cp(DEFAULT_OLD_DEV_FAMILY_ROOT, familyRoot, { recursive: true });
  return { root, familyRoot };
}

async function runGenerator(familyRoot, root, requestSource = DEFAULT_OLD_DEV_REQUEST_SOURCE) {
  return generateOldDevStepwise({
    familyRoot,
    requestSource,
    outDir: familyRoot,
    receiptPath: join(root, "control-receipts.json"),
  });
}

async function mutateSource(familyRoot, relativePath, mutate) {
  const file = join(familyRoot, relativePath);
  const before = await readFile(file, "utf8");
  await writeFile(file, mutate(before), "utf8");
}

test("generates the three old DEV rows from AST-derived direct and computed bindings", async () => {
  const { root, familyRoot } = await makeFamilyCopy();
  const result = await runGenerator(familyRoot, root);
  const rows = await readJsonl(join(familyRoot, "student-observations.jsonl"));

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.sampleId).sort(),
    EXPECTED_SAMPLE_IDS,
  );
  assert.equal(rows.every((row) => row.schemaVersion === FIXED_STEPWISE_STUDENT_SCHEMA), true);
  assert.equal(rows.every((row) => row.partition === "dev"), true);
  assert.equal(rows.some((row) => /"gold"|"A_g"|"teacher"|"oracle"/i.test(JSON.stringify(row))), false);

  const controls = new Map(
    result.controlReceipts.controls.map((control) => [control.sampleId, control]),
  );
  const positive = controls.get("c-dev-positive-factory-call");
  const other = controls.get("c-dev-negative-same-name-other");
  const dynamic = controls.get("c-dev-unknown-dynamic-property");
  assert.equal(positive.shape, "direct-import");
  assert.equal(
    positive.observedTerminalDeclarationRef,
    "decl:sources/src/factory.ts#top:createStepper",
  );
  assert.equal(other.shape, "direct-import");
  assert.equal(
    other.requestedDeclarationRef,
    "decl:sources/src/alternate.ts#top:createStepper",
  );
  assert.equal(
    other.observedTerminalDeclarationRef,
    "decl:sources/src/factory.ts#top:createStepper",
  );
  assert.equal(other.requestTargetRead, false);
  assert.equal(other.readFiles.includes("sources/src/alternate.ts"), false);
  assert.equal(dynamic.shape, "local-table-computed");
  assert.equal(
    dynamic.observedTerminalDeclarationRef,
    "decl:sources/src/factory.ts#top:createStepper",
  );
  assert.equal(dynamic.readFiles.includes("sources/src/factory.ts"), true);

  const episodes = await loadStepwiseEpisodeFamily(familyRoot);
  await assertStudentInputIsolated(familyRoot);
  assert.deepEqual(
    [...new Set(episodes.map((episode) => episode.sampleId))].sort(),
    EXPECTED_SAMPLE_IDS,
  );
  assert.equal(episodes.length, 7);
  const gold = await loadGoldFamily(familyRoot);
  assert.deepEqual(
    gold.map((row) => row.sampleId).sort(),
    EXPECTED_SAMPLE_IDS,
  );
});

test("the fixed consumer-facing artifact excludes supervision-only fields", async () => {
  const { root, familyRoot } = await makeFamilyCopy();
  await runGenerator(familyRoot, root);
  const source = await readFile(join(familyRoot, "student-observations.jsonl"), "utf8");
  assert.doesNotMatch(source, /"(?:A_g|S_g|gold|teacher|oracle|originalLabel|unknownReason)"/);
});

test("rejects missing, renamed, mismatched and ambiguous direct or table bindings", async () => {
  const cases = [
    {
      name: "missing import module",
      apply: (familyRoot) =>
        mutateSource(familyRoot, "sources/src/entry-known.ts", (text) =>
          text.replace('from "./factory"', 'from "./missing"'),
        ),
    },
    {
      name: "renamed imported local",
      apply: (familyRoot) =>
        mutateSource(familyRoot, "sources/src/entry-known.ts", (text) =>
          text.replace("import { createStepper }", "import { createStepper as renamed }"),
        ),
    },
    {
      name: "renamed table member",
      apply: (familyRoot) =>
        mutateSource(familyRoot, "sources/src/entry-dynamic.ts", (text) =>
          text.replace("{ createStepper }", "{ other }"),
        ),
    },
    {
      name: "wrong folded key",
      apply: (familyRoot) =>
        mutateSource(familyRoot, "sources/src/entry-dynamic.ts", (text) =>
          text.replace('"create" + "Stepper"', '"create" + "Other"'),
        ),
    },
    {
      name: "non-literal table initializer",
      apply: (familyRoot) =>
        mutateSource(familyRoot, "sources/src/entry-dynamic.ts", (text) =>
          text.replace("= { createStepper };", "= undefined;"),
        ),
    },
    {
      name: "duplicate import binding",
      apply: (familyRoot) =>
        mutateSource(familyRoot, "sources/src/entry-known.ts", (text) =>
          `import { createStepper } from "./factory";\n${text}`,
        ),
    },
  ];

  for (const item of cases) {
    const { root, familyRoot } = await makeFamilyCopy();
    await item.apply(familyRoot);
    await assert.rejects(
      runGenerator(familyRoot, root),
      /not observed|ambiguous|unsupported|failed|missing|no supported/i,
      item.name,
    );
  }
});

test("preserves an alternate real binding while keeping the factory request", async () => {
  const { root, familyRoot } = await makeFamilyCopy();
  await mutateSource(familyRoot, "sources/src/entry-known.ts", (text) =>
    text.replace('from "./factory"', 'from "./alternate"'),
  );
  const requestRows = JSON.parse(await readFile(DEFAULT_OLD_DEV_REQUEST_SOURCE, "utf8"));
  const row = requestRows.find((entry) => entry.sampleId === "c-dev-negative-same-name-other");
  row.request.requestedDeclaration = {
    declarationRef: {
      state: "known",
      value: "decl:sources/src/factory.ts#top:createStepper",
      reason: null,
      evidenceRefs: [],
    },
    moduleRef: {
      state: "known",
      value: "mod:sources/src/factory.ts",
      reason: null,
      evidenceRefs: [],
    },
    name: { state: "known", value: "createStepper", reason: null, evidenceRefs: [] },
    kind: { state: "known", value: "function", reason: null, evidenceRefs: [] },
    sourceTargetRef: "sources/src/factory.ts#top:createStepper",
  };
  const requestSource = join(root, "alternate-binding-requests.json");
  await writeFile(requestSource, `${JSON.stringify(requestRows, null, 2)}\n`, "utf8");

  const result = await runGenerator(familyRoot, root, requestSource);
  const control = result.controlReceipts.controls.find(
    (entry) => entry.sampleId === "c-dev-negative-same-name-other",
  );
  assert.equal(
    control.requestedDeclarationRef,
    "decl:sources/src/factory.ts#top:createStepper",
  );
  assert.equal(
    control.observedTerminalDeclarationRef,
    "decl:sources/src/alternate.ts#top:createStepper",
  );
  assert.equal(control.requestTargetRead, false);
  assert.equal(control.readFiles.includes("sources/src/alternate.ts"), true);
  assert.equal(control.readFiles.includes("sources/src/factory.ts"), false);
});

test("does not read the real verification family", async () => {
  const { root, familyRoot } = await makeFamilyCopy();
  const result = await runGenerator(familyRoot, root);
  const readFiles = result.controlReceipts.controls.flatMap((control) => control.readFiles);
  assert.equal(readFiles.some((file) => file.includes("verification")), false);
  assert.equal(resolve(familyRoot).includes("dev-closure-shadow-b"), true);
});
