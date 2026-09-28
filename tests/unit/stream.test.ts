// G11 phase 1: webhook coalescing, redaction before fan-out, stream-token scope,
// ?types= filter and transcript rendering (src/stream.ts).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SAR_DATA_DIR = mkdtempSync(join(tmpdir(), 'sar-stream-'));
const { Coalescer, summarize, parseTypes, renderTranscript, issueStreamToken, streamTokenAllows, STREAM_TOKEN_PREFIX } = await import('../../src/stream.ts');
const { bus, createRun, emit, getRun, runDir } = await import('../../src/store.ts');
const { setSecrets, PLACEHOLDER } = await import('../../src/redact.ts');
type RunEvent = import('../../src/store.ts').RunEvent;

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): RunEvent =>
  ({ seq, ts: `2026-09-28T10:00:${String(seq).padStart(2, '0')}.000Z`, run_id: 'run_x', type, data });

function coalescerHarness(intervalMs = 2000) {
  let now = 0;
  const sent: { at: number; ev: RunEvent }[] = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  const c = new Coalescer({ intervalMs, now: () => now, send: e => sent.push({ at: now, ev: e }) });
  const tick = (ms: number) => { now += ms; mock.timers.tick(ms); };
  return { c, sent, tick, done: () => mock.timers.reset() };
}

test('coalescer: first event goes out at once, a burst becomes one batch per interval', () => {
  const h = coalescerHarness();
  try {
    h.c.push(ev(1, 'agent.stdout', { line: 'a' }));
    assert.equal(h.sent.length, 1, 'leading event not delayed');
    for (let i = 2; i <= 30; i++) { h.tick(100); h.c.push(ev(i, 'agent.stdout', { line: `l${i}` })); }
    // 2.9 s of events at 10/s → one trailing batch at t=2000; the rest is still pending.
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1].at, 2000);
    h.tick(2000);
    assert.equal(h.sent.length, 3);
    const gaps = h.sent.slice(1).map((s, i) => s.at - h.sent[i].at);
    assert.ok(gaps.every(g => g >= 2000), `deliveries closer than 2 s: ${gaps}`);
    const covered = h.sent.flatMap(s => { const d = s.ev.data as { from_seq: number; to_seq: number }; return [d.from_seq, d.to_seq]; });
    assert.deepEqual([covered[0], covered.at(-1)], [1, 30], 'every event is covered, none lost');
    assert.equal(h.sent[2].ev.type, 'agent.coalesced');
    assert.equal(h.sent[2].ev.seq, 30, 'batch carries the seq of its last event');
    assert.equal(h.sent[1].ev.data.flushed_at, new Date(2000).toISOString(), 'send time is stamped');
  } finally { h.done(); }
});

test('coalescer: flush() sends the pending batch now (before a lifecycle event) and is a no-op when empty', () => {
  const h = coalescerHarness();
  try {
    h.c.push(ev(1, 'agent.text', { text: 'x' }));
    h.tick(500);
    h.c.push(ev(2, 'agent.tool', { tool: 'bash', status: 'running' }));
    assert.equal(h.sent.length, 1);
    h.c.flush();
    assert.equal(h.sent.length, 2);
    h.c.flush();
    h.tick(5000);
    assert.equal(h.sent.length, 2, 'no empty batches, no stray timer');
  } finally { h.done(); }
});

test('summarize: counts, last text/tool, caps the event list', () => {
  const evs = [ev(1, 'agent.text', { text: 'thinking' }), ev(2, 'agent.tool', { tool: 'bash', status: 'completed' }),
    ...Array.from({ length: 60 }, (_, i) => ev(3 + i, 'agent.stdout', { line: `out ${i}` }))];
  const b = summarize(evs, 50);
  assert.equal(b.count, 62);
  assert.equal(b.events.length, 50);
  assert.equal(b.dropped, 12);
  assert.deepEqual(b.last_tool, { tool: 'bash', status: 'completed' });
  assert.equal(b.last_text, 'out 59');
  assert.equal(b.counts['agent.stdout'], 60);
});

test('redaction before fan-out: bus listeners, events.jsonl and coalesced batches never see the secret', () => {
  const secret = 'sk-stream-fanout-secret-777';
  setSecrets([secret]);
  const rec = createRun({ agent: 'opencode', task: 'x' });
  const seen: RunEvent[] = [];
  const on = (e: RunEvent) => seen.push(e);
  bus.on(rec.id, on);
  try {
    emit(rec.id, 'agent.stdout', { line: `token=${secret}` });
  } finally { bus.off(rec.id, on); }
  assert.equal(seen[0].data.line, `token=${PLACEHOLDER}`);
  assert.ok(!readFileSync(join(runDir(rec.id), 'events.jsonl'), 'utf8').includes(secret));
  // Even an unredacted event handed straight to the coalescer comes out scrubbed.
  const b = summarize([ev(1, 'agent.stdout', { line: secret })]);
  assert.ok(!JSON.stringify(b).includes(secret));
  assert.ok(!renderTranscript(rec, [ev(1, 'agent.text', { text: secret })]).includes(secret));
});

test('stream token: reads only its own run, only GET on read routes', () => {
  const a = createRun({ agent: 'opencode', task: 'a' });
  const b = createRun({ agent: 'opencode', task: 'b' });
  const ta = issueStreamToken(a);
  const tb = issueStreamToken(b);
  assert.ok(ta.startsWith(STREAM_TOKEN_PREFIX));
  assert.ok(!readFileSync(join(runDir(a.id), 'run.json'), 'utf8').includes(ta), 'only the hash is stored');
  const A = getRun(a.id), B = getRun(b.id);
  for (const r of ['events', 'stream', 'transcript', 'artifacts']) {
    assert.equal(streamTokenAllows(ta, 'GET', ['runs', a.id, r], A), true, `own ${r}`);
    assert.equal(streamTokenAllows(ta, 'GET', ['runs', b.id, r], B), false, `other run ${r}`);
  }
  assert.equal(streamTokenAllows(tb, 'GET', ['runs', b.id, 'stream'], B), true);
  assert.equal(streamTokenAllows(ta, 'GET', ['runs', b.id, 'stream'], A), false, 'record/path mismatch');
  assert.equal(streamTokenAllows(ta, 'POST', ['runs', a.id, 'cancel'], A), false);
  assert.equal(streamTokenAllows(ta, 'GET', ['runs', a.id, 'debug'], A), false);
  assert.equal(streamTokenAllows(ta, 'GET', ['runs', a.id], A), false);
  assert.equal(streamTokenAllows(ta, 'GET', ['runs'], undefined), false);
  assert.equal(streamTokenAllows(ta + 'x', 'GET', ['runs', a.id, 'stream'], A), false);
  assert.equal(streamTokenAllows(ta, 'GET', ['runs', a.id, 'stream'], A, Date.now() + 1000 * 3600_000), false, 'expired after retention');
});

test('parseTypes: classes, exact types, run.completed always passes, unknown rejected', () => {
  const t = parseTypes('text,tool');
  assert.ok(!('error' in t));
  if ('error' in t) return;
  assert.ok(t.match('agent.text') && t.match('agent.text.delta') && t.match('agent.tool'));
  assert.ok(!t.match('agent.stdout') && !t.match('run.state'));
  assert.ok(t.match('run.completed'));
  const exact = parseTypes('agent.stdout');
  assert.ok(!('error' in exact) && exact.match('agent.stdout'));
  assert.ok('error' in parseTypes('bogus'));
});

test('transcript: readable markdown of the session', () => {
  const rec = createRun({ agent: 'opencode', task: 'echo hi' });
  const md = renderTranscript(rec, [ev(1, 'run.state', { state: 'RUNNING' }), ev(2, 'agent.stdout', { line: 'hi' }),
    ev(3, 'agent.tool', { tool: 'bash', status: 'completed', input: { cmd: 'ls' }, output: 'a.txt' }),
    ev(4, 'room.stderr', { line: 'noise' }), ev(5, 'run.completed', { state: 'SUCCEEDED', category: 'OK' })]);
  assert.match(md, /^# Run run_/);
  assert.match(md, /\*\*RUNNING\*\*/);
  assert.match(md, /> hi/);
  assert.match(md, /🔧 \*\*bash\*\* completed/);
  assert.match(md, /completed: SUCCEEDED/);
  assert.ok(!md.includes('noise'), 'stderr noise is not part of the transcript');
  assert.ok(!renderTranscript(rec, [], 'text').includes('**'));
});
