import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claim, fingerprint, gcIdem, idemFile, validateKey } from '../../src/idem.ts';

const HOUR = 3600_000;
const T0 = Date.parse('2026-09-28T12:00:00Z');

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sar-idem-'));
  try { fn(join(dir, 'idem')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('validateKey accepts visible ASCII up to 255 chars and rejects the rest', () => {
  assert.equal(validateKey('a1b2-c3_d4:e5'), undefined);
  assert.equal(validateKey('x'.repeat(255)), undefined);
  for (const bad of [undefined, 42, '', 'x'.repeat(256), 'has space', 'tab\t', 'ключ']) {
    assert.ok(validateKey(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('fingerprint ignores key order and undefined fields, sees any value change', () => {
  assert.equal(fingerprint({ task: 't', limits: { a: 1, b: 2 } }), fingerprint({ limits: { b: 2, a: 1 }, task: 't', x: undefined }));
  assert.notEqual(fingerprint({ task: 't' }), fingerprint({ task: 'u' }));
  assert.notEqual(fingerprint({ files: ['a', 'b'] }), fingerprint({ files: ['b', 'a'] }));
  assert.notEqual(fingerprint({ n: 1 }), fingerprint({ n: '1' }));
});

test('first claim creates, same body replays the original id, other body conflicts', () => withDir(dir => {
  const fp = fingerprint({ task: 't' });
  const first = claim(dir, { scope: 'runs', key: 'k1', id: 'run_1', fingerprint: fp }, 72 * HOUR, T0);
  assert.equal(first.status, 'created');
  assert.equal(first.record.id, 'run_1');

  const again = claim(dir, { scope: 'runs', key: 'k1', id: 'run_2', fingerprint: fp }, 72 * HOUR, T0 + HOUR);
  assert.equal(again.status, 'replay');
  assert.equal(again.record.id, 'run_1');

  const other = claim(dir, { scope: 'runs', key: 'k1', id: 'run_3', fingerprint: fingerprint({ task: 'u' }) }, 72 * HOUR, T0 + HOUR);
  assert.equal(other.status, 'conflict');
  assert.equal(other.record.id, 'run_1');

  // Only the record itself is left: no temp files.
  assert.deepEqual(readdirSync(dir), [idemFile(dir, 'runs', 'k1').split('/').pop()]);
}));

test('the same key in another scope is a different record', () => withDir(dir => {
  const fp = fingerprint({});
  assert.equal(claim(dir, { scope: 'runs', key: 'k', id: 'run_1', fingerprint: fp }, HOUR, T0).status, 'created');
  const b = claim(dir, { scope: 'batches', key: 'k', id: 'batch_1', fingerprint: fp }, HOUR, T0);
  assert.equal(b.status, 'created');
  assert.equal(b.record.id, 'batch_1');
}));

test('the file name is a hash: the raw key never reaches the disk path', () => withDir(dir => {
  const file = idemFile(dir, 'runs', '../../etc/passwd');
  assert.match(file.slice(dir.length + 1), /^[0-9a-f]{64}$/);
}));

test('an expired record is replaced by a fresh claim', () => withDir(dir => {
  const fp = fingerprint({ task: 't' });
  claim(dir, { scope: 'runs', key: 'k', id: 'run_old', fingerprint: fp }, 72 * HOUR, T0);
  const later = claim(dir, { scope: 'runs', key: 'k', id: 'run_new', fingerprint: fp }, 72 * HOUR, T0 + 72 * HOUR);
  assert.equal(later.status, 'created');
  assert.equal(later.record.id, 'run_new');
  assert.equal(JSON.parse(readFileSync(idemFile(dir, 'runs', 'k'), 'utf8')).id, 'run_new');
}));

test('an unreadable record does not block the key forever', () => withDir(dir => {
  claim(dir, { scope: 'runs', key: 'k', id: 'run_1', fingerprint: 'f' }, HOUR, T0);
  writeFileSync(idemFile(dir, 'runs', 'k'), '{broken');
  const c = claim(dir, { scope: 'runs', key: 'k', id: 'run_2', fingerprint: 'f' }, HOUR, T0);
  assert.equal(c.status, 'created');
  assert.equal(c.record.id, 'run_2');
}));

test('gcIdem drops expired records and stale temp files, keeps live ones', () => withDir(dir => {
  claim(dir, { scope: 'runs', key: 'old', id: 'run_old', fingerprint: 'f' }, 72 * HOUR, T0);
  claim(dir, { scope: 'runs', key: 'new', id: 'run_new', fingerprint: 'f' }, 72 * HOUR, T0 + 48 * HOUR);
  const staleTmp = join(dir, '.tmp-deadbeef');
  writeFileSync(staleTmp, '{');
  utimesSync(staleTmp, T0 / 1000, T0 / 1000);
  const freshTmp = join(dir, '.tmp-cafebabe');
  writeFileSync(freshTmp, '{');
  utimesSync(freshTmp, (T0 + 50 * HOUR) / 1000, (T0 + 50 * HOUR) / 1000);

  assert.equal(gcIdem(dir, 72 * HOUR, T0 + 73 * HOUR), 2);
  assert.deepEqual(readdirSync(dir).sort(), [idemFile(dir, 'runs', 'new').split('/').pop(), '.tmp-cafebabe'].sort());
  assert.equal(gcIdem(join(dir, 'missing'), HOUR, T0), 0);
}));
