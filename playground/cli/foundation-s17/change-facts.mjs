// S17: reproducible real-OS change comparison. Own sandbox only.
// Records before/after observations and derives changed/unchanged/unknown.
// Includes the counterexample "bytes changed while mtime stayed the same".
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, lstat, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSnapshots } from '../../../dist/filters/cli-change.js';

const root = await mkdtemp(join(tmpdir(), 'nn-s17c-'));
const out = {};
try {
  const file = join(root, 'f.txt');
  await writeFile(file, 'hello');
  // Normalize mtime to a whole millisecond before sampling so that utimes
  // can restore it exactly later.
  const fixedMtime = new Date(1_700_000_000_000);
  await utimes(file, fixedMtime, fixedMtime);
  const beforeStat = await lstat(file);
  const beforeBytes = (await readFile(file)).toString('base64');
  const before = {
    path: file,
    size: beforeStat.size,
    mtimeMs: beforeStat.mtimeMs,
    dev: String(beforeStat.dev),
    ino: String(beforeStat.ino),
    bytes: beforeBytes,
    coverageComplete: true,
  };

  // Case A: bytes changed, then restore the original mtime with utimes.
  await writeFile(file, 'world');
  await utimes(file, fixedMtime, fixedMtime);
  const afterStat = await lstat(file);
  const after = {
    path: file,
    size: afterStat.size,
    mtimeMs: afterStat.mtimeMs,
    dev: String(afterStat.dev),
    ino: String(afterStat.ino),
    bytes: (await readFile(file)).toString('base64'),
    coverageComplete: true,
  };
  const changedSameMtime = compareSnapshots(file, before, after);
  assert.equal(changedSameMtime.status, 'changed');
  assert.equal(changedSameMtime.mtimeSame, true, 'mtime restored to the same value');
  assert.equal(changedSameMtime.bytesSame, false, 'bytes differ');
  out.bytesChangedSameMtime = { mtimeSame: changedSameMtime.mtimeSame, bytesSame: changedSameMtime.bytesSame, status: changedSameMtime.status, beforeBytes: before.bytes, afterBytes: after.bytes };

  // Case B: object replaced (rm + recreate) without reading the new content.
  await rm(file);
  await writeFile(file, 'other');
  const replacedStat = await lstat(file);
  const replaced = {
    path: file,
    size: replacedStat.size,
    mtimeMs: replacedStat.mtimeMs,
    dev: String(replacedStat.dev),
    ino: String(replacedStat.ino),
    bytes: null,
    coverageComplete: false,
  };
  const replacedCompare = compareSnapshots(file, before, replaced);
  assert.equal(replacedCompare.status, 'unknown');
  assert.ok(replacedCompare.reasons.includes('object_replaced'));
  out.objectReplacedUnknown = { inoBefore: before.ino, inoAfter: replaced.ino, status: replacedCompare.status, reasons: replacedCompare.reasons };

  // Case C: untouched file stays unchanged.
  const untouchedStat = await lstat(file);
  const untouched = {
    path: file,
    size: untouchedStat.size,
    mtimeMs: untouchedStat.mtimeMs,
    dev: String(untouchedStat.dev),
    ino: String(untouchedStat.ino),
    bytes: null,
    coverageComplete: false,
  };
  const untouchedCompare = compareSnapshots(file, replaced, untouched);
  assert.equal(untouchedCompare.status, 'unknown'); // no byte coverage, no identity change
  out.untouchedSameObject = { inoBefore: replaced.ino, inoAfter: untouched.ino, status: untouchedCompare.status };

  console.log(JSON.stringify({ status: 'passed', out }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
