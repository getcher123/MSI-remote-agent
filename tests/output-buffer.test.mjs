import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputBuffer } from '../server/lib/output-buffer.mjs';

test('full output and empty stream are not truncated', () => {
  const b = new OutputBuffer(100);
  assert.equal(b.read().truncated, false);
  b.append('AIHUB_RETEST_WIN_712A');
  assert.equal(b.read(0, 2000).truncated, false);
  assert.equal(b.read(b.total, 2000).truncated, false);
  assert.equal(b.read(b.total, 2000).text, '');
});
test('pagination has precise more flags and absolute offsets', () => {
  const b = new OutputBuffer(100); b.append('abcdefgh');
  const a = b.read(0, 3), c = b.read(a.next, 5);
  assert.equal(a.text, 'abc'); assert.equal(a.hasMore, true); assert.equal(a.truncated, true);
  assert.equal(c.text, 'defgh'); assert.equal(c.next, 8); assert.equal(c.truncated, false);
});
test('rolling tail does not reset offsets or silently hide lost output', () => {
  const b = new OutputBuffer(5); b.append('12345'); b.append('678');
  const p = b.read(0, 100);
  assert.equal(p.text, '45678'); assert.equal(p.base, 3); assert.equal(p.total, 8);
  assert.equal(p.lost, 3); assert.equal(p.truncated, true); assert.equal(p.hasMore, false);
  b.append('9');
  assert.equal(b.read(p.next, 100).text, '9'); assert.equal(b.read(9, 100).truncated, false);
});
test('past-end offset cannot cause infinite pagination', () => {
  const b = new OutputBuffer(10); b.append('abc');
  const p = b.read(99, 10); assert.equal(p.next, 3); assert.equal(p.text, ''); assert.equal(p.truncated, false);
});
test('UTF-16 offset definition is stable for Russian and emoji', () => {
  const b = new OutputBuffer(100); b.append('Я🙂x');
  assert.equal(b.total, 4); assert.equal(b.read(3, 5).text, 'x');
});
test('ring truncation does not retain a lone low surrogate', () => {
  const b = new OutputBuffer(2); b.append('🙂x');
  assert.equal(b.text, 'x'); assert.equal(b.base, 2);
});
test('invalid limits and offsets fail explicitly', () => {
  assert.throws(() => new OutputBuffer(0)); const b = new OutputBuffer(10);
  for (const n of [-1, NaN, 1.5]) assert.throws(() => b.read(n));
  assert.throws(() => b.read(0, -1)); assert.throws(() => b.read(0, 200001));
});
