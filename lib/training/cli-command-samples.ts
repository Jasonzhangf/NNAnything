import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expectRecord } from "../core/schema.js";
import { createCliFilesystemSandbox, type SandboxRecipe } from "../adapters/cli/filesystem-sandbox.js";
import { expectedCliCommand, type CliCommandHead, type CliCommandName } from "../filters/cli-command-policy.js";

export type CommandPartition = "train" | "development" | "verification";
export type CommandScenario = Readonly<{
  id: string; sourceGroup: string; partition: CommandPartition; recipe: SandboxRecipe; targetPath: string;
  expectedEntries: readonly Readonly<{ name: string; type: "file" | "directory" | "symlink" }>[];
}>;
export type CommandSample = Readonly<{
  id: string; scenarioId: string; sourceGroup: string; partition: CommandPartition; goalKind: string; expectedHead: CliCommandHead;
}>;
export type CliCommandDataset = Readonly<{ version: 1; scenarios: readonly CommandScenario[]; samples: readonly CommandSample[]; teacherEvidence?: readonly unknown[] }>;

const goalKinds = ["observe_cwd", "set_cwd", "list_directory", "unsupported_operation"];
const grants = ["filesystem.read", "process.exec", "session.write"] as const;

function scenario(id: string, partition: "train" | "development", start: string, target: string,
  files: readonly string[], directories: readonly string[], extra: SandboxRecipe["entries"] = []): CommandScenario {
  const directorySet = new Set<string>();
  function add(path: string) {
    if (path === "." || path === "") return;
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (path.includes("/")) add(parent);
    directorySet.add(path);
  }
  add(start); add(target); directories.forEach(name => add(join(target, name)));
  return { id, sourceGroup: id, partition, targetPath: target,
    recipe: { scenarioId: id, sessions: [
      { id: "s", cwd: start, grantedEffects: grants },
      { id: "other", cwd: start, grantedEffects: grants },
    ], entries: [
      ...[...directorySet].map(path => ({ path, kind: "directory" as const })),
      ...files.map(name => ({ path: join(target, name), kind: "file" as const, contents: "opaque fixture bytes" })), ...extra,
    ] },
    expectedEntries: [...files.map(name => ({ name, type: "file" as const })), ...directories.map(name => ({ name, type: "directory" as const }))],
  };
}

const scenarios: readonly CommandScenario[] = [
  scenario("train-empty-same-directory", "train", "empty", "empty", [], []),
  scenario("train-sibling-mixed", "train", "branches/left", "branches/right", ["one.txt"], ["empty-child"]),
  scenario("train-child-dot-files", "train", "parent", "parent/child", [".hidden", "visible", "notes.txt"], []),
  scenario("train-parent-with-descendants", "train", "outer/inner", "outer", [], ["inner"], [
    { path: "outer/inner/a", kind: "file", contents: "descendant a" }, { path: "outer/inner/b", kind: "file", contents: "descendant b" },
  ]),
  scenario("development-multibranch-space", "development", "begin/deep/a", "work space/target", ["alpha space", "beta", "gamma"], ["left", "right"]),
  scenario("development-extension-types", "development", "source/start", "ending/root", ["a", "b", "c", "d", "looks-like-folder"], ["folder.txt"]),
];

export function prepareCliCommandDataset(value: unknown, names: readonly CliCommandName[], partitions: readonly CommandPartition[] = ["train", "development"]) {
  const dataset = expectRecord(value, "command dataset");
  if (dataset.version !== 1 || !Array.isArray(dataset.scenarios) || !Array.isArray(dataset.samples)) throw new TypeError("Invalid command dataset");
  const groups = new Map<string, CommandPartition>(), sceneMap = new Map<string, CommandScenario>();
  for (const raw of dataset.scenarios) {
    const item = expectRecord(raw, "command scenario") as unknown as CommandScenario;
    if (typeof item.id !== "string" || typeof item.sourceGroup !== "string" || !partitions.includes(item.partition)) throw new TypeError("Invalid scenario identity/partition");
    if (sceneMap.has(item.id)) throw new TypeError("Duplicate scenario id");
    if (groups.has(item.sourceGroup) && groups.get(item.sourceGroup) !== item.partition) throw new TypeError("Source group crosses partitions");
    if (!Array.isArray(item.expectedEntries) || typeof item.targetPath !== "string" || !item.targetPath || isAbsolute(item.targetPath) || item.targetPath.includes("\0")) throw new TypeError("Invalid scenario target/teacher entries");
    const targetRelation = relative("/scene", resolve("/scene", item.targetPath));
    if (targetRelation === ".." || targetRelation.startsWith("../")) throw new TypeError("Scenario target escapes recipe");
    for (const entry of item.expectedEntries) if (typeof entry.name !== "string" || !entry.name || entry.name.includes("/") || entry.name.includes("\0") || !["file", "directory", "symlink"].includes(entry.type)) throw new TypeError("Invalid expected entry");
    if (new Set(item.expectedEntries.map(entry => entry.name)).size !== item.expectedEntries.length) throw new TypeError("Duplicate expected direct child");
    if (!item.recipe || item.recipe.scenarioId !== item.id) throw new TypeError("Scenario recipe identity differs");
    groups.set(item.sourceGroup, item.partition); sceneMap.set(item.id, item);
  }
  const ids = new Set<string>();
  const samples = dataset.samples.map(raw => {
    const item = expectRecord(raw, "command sample") as unknown as CommandSample;
    const scene = sceneMap.get(item.scenarioId);
    if (!scene || scene.partition !== item.partition || scene.sourceGroup !== item.sourceGroup || typeof item.id !== "string" || ids.has(item.id)) throw new TypeError("Invalid sample source/identity");
    if (typeof item.goalKind !== "string" || !item.goalKind) throw new TypeError("Explicit semantic goal kind required");
    const expected = expectedCliCommand({ kind: item.goalKind, session: "s" });
    if (item.expectedHead !== expected) throw new TypeError("Legacy binary labels conflict with shared semantic teacher");
    ids.add(item.id);
    return item;
  }).filter(item => item.expectedHead === "unsupported" || names.includes(item.expectedHead));
  return { dataset: dataset as unknown as CliCommandDataset, scenes: sceneMap, samples,
    train: samples.filter(row => row.partition === "train"), development: samples.filter(row => row.partition === "development"),
    verification: samples.filter(row => row.partition === "verification") };
}

export async function makeCliCommandFixture(options: Readonly<{ root: string }>) {
  const teacherEvidence = [];
  for (const scene of scenarios) {
    const sandbox = await createCliFilesystemSandbox({ root: options.root, recipe: scene.recipe, ownerGrantedEffects: ["filesystem.write"] });
    try {
      const target = join(sandbox.scenarioRoot, scene.targetPath), evidence = [];
      for (const entry of scene.expectedEntries) {
        const info = await lstat(join(target, entry.name));
        const observedType = info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "other";
        if (observedType !== entry.type) throw new Error("Fixture teacher type differs from actual OS type");
        evidence.push({ ...entry, observedType });
      }
      teacherEvidence.push({ scenarioId: scene.id, physicalStart: await realpath(sandbox.getSession(sandbox.bindSession("s")).cwd), physicalTarget: await realpath(target), entries: evidence });
    } finally { await sandbox.cleanup(); }
  }
  const dataset: CliCommandDataset = { version: 1, scenarios, teacherEvidence,
    samples: scenarios.flatMap(scene => goalKinds.map((goalKind, index) => ({ id: `${scene.id}-${index}`, scenarioId: scene.id, sourceGroup: scene.sourceGroup,
      partition: scene.partition, goalKind, expectedHead: expectedCliCommand({ kind: goalKind, session: "s" }) }))) };
  prepareCliCommandDataset(dataset, ["pwd", "cd", "ls"]);
  return { dataset, teacherEvidence };
}
