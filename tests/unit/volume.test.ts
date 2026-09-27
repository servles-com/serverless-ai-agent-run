import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDiskLimit, volumeFull } from '../../src/volume.ts';
import { cappedLog } from '../../src/rooms.ts';

test('limits.disk_mb: bounds, and rejected when quotas are off', () => {
  assert.equal(validateDiskLimit(undefined, false, 8192), undefined);
  assert.equal(validateDiskLimit(512, true, 8192), undefined);
  assert.match(validateDiskLimit(512, false, 8192)!, /not enabled/);
  for (const v of [8, 9000, 1.5, '512', -1]) assert.match(validateDiskLimit(v, true, 8192)!, /16\.\.8192/, String(v));
});

test('no volume mounted -> never "full"', () => assert.equal(volumeFull(mkdtempSync(join(tmpdir(), 'sar-vol-'))), false));

test('room log files stop growing at the cap, with one marker line', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sar-log-')), 'stdout.log');
  const log = cappedLog(file, 100);
  for (let i = 0; i < 50; i++) log.write(`line ${i} xxxxxxxx\n`);
  log.end();
  await new Promise(r => setTimeout(r, 50));
  const text = readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(text) < 100 + 60, `${Buffer.byteLength(text)} bytes`);
  assert.equal(text.match(/log truncated at 100 bytes/g)?.length, 1);
  assert.ok(text.startsWith('line 0 '));
});
