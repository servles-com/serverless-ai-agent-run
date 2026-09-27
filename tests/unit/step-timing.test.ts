import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { opencodeAdapter } from '../../src/adapters/opencode.ts';
import { emptyStats, type AgentStats } from '../../src/adapters/index.ts';
import { closeOpenStep } from '../../src/step-timing.ts';
import { classify } from '../../src/failures.ts';

// Recorded `opencode run --format json` stream (tests/fixtures/opencode-timed-run.jsonl),
// timestamps in ms: step 1 = model 700 + tool 300, step 2 = model 500.
const RECORDED = readFileSync(new URL('../fixtures/opencode-timed-run.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean);

function feed(stats: AgentStats, events: object[]): void {
  for (const ev of events) opencodeAdapter.parse(JSON.stringify(ev), stats);
}

const stepStart = (timestamp: number) =>
  ({ type: 'step_start', timestamp, sessionID: 'ses_01', part: { id: 'p', type: 'step-start' } });
const toolUse = (start: number, end: number) =>
  ({ type: 'tool_use', timestamp: end, sessionID: 'ses_01',
     part: { id: 'p', type: 'tool', tool: 'bash', state: { status: 'completed', time: { start, end } } } });

test('per-step model wait vs tool execution from a recorded event stream', () => {
  const stats = emptyStats();
  feed(stats, RECORDED.map(l => JSON.parse(l)));

  assert.equal(stats.steps, 2);
  assert.equal(stats.toolCalls, 1);
  assert.deepEqual(stats.timing.stepTimings, [
    { step: 1, model_ms: 700, tool_ms: 300, total_ms: 1000 },
    { step: 2, model_ms: 500, tool_ms: 0, total_ms: 500 },
  ]);
  assert.equal(stats.timing.modelMs, 1200);
  assert.equal(stats.timing.toolMs, 300);
});

test('a step left open by a timeout is closed at kill time', () => {
  const stats = emptyStats();
  feed(stats, [stepStart(1000), toolUse(1200, 1500)]);

  assert.deepEqual(closeOpenStep(stats.timing, 3000), { step: 1, model_ms: 1700, tool_ms: 300, total_ms: 2000 });
  assert.equal(stats.timing.modelMs, 1700);
  assert.equal(stats.timing.toolMs, 300);
  // closed once; a second call is a no-op
  assert.equal(closeOpenStep(stats.timing, 9000), undefined);
});

test('TIMEOUT evidence reports model_ms and tool_ms', () => {
  const stats = emptyStats();
  feed(stats, [stepStart(1000), toolUse(1200, 1500)]);
  closeOpenStep(stats.timing, 5000);

  const v = classify({
    agent: 'opencode',
    room: { container: 'c', runtime: 'runc', exitCode: 137, oomKilled: false, timedOut: true,
      idleKilled: false, cancelled: false, durationMs: 5000, stderrTail: [] },
    stats, artifacts: [],
  });

  assert.equal(v.diagnosis?.category, 'TIMEOUT');
  assert.ok(v.diagnosis?.evidence.includes('model_ms=3700'), v.diagnosis?.evidence.join(','));
  assert.ok(v.diagnosis?.evidence.includes('tool_ms=300'));
});
