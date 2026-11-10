// Controlled runtime contrast. The committed sources are left untouched; this
// script copies them into a disposable directory, instruments only the table
// member bodies to record which callable is reached, compiles, and runs the
// unchanged outer call sites with proof-side selectors. The reached callable
// identity is recorded both as the logged member key and as reference equality
// against the named table members.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const familyRoot = join(here, "..");
const srcDir = join(familyRoot, "src");
const receiptsDir = join(familyRoot, "receipts");
const tsc = "/Volumes/extension/code/NNAnything/node_modules/.bin/tsc";

const disposable = mkdtempSync(join(tmpdir(), "tsjs-clean-dev-runtime-"));
const disposableSrc = join(disposable, "src");
mkdirSync(disposableSrc, { recursive: true });
writeFileSync(join(disposable, "package.json"), JSON.stringify({ type: "module" }));

const committedSources = readdirSync(srcDir)
  .filter(name => name.endsWith(".ts"))
  .sort();

for (const name of committedSources) {
  copyFileSync(join(srcDir, name), join(disposableSrc, name));
}

// Instrument only dispatch.ts; the outer call sites in the caller files are
// byte-for-byte the committed sources.
writeFileSync(
  join(disposableSrc, "dispatch.ts"),
  `export type DispatchKey = "spell" | "chant";

export const reachedCallees: string[] = [];

export const dispatchTable = {
  spell: (payload: string): string => {
    reachedCallees.push("spell");
    return \`spell:\${payload}\`;
  },
  chant: (payload: string): number => {
    reachedCallees.push("chant");
    return payload.length;
  },
};

export function pickDispatch(selector: DispatchKey) {
  return dispatchTable[selector];
}
`,
);

writeFileSync(
  join(disposable, "driver.mjs"),
  `import { runDirect } from "./out/dv-c01-direct.js";
import { runAlias } from "./out/dv-c02-alias.js";
import { pickDispatch, dispatchTable, reachedCallees } from "./out/dispatch.js";

function probe(runner, selector, payload) {
  reachedCallees.length = 0;
  const output = runner(selector, payload);
  const reachedKeys = reachedCallees.slice();
  const callee = pickDispatch(selector);
  return {
    selector,
    output,
    reachedKeys,
    calleeName: callee.name,
    sameAsSpell: callee === dispatchTable.spell,
    sameAsChant: callee === dispatchTable.chant,
  };
}

const payload = "payload";
process.stdout.write(JSON.stringify({
  spellChantDistinct: dispatchTable.spell !== dispatchTable.chant,
  dvC01: [probe(runDirect, "spell", payload), probe(runDirect, "chant", payload)],
  dvC02: [probe(runAlias, "spell", payload), probe(runAlias, "chant", payload)],
}, null, 2));
`,
);

const compileArgs = [
  "--strict",
  "--target", "ES2022",
  "--module", "NodeNext",
  "--moduleResolution", "NodeNext",
  "--rootDir", disposableSrc,
  "--outDir", join(disposable, "out"),
  "--skipLibCheck",
  join(disposableSrc, "dv-c01-direct.ts"),
  join(disposableSrc, "dv-c02-alias.ts"),
  join(disposableSrc, "dispatch.ts"),
];

let compileOutput = "";
let compileExit = 0;
try {
  compileOutput = execFileSync(tsc, compileArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
  compileExit = error.status ?? 1;
  compileOutput = String(error.stdout ?? "") + String(error.stderr ?? "");
}

let runtimeOutput = "";
let runtimeExit = 0;
if (compileExit === 0) {
  try {
    runtimeOutput = execFileSync(process.execPath, [join(disposable, "driver.mjs")], {
      encoding: "utf8",
    });
  } catch (error) {
    runtimeExit = error.status ?? 1;
    runtimeOutput = String(error.stdout ?? "") + String(error.stderr ?? "");
  }
}

const receipt = {
  schema: "nnanything.tsjs.dev.runtime-contrast.v1",
  producedAt: new Date().toISOString(),
  nodeVersion: process.version,
  nodePath: process.execPath,
  tsc: {
    path: tsc,
    args: compileArgs,
    exit: compileExit,
    output: compileOutput,
  },
  disposableDirectory: disposable,
  committedSourcesUnchanged: true,
  instrumentedFiles: ["src/dispatch.ts"],
  instrumentation:
    "dispatch.ts member bodies push the reached member key into an exported log; caller call sites are unchanged.",
  probes: runtimeExit === 0 ? JSON.parse(runtimeOutput) : null,
  runtime: {
    exit: runtimeExit,
    stdout: runtimeOutput,
  },
};

mkdirSync(receiptsDir, { recursive: true });
writeFileSync(join(receiptsDir, "runtime-contrast-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

// Keep the raw process text for the run dir record.
writeFileSync(
  join(disposable, "raw-process.txt"),
  `compile exit=${compileExit}\n${compileOutput}\nruntime exit=${runtimeExit}\n${runtimeOutput}`,
);
