import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubSlug, repoAllowed, branchName, syncWorktree, PullRequestError } from '../../src/pullrequest.ts';

test('githubSlug parses https GitHub URLs only', () => {
  assert.equal(githubSlug('https://github.com/servles-com/universe-timeline'), 'servles-com/universe-timeline');
  assert.equal(githubSlug('https://github.com/a/b.git'), 'a/b');
  assert.equal(githubSlug('http://github.com/a/b'), undefined);
  assert.equal(githubSlug('https://evil.com/a/b'), undefined);
});

test('repoAllowed is an exact, case-insensitive allowlist', () => {
  assert.equal(repoAllowed('https://github.com/Servles-com/Universe-Timeline', ['servles-com/universe-timeline']), true);
  assert.equal(repoAllowed('https://github.com/servles-com/other', ['servles-com/universe-timeline']), false);
  assert.equal(repoAllowed('https://github.com/servles-com/universe-timeline', []), false);
});

test('branchName defaults to agent/<run> and rejects unsafe names', () => {
  assert.equal(branchName('run_1', {}), 'agent/run_1');
  assert.equal(branchName('run_1', { branch: 'agent/issue-7' }), 'agent/issue-7');
  for (const bad of ['../x', '/x', 'x/', 'a b', 'a;rm', 'x'.repeat(101)]) {
    assert.throws(() => branchName('run_1', { branch: bad }), PullRequestError, bad);
  }
});

test('syncWorktree copies files, never .git, keeps symlinks as links, removes deleted files', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ws-')), host = mkdtempSync(join(tmpdir(), 'host-'));
  mkdirSync(join(ws, '.git/hooks'), { recursive: true });
  writeFileSync(join(ws, '.git/hooks/pre-commit'), 'evil');
  mkdirSync(join(ws, 'data/events'), { recursive: true });
  writeFileSync(join(ws, 'data/events/a.json'), '{}');
  mkdirSync(join(ws, 'sub/.git'), { recursive: true });
  writeFileSync(join(ws, 'sub/.git/config'), 'evil');
  symlinkSync('/etc/passwd', join(ws, 'leak'));
  mkdirSync(join(host, '.git'));
  writeFileSync(join(host, '.git/HEAD'), 'ref: refs/heads/main');
  writeFileSync(join(host, 'old.txt'), 'deleted by agent');

  syncWorktree(ws, host);

  assert.equal(readFileSync(join(host, 'data/events/a.json'), 'utf8'), '{}');
  assert.equal(readFileSync(join(host, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main', 'host .git untouched');
  assert.equal(existsSync(join(host, '.git/hooks/pre-commit')), false, 'agent .git not copied');
  assert.equal(existsSync(join(host, 'sub/.git')), false, 'nested .git not copied');
  assert.equal(readlinkSync(join(host, 'leak')), '/etc/passwd', 'symlink copied as a link, not dereferenced');
  assert.equal(existsSync(join(host, 'old.txt')), false, 'files deleted by the agent are deleted');
});
