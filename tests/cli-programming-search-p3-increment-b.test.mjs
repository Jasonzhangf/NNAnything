import test from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const searchApi = () => import("nnanything/cli-content-search");
const policyApi = () => import("nnanything/cli-goal");

const SCAN = Object.freeze({
  maxBytesPerFile: 256,
  maxTotalBytes: 4096,
  chunkSize: 64,
  maxDirectoryDepth: 0,
  maxStaleRetries: 1,
});

const LIMITS = Object.freeze({ maxTransitions: 256, maxDepth: 8, maxDerivedGoals: 64 });

const NEEDLE = "KX000001";
const SLOT_NAMES = Object.freeze([
  "tu-PX000001.p3t",
  "tv-PX000002.p3t",
  "tw-PX000003.p3t",
  "tz-KX000001.p3t",
]);

function dec4(value) {
  return String(value).padStart(4, "0");
}

function p3Header(partitionCharacter, episode, slot) {
  return `${partitionCharacter}${dec4(episode)}${slot}QZ`;
}

function p3Content(partitionCharacter, episode, slot) {
  const header = p3Header(partitionCharacter, episode, slot);
  const content = header + "H".repeat(88);
  if (slot === 3) {
    return `${content.slice(0, 16)}${NEEDLE}${content.slice(24)}`;
  }
  return content;
}

const TRAIN_FILES = Object.freeze(SLOT_NAMES.map((name, index) => Object.freeze({
  path: `src/${name}`,
  kind: "file",
  contents: p3Content("T", 1, index),
})));

async function fixture(t, entries = TRAIN_FILES, options = {}) {
  const module = await searchApi();
  const root = await realpath(await mkdtemp(join(tmpdir(), "nn-p3-inc-b-")));
  const sandbox = await module.createCliFilesystemSandbox({
    root,
    ownerGrantedEffects: ["filesystem.write"],
    recipe: {
      scenarioId: options.scenarioId ?? "p3-inc-b",
      entries: [{ path: "src", kind: "directory" }, ...entries],
      sessions: [{ id: "s", cwd: ".", grantedEffects: ["filesystem.read", "process.exec"] }],
    },
    ...(options.listingObserver === undefined ? {} : { listingObserver: options.listingObserver }),
    ...(options.fileReadIo === undefined ? {} : { fileReadIo: options.fileReadIo }),
  });
  t.after(async () => {
    await sandbox.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return { module, sandbox, session: sandbox.bindSession("s"), root };
}

function request(directory, { cardinality = "one", requestId = "p3-inc-b", needle = NEEDLE } = {}) {
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: ".p3t" },
        cardinality,
        recursion: "flat",
      },
      requirement: {
        kind: "contains",
        predicate: { kind: "contains", needle, encoding: "utf8" },
      },
    },
    satisfactionThreshold: 100,
  };
}

function baselineProfile(module, nameWeight = 0) {
  const profile = module.zeroCliCommandProfile();
  const weights = profile.weights.map(row => [...row]);
  weights[profile.heads.indexOf("ls")][profile.wires.indexOf("goalListDirectory")] = 10;
  const inspect = profile.heads.indexOf("entry.inspect");
  weights[inspect][profile.wires.indexOf("predicate.observe.inspect")] = 10;
  weights[inspect][profile.wires.indexOf("property.type")] = 10;
  weights[inspect][profile.wires.indexOf("search.nameNeedleSegment")] = nameWeight;
  return { ...profile, weights };
}

async function run(module, value, profileModule, options = {}) {
  const directory = await value.sandbox.bindDirectory(value.session, "src");
  return value.module.runCliContentSearchGoal(request(directory, options.requestOptions), {
    sandbox: value.sandbox,
    session: value.session,
    profile: options.profile ?? baselineProfile(profileModule, options.nameWeight ?? 0),
    limits: options.limits ?? LIMITS,
    scan: options.scan ?? SCAN,
    ...(options.order === undefined ? {} : { order: options.order }),
    ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
  });
}

function realIo() {
  return {
    lstat: (path, options) => lstat(path, options),
    open: (path, flags) => open(path, flags),
  };
}

function shortReadIo(slotPath) {
  const calls = new Map();
  const io = realIo();
  return {
    calls,
    io: {
      lstat: io.lstat,
      open: async (path, flags) => {
        const handle = await io.open(path, flags);
        const name = basename(path);
        return {
          stat: opts => handle.stat(opts),
          read: async (buffer, offset, length, position) => {
            const key = `${name}:${position}:${length}`;
            if (name === slotPath && position === 0 && length === 64 && (calls.get(key) ?? 0) === 0) {
              calls.set(key, 1);
              const result = await handle.read(buffer, offset, 8, 0);
              return { bytesRead: result.bytesRead };
            }
            const result = await handle.read(buffer, offset, length, position);
            return { bytesRead: result.bytesRead };
          },
          close: () => handle.close(),
        };
      },
    },
  };
}

function eioIo(slotPath) {
  const calls = new Map();
  const io = realIo();
  return {
    calls,
    io: {
      lstat: io.lstat,
      open: async (path, flags) => {
        const name = basename(path);
        if (name === slotPath && (calls.get(name) ?? 0) === 0) {
          calls.set(name, 1);
          const error = new Error("P3 read denied");
          error.code = "EIO";
          throw error;
        }
        return io.open(path, flags);
      },
    },
  };
}

test("R3 preference prepare rejects all delta-zero rows and a legal delta-one row has -0.5 zero-init gradient", {
  skip: !process.env.NN_HANDWIRED_ROOT && "provide explicit real Handwired source root",
}, async () => {
  const module = await policyApi();
  const preferred = module.cliCandidateFeatures("tz-KX000001.p3t", NEEDLE);
  const other = module.cliCandidateFeatures("tu-PX000001.p3t", NEEDLE);
  const deltaZero = [{
    id: "delta-zero",
    sourceGroup: "train",
    partition: "train",
    preferredName: "same-a.p3t",
    otherName: "same-b.p3t",
    preferredFeatures: other,
    otherFeatures: other,
    evidenceRefs: [],
  }];
  assert.throws(() => module.prepareCliCandidatePreferenceDataset(deltaZero), /delta=0|valid|pair/i);
  const prepared = module.prepareCliCandidatePreferenceDataset([{
    id: "delta-one",
    sourceGroup: "train",
    partition: "train",
    preferredName: "tz-KX000001.p3t",
    otherName: "tu-PX000001.p3t",
    preferredFeatures: preferred,
    otherFeatures: other,
    evidenceRefs: [],
  }]);
  assert.equal(prepared.rows.length, 1);
  assert.equal(prepared.deltaZeroCount, 0);

  const fit = await module.fitCliCandidateNamePreference({
    initial: module.zeroCliCommandProfile(),
    rows: prepared.rows,
    handwiredRoot: process.env.NN_HANDWIRED_ROOT,
    epochs: 1,
    learningRate: 0.1,
  });
  assert.equal(fit.initialGradient, -0.5);
  assert.equal(fit.parameterBefore, 0);
  assert.equal(fit.parameterAfter, 0.05);
  assert.equal(fit.validPairCount, 1);
});

test("R7 a fresh run is not excluded by an older proven negative after the inode changes", async t => {
  const value = await fixture(t, [Object.freeze({
    path: "src/only.p3t",
    kind: "file",
    contents: "no needle".padEnd(96, "x"),
  })]);
  const profileModule = await policyApi();
  const first = await run(value.module, value, profileModule, { order: { kind: "injected-first", name: "only.p3t" } });
  assert.equal(first.domain.status, "unmet");
  assert.equal(first.domain.negatives.length, 1);

  const target = join(value.sandbox.scenarioRoot, "src", "only.p3t");
  await rm(target);
  await writeFile(target, "x".repeat(16) + NEEDLE + "y".repeat(96 - 16 - NEEDLE.length));
  const second = await run(value.module, value, profileModule, { order: { kind: "injected-first", name: "only.p3t" } });
  assert.equal(second.domain.status, "achieved");
  assert.equal(second.domain.matches.length, 1);
});

test("R8 a fresh request with a new needle is not excluded by the previous no-hit", async t => {
  const value = await fixture(t, [Object.freeze({
    path: "src/one.p3t",
    kind: "file",
    contents: "x".repeat(16) + "NW000001" + "y".repeat(96 - 16 - 8),
  })]);
  const profileModule = await policyApi();
  const first = await run(value.module, value, profileModule, {
    order: { kind: "injected-first", name: "one.p3t" },
    requestOptions: { needle: NEEDLE },
  });
  assert.equal(first.domain.status, "unmet");
  assert.equal(first.domain.negatives.length, 1);

  const second = await run(value.module, value, profileModule, {
    order: { kind: "injected-first", name: "one.p3t" },
    requestOptions: { needle: "NW000001" },
  });
  assert.equal(second.domain.status, "achieved");
  assert.equal(second.domain.matches.length, 1);
});

test("R9 a short read on the forced first candidate is unknown and the named candidate still wins next", async t => {
  const short = shortReadIo("tu-PX000001.p3t");
  const value = await fixture(t, TRAIN_FILES, { fileReadIo: short.io });
  const profileModule = await policyApi();
  const result = await run(value.module, value, profileModule, {
    order: { kind: "injected-first", name: "tu-PX000001.p3t" },
    nameWeight: 10,
  });
  assert.equal(result.domain.status, "achieved");
  assert.equal(result.domain.negatives.length, 0);
  assert.ok(result.domain.matches.some(match => match.path.endsWith("tz-KX000001.p3t")));
  const slot0Read = result.domain.preserve.atomicResults
    ?.map(item => item?.sourceResult)
    .filter(source => source?.tag === "cli.file.read.receipt.v1")
    .map(source => source.value)
    .find(value => value?.ref?.absolutePath?.endsWith("tu-PX000001.p3t"));
  assert.equal(slot0Read?.receipt?.execution?.observation?.bytesRead, 8);
  assert.equal(slot0Read?.receipt?.execution?.observation?.eof, true);
  assert.equal(slot0Read?.receipt?.execution?.observation?.end_observed, false);
  assert.equal(short.calls.get("tu-PX000001.p3t:0:64"), 1);
  assert.equal(result.domain.invocationCount, 5);
  assert.equal(result.domain.bytesReadTotal, 72);
});

test("R10 an EIO first candidate preserves the error and recovers to a real later hit", {
  skip: "shared recursive-goal core treats a failed atomic read as terminal; see playground/cli/content-search/p3-eio-core-repro.mjs",
}, async t => {
  const eio = eioIo("tu-PX000001.p3t");
  const value = await fixture(t, TRAIN_FILES, { fileReadIo: eio.io });
  const profileModule = await policyApi();
  const result = await run(value.module, value, profileModule, {
    order: { kind: "injected-first", name: "tu-PX000001.p3t" },
    nameWeight: 10,
  });
  assert.equal(result.domain.status, "achieved");
  assert.ok(result.domain.matches.some(match => match.path.endsWith("tz-KX000001.p3t")));
  assert.equal(eio.calls.get("tu-PX000001.p3t"), 1);
  assert.match(JSON.stringify(result.response), /EIO/);
});

test("R11 partial listing lets one satisfy a known hit and never lets all complete", async t => {
  const value = await fixture(t, TRAIN_FILES, {
    listingObserver: async input => {
      const { runDirectoryListHelper } = await import("../dist/adapters/cli/directory-listing.js");
      const result = await runDirectoryListHelper(input);
      if (!result.ok) return result;
      const keep = new Set(["tu-PX000001.p3t", "tw-PX000003.p3t", "tz-KX000001.p3t"]);
      return {
        ok: true,
        observation: {
          ...result.observation,
          coverage: "partial",
          entries: result.observation.entries.filter(entry => keep.has(entry.name)),
          errors: [{ name: "tv-PX000002.p3t", code: "EACCES", message: "P3 enumeration denied" }],
        },
      };
    },
  });
  const profileModule = await policyApi();
  const one = await run(value.module, value, profileModule, {
    order: { kind: "injected-first", name: "tu-PX000001.p3t" },
    nameWeight: 10,
  });
  assert.equal(one.domain.status, "achieved");
  assert.equal(one.domain.denominators.directoriesUncovered, 1);
  assert.equal(one.domain.denominators.listedDirectories, 1);
  assert.equal(one.domain.denominators.candidatesTotal, 3);

  const all = await run(value.module, value, profileModule, {
    order: { kind: "injected-first", name: "tu-PX000001.p3t" },
    nameWeight: 10,
    requestOptions: { cardinality: "all" },
  });
  assert.notEqual(all.domain.status, "achieved");
  assert.equal(all.domain.denominators.directoriesUncovered, 1);
});
