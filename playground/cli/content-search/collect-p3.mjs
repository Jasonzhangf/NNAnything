import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertP3EpisodeOnDisk,
  createP3Injection,
  p3PartitionEpisodes,
  p3Request,
  p3SandboxRecipe,
  P3_PARTITIONS,
} from "./p3-recipe.mjs";
import { atomicStepViews, decisionExecutions } from "./p3-recovery.mjs";

const search = await import("nnanything/cli-content-search");
const policy = await import("nnanything/cli-goal");

const SCAN = Object.freeze({
  maxBytesPerFile: 256,
  maxTotalBytes: 4096,
  chunkSize: 64,
  maxDirectoryDepth: 0,
  maxStaleRetries: 1,
});
const LIMITS = Object.freeze({ maxTransitions: 256, maxDepth: 8, maxDerivedGoals: 64 });

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const runId = argument("run-id", `p3-collect-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const samplePath = resolve(argument("samples", join("training", "samples", "filesystem", "p3-content-search", runId, "samples.json")));
const receiptPath = resolve(argument("receipt", join("training", "results", "p3-content-search", runId, "collection.json")));
const partitionIds = argument("partitions", Object.keys(P3_PARTITIONS).join(",")).split(",");
const armKinds = argument("arms", "natural,forced").split(",");

const candidateProfilePath = process.env.NN_CLI_COMMAND_PROFILE;
if (typeof candidateProfilePath !== "string" || candidateProfilePath.length === 0) {
  throw new Error("NN_CLI_COMMAND_PROFILE must point at the saved 10x30 candidate to migrate to t0");
}
const sourceProfile = JSON.parse(await readFile(candidateProfilePath, "utf8"));
const t0Profile = policy.migrateCliCommandProfileV10x30(sourceProfile);
if (t0Profile.wires.length !== 31) throw new Error("migrated t0 profile must be 31-wire");

const NAME_COLUMN = t0Profile.wires.indexOf("search.nameNeedleSegment");
const slot0Name = episode => episode.names[0];

function latestState(response) {
  const states = response?.report?.states;
  return Array.isArray(states) && states.length > 0 ? states[states.length - 1]?.value ?? null : null;
}

function stateValueByRef(response, ref) {
  const states = response?.report?.states;
  if (!Array.isArray(states)) return null;
  const found = states.find(step => step?.value?.stateId === ref);
  return found?.value ?? null;
}

function feedbackObservation(episode, candidate) {
  if (candidate === undefined || candidate === null) return "not_triggered";
  if (episode.feedbackKind === "N") return candidate.scan?.complete && candidate.outcome === "negative" ? "complete_negative" : "incomplete";
  if (episode.feedbackKind === "S") return candidate.scan?.shortRead ? "short_read" : candidate.outcome === "unknown" ? "unknown" : "not_short";
  if (episode.feedbackKind === "E") return candidate.outcome === "read_error" ? "read_error" : "no_read_error";
  return candidate.scan?.complete && candidate.outcome === "negative" ? "partial_listing_then_negative" : "incomplete";
}

async function runArm(episode, arm, profileReference) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-p3-collect-")));
  const injection = createP3Injection(episode, episode.feedbackKind);
  const sandbox = await search.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: p3SandboxRecipe(episode),
    ...(injection.fileReadIo === undefined ? {} : { fileReadIo: injection.fileReadIo }),
    ...(injection.listingObserver === undefined ? {} : { listingObserver: injection.listingObserver }),
  });
  try {
    await assertP3EpisodeOnDisk(episode, sandbox.scenarioRoot, "pre-run");
    const session = sandbox.bindSession("s");
    const directory = await sandbox.bindDirectory(session, episode.scope);
    const decisions = [];
    const result = await search.runCliContentSearchGoal(
      p3Request(episode, directory, arm, "one"),
      {
        sandbox,
        session,
        profile: t0Profile,
        limits: LIMITS,
        scan: SCAN,
        order: arm === "forced" ? { kind: "injected-first", name: slot0Name(episode) } : { kind: "lexicographic" },
        onDecision: decision => { decisions.push(decision); },
      },
    );
    await assertP3EpisodeOnDisk(episode, sandbox.scenarioRoot, "post-run");
    const state = latestState(result.response);
    const candidates = Array.isArray(state?.candidates) ? state.candidates : [];
    const featureByName = new Map();
    for (const decision of decisions) {
      for (const candidate of decision.candidates) featureByName.set(candidate.name, candidate.features);
    }
    const slot0Candidate = candidates.find(candidate => candidate.name === episode.names[0]);
    const hits = candidates.filter(candidate => candidate.outcome === "matched" && candidate.scan?.found && !candidate.scan?.shortRead);
    const negatives = candidates.filter(candidate => candidate.outcome === "negative" && candidate.scan?.complete === true)
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const hit = hits.find(candidate => candidate.name === episode.names[episode.hitSlot]) ?? hits[0] ?? null;
    const other = negatives.find(candidate => candidate.name !== hit?.name && featureByName.has(candidate.name)) ?? null;
    const steps = atomicStepViews(result.response);
    const executionTrace = decisionExecutions(decisions, steps);
    const dispatchesOf = (name) => executionTrace
      .filter(decision => decision.selectedName === name)
      .flatMap(decision => decision.executions)
      .map(step => step.dispatchId);
    const pair = hit !== null && other !== null && featureByName.has(hit.name)
      ? {
          preferredName: hit.name,
          otherName: other.name,
          preferredFeatures: featureByName.get(hit.name),
          otherFeatures: featureByName.get(other.name),
          delta: featureByName.get(hit.name)[NAME_COLUMN] - featureByName.get(other.name)[NAME_COLUMN],
          evidenceRefs: [...dispatchesOf(hit.name), ...dispatchesOf(other.name)],
        }
      : null;
    return {
      episode,
      arm,
      decisions,
      steps,
      executionTrace,
      result,
      state,
      candidates,
      featureByName,
      pair,
      dispatchesOf,
      slot0Candidate,
      profileReference,
      injection,
    };
  } finally {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

const failures = [];
const arms = [];
const samples = [];
const preferenceRows = [];
const dispatches = new Map();
const states = new Map();

for (const partitionId of partitionIds) {
  for (const episode of p3PartitionEpisodes(partitionId)) {
    for (const arm of armKinds) {
      if (!["natural", "forced"].includes(arm)) throw new TypeError(`unknown arm ${arm}`);
      const profileReference = `${candidateProfilePath}#migrateCliCommandProfileV10x30`;
      const run = await runArm(episode, arm, profileReference);
      const domain = run.result.domain;
      const state = run.state;
      const firstSelected = run.decisions[0]?.selected?.name ?? null;
      const slot0 = run.slot0Candidate;
      const denominator = domain.denominators;
      const armReceipt = {
        partition: partitionId,
        scenarioId: episode.scenarioId,
        episode: episode.episode,
        semanticFamily: episode.semanticFamily,
        feedbackKind: episode.feedbackKind,
        arm,
        requestId: run.result.request.requestId,
        hitSlot: episode.hitSlot,
        hitName: episode.names[episode.hitSlot],
        status: domain.status,
        resolution: domain.resolution,
        satisfaction: domain.satisfaction,
        matches: domain.matches.map(match => match.path),
        negatives: domain.negatives.map(match => match.path),
        invocationCount: domain.invocationCount,
        observationCount: domain.observationCount,
        bytesReadTotal: domain.bytesReadTotal,
        duplicateReads: domain.duplicateReads,
        transitionsUsed: domain.budgetUsed?.transitionsUsed ?? null,
        derivedGoalsUsed: domain.budgetUsed?.derivedGoalsUsed ?? null,
        denominators: denominator,
        firstSelected,
        slot0SelectedFirst: firstSelected === episode.names[0],
        slot0Feedback: feedbackObservation(episode, slot0),
        slot0Outcome: slot0?.outcome ?? null,
        slot0FailureCode: slot0?.failureCode ?? null,
        injectionCounters: { ...run.injection.counters },
        decisionCount: run.decisions.length,
        preferencePair: run.pair,
        oracle: { before: true, after: true },
      };
      arms.push(armReceipt);

      // Recipe invariants for every arm. An EIO must become a read_error fact and
      // then recover through the legal later candidate; it must never terminate
      // the run or vanish from the evidence.
      if (domain.status !== "achieved") failures.push(`${episode.scenarioId}/${arm}: expected achieved, got ${domain.status}`);
      if (!domain.matches.some(match => match.path.endsWith(episode.names[episode.hitSlot]))) {
        failures.push(`${episode.scenarioId}/${arm}: expected hit ${episode.names[episode.hitSlot]}`);
      }
      if (episode.feedbackKind === "E" && (slot0?.outcome !== "read_error" || slot0?.failureCode !== "EIO")) {
        failures.push(`${episode.scenarioId}/${arm}: EIO slot 0 must stay read_error/EIO, got ${slot0?.outcome}/${slot0?.failureCode}`);
      }
      if (episode.feedbackKind === "S" && run.injection.counters.shortRead !== 1) {
        failures.push(`${episode.scenarioId}/${arm}: short read injection fired ${run.injection.counters.shortRead} times`);
      }
      if (episode.feedbackKind === "E" && run.injection.counters.eio !== 1) {
        failures.push(`${episode.scenarioId}/${arm}: EIO injection fired ${run.injection.counters.eio} times`);
      }
      if (episode.feedbackKind === "P") {
        if (run.injection.counters.listing !== 1) failures.push(`${episode.scenarioId}/${arm}: partial listing observer fired ${run.injection.counters.listing} times`);
        if (denominator.directoriesUncovered !== 1 || denominator.candidatesTotal !== 3) {
          failures.push(`${episode.scenarioId}/${arm}: partial listing denominators ${JSON.stringify(denominator)}`);
        }
      }
      if (episode.feedbackKind === "N" && slot0?.outcome !== "negative") {
        failures.push(`${episode.scenarioId}/${arm}: N slot 0 must be negative`);
      }
      if (episode.feedbackKind === "S" && slot0?.scan?.shortRead !== true) {
        failures.push(`${episode.scenarioId}/${arm}: S slot 0 must keep short_read`);
      }
      const negativeNames = new Set(domain.negatives.map(fact => fact.path.split("/").at(-1)));
      if (episode.feedbackKind === "S" && negativeNames.has(episode.names[0])) {
        failures.push(`${episode.scenarioId}/${arm}: short-read slot 0 must not become a proven negative`);
      }
      if (episode.feedbackKind === "E" && negativeNames.has(episode.names[0])) {
        failures.push(`${episode.scenarioId}/${arm}: EIO slot 0 must not become a proven negative`);
      }

      const preferencePair = partitionId === "train" && arm === "forced" && run.pair !== null && run.pair.delta !== 0
        ? run.pair
        : null;
      if (preferencePair !== null) {
        preferenceRows.push({
          id: `${episode.scenarioId}:forced:${run.pair.preferredName}~${run.pair.otherName}`,
          sourceGroup: episode.sourceGroup,
          partition: "train",
          preferredName: run.pair.preferredName,
          otherName: run.pair.otherName,
          preferredFeatures: [...run.pair.preferredFeatures],
          otherFeatures: [...run.pair.otherFeatures],
          evidenceRefs: run.pair.evidenceRefs,
        });
      }
      const slot0Name = episode.names[0];
      const slot0Decision = run.executionTrace.find(decision => decision.selectedName === slot0Name) ?? null;
      const slot0DispatchIds = slot0Decision === null ? [] : slot0Decision.executions.map(step => step.dispatchId);
      for (let index = 0; index < run.decisions.length; index += 1) {
        const decision = run.decisions[index];
        const executed = run.executionTrace[index]?.executions ?? [];
        const preStateRef = executed[0]?.stateBeforeRef ?? null;
        const postStateRef = executed[executed.length - 1]?.stateAfterRef ?? null;
        const invocationRefs = executed.map(step => step.dispatchId);
        const feedbackEvidenceRefs = decision.ordinal > (slot0Decision?.ordinal ?? -1) ? [...slot0DispatchIds] : [];
        for (const step of executed) {
          if (!dispatches.has(step.dispatchId)) {
            dispatches.set(step.dispatchId, {
              dispatchId: step.dispatchId,
              head: step.head,
              candidateName: step.candidateName,
              outcome: step.outcome,
              errorCode: step.errorCode,
              stateBeforeRef: step.stateBeforeRef,
              stateAfterRef: step.stateAfterRef,
            });
          }
        }
        for (const ref of [preStateRef, postStateRef]) {
          if (ref !== null && !states.has(ref)) states.set(ref, stateValueByRef(run.result.response, ref));
        }
        samples.push({
          sampleId: `${episode.scenarioId}:${arm}:decision-${decision.ordinal}`,
          sourceGroup: episode.sourceGroup,
          partition: partitionId,
          semanticFamily: episode.semanticFamily,
          episodeId: episode.scenarioId,
          requestId: run.result.request.requestId,
          decisionOrdinal: decision.ordinal,
          goal: run.result.request.goal,
          satisfactionThreshold: 100,
          profileReference,
          preStateRef,
          evidenceRefs: invocationRefs,
          candidateRefs: decision.candidates.map(candidate => candidate.name),
          featuresByCandidate: Object.fromEntries(decision.candidates.map(candidate => [candidate.name, [...candidate.features]])),
          selectedCandidateRef: decision.selected.name,
          experimentCondition: {
            kind: arm,
            forced: decision.forced,
            feedbackKind: episode.feedbackKind,
            injections: { ...run.injection.counters },
          },
          actualInvocationRefs: invocationRefs,
          actualPostStateRef: postStateRef,
          feedbackKind: armReceipt.slot0Feedback,
          feedbackEvidenceRefs,
          preferencePair: decision.selected.name === preferencePair?.preferredName ? preferencePair : null,
          supervisionSource: preferencePair === null ? "evaluation_only" : "executed_poststate",
          invocationCount: domain.invocationCount,
          observationCount: domain.observationCount,
          bytesReadTotal: domain.bytesReadTotal,
          transitionsUsed: domain.budgetUsed?.transitionsUsed ?? null,
          derivedGoalsUsed: domain.budgetUsed?.derivedGoalsUsed ?? null,
        });
      }
      process.stdout.write(`${episode.scenarioId} ${episode.feedbackKind} ${arm} ${domain.status} inv=${domain.invocationCount} bytes=${domain.bytesReadTotal} pairs=${preferencePair === null ? 0 : 1}\n`);
    }
  }
}

const deltaOne = preferenceRows.filter(row => row.preferredFeatures[NAME_COLUMN] - row.otherFeatures[NAME_COLUMN] === 1).length;
const deltaZero = preferenceRows.filter(row => row.preferredFeatures[NAME_COLUMN] - row.otherFeatures[NAME_COLUMN] === 0).length;
const sampleDocument = {
  schemaVersion: "p3-content-search-samples.v2",
  runId,
  generatedAt: new Date().toISOString(),
  profileReference: `${candidateProfilePath}#migrateCliCommandProfileV10x30`,
  wire: { name: "search.nameNeedleSegment", column: NAME_COLUMN, dimensions: 31 },
  samples,
  evidence: {
    dispatches: Object.fromEntries(dispatches.entries()),
    states: Object.fromEntries(states.entries()),
  },
  preferenceRows,
  preferenceStats: { total: preferenceRows.length, deltaOne, deltaZero },
  partitions: partitionIds,
  arms: armKinds,
};
const receipt = {
  schemaVersion: "p3-content-search-collection.v2",
  runId,
  generatedAt: sampleDocument.generatedAt,
  profileReference: sampleDocument.profileReference,
  budget: { limits: LIMITS, scan: SCAN },
  partitions: partitionIds,
  arms,
  totals: {
    armCount: arms.length,
    sampleCount: samples.length,
    preferenceRows: preferenceRows.length,
    achieved: arms.filter(arm => arm.status === "achieved").length,
    failed: arms.filter(arm => arm.status === "failed").length,
    other: arms.filter(arm => !["achieved", "failed"].includes(arm.status)).length,
  },
  failures,
  evidence: { dispatchRefs: dispatches.size, stateRefs: states.size },
  eio: {
    arms: arms.filter(arm => arm.feedbackKind === "E").length,
    recovered: arms.filter(arm => arm.feedbackKind === "E" && arm.status === "achieved").length,
  },
};

await mkdir(dirname(samplePath), { recursive: true });
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(samplePath, `${JSON.stringify(sampleDocument, null, 2)}\n`);
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ samplePath, receiptPath, totals: receipt.totals, failures: failures.length, evidence: receipt.evidence, eio: receipt.eio }, null, 2));
if (failures.length > 0) process.exitCode = 1;
