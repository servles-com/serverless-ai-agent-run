// `sar` CLI: argument parsing, request building and output formatting (pure parts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildRunRequest, formatEvent, formatStatus, sseParser, type Command } from '../../cli/sar.ts';

test('help: no args, help, --help, -h, and --help after a command', () => {
  for (const argv of [[], ['help'], ['--help'], ['-h'], ['status', 'x', '--help']]) {
    assert.deepEqual(parseArgs(argv), { cmd: 'help' }, argv.join(' '));
  }
});

test('run: minimal', () => {
  assert.deepEqual(parseArgs(['run', '--task', 'do it']), {
    cmd: 'run', task: 'do it', agent: undefined, model: undefined, files: [], repo: undefined,
    expectArtifacts: [], timeoutS: undefined, follow: false });
});

test('run: every option, repeatable flags, --x=v form', () => {
  const p = parseArgs(['run', '--task=fix it', '--agent', 'shell', '--model', 'm1', '--file', 'a/calc.py',
    '--file', 'local.txt=in/data.txt', '--repo', 'https://github.com/o/r@dev', '--expect-artifact', 'calc.py',
    '--expect-artifact=*.md', '--timeout', '60', '--follow']);
  assert.deepEqual(p, {
    cmd: 'run', task: 'fix it', agent: 'shell', model: 'm1',
    files: [{ path: 'a/calc.py', name: 'calc.py' }, { path: 'local.txt', name: 'in/data.txt' }],
    repo: { url: 'https://github.com/o/r', ref: 'dev' },
    expectArtifacts: ['calc.py', '*.md'], timeoutS: 60, follow: true });
});

test('run: repo without ref, and git@ URLs keep their @', () => {
  const repo = (r: string) => (parseArgs(['run', '--task', 't', '--repo', r]) as Extract<Command, { cmd: 'run' }>).repo;
  assert.deepEqual(repo('https://github.com/o/r'), { url: 'https://github.com/o/r' });
  assert.deepEqual(repo('git@github.com:o/r.git'), { url: 'git@github.com:o/r.git' });
  assert.deepEqual(repo('git@github.com:o/r.git@v1.2'), { url: 'git@github.com:o/r.git', ref: 'v1.2' });
});

test('run: usage errors', () => {
  const err = (argv: string[]) => (parseArgs(argv) as { error: string }).error;
  assert.match(err(['run']), /--task is required/);
  assert.match(err(['run', '--task', '  ']), /--task is required/);
  assert.match(err(['run', '--task']), /--task needs a value/);
  assert.match(err(['run', 'hello']), /unexpected argument: hello/);
  assert.match(err(['run', '--task', 't', '--nope']), /unknown option for 'sar run': --nope/);
  assert.match(err(['run', '--task', 't', '--timeout', '0']), /positive integer/);
  assert.match(err(['run', '--task', 't', '--timeout', '1.5']), /positive integer/);
  assert.match(err(['run', '--task', 't', '--follow=yes']), /takes no value/);
  assert.match(err(['run', '--task', 't', '--file', 'x=']), /PATH or PATH=NAME/);
  assert.match(err(['frobnicate']), /unknown command: frobnicate/);
});

test('status / logs / artifacts: id and flags', () => {
  assert.deepEqual(parseArgs(['status', 'run_abc-1']), { cmd: 'status', id: 'run_abc-1', json: false });
  assert.deepEqual(parseArgs(['status', '--json', 'r1']), { cmd: 'status', id: 'r1', json: true });
  assert.deepEqual(parseArgs(['logs', 'r1', '--follow']), { cmd: 'logs', id: 'r1', follow: true });
  assert.deepEqual(parseArgs(['artifacts', 'r1']), { cmd: 'artifacts', id: 'r1', get: undefined, out: undefined });
  assert.deepEqual(parseArgs(['artifacts', 'r1', '--get', 'sub/a b.txt', '--out', '-']),
    { cmd: 'artifacts', id: 'r1', get: 'sub/a b.txt', out: '-' });
});

test('status / logs / artifacts: usage errors', () => {
  const err = (argv: string[]) => (parseArgs(argv) as { error: string }).error;
  assert.match(err(['status']), /exactly one run id/);
  assert.match(err(['logs', 'a', 'b']), /exactly one run id/);
  assert.match(err(['status', '../etc']), /bad run id/);
  assert.match(err(['status', 'r1', '--follow']), /unknown option/);
  assert.match(err(['artifacts', 'r1', '--out', 'f']), /--out needs --get/);
});

test('cred: parsed as a stub regardless of arguments', () => {
  assert.deepEqual(parseArgs(['cred', 'put', 'GH', '--from-env', 'X']), { cmd: 'cred', sub: 'put' });
  assert.deepEqual(parseArgs(['cred']), { cmd: 'cred', sub: '' });
});

test('buildRunRequest: only set fields, files read through the callback', () => {
  const p = parseArgs(['run', '--task', 't', '--file', 'x.py=in/x.py', '--expect-artifact', 'out.txt', '--timeout', '30']) as Extract<Command, { cmd: 'run' }>;
  assert.deepEqual(buildRunRequest(p, path => `content of ${path}`), {
    task: 't', files: { 'in/x.py': 'content of x.py' }, expect: { artifacts: ['out.txt'] }, limits: { timeout_s: 30 } });
  assert.deepEqual(buildRunRequest(parseArgs(['run', '--task', 't']) as Extract<Command, { cmd: 'run' }>, () => ''), { task: 't' });
});

test('sseParser: split chunks, CRLF, comments and multi-line data', () => {
  const got: string[] = [];
  const feed = sseParser(d => got.push(d));
  feed(': ping\n\nid: 1\nevent: run.state\nda');
  feed('ta: {"a":1}\n\n');
  feed('id: 2\r\ndata: x\r\ndata: y\r\n\r\n');
  assert.deepEqual(got, ['{"a":1}', 'x\ny']);
});

test('formatEvent / formatStatus', () => {
  assert.equal(formatEvent({ seq: 3, ts: '2026-09-28T10:11:12.000Z', type: 'run.state', data: { state: 'RUNNING' } }),
    '   3 10:11:12 run.state        RUNNING');
  assert.match(formatEvent({ seq: 9, ts: 'x', type: 'run.completed', data: { state: 'FAILED', category: 'TIMEOUT' } }), /FAILED TIMEOUT$/);
  assert.match(formatEvent({ seq: 1, ts: 'x', type: 'agent.step', data: { n: 1 } }), /\{"n":1\}$/);
  const s = formatStatus({ id: 'r1', state: 'FAILED', result: { artifacts: ['a.txt'] },
    diagnosis: { category: 'EXPECTATION_NOT_MET', summary: 'no file', hints: ['check path'] } });
  assert.equal(s, 'r1  FAILED  EXPECTATION_NOT_MET\n  why: no file\n  hint: check path\n  artifacts: a.txt');
});
