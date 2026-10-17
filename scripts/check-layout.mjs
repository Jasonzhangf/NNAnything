import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
const start = '<!-- root-layout:start -->', end = '<!-- root-layout:end -->';
const blocks = [...agents.matchAll(/<!-- root-layout:start -->\s*```text\r?\n([\s\S]*?)\r?\n```\s*<!-- root-layout:end -->/g)];
if (blocks.length !== 1 || agents.split(start).length !== 2 || agents.split(end).length !== 2) {
  throw new Error('AGENTS.md root-layout registration must contain one complete text block');
}
const allowed = new Set(blocks[0][1].split(/\r?\n/).map(name => name.trim()).filter(Boolean));
if (!allowed.size) throw new Error('AGENTS.md root-layout registration must not be empty');
const unknown = (await readdir(root)).filter(name => !allowed.has(name));
if (unknown.length) {
  console.error('Unregistered repository root entries:\n' + unknown.map(name => join(root, name)).join('\n'));
  console.error('Move each entry into its existing owner directory. If an authorized change needs a new root entry, register its responsibility in AGENTS.md before creating it.');
  process.exitCode = 1;
}
