// Compile ExtractJavaSymbols.java to dist/adapters/cli/java-symbol-jvm using
// a JDK 17+ javac. This build is intentionally free of --add-exports and
// --add-opens because the Java driver only uses the publicly exported
// javax.tools and com.sun.source packages.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = path.join(ROOT, "lib", "adapters", "cli", "java-symbol-jvm", "ExtractJavaSymbols.java");
const OUTPUT_DIR = path.join(ROOT, "dist", "adapters", "cli", "java-symbol-jvm");
const REQUIRED_JAVA_MAJOR = 17;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function probeJavac(candidate) {
  if (!existsSync(candidate)) return null;
  const run = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (run.error !== undefined || run.status !== 0) return null;
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const match = /javac\s+(\d+)/i.exec(output) ?? /version\s+"?(\d+)/i.exec(output);
  if (match === null) return null;
  const major = Number.parseInt(match[1] ?? "0", 10);
  if (!Number.isSafeInteger(major) || major < REQUIRED_JAVA_MAJOR) return null;
  return candidate;
}

function resolveJavac() {
  const candidates = [];
  const explicit = process.env.NN_CODE_JAVAC_BIN;
  if (explicit !== undefined && explicit.trim().length > 0) {
    candidates.push({ path: explicit.trim(), explicit: true });
  }
  const javaBin = process.env.NN_CODE_JAVA_BIN ?? process.env.NN_CODE_KOTLIN_JAVA_BIN;
  if (javaBin !== undefined && javaBin.length > 0) {
    candidates.push({ path: path.join(path.dirname(javaBin), "javac"), explicit: false });
  }
  const javaHome = process.env.JAVA_HOME;
  if (javaHome !== undefined && javaHome.trim().length > 0) {
    candidates.push({ path: path.join(javaHome.trim(), "bin", "javac"), explicit: false });
  }
  candidates.push({ path: "/opt/homebrew/opt/openjdk@17/bin/javac", explicit: false });
  candidates.push({ path: "/opt/homebrew/opt/openjdk/bin/javac", explicit: false });
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue;
    candidates.push({ path: path.join(dir, "javac"), explicit: false });
  }

  for (const candidate of candidates) {
    const found = probeJavac(candidate.path);
    if (found !== null) return found;
    if (candidate.explicit) {
      fail(`invalid NN_CODE_JAVAC_BIN (${candidate.path}): expected JDK ${REQUIRED_JAVA_MAJOR}+ javac`);
    }
  }
  fail(`missing required JDK ${REQUIRED_JAVA_MAJOR}+ compiler (javac): checked NN_CODE_JAVAC_BIN, JAVA_HOME, /opt/homebrew/opt/openjdk@17/bin/javac, and PATH`);
}

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--clean")) {
  fail(`unknown argument: ${args.find(arg => arg !== "--clean")}`);
}
const clean = args.includes("--clean");
const javac = resolveJavac();

mkdirSync(path.join(ROOT, "dist"), { recursive: true });
const staging = clean
  ? mkdtempSync(path.join(ROOT, "dist", ".java-symbol-jvm-build-"))
  : null;
const compileDir = staging ?? OUTPUT_DIR;
mkdirSync(compileDir, { recursive: true });
const compile = spawnSync(javac, ["--release", "17", "-encoding", "UTF-8", "-d", compileDir, SOURCE], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (compile.stdout) process.stdout.write(compile.stdout);
if (compile.stderr) process.stderr.write(compile.stderr);
if (staging !== null && (compile.error !== undefined || compile.status !== 0)) {
  rmSync(staging, { recursive: true, force: true });
}
if (compile.error !== undefined) {
  fail(`failed to start javac: ${compile.error.message}`);
}
if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

if (staging !== null) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const generated = new Set(readdirSync(staging));
  const names = [...generated].sort((left, right) => {
    if (left === "ExtractJavaSymbols.class") return 1;
    if (right === "ExtractJavaSymbols.class") return -1;
    return left.localeCompare(right);
  });
  for (const name of names) {
    renameSync(path.join(staging, name), path.join(OUTPUT_DIR, name));
  }
  for (const name of readdirSync(OUTPUT_DIR)) {
    if (!generated.has(name)) rmSync(path.join(OUTPUT_DIR, name), { recursive: true, force: true });
  }
  rmSync(staging, { recursive: true, force: true });
}
