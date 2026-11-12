import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

// Explicit audit suite, outside tests/*.test.mjs: no default-suite environment dependency.
const subject = process.env.NNANYTHING_AUDIT_SUBJECT;
if (!subject || !isAbsolute(subject)) throw new Error('NNANYTHING_AUDIT_SUBJECT must name an absolute candidate worktree');
const { runTsJsSymbolTable } = await import(pathToFileURL(join(subject, 'dist/adapters/cli/tsjs-symbol-table-adapter.js')));

async function observe(entry) {
  const root = await mkdtemp(join(tmpdir(), 'nnanything-ontology-lexical-'));
  try {
    await writeFile(join(root, 'factory.ts'), 'export function target(x: number) { return x; }\n');
    await writeFile(join(root, 'entry.ts'), entry);
    const output = await runTsJsSymbolTable({ repo: root, language: 'typescript', scope: ['.'], files: ['entry.ts', 'factory.ts'] });
    assert.equal(output.status, 'ok', JSON.stringify(output));
    const calls = output.result.lexicalCallSiteBindings.filter(x => x.calleeName === 'target');
    assert.equal(calls.length, 1, JSON.stringify(output.result.lexicalCallSiteBindings));
    return calls[0];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('G01 allow: unshadowed import keeps source module evidence', async () => {
  const call = await observe('import { target } from "./factory";\nexport const value = target(2);\n');
  assert.equal(call.sourceModuleFile, 'factory.ts', JSON.stringify(call));
});

test('G01 deny: for-of local binding cannot become imported source evidence', async () => {
  const call = await observe('import { target } from "./factory";\nconst callbacks = [(x: number) => x + 1];\nfor (const target of callbacks) { target(2); }\n');
  assert.notEqual(call.sourceModuleFile, 'factory.ts', JSON.stringify(call));
});
