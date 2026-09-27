// G11 phase 1 end to end, with the deterministic shell agent emitting partial output:
// live SSE via the per-run stream token, ?types= filter, Last-Event-ID resume,
// transcript, coalesced webhook, and the scope probes of the stream token
// ("token of run A cannot read run B" + the paired "token of run A reads A").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BASE, explain, runAndWait, webhookReceiver } from '../lib/client.ts';

interface Frame { id?: number; event?: string; data?: { seq: number; type: string; data: Record<string, unknown> }; at: number }

async function sse(path: string, token: string, headers: Record<string, string> = {}): Promise<Frame[]> {
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(90_000) });
  assert.equal(res.status, 200, `${path}: HTTP ${res.status}`);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f: Frame = { at: Date.now() };
      for (const line of raw.split('\n')) {
        if (line.startsWith('id: ')) f.id = Number(line.slice(4));
        else if (line.startsWith('event: ')) f.event = line.slice(7);
        else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6));
      }
      if (f.event) frames.push(f);
    }
  }
  return frames;
}

const get = (path: string, token: string, method = 'GET') =>
  fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}` } });

test('stream: live partial output over SSE with the run token, filter, resume, transcript', async () => {
  const created = await api('POST', '/runs', { agent: 'shell',
    task: 'for i in 1 2 3 4 5; do echo "part-$i"; sleep 1; done; echo "err-line" >&2; echo stream-done' });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const { id, stream_token: token, links } = created.body;
  assert.equal(links.stream, `/runs/${id}/stream`);
  assert.match(token, /^sar_st_/);

  const frames = await sse(`/runs/${id}/stream?types=stdout,state`, token);
  const types = new Set(frames.map(f => f.event));
  assert.ok(types.has('agent.stdout') && types.has('run.state') && types.has('run.completed'), [...types].join(','));
  assert.ok(!types.has('room.stderr'), 'filtered out by ?types=');
  const lines = frames.filter(f => f.event === 'agent.stdout').map(f => String(f.data?.data.line));
  assert.deepEqual(lines, ['part-1', 'part-2', 'part-3', 'part-4', 'part-5', 'stream-done']);
  const first = frames.find(f => f.data?.data.line === 'part-1')!;
  const last = frames.find(f => f.data?.data.line === 'part-5')!;
  assert.ok(last.at - first.at >= 2500, `output arrived live, not in one lump at the end (${last.at - first.at} ms)`);
  assert.equal(frames.at(-1)?.event, 'run.completed');

  // Resume after a disconnect: only events after Last-Event-ID, then the stream closes.
  const cutAt = first.id!;
  const resumed = await sse(`/runs/${id}/stream`, token, { 'last-event-id': String(cutAt) });
  assert.ok(resumed.length > 0 && resumed.every(f => (f.id ?? 0) > cutAt), 'resume replays only newer events');
  assert.ok(resumed.some(f => f.event === 'room.stderr'), 'no filter → stderr included');
  assert.equal(resumed.at(-1)?.event, 'run.completed');

  const tr = await get(`/runs/${id}/transcript`, token);
  assert.equal(tr.status, 200);
  const md = await tr.text();
  assert.match(md, /> part-3/);
  assert.match(md, /completed: SUCCEEDED/);

  assert.equal((await api('GET', `/runs/${id}/stream?types=bogus`)).status, 400);
});

test('stream token scope: token of run A cannot read run B; reads its own run', async () => {
  const a = await api('POST', '/runs', { agent: 'shell', task: 'echo run-a > /artifacts/a.txt; echo a' });
  const b = await api('POST', '/runs', { agent: 'shell', task: 'echo run-b-private > /artifacts/b.txt; echo b' });
  const ta: string = a.body.stream_token;
  for (const id of [a.body.id, b.body.id]) {
    for (let i = 0; i < 240 && !['SUCCEEDED', 'FAILED'].includes((await api('GET', `/runs/${id}`)).body.state); i++) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Paired "can": A's token reads A.
  for (const p of ['events', 'transcript', 'artifacts', 'artifacts/a.txt']) {
    const r = await get(`/runs/${a.body.id}/${p}`, ta);
    assert.equal(r.status, 200, `own run ${p}: HTTP ${r.status}`);
  }
  assert.equal(await (await get(`/runs/${a.body.id}/artifacts/a.txt`, ta)).text(), 'run-a\n');
  const q = await fetch(`${BASE}/runs/${a.body.id}/events?access_token=${encodeURIComponent(ta)}`);
  assert.equal(q.status, 200, 'EventSource-style ?access_token= works for the stream token');

  // "cannot": B's data, anything not read-only, anything outside one run.
  for (const p of ['events', 'stream', 'transcript', 'artifacts', 'artifacts/b.txt']) {
    const r = await get(`/runs/${b.body.id}/${p}`, ta);
    assert.equal(r.status, 403, `run B ${p} with A's token: HTTP ${r.status}`);
    assert.ok(!(await r.text()).includes('run-b-private'));
  }
  assert.equal((await get('/runs', ta)).status, 403, 'list runs');
  assert.equal((await get(`/runs/${a.body.id}`, ta)).status, 403, 'run record (request body) not in scope');
  assert.equal((await get(`/runs/${a.body.id}/debug`, ta)).status, 403, 'debug bundle');
  assert.equal((await get(`/runs/${a.body.id}/cancel`, ta, 'POST')).status, 403, 'cancel');
  assert.equal((await get('/runs', ta, 'POST')).status, 403, 'create run');
  assert.equal((await get(`/runs/${a.body.id}/events`, ta + 'x')).status, 403, 'tampered token');
});

test('webhook agent_events "coalesced": ≤ 1 agent delivery per 2 s, nothing lost, lifecycle intact', async () => {
  const hook = await webhookReceiver('coalesce-secret');
  try {
    const run = await runAndWait({ agent: 'shell', webhook: { url: hook.url, secret: 'coalesce-secret', agent_events: 'coalesced' },
      task: 'for i in $(seq 1 40); do echo "line-$i"; sleep 0.1; done' });
    assert.equal(run.state, 'SUCCEEDED', explain(run));
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(hook.bad(), 0, 'signatures valid');
    const types: string[] = hook.events.map(e => e.type);
    assert.ok(!types.includes('agent.stdout'), 'raw agent events are not delivered one by one');
    const batches = hook.events.filter(e => e.type === 'agent.coalesced');
    assert.ok(batches.length >= 2 && batches.length <= 5, `batches: ${batches.length}`);
    const covered = batches.reduce((n, e) => n + e.data.count, 0);
    assert.equal(covered, 40, 'every agent event is counted in some batch');
    const times = batches.map(e => e.received_at as number);
    for (let i = 1; i < times.length - 1; i++) {
      assert.ok(times[i] - times[i - 1] >= 1800, `batches ${i - 1}→${i} only ${times[i] - times[i - 1]} ms apart`);
    }
    assert.equal(types.at(-1), 'run.completed');
    const seqs: number[] = hook.events.map(e => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'deliveries in seq order');
  } finally { hook.close(); }
});
