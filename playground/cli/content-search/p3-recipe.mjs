import assert from "node:assert/strict";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { runDirectoryListHelper } from "nnanything/cli-goal";

export const P3_CHUNK_SIZE = 64;

export const P3_PARTITIONS = Object.freeze({
  train: Object.freeze({
    id: "train",
    scenarioPrefix: "m3-train-cobalt-e",
    semanticFamily: "A",
    scope: "ct",
    slotPrefixes: Object.freeze(["tu", "tv", "tw", "tz"]),
    suffix: ".p3t",
    needlePrefix: "KX",
    tokenPrefix: "PX",
    headerCharacter: "T",
    fill: "H",
    episodes: 24,
  }),
  development: Object.freeze({
    id: "development",
    scenarioPrefix: "m3-dev-saffron-e",
    semanticFamily: "A",
    scope: "ds",
    slotPrefixes: Object.freeze(["du", "dv", "dw", "dz"]),
    suffix: ".p3d",
    needlePrefix: "LY",
    tokenPrefix: "QY",
    headerCharacter: "D",
    fill: "I",
    episodes: 8,
  }),
  "verification-a": Object.freeze({
    id: "verification-a",
    scenarioPrefix: "m3-test-cerulean-e",
    semanticFamily: "A",
    scope: "ev",
    slotPrefixes: Object.freeze(["au", "av", "aw", "az"]),
    suffix: ".p3v",
    needlePrefix: "MZ",
    tokenPrefix: "RZ",
    headerCharacter: "V",
    fill: "J",
    episodes: 12,
  }),
  "verification-b": Object.freeze({
    id: "verification-b",
    scenarioPrefix: "m3-test-obsidian-e",
    semanticFamily: "B",
    scope: "fw",
    slotPrefixes: Object.freeze(["bu", "bv", "bw", "bz"]),
    suffix: ".p3w",
    needlePrefix: "NW",
    tokenPrefix: "SW",
    headerCharacter: "W",
    fill: "K",
    episodes: 12,
  }),
});

export const P3_FEEDBACK_KINDS = Object.freeze(["N", "S", "E", "P"]);
export const P3_B_REVERSE_EPISODES = Object.freeze([2, 3, 5, 8, 10, 12]);

export function dec4(value) {
  return String(value).padStart(4, "0");
}

export function dec6(value) {
  return String(value).padStart(6, "0");
}

export function p3FeedbackKind(episode) {
  return P3_FEEDBACK_KINDS[(episode - 1) % 4];
}

export function p3HitSlot(partitionId, episode) {
  const partition = P3_PARTITIONS[partitionId];
  if (partition === undefined) throw new TypeError(`unknown P3 partition ${partitionId}`);
  return partitionId === "verification-b" && P3_B_REVERSE_EPISODES.includes(episode) ? 2 : 3;
}

export function p3Episode(partitionId, episode) {
  const partition = P3_PARTITIONS[partitionId];
  if (partition === undefined) throw new TypeError(`unknown P3 partition ${partitionId}`);
  if (!Number.isInteger(episode) || episode < 1 || episode > partition.episodes) {
    throw new TypeError(`P3 ${partitionId} episode must be 1..${partition.episodes}`);
  }
  const scenarioId = `${partition.scenarioPrefix}${dec4(episode)}`;
  const needle = `${partition.needlePrefix}${dec6(episode)}`;
  const hitSlot = p3HitSlot(partitionId, episode);
  const names = partition.slotPrefixes.map((prefix, slot) => {
    const token = slot === 3 ? needle : `${partition.tokenPrefix}${dec6(3 * (episode - 1) + slot + 1)}`;
    return `${prefix}-${token}${partition.suffix}`;
  });
  const contents = names.map((_, slot) => {
    const header = `${partition.headerCharacter}${dec4(episode)}${slot}QZ`;
    const initial = header + partition.fill.repeat(88);
    assert.equal(Buffer.byteLength(header, "utf8"), 8);
    assert.equal(Buffer.byteLength(initial, "utf8"), 96);
    return slot === hitSlot
      ? `${initial.slice(0, 16)}${needle}${initial.slice(24)}`
      : initial;
  });
  return Object.freeze({
    partition: partition.id,
    sourceGroup: scenarioId,
    scenarioId,
    semanticFamily: partition.semanticFamily,
    episode,
    requestId: Object.freeze({
      natural: `${scenarioId}-n`,
      forced: `${scenarioId}-f`,
    }),
    scope: partition.scope,
    suffix: partition.suffix,
    needle,
    hitSlot,
    feedbackKind: p3FeedbackKind(episode),
    names: Object.freeze(names),
    contents: Object.freeze(contents),
    paths: Object.freeze(names.map(name => `${partition.scope}/${name}`)),
    entries: Object.freeze([
      Object.freeze({ path: partition.scope, kind: "directory" }),
      ...names.map((name, slot) => Object.freeze({
        path: `${partition.scope}/${name}`,
        kind: "file",
        contents: contents[slot],
      })),
    ]),
  });
}

export function p3PartitionEpisodes(partitionId) {
  const partition = P3_PARTITIONS[partitionId];
  if (partition === undefined) throw new TypeError(`unknown P3 partition ${partitionId}`);
  return Object.freeze(Array.from({ length: partition.episodes }, (_, index) => p3Episode(partitionId, index + 1)));
}

export function p3Request(episode, directory, arm = "forced", cardinality = "one") {
  const requestId = cardinality === "one"
    ? episode.requestId[arm]
    : `${episode.requestId[arm]}-${cardinality}`;
  return {
    requestId,
    goal: {
      kind: "file.property",
      property: "file.property.content.bytes",
      target: {
        kind: "cli.content-search-scope",
        directory,
        fileCondition: { type: "regular", suffix: episode.suffix },
        cardinality,
        recursion: "flat",
      },
      requirement: {
        kind: "contains",
        predicate: { kind: "contains", needle: episode.needle, encoding: "utf8" },
      },
    },
    satisfactionThreshold: 100,
  };
}

export function p3SandboxRecipe(episode) {
  return Object.freeze({
    scenarioId: episode.scenarioId,
    entries: episode.entries,
    sessions: Object.freeze([{ id: "s", cwd: ".", grantedEffects: ["filesystem.read", "process.exec"] }]),
  });
}

export async function assertP3EpisodeOnDisk(episode, scenarioRoot, phase) {
  const scope = join(scenarioRoot, episode.scope);
  const entries = (await readdir(scope)).sort();
  assert.deepEqual(entries, [...episode.names].sort(), `${phase} scope entries`);
  for (let slot = 0; slot < 4; slot += 1) {
    const bytes = await readFile(join(scope, episode.names[slot]));
    assert.equal(bytes.length, 96, `${phase} slot ${slot} length`);
    assert.equal(bytes.toString("utf8"), episode.contents[slot], `${phase} slot ${slot} content`);
    assert.equal(bytes.indexOf(episode.needle), slot === episode.hitSlot ? 16 : -1, `${phase} slot ${slot} needle position`);
  }
  return true;
}

export function createP3Injection(episode, feedbackKind) {
  const counters = { shortRead: 0, eio: 0, listing: 0 };
  const slot0 = episode.names[0];
  let fileReadIo, listingObserver;
  if (feedbackKind === "S") {
    fileReadIo = {
      lstat: (path, options) => lstat(path, options),
      open: async (path, flags) => {
        const handle = await open(path, flags);
        const name = basename(path);
        return {
          stat: options => handle.stat(options),
          read: async (buffer, offset, length, position) => {
            if (name === slot0 && position === 0 && length === P3_CHUNK_SIZE && counters.shortRead === 0) {
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
  } else if (feedbackKind === "E") {
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
  } else if (feedbackKind === "P") {
    const keep = new Set([episode.names[0], episode.names[2], episode.names[3]]);
    listingObserver = async input => {
      counters.listing += 1;
      const result = await runDirectoryListHelper(input);
      if (!result.ok) return result;
      return {
        ok: true,
        observation: {
          ...result.observation,
          coverage: "partial",
          entries: result.observation.entries
            .filter(entry => keep.has(entry.name))
            .map(entry => ({ name: entry.name, path: entry.path, type: entry.type })),
          errors: [{ name: episode.names[1], code: "EACCES", message: "P3 enumeration denied" }],
        },
      };
    };
  }
  return Object.freeze({
    feedbackKind,
    counters,
    ...(fileReadIo === undefined ? {} : { fileReadIo }),
    ...(listingObserver === undefined ? {} : { listingObserver }),
  });
}
