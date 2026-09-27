// The room controls /artifacts and /workspace: a symlink there must never make the
// host list or serve a host file (found 2026-09-28: /artifacts/leak.txt -> /etc/os-release was served).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles, openInside, symlinkOnPath } from '../../src/safe-files.ts';

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sar-safe-')));
  const root = join(base, 'artifacts');
  const host = join(base, 'host');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(host);
  writeFileSync(join(host, 'secret.env'), 'TOKEN=host-secret');
  writeFileSync(join(root, 'ok.txt'), 'fine');
  writeFileSync(join(root, 'sub', 'nested.txt'), 'nested');
  symlinkSync(join(host, 'secret.env'), join(root, 'leak.txt'));
  symlinkSync(host, join(root, 'hostdir'));
  symlinkSync('ok.txt', join(root, 'inner-link.txt'));
  return { root };
}

test('listFiles skips symlinks (files and dirs), keeps regular files', () => {
  const { root } = fixture();
  assert.deepEqual(listFiles(root), ['ok.txt', 'sub/nested.txt']);
});

test('openInside serves regular files inside root', () => {
  const { root } = fixture();
  for (const [rel, want] of [['ok.txt', 'fine'], ['sub/nested.txt', 'nested']]) {
    const fd = openInside(root, rel);
    assert.ok(fd !== undefined, rel);
    assert.equal(readFileSync(fd!, 'utf8'), want);
    closeSync(fd!);
  }
});

test('openInside refuses symlinks, symlinked dirs, traversal and non-files', () => {
  const { root } = fixture();
  for (const rel of ['leak.txt', 'hostdir/secret.env', 'inner-link.txt', '../host/secret.env', '/etc/passwd', 'sub', '', 'missing.txt']) {
    assert.equal(openInside(root, rel), undefined, rel);
  }
});

test('symlinkOnPath: input files are never written through a symlink of a cloned repo', () => {
  const { root } = fixture();
  assert.equal(symlinkOnPath(root, 'hostdir/new.txt'), 'hostdir');
  assert.equal(symlinkOnPath(root, 'leak.txt'), 'leak.txt');
  assert.equal(symlinkOnPath(root, 'sub/new/deeper.txt'), undefined);
  assert.equal(symlinkOnPath(root, 'fresh.txt'), undefined);
});
