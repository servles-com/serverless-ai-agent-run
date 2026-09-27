// `sar` CLI against a running server (same setup as the other e2e suites:
// SAR_URL, SAR_API_TOKEN; needs docker + the room image). Runs the real binary
// as a subprocess and uses the deterministic `shell` agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE } from '../lib/client.ts';

const CLI = new URL('../../cli/sar.ts', import.meta.url).pathname;
const env = { ...process.env, SAR_URL: BASE, SAR_TOKEN: process.env.SAR_API_TOKEN ?? '' };

function sar(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env, cwd, timeout: 180_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });
}

test('cli: run --follow with input file and --expect-artifact, then status / logs / artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sar-cli-'));
  writeFileSync(join(dir, 'data.txt'), 'payload-cli-7');
  const run = await sar(['run', '--agent', 'shell', '--file', `${join(dir, 'data.txt')}=in/data.txt`,
    '--expect-artifact', 'copy.txt', '--follow',
    '--task', 'cat in/data.txt > /artifacts/copy.txt && echo cli-finished'], dir);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const id = run.stdout.split(/\s+/)[0];
  assert.match(run.stdout, / SUCCEEDED/);
  assert.match(run.stdout, /result: cli-finished/);
  assert.match(run.stderr, /run\.completed\s+SUCCEEDED/, 'events streamed over SSE');

  const status = await sar(['status', id, '--json']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).state, 'SUCCEEDED');

  const logs = await sar(['logs', id]);
  assert.equal(logs.code, 0, logs.stderr);
  assert.match(logs.stdout, /run\.state\s+RUNNING/);
  assert.match(logs.stdout, /run\.completed/);

  const logsFollow = await sar(['logs', id, '--follow']);
  assert.equal(logsFollow.code, 0, logsFollow.stderr);
  assert.match(logsFollow.stdout, /run\.completed/, 'follow on a finished run replays and exits');

  const list = await sar(['artifacts', id]);
  assert.equal(list.stdout.trim(), 'copy.txt');
  const get = await sar(['artifacts', id, '--get', 'copy.txt'], dir);
  assert.equal(get.code, 0, get.stderr);
  assert.equal(readFileSync(join(dir, 'copy.txt'), 'utf8'), 'payload-cli-7');
  const toStdout = await sar(['artifacts', id, '--get', 'copy.txt', '--out', '-']);
  assert.equal(toStdout.stdout, 'payload-cli-7');
});

test('cli: unmet --expect-artifact -> exit 1 with EXPECTATION_NOT_MET', async () => {
  const run = await sar(['run', '--agent', 'shell', '--expect-artifact', 'report.md', '--follow', '--task', 'echo "all done!"']);
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /FAILED\s+EXPECTATION_NOT_MET/);
});

test('cli: run without --follow prints only the run id', async () => {
  const run = await sar(['run', '--agent', 'shell', '--task', 'echo quick']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout.trim(), /^[A-Za-z0-9_-]+$/);
});

test('cli: API errors are readable, not stack traces', async () => {
  const missing = await sar(['status', 'no-such-run']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /404: run not found/);
  const badArt = await sar(['artifacts', 'no-such-run', '--get', 'x']);
  assert.equal(badArt.code, 1);
});

test('cli: cred put/request are explicit stubs', async () => {
  for (const sub of ['put', 'request']) {
    const r = await sar(['cred', sub, 'GITHUB_TOKEN']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not implemented yet.*#92.*zerocreds-server#63/);
  }
});
