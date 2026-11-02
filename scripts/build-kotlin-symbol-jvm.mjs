import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = path.join(ROOT, "lib", "adapters", "cli", "kotlin-symbol-jvm", "ExtractKotlinSymbols.java");
const OUTPUT_DIR = path.join(ROOT, "dist", "adapters", "cli", "kotlin-symbol-jvm");
const REQUIRED_KOTLIN_ARTIFACTS = Object.freeze([
  "kotlin-compiler-embeddable",
  "kotlin-stdlib",
  "kotlinx-coroutines-core-jvm",
  "trove4j",
]);
const CACHE_SEARCH_MAX_DIRECTORIES = 20_000;
const CACHE_SEARCH_MAX_DEPTH = 8;

function artifactVersion(base, name) {
  if (!base.startsWith(`${name}-`) || !base.endsWith(".jar")) return null;
  const stem = base.slice(name.length + 1, -".jar".length);
  if (stem.endsWith("-sources") || stem.endsWith("-javadoc") || stem.endsWith("-tests")) return null;
  if (!/^[0-9]/.test(stem)) return null;
  return stem;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function cacheRoots() {
  const gradleHome = process.env.GRADLE_USER_HOME ?? path.join(homedir(), ".gradle");
  return Object.freeze([
    path.join(gradleHome, "caches", "modules-2", "files-2.1"),
    path.join(homedir(), ".m2", "repository"),
  ]);
}

function collectArtifactJars(root, buckets) {
  const stack = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (stack.length > 0 && scanned < CACHE_SEARCH_MAX_DIRECTORIES) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    scanned += 1;
    if (current.depth >= CACHE_SEARCH_MAX_DEPTH) continue;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        for (const name of REQUIRED_KOTLIN_ARTIFACTS) {
          if (artifactVersion(entry.name, name) !== null) {
            const bucket = buckets.get(name) ?? [];
            bucket.push(full);
            buckets.set(name, bucket);
          }
        }
      }
    }
  }
}

function selectNewest(candidates, artifactName) {
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map(file => ({ file, version: artifactVersion(path.basename(file), artifactName) ?? "" }))
    .sort((left, right) => compareVersions(right.version, left.version));
  return ranked[0]?.file ?? null;
}

function resolveExplicitJars(candidates) {
  const invalid = [];
  const missing = [];
  for (const name of REQUIRED_KOTLIN_ARTIFACTS) {
    const matches = candidates.filter(jar => artifactVersion(path.basename(jar), name) !== null);
    if (matches.length === 0) {
      missing.push(name);
    } else if (matches.length > 1) {
      invalid.push(`${name}: ${matches.join(", ")}`);
    }
  }
  return { jars: [...candidates], invalid, missing };
}

function resolveJars() {
  const explicit = process.env.NN_CODE_KOTLIN_JARS;
  if (explicit !== undefined && explicit.trim().length > 0) {
    const candidates = explicit.split(path.delimiter).map(value => value.trim()).filter(value => value.length > 0);
    return resolveExplicitJars(candidates);
  }

  const buckets = new Map();
  for (const name of REQUIRED_KOTLIN_ARTIFACTS) buckets.set(name, []);
  for (const root of cacheRoots()) {
    if (!existsSync(root)) continue;
    collectArtifactJars(root, buckets);
  }
  const jars = [];
  const missing = [];
  for (const name of REQUIRED_KOTLIN_ARTIFACTS) {
    const chosen = selectNewest(buckets.get(name) ?? [], name);
    if (chosen === null) missing.push(name);
    else jars.push(chosen);
  }
  return { jars, invalid: [], missing };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--clean")) {
  fail(`unknown argument: ${args.find(arg => arg !== "--clean")}`);
}

const resolved = resolveJars();
if (resolved.invalid.length > 0) {
  const details = [`ambiguous Kotlin JVM artifacts: ${resolved.invalid.join("; ")}`];
  if (resolved.missing.length > 0) details.push(`missing required Kotlin JVM artifacts: ${resolved.missing.join(", ")}`);
  fail(details.join("; "));
}
if (resolved.missing.length > 0) {
  fail(`missing required Kotlin JVM artifacts: ${resolved.missing.join(", ")}`);
}

const javaHome = process.env.JAVA_HOME?.trim();
const javac = javaHome !== undefined && javaHome.length > 0
  ? path.join(javaHome, "bin", "javac")
  : "javac";
const classpath = resolved.jars.join(path.delimiter);
const clean = args.includes("--clean");
mkdirSync(path.join(ROOT, "dist"), { recursive: true });
const compileDir = clean
  ? mkdtempSync(path.join(ROOT, "dist", ".kotlin-symbol-jvm-build-"))
  : OUTPUT_DIR;
mkdirSync(compileDir, { recursive: true });
const compile = spawnSync(javac, ["-cp", classpath, "-d", compileDir, SOURCE], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
if (clean && (compile.error !== undefined || compile.status !== 0)) {
  rmSync(compileDir, { recursive: true, force: true });
}
if (compile.error !== undefined) {
  fail(`failed to start javac: ${compile.error.message}`);
}
if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}
if (clean) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const generated = new Set(readdirSync(compileDir));
  const names = [...generated].sort((left, right) => {
    if (left === "ExtractKotlinSymbols.class") return 1;
    if (right === "ExtractKotlinSymbols.class") return -1;
    return left.localeCompare(right);
  });
  for (const name of names) {
    renameSync(path.join(compileDir, name), path.join(OUTPUT_DIR, name));
  }
  for (const name of readdirSync(OUTPUT_DIR)) {
    if (!generated.has(name)) rmSync(path.join(OUTPUT_DIR, name), { recursive: true, force: true });
  }
  rmSync(compileDir, { recursive: true, force: true });
}
