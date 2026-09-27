// Every way a run can die must end in the right state with the right diagnosis.
// Uses the deterministic `shell` agent so the failure is exactly what we injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, runAndWait, explain, webhookReceiver } from '../lib/client.ts';

test('health: docker, runtime and image are ready', async () => {
  const h = await api('GET', '/healthz');
  assert.equal(h.status, 200, JSON.stringify(h.body));
});

test('success: output, artifact, input files', async () => {
  const run = await runAndWait({ agent: 'shell', files: { 'in/data.txt': 'payload-42' },
    task: 'cat in/data.txt > /artifacts/copy.txt && echo finished-ok' });
  assert.equal(run.state, 'SUCCEEDED', explain(run));
  assert.equal(run.result.text, 'finished-ok');
  assert.deepEqual(run.result.artifacts, ['copy.txt']);
  const art = await fetch(`${process.env.SAR_URL ?? 'http://127.0.0.1:8787'}/runs/${run.id}/artifacts/copy.txt`,
    { headers: { authorization: `Bearer ${process.env.SAR_API_TOKEN ?? ''}` } });
  assert.equal(await art.text(), 'payload-42');
});

test('expect: promised artifact missing -> FAILED/EXPECTATION_NOT_MET, not SUCCEEDED', async () => {
  const run = await runAndWait({ agent: 'shell', expect: { artifacts: ['report.md'], json: ['data.json'] },
    task: 'echo "{broken" > /artifacts/data.json; echo "all done!"' });
  assert.equal(run.state, 'FAILED', explain(run));
  assert.equal(run.diagnosis.category, 'EXPECTATION_NOT_MET', explain(run));
  const ev = run.diagnosis.evidence.join('\n');
  assert.match(ev, /artifact missing: report\.md/);
  assert.match(ev, /json invalid: data\.json/);
});

test('expect: contract met -> SUCCEEDED', async () => {
  const run = await runAndWait({ agent: 'shell', expect: { artifacts: ['*.md'], json: ['data.json'], text: 'done' },
    task: 'echo "# r" > /artifacts/report.md; echo "{\\"ok\\":1}" > /artifacts/data.json; echo done' });
  assert.equal(run.state, 'SUCCEEDED', explain(run));
});

test('artifact symlink to a host file is neither listed nor served; the regular file is', async () => {
  const run = await runAndWait({ agent: 'shell',
    task: 'echo real > /artifacts/real.txt; ln -s /etc/os-release /artifacts/leak.txt; ln -s /etc /artifacts/etc; echo made' });
  assert.equal(run.state, 'SUCCEEDED', explain(run));
  assert.deepEqual(run.result.artifacts, ['real.txt']);
  assert.equal((await api('GET', `/runs/${run.id}/artifacts/leak.txt`)).status, 404);
  assert.equal((await api('GET', `/runs/${run.id}/artifacts/etc/os-release`)).status, 404);
  const ok = await api('GET', `/runs/${run.id}/artifacts/real.txt`);
  assert.equal(ok.status, 200);
  assert.equal(String(ok.body).trim(), 'real');
});

test('crash: non-zero exit -> AGENT_CRASHED with stderr evidence', async () => {
  const run = await runAndWait({ agent: 'shell', task: 'echo "boom: something broke" >&2; exit 3' });
  assert.equal(run.state, 'FAILED', explain(run));
  assert.equal(run.diagnosis.category, 'AGENT_CRASHED');
  assert.ok(run.diagnosis.evidence.some((e: string) => e.includes('boom')), explain(run));
});

test('timeout -> TIMED_OUT', async () => {
  const run = await runAndWait({ agent: 'shell', task: 'while true; do echo tick; sleep 1; done', limits: { timeout_s: 5 } });
  assert.equal(run.state, 'TIMED_OUT', explain(run));
});

test('silent hang -> IDLE_STALL', async () => {
  const run = await runAndWait({ agent: 'shell', task: 'echo start; sleep 600', limits: { idle_timeout_s: 4, timeout_s: 60 } });
  assert.equal(run.diagnosis?.category, 'IDLE_STALL', explain(run));
});

test('memory bomb -> OOM_KILLED', async () => {
  const run = await runAndWait({ agent: 'shell', limits: { memory_mb: 128 },
    task: 'python3 -c "a=[]\nwhile True: a.append(bytearray(10**7))"' });
  assert.equal(run.diagnosis?.category, 'OOM_KILLED', explain(run));
});

test('fork bomb is contained by pids limit and the room is torn down', async () => {
  const run = await runAndWait({ agent: 'shell', limits: { pids: 64, timeout_s: 20 },
    task: 'for i in $(seq 1 500); do sleep 300 & done; echo spawned; wait' });
  assert.ok(['FAILED', 'TIMED_OUT', 'SUCCEEDED'].includes(run.state), explain(run));
  const h = await api('GET', '/healthz');
  assert.equal(h.status, 200, 'host still healthy after fork bomb');
});

test('missing binary -> AGENT_BINARY_MISSING', async () => {
  const run = await runAndWait({ agent: 'shell', task: 'definitely-not-a-command --x' });
  assert.equal(run.diagnosis?.category, 'AGENT_BINARY_MISSING', explain(run));
});

test('cancel a running run', async () => {
  const created = await api('POST', '/runs', { agent: 'shell', task: 'while true; do echo x; sleep 1; done' });
  const id = created.body.id;
  for (let i = 0; i < 60; i++) {
    if ((await api('GET', `/runs/${id}`)).body.state === 'RUNNING') break;
    await new Promise(r => setTimeout(r, 500));
  }
  await new Promise(r => setTimeout(r, 1500));
  assert.equal((await api('POST', `/runs/${id}/cancel`)).status, 202);
  for (let i = 0; i < 60; i++) {
    const r = await api('GET', `/runs/${id}`);
    if (r.body.state === 'CANCELLED') return;
    await new Promise(res => setTimeout(res, 500));
  }
  assert.fail('run was not cancelled');
});

test('bad request is rejected up front', async () => {
  assert.equal((await api('POST', '/runs', { agent: 'shell' })).status, 400);
  assert.equal((await api('POST', '/runs', { agent: 'shell', task: 'x', files: { '../escape': 'x' } })).status, 400);
  assert.equal((await api('POST', '/runs', { agent: 'nope', task: 'x' })).status, 400);
  assert.equal((await api('POST', '/runs', { agent: 'shell', task: 'x', expect: { artifacts: ['../x'] } })).status, 400);
});

test('webhook: signed, ordered, ends with run.completed', async () => {
  const hook = await webhookReceiver('s3cret');
  try {
    const run = await runAndWait({ agent: 'shell', task: 'echo hi', webhook: { url: hook.url, secret: 's3cret' } });
    await new Promise(r => setTimeout(r, 1500));
    const types = hook.events.map(e => e.type);
    assert.equal(hook.bad(), 0, 'all signatures valid');
    assert.equal(types.at(-1), 'run.completed', types.join(','));
    assert.deepEqual(hook.events.map(e => e.seq), [...hook.events.map(e => e.seq)].sort((a, b) => a - b));
    assert.equal(run.state, 'SUCCEEDED');
  } finally { hook.close(); }
});

test('debug bundle explains a failure in one call', async () => {
  const run = await runAndWait({ agent: 'shell', task: 'echo "fatal: missing thing" >&2; exit 9' });
  const d = await api('GET', `/runs/${run.id}/debug`);
  assert.equal(d.body.diagnosis.category, 'AGENT_CRASHED');
  assert.ok(d.body.stderr_tail.some((l: string) => l.includes('fatal: missing thing')));
  assert.ok(d.body.docker.args.includes('--pids-limit'));
});

test('no room survives its run', async () => {
  const { execFileSync } = await import('node:child_process');
  const left = execFileSync(process.env.SAR_DOCKER_BIN ?? 'docker', ['ps', '-aq', '--filter', 'label=sar.room=1',
    '--filter', `label=sar.instance=${process.env.SAR_INSTANCE ?? 'main'}`]).toString().trim();
  assert.equal(left, '', `leftover rooms: ${left}`);
});
