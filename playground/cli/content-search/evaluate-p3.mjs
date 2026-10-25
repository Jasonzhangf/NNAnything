import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const search = await import("nnanything/cli-content-search");
const policy = await import("nnanything/cli-goal");
const { p3PartitionEpisodes, p3Request, p3SandboxRecipe, assertP3EpisodeOnDisk, createP3Injection } =
  await import("./p3-recipe.mjs");
const { atomicStepViews, decisionExecutions, recoveryOutcome, t1t2Mismatches: t1t2Mismatch } =
  await import("./p3-recovery.mjs");

const SCAN = Object.freeze({
  maxBytesPerFile: 256,
  maxTotalBytes: 4096,
  chunkSize: 64,
  maxDirectoryDepth: 0,
  maxStaleRetries: 1,
});
const LIMITS = Object.freeze({ maxTransitions: 256, maxDepth: 8, maxDerivedGoals: 64 });
const STAGES = Object.freeze(["t0", "t1", "t2"]);
const CONDITIONS = Object.freeze(["natural", "forced"]);
const EVALUATION_SCHEMA = "p3-content-search-evaluation.v1";
const CASES_SCHEMA = "p3-content-search-verification-cases.v1";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`--${name} requires a value`);
  return value;
}

function requiredArgument(name) {
  const value = argument(name, undefined);
  if (value === undefined || value.length === 0) throw new TypeError(`--${name} is required`);
  return value;
}

function parseStages(value) {
  const stages = value.split(",");
  for (const stage of stages) {
    if (!STAGES.includes(stage)) throw new TypeError(`unknown evaluation stage ${stage}`);
  }
  return stages;
}

function latestState(response) {
  const states = response?.report?.states;
  return Array.isArray(states) && states.length > 0 ? states[states.length - 1]?.value ?? null : null;
}

function feedbackObservation(episode, candidate) {
  if (candidate === undefined || candidate === null) return "not_triggered";
  if (episode.feedbackKind === "N") {
    return candidate.scan?.complete && candidate.outcome === "negative" ? "complete_negative" : "incomplete";
  }
  if (episode.feedbackKind === "S") {
    return candidate.scan?.shortRead ? "short_read" : candidate.outcome === "unknown" ? "unknown" : "not_short";
  }
  if (episode.feedbackKind === "E") return candidate.outcome === "read_error" ? "read_error" : "no_read_error";
  return candidate.scan?.complete && candidate.outcome === "negative"
    ? "partial_listing_then_negative"
    : "incomplete";
}

function candidateSummary(candidate) {
  if (candidate === undefined || candidate === null) return null;
  return {
    name: candidate.name,
    outcome: candidate.outcome,
    failureCode: candidate.failureCode ?? null,
    contains: candidate.contains ?? null,
    hasRead: candidate.read !== null && candidate.read !== undefined,
    hasScan: candidate.scan !== null && candidate.scan !== undefined,
    scan: candidate.scan === null || candidate.scan === undefined
      ? null
      : {
          complete: candidate.scan.complete,
          shortRead: candidate.scan.shortRead,
          found: candidate.scan.found,
          coveredBytes: candidate.scan.coveredBytes,
        },
  };
}

function decisionTrace(decisions) {
  return decisions.map(decision => ({
    ordinal: decision.ordinal,
    forced: decision.forced,
    candidateNames: decision.candidates.map(candidate => candidate.name),
    selectedName: decision.selected.name,
    selectedFeatures: [...decision.selected.features],
  }));
}

function normalizedTrace(decisions) {
  return decisions.map(decision => ({
    ordinal: decision.ordinal,
    forced: decision.forced,
    candidateNames: [...decision.candidateNames],
    selectedName: decision.selectedName,
    selectedNameColumn: decision.selectedFeatures[29],
  }));
}

function recoveryView(item) {
  const outcome = recoveryOutcome(item);
  return {
    applicable: outcome.applicable,
    covered: outcome.covered,
    recovered: outcome.recovered,
    measured: outcome.measured,
    reasons: outcome.reasons,
  };
}

async function oracleScan(episode, scenarioRoot) {
  const scopeRoot = join(scenarioRoot, episode.scope);
  const names = (await readdir(scopeRoot)).sort();
  const expectedNames = [...episode.names].sort();
  const files = [];
  for (let slot = 0; slot < 4; slot += 1) {
    const path = join(scopeRoot, episode.names[slot]);
    const attributes = await lstat(path);
    const bytes = await readFile(path);
    const expected = Buffer.from(episode.contents[slot], "utf8");
    const needle = Buffer.from(episode.needle, "utf8");
    files.push({
      name: episode.names[slot],
      regular: attributes.isFile(),
      size: bytes.length,
      contentMatchesRecipe: bytes.equals(expected),
      needlePositions: [...bytes.keys()]
        .filter(index => index + needle.length <= bytes.length && bytes.subarray(index, index + needle.length).equals(needle)),
    });
  }
  return Object.freeze({
    entriesMatchRecipe: JSON.stringify(names) === JSON.stringify(expectedNames),
    names,
    files,
    contentUnchanged: files.every(file => file.regular && file.size === 96 && file.contentMatchesRecipe),
    onlyExpectedNeedlePosition: files.every((file, slot) => JSON.stringify(file.needlePositions)
      === JSON.stringify(slot === episode.hitSlot ? [16] : [])),
  });
}

async function runArm(episode, arm, profile, profileReference) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-p3-evaluate-")));
  const injection = createP3Injection(episode, episode.feedbackKind);
  let sandbox;
  const failures = [];
  try {
    sandbox = await search.createCliFilesystemSandbox({
      root,
      ownerGrantedEffects: ["filesystem.write"],
      recipe: p3SandboxRecipe(episode),
      ...(injection.fileReadIo === undefined ? {} : { fileReadIo: injection.fileReadIo }),
      ...(injection.listingObserver === undefined ? {} : { listingObserver: injection.listingObserver }),
    });
    const before = await oracleScan(episode, sandbox.scenarioRoot);
    if (!before.entriesMatchRecipe) failures.push("pre-run oracle entries differ from recipe");
    if (!before.contentUnchanged) failures.push("pre-run oracle content differs from recipe");
    if (!before.onlyExpectedNeedlePosition) failures.push("pre-run oracle needle positions differ from recipe");

    const session = sandbox.bindSession("s");
    const directory = await sandbox.bindDirectory(session, episode.scope);
    const decisions = [];
    const result = await search.runCliContentSearchGoal(p3Request(episode, directory, arm, "one"), {
      sandbox,
      session,
      profile,
      limits: LIMITS,
      scan: SCAN,
      order: arm === "forced" ? { kind: "injected-first", name: episode.names[0] } : { kind: "lexicographic" },
      onDecision: decision => { decisions.push(decision); },
    });
    const after = await oracleScan(episode, sandbox.scenarioRoot);
    if (!after.entriesMatchRecipe) failures.push("post-run oracle entries changed");
    if (!after.contentUnchanged) failures.push("post-run content changed");
    if (!after.onlyExpectedNeedlePosition) failures.push("post-run needle positions changed");

    const state = latestState(result.response);
    const candidates = Array.isArray(state?.candidates) ? state.candidates : [];
    const slot0 = candidates.find(candidate => candidate.name === episode.names[0]) ?? null;
    const matchNames = result.domain.matches.map(match => basename(match.path));
    const negativeNames = result.domain.negatives.map(fact => basename(fact.path));
    const trace = decisionTrace(decisions);
    const firstSelected = trace[0]?.selectedName ?? null;
    const slot0Selected = trace.some(decision => decision.selectedName === episode.names[0]);
    const slot0Feedback = feedbackObservation(episode, slot0);
    const atomicSteps = atomicStepViews(result.response);
    const executionTrace = decisionExecutions(trace, atomicSteps);
    const armReceipt = {
      stage: null,
      profileReference,
      partition: episode.partition,
      scenarioId: episode.scenarioId,
      episode: episode.episode,
      semanticFamily: episode.semanticFamily,
      feedbackKind: episode.feedbackKind,
      arm,
      requestId: arm === "natural" ? episode.requestId.natural : episode.requestId.forced,
      hitSlot: episode.hitSlot,
      hitName: episode.names[episode.hitSlot],
      status: result.domain.status,
      resolution: result.domain.resolution,
      satisfaction: result.domain.satisfaction,
      root: result.domain.preserve.rootEvaluation,
      control: result.domain.preserve.control,
      primaryErrorId: result.domain.preserve.primaryErrorId,
      matches: matchNames,
      negatives: negativeNames,
      negativeNames,
      limits: LIMITS,
      invocationCount: result.domain.invocationCount,
      observationCount: result.domain.observationCount,
      bytesReadTotal: result.domain.bytesReadTotal,
      duplicateReads: result.domain.duplicateReads,
      transitionsUsed: result.domain.budgetUsed?.transitionsUsed ?? null,
      derivedGoalsUsed: result.domain.budgetUsed?.derivedGoalsUsed ?? null,
      coverage: result.domain.coverage,
      denominators: result.domain.denominators,
      firstSelected,
      slot0SelectedFirst: firstSelected === episode.names[0],
      slot0Feedback,
      slot0Outcome: slot0?.outcome ?? null,
      slot0FailureCode: slot0?.failureCode ?? null,
      decisionTrace: executionTrace,
      atomicSteps,
      recovery: recoveryView(Object.freeze({
        arm,
        feedbackKind: episode.feedbackKind,
        slot0: candidateSummary(slot0),
        negativeNames,
        denominators: result.domain.denominators,
        decisionTrace: executionTrace,
        atomicSteps,
        status: result.domain.status,
        root: result.domain.preserve.rootEvaluation,
        control: result.domain.preserve.control,
        hitName: episode.names[episode.hitSlot],
        transitionsUsed: result.domain.budgetUsed?.transitionsUsed ?? null,
        derivedGoalsUsed: result.domain.budgetUsed?.derivedGoalsUsed ?? null,
        limits: LIMITS,
      })),
      candidates: candidates.map(candidateSummary),
      slot0: candidateSummary(slot0),
      injectionCounters: { ...injection.counters },
      oracle: { before, after, unchanged: true },
      failures,
    };

    if (result.domain.status !== "achieved") failures.push(`expected achieved, got ${result.domain.status}`);
    if (matchNames.length !== 1 || matchNames[0] !== episode.names[episode.hitSlot]) {
      failures.push(`expected one match ${episode.names[episode.hitSlot]}, got ${JSON.stringify(matchNames)}`);
    }
    if (result.domain.preserve.rootEvaluation?.state !== "evaluated"
      || result.domain.preserve.rootEvaluation.result !== "satisfied"
      || result.domain.preserve.rootEvaluation.satisfaction !== 100) {
      failures.push("rootEvaluation is not evaluated/satisfied/100");
    }
    if (result.domain.bytesReadTotal > SCAN.maxTotalBytes) failures.push("bytesReadTotal exceeded maxTotalBytes");
    if ((result.domain.budgetUsed?.transitionsUsed ?? Infinity) > LIMITS.maxTransitions) failures.push("transitions exceeded maxTransitions");
    if ((result.domain.budgetUsed?.derivedGoalsUsed ?? Infinity) > LIMITS.maxDerivedGoals) failures.push("derived goals exceeded maxDerivedGoals");
    if (result.domain.duplicateReads !== 0) failures.push(`duplicateReads must be 0, got ${result.domain.duplicateReads}`);
    if (result.domain.denominators.typeMismatches !== 0) failures.push("typeMismatches must be 0");
    if (arm === "forced" && firstSelected !== episode.names[0]) {
      failures.push(`forced first selection must be ${episode.names[0]}, got ${firstSelected}`);
    }
    if (episode.feedbackKind === "N" && slot0Selected) {
      if (slot0?.outcome !== "negative" || slot0?.scan?.complete !== true) {
        failures.push("N slot 0 must be a complete negative");
      }
    }
    if (episode.feedbackKind === "S" && slot0Selected) {
      if (slot0?.scan?.shortRead !== true || slot0?.outcome !== "unknown" || slot0?.contains !== null) {
        failures.push("S slot 0 must remain the measured short read");
      }
      if (negativeNames.includes(episode.names[0])) failures.push("S slot 0 must not become a proven negative");
      if (injection.counters.shortRead !== 1) failures.push(`short-read injection fired ${injection.counters.shortRead} times`);
    }
    if (episode.feedbackKind === "E" && slot0Selected) {
      if (slot0?.outcome !== "read_error" || slot0?.failureCode !== "EIO") {
        failures.push("E slot 0 must retain outcome=read_error and failureCode=EIO");
      }
      if (slot0?.contains !== null || slot0?.read !== null) {
        failures.push("E slot 0 must retain contains=null and read=null");
      }
      if (negativeNames.includes(episode.names[0])) failures.push("E slot 0 must not become a proven negative");
      if (injection.counters.eio !== 1) failures.push(`EIO injection fired ${injection.counters.eio} times`);
    }
    if (episode.feedbackKind === "P") {
      if (result.domain.denominators.listedDirectories !== 1
        || result.domain.denominators.directoriesComplete !== 0
        || result.domain.denominators.directoriesUncovered !== 1
        || result.domain.denominators.candidatesTotal !== 3) {
        failures.push(`partial denominators differ: ${JSON.stringify(result.domain.denominators)}`);
      }
      if (injection.counters.listing !== 1) failures.push(`partial listing observer fired ${injection.counters.listing} times`);
    } else {
      if (result.domain.denominators.candidatesTotal !== 4
        || result.domain.denominators.directoriesUncovered !== 0) {
        failures.push(`complete-listing denominators differ: ${JSON.stringify(result.domain.denominators)}`);
      }
    }
    return armReceipt;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return {
      stage: null,
      profileReference,
      partition: episode.partition,
      scenarioId: episode.scenarioId,
      episode: episode.episode,
      semanticFamily: episode.semanticFamily,
      feedbackKind: episode.feedbackKind,
      arm,
      requestId: arm === "natural" ? episode.requestId.natural : episode.requestId.forced,
      status: "exception",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      failures,
    };
  } finally {
    if (sandbox !== undefined) await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChange(before, after) {
  if (before === 0) return null;
  return ((after - before) / before) * 100;
}

function round3(value) {
  return value === null || value === undefined ? null : Math.round(value * 1000) / 1000;
}

function groupMatrix(matrix, predicate) {
  return matrix.filter(item => predicate(item));
}

function summarizeMatrix(matrix, family, arm) {
  const cells = groupMatrix(matrix, item => item.semanticFamily === family && item.arm === arm);
  return {
    family,
    arm,
    caseCount: cells.length,
    achieved: cells.filter(item => item.status === "achieved").length,
    failed: cells.filter(item => item.status !== "achieved").length,
    invocationMean: round3(mean(cells.filter(item => item.status === "achieved").map(item => item.invocationCount))),
    bytesMean: round3(mean(cells.filter(item => item.status === "achieved").map(item => item.bytesReadTotal))),
    observationMean: round3(mean(cells.filter(item => item.status === "achieved").map(item => item.observationCount))),
    duplicateReads: cells.reduce((sum, item) => sum + (item.duplicateReads ?? 0), 0),
    transitionsMean: round3(mean(cells.filter(item => item.status === "achieved").map(item => item.transitionsUsed))),
    derivedMean: round3(mean(cells.filter(item => item.status === "achieved").map(item => item.derivedGoalsUsed))),
    failures: cells.flatMap(item => item.failures),
  };
}

async function main() {
  const outputPath = resolve(requiredArgument("output"));
  const casesPath = resolve(argument("cases", join(dirname(outputPath), "verification-cases.json")));
  const stages = parseStages(argument("stages", "t0,t1,t2"));
  const t0ProfilePath = resolve(requiredArgument("t0-profile"));
  const t1ProfilePath = resolve(requiredArgument("t1-profile"));
  const t2ProfilePath = resolve(argument("t2-profile", t1ProfilePath));
  const reloadPath = resolve(argument("reload", fileURLToPath(new URL("./reload-p3.mjs", import.meta.url))));

  const episodes = Object.freeze([
    ...p3PartitionEpisodes("verification-a"),
    ...p3PartitionEpisodes("verification-b"),
  ]);
  const cases = episodes.map(episode => ({
    caseId: episode.scenarioId,
    partition: episode.partition,
    semanticFamily: episode.semanticFamily,
    feedbackKind: episode.feedbackKind,
    scenarioId: episode.scenarioId,
    scope: episode.scope,
    suffix: episode.suffix,
    needle: episode.needle,
    hitSlot: episode.hitSlot,
    names: [...episode.names],
    contents: [...episode.contents],
    requestId: { ...episode.requestId },
  }));
  const casesDocument = {
    schemaVersion: CASES_SCHEMA,
    generatedAt: new Date().toISOString(),
    partitions: ["verification-a", "verification-b"],
    caseCount: cases.length,
    cases,
  };
  await mkdir(dirname(casesPath), { recursive: true });
  await writeFile(casesPath, `${JSON.stringify(casesDocument, null, 2)}\n`);

  const t0Raw = JSON.parse(await readFile(t0ProfilePath, "utf8"));
  const t0Schema = policy.detectCliCommandProfileSchema(t0Raw);
  const t0Profile = t0Schema === "rejected-10x30"
    ? policy.migrateCliCommandProfileV10x30(t0Raw)
    : policy.validateCliCommandProfile(t0Raw);
  if (t0Profile.wires.length !== 31 || t0Profile.weights.length !== 10
    || t0Profile.weights.some(row => row.length !== 31)) {
    throw new TypeError("t0 profile did not validate as a 10x31 matrix");
  }
  const t0NameWeight = t0Profile.weights[t0Profile.heads.indexOf("entry.inspect")]
    [t0Profile.wires.indexOf("search.nameNeedleSegment")];
  if (t0NameWeight !== 0) {
    throw new TypeError(`t0 must have a zero name weight, got ${t0NameWeight}`);
  }

  const t1Raw = JSON.parse(await readFile(t1ProfilePath, "utf8"));
  const t1Schema = policy.detectCliCommandProfileSchema(t1Raw);
  if (t1Schema !== "current-10x31") {
    throw new TypeError(`t1 profile schema must be current-10x31; detected ${t1Schema}`);
  }
  const t1Profile = policy.validateCliCommandProfile(t1Raw);

  let t2Profile = null;
  const t2Raw = JSON.parse(await readFile(t2ProfilePath, "utf8"));
  const t2Schema = policy.detectCliCommandProfileSchema(t2Raw);
  if (t2Schema !== "current-10x31") {
    throw new TypeError(`t2 profile schema must be current-10x31; detected ${t2Schema}`);
  }
  t2Profile = policy.validateCliCommandProfile(t2Raw);

  const profileReceipts = Object.freeze({
    t0: {
      path: t0ProfilePath,
      schema: t0Schema,
      contract: t0Profile.contract,
      heads: t0Profile.heads.length,
      wires: t0Profile.wires.length,
      weightRows: t0Profile.weights.length,
      weightColumns: t0Profile.weights[0].length,
      nameColumn: t0Profile.wires.indexOf("search.nameNeedleSegment"),
      nameWeight: t0NameWeight,
      calibration: t0Profile.calibration,
      adoption: t0Profile.adoption,
    },
    t1: {
      path: t1ProfilePath,
      schema: t1Schema,
      contract: t1Profile.contract,
      heads: t1Profile.heads.length,
      wires: t1Profile.wires.length,
      weightRows: t1Profile.weights.length,
      weightColumns: t1Profile.weights[0].length,
      nameColumn: t1Profile.wires.indexOf("search.nameNeedleSegment"),
      nameWeight: t1Profile.weights[t1Profile.heads.indexOf("entry.inspect")]
        [t1Profile.wires.indexOf("search.nameNeedleSegment")],
      calibration: t1Profile.calibration,
      adoption: t1Profile.adoption,
    },
    t2: t2Profile === null
      ? null
      : {
          path: t2ProfilePath,
          schema: t2Schema,
          contract: t2Profile.contract,
          heads: t2Profile.heads.length,
          wires: t2Profile.wires.length,
          weightRows: t2Profile.weights.length,
          weightColumns: t2Profile.weights[0].length,
          nameColumn: t2Profile.wires.indexOf("search.nameNeedleSegment"),
          nameWeight: t2Profile.weights[t2Profile.heads.indexOf("entry.inspect")]
            [t2Profile.wires.indexOf("search.nameNeedleSegment")],
          calibration: t2Profile.calibration,
          adoption: t2Profile.adoption,
        },
  });

  const cells = [];
  const t2Results = [];
  if (stages.includes("t2")) {
    for (const condition of CONDITIONS) {
      const reportPath = join(dirname(outputPath), `t2-${condition}.json`);
      const spawned = spawnSync(process.execPath, [
        reloadPath,
        "--profile", t2ProfilePath,
        "--cases", casesPath,
        "--condition", condition === "forced" ? "forced-first" : "natural",
        "--output", reportPath,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (spawned.status !== 0) {
        throw new Error(`t2 reload process failed for ${condition}: ${spawned.stderr || spawned.stdout || "exit " + spawned.status}`);
      }
      const reloadReport = JSON.parse(await readFile(reportPath, "utf8"));
      for (const result of reloadReport.results) {
        const episode = episodes.find(item => item.scenarioId === result.scenarioId);
        const trace = result.decisionTrace ?? [];
        const firstSelected = trace[0]?.selectedName ?? null;
        const slot0 = result.slot0 ?? null;
        t2Results.push({
          ...result,
          stage: "t2",
          profileReference: `${t2ProfilePath}#read-from-file`,
          episode: episode.episode,
          hitSlot: episode.hitSlot,
          hitName: episode.names[episode.hitSlot],
          arm: condition,
          firstSelected,
          slot0SelectedFirst: firstSelected === episode.names[0],
          slot0Feedback: feedbackObservation(episode, slot0 === null ? null : {
            outcome: slot0.outcome,
            scan: slot0.scan,
            failureCode: slot0.failureCode,
          }),
          slot0Outcome: slot0?.outcome ?? null,
          slot0FailureCode: slot0?.failureCode ?? null,
        });
      }
    }
  }

  for (const stage of stages) {
    if (stage === "t2") continue;
    for (const episode of episodes) {
      for (const arm of CONDITIONS) {
        const reference = stage === "t0"
          ? `${t0ProfilePath}#migrateCliCommandProfileV10x30`
          : `${t1ProfilePath}#read-from-file`;
        const run = await runArm(episode, arm, stage === "t0" ? t0Profile : t1Profile, reference);
        cells.push({ ...run, stage });
      }
    }
  }
  cells.push(...t2Results);

  const families = Object.freeze(["A", "B"]);
  const arms = Object.freeze(["natural", "forced"]);
  const byKey = new Map();
  for (const item of cells) {
    byKey.set(`${item.stage}/${item.partition}/${item.arm}/${item.scenarioId}`, item);
  }
  const stageMatrix = stage => groupMatrix(cells, item => item.stage === stage);
  const matrix = {
    t0: summarizeMatrix(stageMatrix("t0"), "A", "natural"),
    t1: summarizeMatrix(stageMatrix("t1"), "A", "natural"),
    t2: summarizeMatrix(stageMatrix("t2"), "A", "natural"),
  };

  const comparisons = [];
  for (const family of families) {
    for (const arm of arms) {
      const t0 = summarizeMatrix(stageMatrix("t0"), family, arm);
      const t1 = summarizeMatrix(stageMatrix("t1"), family, arm);
      const t2 = summarizeMatrix(stageMatrix("t2"), family, arm);
      comparisons.push({
        family,
        arm,
        t0,
        t1,
        t2,
        invocationChangePercent: round3(percentChange(t0.invocationMean, t1.invocationMean)),
        bytesChangePercent: round3(percentChange(t0.bytesMean, t1.bytesMean)),
      });
    }
  }

  const aNatural = comparisons.find(item => item.family === "A" && item.arm === "natural");
  const aForced = comparisons.find(item => item.family === "A" && item.arm === "forced");
  const bNatural = comparisons.find(item => item.family === "B" && item.arm === "natural");
  const bForced = comparisons.find(item => item.family === "B" && item.arm === "forced");
  const mainEfficiency = {
    invocationChangePercent: round3(percentChange(
      mean([aNatural.t0.invocationMean, aForced.t0.invocationMean]),
      mean([aNatural.t1.invocationMean, aForced.t1.invocationMean]),
    )),
    bytesChangePercent: round3(percentChange(
      mean([aNatural.t0.bytesMean, aForced.t0.bytesMean]),
      mean([aNatural.t1.bytesMean, aForced.t1.bytesMean]),
    )),
  };

  const judgments = [];
  const successCells = cells.filter(item => item.status === "achieved");
  const allSuccessRate = successCells.length / cells.length;
  judgments.push({
    item: 1,
    label: "A/B all reachable cases succeed",
    metric: `${successCells.length}/${cells.length}`,
    rate: round3(allSuccessRate),
    pass: successCells.length === cells.length,
  });

  const forcedCells = cells.filter(item => item.arm === "forced");
  const forcedOutcomes = forcedCells.map(item => ({ item, outcome: recoveryOutcome(item) }));
  const forcedDenominator = forcedOutcomes.filter(entry => entry.outcome.applicable && entry.outcome.covered);
  const forcedRecovered = forcedDenominator.filter(entry => entry.outcome.recovered);
  const uncoveredForced = forcedOutcomes.filter(entry => !(entry.outcome.applicable && entry.outcome.covered));
  judgments.push({
    item: 2,
    label: "forced feedback cases recover through a different legal candidate",
    forcedTotal: forcedCells.length,
    covered: forcedDenominator.length,
    uncovered: uncoveredForced.length,
    uncoveredCells: uncoveredForced.map(entry => ({
      partition: entry.item.partition,
      scenarioId: entry.item.scenarioId,
      measured: entry.outcome.measured,
      reasons: entry.outcome.reasons,
    })),
    recovered: forcedRecovered.length,
    metric: `${forcedRecovered.length}/${forcedDenominator.length}`,
    pass: forcedCells.length > 0 && uncoveredForced.length === 0 && forcedDenominator.length === forcedRecovered.length,
  });

  judgments.push({
    item: 3,
    label: "A same-family main efficiency mean invocation and mean bytes drop at least 15% vs t0",
    invocation: mainEfficiency.invocationChangePercent,
    bytes: mainEfficiency.bytesChangePercent,
    pass: (mainEfficiency.invocationChangePercent ?? -Infinity) <= -15
      && (mainEfficiency.bytesChangePercent ?? -Infinity) <= -15,
  });
  judgments.push({
    item: 4,
    label: "B cross-family full report",
    natural: {
      invocationChangePercent: bNatural.invocationChangePercent,
      bytesChangePercent: bNatural.bytesChangePercent,
    },
    forced: {
      invocationChangePercent: bForced.invocationChangePercent,
      bytesChangePercent: bForced.bytesChangePercent,
    },
    pass: true,
  });

  const t1t2Cells = cells.filter(item => item.stage === "t1" || item.stage === "t2");
  const t1t2Mismatches = [];
  for (const item of t1t2Cells) {
    if (item.stage === "t1") continue;
    const t1 = byKey.get(`t1/${item.partition}/${item.arm}/${item.scenarioId}`);
    if (t1 === undefined) {
      t1t2Mismatches.push(`${item.partition}/${item.scenarioId}/${item.arm}: missing t1 counterpart`);
      continue;
    }
    t1t2Mismatches.push(...t1t2Mismatch(item, t1, `${item.partition}/${item.scenarioId}/${item.arm}`));
  }
  judgments.push({
    item: 6,
    label: "t1/t2 normalized traces, root/control results, invocation, observation, bytes equal",
    mismatches: t1t2Mismatches.length,
    pass: t1t2Mismatches.length === 0,
  });

  const failuresByKind = [];
  const runFailures = cells.filter(item => item.status !== "achieved");
  for (const item of runFailures) {
    failuresByKind.push({
      stage: item.stage,
      partition: item.partition,
      scenarioId: item.scenarioId,
      arm: item.arm,
      status: item.status,
      error: item.error ?? null,
      failures: item.failures,
    });
  }
  judgments.push({
    item: 5,
    label: "error, authority, unknown, partial, and budget boundary regressions",
    runFailures: runFailures.length,
    detail: failuresByKind,
    pass: runFailures.length === 0,
  });

  const report = {
    schemaVersion: EVALUATION_SCHEMA,
    generatedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      node: process.version,
      entry: "playground/cli/content-search/evaluate-p3.mjs",
    },
    stages,
    cases: {
      path: casesPath === undefined ? null : resolve(casesPath),
      schemaVersion: CASES_SCHEMA,
      count: cases.length,
      partitions: ["verification-a", "verification-b"],
      caseIds: cases.map(item => item.caseId),
    },
    profiles: profileReceipts,
    budget: { limits: LIMITS, scan: SCAN },
    comparisons,
    mainEfficiency,
    matrix,
    judgments,
    totals: {
      cellCount: cells.length,
      achieved: successCells.length,
      failed: runFailures.length,
      failureCount: cells.reduce((sum, item) => sum + item.failures.length, 0),
    },
    failures: failuresByKind,
    cells,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    casesPath,
    stages,
    totals: report.totals,
    comparisons,
    mainEfficiency,
    judgments,
  }, null, 2));
  if (failuresByKind.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`evaluate-p3: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
}
