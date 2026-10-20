import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 全仓基线必须显式给齐真实资产；缺一项就非零退出，不以 skip 冒充通过。
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const required = [
  ["NN_HANDWIRED_ROOT", "directory"],
  ["NN_CLI_COMMAND_PROFILE", "file"],
  ["NN_CWD_RELATION_PROFILE", "file"],
];
const invalid = required.filter(([name, kind]) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0 || !existsSync(value)) return true;
  const stats = statSync(value);
  return kind === "directory" ? !stats.isDirectory() : !stats.isFile();
});

if (invalid.length > 0) {
  console.error("test:full needs explicit real assets. Missing or invalid:");
  for (const [name] of invalid) console.error(`  ${name}`);
  console.error("");
  console.error("Environment used for the recorded baseline:");
  console.error("  NN_HANDWIRED_ROOT=/Volumes/extension/code/handwired");
  console.error("  NN_CLI_COMMAND_PROFILE=<repo>/training/weights/filesystem/command/<run>/candidate.json");
  console.error("  NN_CWD_RELATION_PROFILE=<repo>/training/weights/filesystem/cwd/<run>/relation-candidate.json");
  process.exit(2);
}

const testFiles = readdirSync(join(root, "tests"))
  .filter(name => name.endsWith(".test.mjs"))
  .sort()
  .map(name => join(root, "tests", name));

const child = spawnSync(process.execPath, ["--test", ...testFiles], { cwd: root, stdio: "inherit" });
process.exit(child.status ?? 1);