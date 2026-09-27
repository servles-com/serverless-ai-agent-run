import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newView, reduceView, renderView, sseParser, type LiveEvent } from '../../scripts/telegram-live-lib.ts';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, ts = '2026-09-28T10:00:00Z'): LiveEvent => ({ seq: ++seq, type, ts, data });

test('reduceView: live tool, deltas replaced by the final text, replay after resume is ignored', () => {
  seq = 0;
  const evs = [
    ev('run.state', { state: 'RUNNING' }, '2026-09-28T10:00:00Z'),
    ev('agent.tool.start', { call: 'c', tool: 'bash', input: { command: 'make test' } }),
    ev('agent.tool.output', { call: 'c', output: 'ok 1\nok 2' }),
    ev('agent.text.delta', { part: 'p', kind: 'reasoning', delta: 'thinking…' }),
    ev('agent.text.delta', { part: 'p', kind: 'text', delta: 'All tests ' }),
    ev('agent.text.delta', { part: 'p', kind: 'text', delta: 'pass.' }),
  ];
  let v = evs.reduce(reduceView, newView('run_x'));
  assert.equal(v.text, 'All tests pass.', 'reasoning is not shown');
  assert.equal(v.tool?.running, true);
  const live = renderView(v, Date.parse('2026-09-28T10:00:42Z'));
  assert.match(live, /⏳ run_x — RUNNING · 0:42/);
  assert.match(live, /▶ bash: make test\nok 1\nok 2/);
  // A restart replays events with seq <= lastSeq: nothing changes.
  const again = evs.reduce(reduceView, v);
  assert.deepEqual(again, v);
  v = reduceView(v, ev('agent.tool', { tool: 'bash', status: 'completed', input: { command: 'make test' }, output: 'ok 1\nok 2\nok 3' }));
  v = reduceView(v, ev('agent.text', { text: 'All tests pass (3).' }));
  v = reduceView(v, ev('run.completed', { state: 'SUCCEEDED', category: 'OK' }, '2026-09-28T10:01:05Z'));
  const done = renderView(v);
  assert.match(done, /✅ run_x — SUCCEEDED · 1:05 · 1 tools/);
  assert.match(done, /✔ bash: make test\nok 1\nok 2\nok 3/);
  assert.match(done, /All tests pass \(3\)\.$/);
  assert.ok(done.length < 4096);
});

test('reduceView: failures show the category; shell output lines are shown', () => {
  seq = 0;
  let v = reduceView(newView('r'), ev('agent.stdout', { line: 'step 1' }));
  v = reduceView(v, ev('run.completed', { state: 'FAILED', category: 'EXPECTATION_NOT_MET' }));
  assert.match(renderView(v), /❌ r — FAILED \(EXPECTATION_NOT_MET\)[\s\S]*step 1/);
});

test('sseParser: events split across chunks, heartbeats and retry lines ignored', () => {
  const p = sseParser();
  const e1 = JSON.stringify({ seq: 1, type: 'run.state', ts: 't', data: { state: 'RUNNING' } });
  const e2 = JSON.stringify({ seq: 2, type: 'run.completed', ts: 't', data: { state: 'SUCCEEDED' } });
  const wire = `retry: 3000\n\n: ping x\n\nid: 1\nevent: run.state\ndata: ${e1}\n\nid: 2\nevent: run.completed\ndata: ${e2}\n\n`;
  const got: LiveEvent[] = [];
  for (let i = 0; i < wire.length; i += 7) got.push(...p(wire.slice(i, i + 7)));
  assert.deepEqual(got.map(e => e.seq), [1, 2]);
});
