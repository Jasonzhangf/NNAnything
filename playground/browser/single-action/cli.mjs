import { readFile } from "node:fs/promises";

export function parseArgs(argv, allowed) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!allowed.includes(name) || value === undefined || options.has(name)) {
      throw new Error(`Expected one value for each of: ${allowed.join(", ")}`);
    }
    options.set(name, value);
  }
  return options;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
