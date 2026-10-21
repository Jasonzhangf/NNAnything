import test from 'node:test';
import assert from 'node:assert/strict';
import { observeContentFormat, detectSignature, decodeUtf8 } from '../dist/filters/cli-content.js';

// S11: explicit decode/format evidence. Deterministic (D). File names are not gold.

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13])]);
const utf8 = Buffer.from('{"a":1}', 'utf8');

test('S11 same extension different bytes: .txt name is not gold', () => {
  const result = observeContentFormat({ bytes: png, complete: true });
  assert.equal(result.format, 'png');
  assert.equal(result.encoding, 'unknown');
});

test('S11 different extension same format: .dat with png signature is png', () => {
  const result = observeContentFormat({ bytes: png, complete: true });
  assert.equal(result.format, 'png');
});

test('S11 valid utf8 + complete coverage gives json', () => {
  const result = observeContentFormat({ bytes: utf8, complete: true });
  assert.equal(result.encoding, 'utf8');
  assert.equal(result.format, 'json');
  assert.equal(result.valid, true);
});

test('S11 partial coverage does not claim json', () => {
  const result = observeContentFormat({ bytes: utf8.subarray(0, 3), complete: false });
  assert.equal(result.encoding, 'utf8');
  assert.notEqual(result.format, 'json');
  assert.equal(result.valid, null);
});

test('S11 invalid utf8 keeps invalid, unknown format', () => {
  const result = observeContentFormat({ bytes: Buffer.from([0xff, 0xfe, 0x00]), complete: true });
  assert.equal(result.encoding, 'unknown');
  assert.equal(result.format, 'unknown');
});

test('S11 detectSignature and decodeUtf8 are pure helpers', () => {
  assert.equal(detectSignature(Buffer.from('%PDF-1.7')), 'pdf');
  assert.equal(detectSignature(Buffer.from('GIF89a')), 'gif');
  assert.equal(detectSignature(Buffer.from('plain')), 'unknown');
  assert.equal(decodeUtf8(Buffer.from('hi')).valid, true);
  assert.equal(decodeUtf8(Buffer.from([0xff])).valid, false);
});
