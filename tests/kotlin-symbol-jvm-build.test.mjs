import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(TESTS_DIR);
const BIN = join(REPO_ROOT, "dist", "cli-call-depth-bin.js");
const BUILDER = join(REPO_ROOT, "scripts", "build-kotlin-symbol-jvm.mjs");
const JVM_DIR = join(REPO_ROOT, "dist", "adapters", "cli", "kotlin-symbol-jvm");
const FIXTURES = join(TESTS_DIR, "fixtures", "kotlin-symbols");

function envWithoutExplicitJars() {
  const env = { ...process.env };
  delete env.NN_CODE_KOTLIN_JARS;
  return env;
}

test("clean build compiles Kotlin JVM driver and public symbols route parses fixture", () => {
  const build = spawnSync(process.execPath, [BUILDER, "--clean"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: envWithoutExplicitJars(),
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const mainClass = join(JVM_DIR, "ExtractKotlinSymbols.class");
  assert.equal(existsSync(mainClass), true, mainClass);
  const classNames = readdirSync(JVM_DIR);
  assert.ok(classNames.includes("ExtractKotlinSymbols$OwnerInfo.class"));
  assert.ok(classNames.some(name => /^ExtractKotlinSymbols\$\d+\.class$/.test(name)));

  const result = spawnSync(process.execPath, [
    BIN,
    "symbols",
    "--repo", FIXTURES,
    "--language", "kotlin",
    "--scope", "kinds",
    "--compact",
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: envWithoutExplicitJars(),
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, "nnanything.cli-symbols.result.v1");
  assert.equal(payload.language, "kotlin");
  assert.equal(payload.parser.backend, "kotlin_psi_factory");
  assert.ok(payload.symbols.length > 0);
  assert.equal(payload.status, undefined);
  assert.equal(payload.reasonCode, undefined);
});
