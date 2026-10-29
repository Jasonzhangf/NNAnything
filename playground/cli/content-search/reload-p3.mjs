import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const search = await import("nnanything/cli-content-search");
const policy = await import("nnanything/cli-goal");
const { atomicStepViews, decisionExecutions } = await import("./p3-recovery.mjs");

const SCAN = Object.freeze({
  maxBytesPerFile: 256,
  maxTotalBytes: 4096,
  chunkSize: 64,
  maxDirectoryDepth: 0,
  maxStaleRetries: 1,
});
const LIMITS = Object.freeze({ maxTransitions: 256, maxDepth: 8, maxDerivedGoals: 64 });
const CASE_SCHEMA = "p3-content-search-verification-cases.v1";
const REPORT_SCHEMA = "p3-content-search-reload-report.v1";
const CONDITIONS = Object.freeze(["natural", "forced-first"]);
const FEEDBACK_KINDS = new Set(["N", "S", "E", "P"]);

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

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function validateCase(raw, index) {
  const value = record(raw, `cases[${index}]`);
  const caseId = nonEmpty(value.caseId, `cases[${index}].caseId`);
  const partition = nonEmpty(value.partition, `cases[${index}].partition`);
  if (partition !== "verification-a" && partition !== "verification-b") {
    throw new TypeError(`cases[${index}].partition must be verification-a or verification-b`);
  }
  const semanticFamily = nonEmpty(value.semanticFamily, `cases[${index}].semanticFamily`);
  if (partition === "verification-a" && semanticFamily !== "A") {
    throw new TypeError(`cases[${index}] verification-a must use semantic family A`);
  }
  if (partition === "verification-b" && semanticFamily !== "B") {
    throw new TypeError(`cases[${index}] verification-b must use semantic family B`);
  }
  const feedbackKind = nonEmpty(value.feedbackKind, `cases[${index}].feedbackKind`);
  if (!FEEDBACK_KINDS.has(feedbackKind)) throw new TypeError(`cases[${index}].feedbackKind must be N, S, E, or P`);
  const scenarioId = nonEmpty(value.scenarioId, `cases[${index}].scenarioId`);
  const scope = nonEmpty(value.scope, `cases[${index}].scope`);
  if (scope.includes("/") || scope === "." || scope === "..") {
    throw new TypeError(`cases[${index}].scope must be one flat directory name`);
  }
  const suffix = nonEmpty(value.suffix, `cases[${index}].suffix`);
  const needle = nonEmpty(value.needle, `cases[${index}].needle`);
  if (Buffer.byteLength(needle, "utf8") !== 8) throw new TypeError(`cases[${index}].needle must be exactly 8 bytes`);
  const hitSlot = integer(value.hitSlot, 0, 3, `cases[${index}].hitSlot`);
  if (!Array.isArray(value.names) || value.names.length !== 4) {
    throw new TypeError(`cases[${index}].names must contain four names`);
  }
  if (!Array.isArray(value.contents) || value.contents.length !== 4) {
    throw new TypeError(`cases[${index}].contents must contain four contents`);
  }
  const names = value.names.map((name, slot) => nonEmpty(name, `cases[${index}].names[${slot}]`));
  const contents = value.contents.map((content, slot) => nonEmpty(content, `cases[${index}].contents[${slot}]`));
  if (new Set(names).size !== 4) throw new TypeError(`cases[${index}].names must be unique`);
  for (let slot = 0; slot < 4; slot += 1) {
    if (Buffer.byteLength(contents[slot], "utf8") !== 96) {
      throw new TypeError(`cases[${index}].contents[${slot}] must be exactly 96 bytes`);
    }
    const position = Buffer.from(contents[slot], "utf8").indexOf(Buffer.from(needle, "utf8"));
    const expected = slot === hitSlot ? 16 : -1;
    if (position !== expected) {
      throw new TypeError(`cases[${index}].contents[${slot}] needle position must be ${expected}`);
    }
  }
  const requestId = record(value.requestId, `cases[${index}].requestId`);
  const naturalRequestId = nonEmpty(requestId.natural, `cases[${index}].requestId.natural`);
  const forcedRequestId = nonEmpty(requestId.forced, `cases[${index}].requestId.forced`);
  return Object.freeze({
    caseId,
    partition,
    semanticFamily,
    feedbackKind,
    scenarioId,
    scope,
    suffix,
    needle,
    hitSlot,
    names: Object.freeze(names),
    contents: Object.freeze(contents),
    requestId: Object.freeze({ natural: naturalRequestId, forced: forcedRequestId }),
  });
}

function validateCases(value) {
  const document = record(value, "verification cases");
  if (document.schemaVersion !== CASE_SCHEMA) {
    throw new TypeError(`verification cases schemaVersion must be ${CASE_SCHEMA}`);
  }
  if (!Array.isArray(document.cases) || document.cases.length === 0) {
    throw new TypeError("verification cases must contain at least one case");
  }
  const cases = document.cases.map(validateCase);
  if (new Set(cases.map(item => item.caseId)).size !== cases.length) {
    throw new TypeError("verification case IDs must be unique");
  }
  return Object.freeze(cases);
}

function scenarioRecipe(item) {
  return Object.freeze({
    scenarioId: item.scenarioId,
    entries: Object.freeze([
      Object.freeze({ path: item.scope, kind: "directory" }),
      ...item.names.map((name, slot) => Object.freeze({
        path: `${item.scope}/${name}`,
        kind: "file",
        contents: item.contents[slot],
      })),
    ]),
    sessions: Object.freeze([{ id: "s", cwd: ".", grantedEffects: ["filesystem.read", "process.exec"] }]),
  });
}

function createInjection(item) {
  const counters = { shortRead: 0, eio: 0, listing: 0 };
  const slot0 = item.names[0];
  let fileReadIo;
  let listingObserver;
  if (item.feedbackKind === "S") {
    fileReadIo = {
      lstat: (path, options) => lstat(path, options),
      open: async (path, flags) => {
        const handle = await open(path, flags);
        const name = basename(path);
        return {
          stat: options => handle.stat(options),
          read: async (buffer, offset, length, position) => {
            if (name === slot0 && position === 0 && length === 64 && counters.shortRead === 0) {
              counters.shortRead += 1;
              const result = await handle.read(buffer, offset, 8, 0);
              return { bytesRead: result.bytesRead };
            }
            const result = await handle.read(buffer, offset, length, position);
            return { bytesRead: result.bytesRead };
          },
          close: () => handle.close(),
        };
      },
    };
  } else if (item.feedbackKind === "E") {
    fileReadIo = {
      lstat: (path, options) => lstat(path, options),
      open: async (path, flags) => {
        if (basename(path) === slot0 && counters.eio === 0) {
          counters.eio += 1;
          const error = new Error("P3 read denied");
          error.code = "EIO";
          throw error;
        }
        return open(path, flags);
      },
    };
  } else if (item.feedbackKind === "P") {
    const keep = new Set([item.names[0], item.names[2], item.names[3]]);
    listingObserver = async input => {
      counters.listing += 1;
      const names = (await readdir(input.physicalDirectory)).sort();
      const entries = [];
      for (const name of names) {
        if (!keep.has(name)) continue;
        const path = join(input.physicalDirectory, name);
        const attributes = await lstat(path);
        entries.push({
          name,
          path,
          type: attributes.isFile() ? "file" : attributes.isDirectory() ? "directory" : attributes.isSymbolicLink() ? "symlink" : "other",
        });
      }
      return {
        ok: true,
        observation: {
          kind: "directory.list",
          configuredDirectory: input.configuredDirectory,
          physicalDirectory: input.physicalDirectory,
          executable: process.execPath,
          helperPath: "node:fs.readdir",
          argv: [process.execPath, input.physicalDirectory],
          stdout: "",
          stderr: "",
          exitCode: 0,
          entries,
          coverage: "partial",
          errors: [{ name: item.names[1], code: "EACCES", message: "P3 enumeration denied" }],
        },
      };
    };
  }
  return Object.freeze({
    counters,
    ...(fileReadIo === undefined ? {} : { fileReadIo }),
    ...(listingObserver === undefined ? {} : { listingObserver }),
  });
}

function makeRequest(item, directory, condition) {
  return {
    requestId: condition === "natural" ? item.requestId.natural : item.requestId.forced,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: item.suffix },
        cardinality: "one",
        recursion: "flat",
      },
      requirement: {
        kind: "contains",
        predicate: { kind: "contains", needle: item.needle, encoding: "utf8" },
      },
    },
    satisfactionThreshold: 100,
  };
}

async function oracleScan(item, scenarioRoot) {
  const scopeRoot = join(scenarioRoot, item.scope);
  const names = (await readdir(scopeRoot)).sort();
  const expectedNames = [...item.names].sort();
  const files = [];
  for (let slot = 0; slot < 4; slot += 1) {
    const path = join(scopeRoot, item.names[slot]);
    const attributes = await lstat(path);
    const bytes = await readFile(path);
    const expected = Buffer.from(item.contents[slot], "utf8");
    const needle = Buffer.from(item.needle, "utf8");
    files.push({
      name: item.names[slot],
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
    matchNames: files.filter((file, slot) => slot === item.hitSlot).map(file => file.name),
    contentUnchanged: files.every(file => file.regular && file.size === 96 && file.contentMatchesRecipe),
    onlyExpectedNeedlePosition: files.every((file, slot) => JSON.stringify(file.needlePositions)
      === JSON.stringify(slot === item.hitSlot ? [16] : [])),
  });
}

function latestState(response) {
  const states = response?.report?.states;
  return Array.isArray(states) && states.length > 0 ? states[states.length - 1]?.value ?? null : null;
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

async function runCase(profile, item, condition) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-p3-reload-")));
  const injection = createInjection(item);
  let sandbox;
  const failures = [];
  try {
    sandbox = await search.createCliFilesystemSandbox({
      root,
      ownerGrantedEffects: ["filesystem.write"],
      recipe: scenarioRecipe(item),
      ...(injection.fileReadIo === undefined ? {} : { fileReadIo: injection.fileReadIo }),
      ...(injection.listingObserver === undefined ? {} : { listingObserver: injection.listingObserver }),
    });
    const before = await oracleScan(item, sandbox.scenarioRoot);
    if (!before.entriesMatchRecipe) failures.push("pre-run oracle entries differ from recipe");
    if (!before.contentUnchanged) failures.push("pre-run oracle content differs from recipe");
    if (!before.onlyExpectedNeedlePosition) failures.push("pre-run oracle needle positions differ from recipe");

    const session = sandbox.bindSession("s");
    const directory = await sandbox.bindDirectory(session, item.scope);
    const decisions = [];
    const result = await search.runCliContentSearchGoal(makeRequest(item, directory, condition), {
      sandbox,
      session,
      profile,
      limits: LIMITS,
      scan: SCAN,
      order: condition === "forced-first"
        ? { kind: "injected-first", name: item.names[0] }
        : { kind: "lexicographic" },
      onDecision: decision => { decisions.push(decision); },
    });
    const after = await oracleScan(item, sandbox.scenarioRoot);
    if (!after.entriesMatchRecipe) failures.push("post-run oracle entries changed");
    if (!after.contentUnchanged) failures.push("post-run content changed");
    if (!after.onlyExpectedNeedlePosition) failures.push("post-run needle positions changed");

    const state = latestState(result.response);
    const candidates = Array.isArray(state?.candidates) ? state.candidates : [];
    const slot0 = candidates.find(candidate => candidate.name === item.names[0]) ?? null;
    const matchNames = result.domain.matches.map(match => basename(match.path));
    const negativeNames = result.domain.negatives.map(fact => basename(fact.path));
    const rootEvaluation = result.domain.preserve.rootEvaluation;
    const control = result.domain.preserve.control;
    const atomicSteps = atomicStepViews(result.response);
    const trace = decisionExecutions(decisions, atomicSteps);
    const firstSelected = trace[0]?.selectedName ?? null;
    const slot0Selected = trace.some(decision => decision.selectedName === item.names[0]);

    if (result.domain.status !== "achieved") failures.push(`expected achieved, got ${result.domain.status}`);
    if (matchNames.length !== 1 || matchNames[0] !== item.names[item.hitSlot]) {
      failures.push(`expected one match ${item.names[item.hitSlot]}, got ${JSON.stringify(matchNames)}`);
    }
    if (rootEvaluation?.state !== "evaluated"
      || rootEvaluation.result !== "satisfied"
      || rootEvaluation.satisfaction !== 100) {
      failures.push("rootEvaluation is not evaluated/satisfied/100");
    }
    if (result.domain.bytesReadTotal > SCAN.maxTotalBytes) failures.push("bytesReadTotal exceeded maxTotalBytes");
    if ((result.domain.budgetUsed?.transitionsUsed ?? Infinity) > LIMITS.maxTransitions) failures.push("transitions exceeded maxTransitions");
    if ((result.domain.budgetUsed?.derivedGoalsUsed ?? Infinity) > LIMITS.maxDerivedGoals) failures.push("derived goals exceeded maxDerivedGoals");
    if (result.domain.duplicateReads !== 0) failures.push(`duplicateReads must be 0, got ${result.domain.duplicateReads}`);
    if (result.domain.denominators.typeMismatches !== 0) failures.push("typeMismatches must be 0");

    const partial = item.feedbackKind === "P";
    if (partial) {
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

    if (condition === "forced-first" && firstSelected !== item.names[0]) {
      failures.push(`forced first selection must be ${item.names[0]}, got ${firstSelected}`);
    }
    if (item.feedbackKind === "N" && slot0Selected) {
      if (slot0?.outcome !== "negative" || slot0?.scan?.complete !== true) {
        failures.push("N slot 0 must be a complete negative");
      }
    }
    if (item.feedbackKind === "S" && slot0Selected) {
      if (slot0?.scan?.shortRead !== true || slot0?.outcome !== "unknown" || slot0?.contains !== null) {
        failures.push("S slot 0 must remain the measured short read");
      }
      if (negativeNames.includes(item.names[0])) failures.push("S slot 0 must not become a proven negative");
      if (injection.counters.shortRead !== 1) failures.push(`short-read injection fired ${injection.counters.shortRead} times`);
    }
    if (item.feedbackKind === "E" && slot0Selected) {
      if (slot0?.outcome !== "read_error" || slot0?.failureCode !== "EIO") {
        failures.push("E slot 0 must retain outcome=read_error and failureCode=EIO");
      }
      if (slot0?.contains !== null || slot0?.read !== null) {
        failures.push("E slot 0 must retain contains=null and read=null");
      }
      if (negativeNames.includes(item.names[0])) failures.push("E slot 0 must not become a proven negative");
      if (injection.counters.eio !== 1) failures.push(`EIO injection fired ${injection.counters.eio} times`);
    }

    return {
      caseId: item.caseId,
      partition: item.partition,
      semanticFamily: item.semanticFamily,
      scenarioId: item.scenarioId,
      feedbackKind: item.feedbackKind,
      condition,
      hitName: item.names[item.hitSlot],
      requestId: condition === "natural" ? item.requestId.natural : item.requestId.forced,
      status: result.domain.status,
      resolution: result.domain.resolution,
      satisfaction: result.domain.satisfaction,
      root: rootEvaluation,
      control,
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
      decisionTrace: trace,
      atomicSteps,
      candidates: candidates.map(candidateSummary),
      slot0: candidateSummary(slot0),
      injectionCounters: { ...injection.counters },
      oracle: { before, after, unchanged: true },
      failures,
    };
  } catch (error) {
    return {
      caseId: item.caseId,
      partition: item.partition,
      semanticFamily: item.semanticFamily,
      scenarioId: item.scenarioId,
      feedbackKind: item.feedbackKind,
      condition,
      requestId: condition === "natural" ? item.requestId.natural : item.requestId.forced,
      status: "exception",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      failures: [...failures, error instanceof Error ? error.message : String(error)],
    };
  } finally {
    if (sandbox !== undefined) await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const profilePath = resolve(requiredArgument("profile"));
  const casesPath = resolve(requiredArgument("cases"));
  const condition = requiredArgument("condition");
  const outputPath = resolve(requiredArgument("output"));
  if (!CONDITIONS.includes(condition)) {
    throw new TypeError(`--condition must be one of ${CONDITIONS.join(", ")}; no condition was inferred`);
  }

  const profileStat = await stat(profilePath);
  const profileText = await readFile(profilePath, "utf8");
  let rawProfile;
  try {
    rawProfile = JSON.parse(profileText);
  } catch (error) {
    throw new TypeError(`profile is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const schema = policy.detectCliCommandProfileSchema(rawProfile);
  const profile = policy.migrateCliCommandProfileToCurrent(rawProfile);
  if (profile.heads.length !== 11 || profile.wires.length !== 34
    || profile.weights.length !== 11 || profile.weights.some(row => row.length !== 34)) {
    throw new TypeError("profile did not validate as the current 11x34 matrix");
  }

  const casesStat = await stat(casesPath);
  const casesText = await readFile(casesPath, "utf8");
  let rawCases;
  try {
    rawCases = JSON.parse(casesText);
  } catch (error) {
    throw new TypeError(`verification cases are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cases = validateCases(rawCases);

  const startedAt = new Date().toISOString();
  const results = [];
  for (const item of cases) {
    results.push(await runCase(profile, item, condition));
  }
  const failures = results.flatMap(result =>
    result.failures.map(message => `${result.caseId}/${condition}: ${message}`));
  const report = {
    schemaVersion: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    startedAt,
    process: {
      pid: process.pid,
      node: process.version,
      entry: "playground/cli/content-search/reload-p3.mjs",
      condition,
    },
    profile: {
      path: profilePath,
      fileReadReceipt: {
        bytes: Buffer.byteLength(profileText, "utf8"),
        size: profileStat.size,
        modifiedAt: profileStat.mtime.toISOString(),
      },
      schema,
      contract: profile.contract,
      heads: profile.heads.length,
      wires: profile.wires.length,
      weightRows: profile.weights.length,
      weightColumns: profile.weights[0].length,
      nameColumn: profile.wires.indexOf("search.nameNeedleSegment"),
      calibration: profile.calibration,
      adoption: profile.adoption,
    },
    cases: {
      path: casesPath,
      fileReadReceipt: {
        bytes: Buffer.byteLength(casesText, "utf8"),
        size: casesStat.size,
        modifiedAt: casesStat.mtime.toISOString(),
      },
      schemaVersion: rawCases.schemaVersion,
      count: cases.length,
      partitions: [...new Set(cases.map(item => item.partition))],
    },
    budget: { limits: LIMITS, scan: SCAN },
    totals: {
      caseCount: results.length,
      achieved: results.filter(result => result.status === "achieved").length,
      failed: results.filter(result => result.status !== "achieved").length,
      failures: failures.length,
    },
    failures,
    results,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    processId: report.process.pid,
    condition,
    profile: report.profile,
    cases: report.cases,
    totals: report.totals,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`reload-p3: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
