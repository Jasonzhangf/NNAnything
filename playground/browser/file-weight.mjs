import { readFile, rename, rm, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_BASIC_KIND_CONFIG,
  DEFAULT_BASIC_KIND_PROFILE,
  checkCandidates,
  classifyBrowserBasicKinds,
  createFocusSpec,
  observeCandidates,
  splitCandidates,
} from "nnanything/browser-classify";

const viewport = { x: 0, y: 0, width: 800, height: 600 };
const rect = { x: 10, y: 10, width: 120, height: 40 };

function weightAsset(familyWeight) {
  const profile = structuredClone(DEFAULT_BASIC_KIND_PROFILE);
  profile.familyWeights.control.nat_control_button = familyWeight;
  return {
    targetOperator: "dom.basic_kinds",
    operatorVersion: "0.1.0",
    contractVersion: 1,
    taskId: "dom.basic-kinds.v1",
    profileId: profile.id,
    baseProfileId: profile.id,
    calibrated: false,
    compatibility: {
      taskId: DEFAULT_BASIC_KIND_CONFIG.taskId,
      minScore: DEFAULT_BASIC_KIND_CONFIG.minScore,
      minMargin: DEFAULT_BASIC_KIND_CONFIG.minMargin,
    },
    profile,
  };
}

function classificationInput() {
  const observation = {
    viewport,
    nodes: [{
      nodeRef: "target",
      parentRef: null,
      tag: "button",
      role: null,
      rect,
      fragments: [rect],
      clippedRect: rect,
      attributes: {},
    }],
    coverage: {
      geometry: "assessed",
      fragments: "assessed",
      clipping: "assessed",
    },
  };
  const candidates = splitCandidates(observeCandidates({ observation }));
  return checkCandidates(candidates, createFocusSpec());
}

function resultSummary(batch) {
  const slot = batch.slots[0];
  return {
    profileId: batch.profileId,
    nodeRef: slot?.nodeRef,
    judgmentStatus: slot?.judgmentStatus,
    basicKind: slot?.basicKind,
    score: slot?.score,
  };
}

async function writeAtomic(filePath, text) {
  const temporaryPath = `${filePath}.next`;
  await writeFile(temporaryPath, text, "utf8");
  await rename(temporaryPath, filePath);
}

async function rejects(action) {
  try {
    await action();
  } catch {
    return true;
  }
  return false;
}

export async function verifyFileWeightLifecycle(tempDir) {
  await mkdir(tempDir, { recursive: true });
  const weightPath = join(tempDir, "file-weight-fixture.json");
  const sourceOnce = {
    sourceLabel: basename(weightPath),
    readText: () => readFile(weightPath, "utf8"),
  };
  const options = { weightFile: sourceOnce };
  const input = classificationInput();
  const assetA = weightAsset(1);
  const assetB = weightAsset(0.3);

  await writeAtomic(weightPath, JSON.stringify(assetA));
  const firstResult = resultSummary(await classifyBrowserBasicKinds(input, options));

  await writeFile(weightPath, JSON.stringify(assetB), "utf8");
  const secondResult = resultSummary(await classifyBrowserBasicKinds(input, options));

  await writeAtomic(weightPath, JSON.stringify(assetA));
  const atomicRestoredResult = resultSummary(await classifyBrowserBasicKinds(input, options));

  await writeFile(weightPath, "{", "utf8");
  const malformedRejected = await rejects(() => classifyBrowserBasicKinds(input, options));

  const incompatible = structuredClone(assetA);
  incompatible.targetOperator = "not.dom.basic_kinds";
  await writeFile(weightPath, JSON.stringify(incompatible), "utf8");
  const incompatibleRejected = await rejects(() => classifyBrowserBasicKinds(input, options));

  await rm(weightPath);
  const deletedRejected = await rejects(() => classifyBrowserBasicKinds(input, options));

  await writeAtomic(weightPath, JSON.stringify(assetA));
  const restoredResult = resultSummary(await classifyBrowserBasicKinds(input, options));

  return {
    sameProfileId: firstResult.profileId === secondResult.profileId,
    firstResult,
    secondResult,
    restoredEqualsFirst: JSON.stringify(atomicRestoredResult) === JSON.stringify(firstResult),
    malformedRejected,
    incompatibleRejected,
    deletedRejected,
    restoredResult,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const suppliedDir = process.argv[2];
  const tempDir = suppliedDir ?? await mkdtemp(join(tmpdir(), "nnanything-file-weight-"));
  const result = await verifyFileWeightLifecycle(tempDir);
  if (suppliedDir === undefined) await rm(tempDir, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
}
