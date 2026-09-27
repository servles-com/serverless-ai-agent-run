import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type Facts } from '../../src/failures.ts';
import { emptyStats } from '../../src/adapters/index.ts';

function facts(over: Partial<Facts['room']> = {}, stats: Partial<ReturnType<typeof emptyStats>> = {}, agent = 'opencode'): Facts {
  return {
    agent,
    room: { container: 'c', runtime: 'runc', exitCode: 0, oomKilled: false, timedOut: false, idleKilled: false,
      cancelled: false, durationMs: 1000, stderrTail: [], ...over },
    stats: { ...emptyStats(), parsedLines: 5, steps: 2, toolCalls: 1, finalText: 'done', lastStepReason: 'stop', ...stats },
    artifacts: [],
  };
}

const cat = (f: Facts) => classify(f).diagnosis?.category ?? classify(f).state;

test('clean opencode run succeeds', () => assert.equal(cat(facts()), 'SUCCEEDED'));
test('docker start error', () => assert.equal(cat(facts({ startError: 'Unknown runtime specified runsc', exitCode: 125 })), 'ROOM_START_FAILED'));
test('oom wins over exit code', () => assert.equal(cat(facts({ oomKilled: true, exitCode: 137 })), 'OOM_KILLED'));
test('timeout', () => assert.equal(classify(facts({ timedOut: true, exitCode: 137 })).state, 'TIMED_OUT'));
test('idle stall', () => assert.equal(cat(facts({ idleKilled: true, exitCode: 137 })), 'IDLE_STALL'));
test('cancel', () => assert.equal(classify(facts({ cancelled: true, exitCode: 137 })).state, 'CANCELLED'));
test('rate limit from agent error event', () =>
  assert.equal(cat(facts({ exitCode: 1 }, { agentErrors: ['{"name":"APIError","data":{"statusCode":429}}'] })), 'MODEL_RATE_LIMITED'));
test('model not found', () =>
  assert.equal(cat(facts({ exitCode: 1, stderrTail: ['ProviderModelNotFoundError: foo/bar'] })), 'MODEL_NOT_FOUND'));
test('provider error text but agent actually finished -> success', () =>
  assert.equal(cat(facts({ stderrTail: ['WARN retrying after 429'] })), 'SUCCEEDED'));
test('crash', () => assert.equal(cat(facts({ exitCode: 3, stderrTail: ['TypeError: x'] })), 'AGENT_CRASHED'));
test('binary missing', () => assert.equal(cat(facts({ exitCode: 127 })), 'AGENT_BINARY_MISSING'));
test('no output', () => assert.equal(cat(facts({}, { parsedLines: 0, steps: 0, finalText: undefined })), 'AGENT_NO_OUTPUT'));
test('empty result', () => assert.equal(cat(facts({}, { toolCalls: 0, finalText: undefined })), 'AGENT_EMPTY_RESULT'));
test('truncated answer is a warning', () => {
  const v = classify(facts({}, { lastStepReason: 'length' }));
  assert.equal(v.state, 'SUCCEEDED');
  assert.match(v.warnings.join(), /length/);
});
test('shell adapter: exit 0 with no events is fine', () =>
  assert.equal(cat(facts({}, { parsedLines: 0, steps: 0, toolCalls: 0, finalText: undefined }, 'shell')), 'SUCCEEDED'));

test('timeout caused by provider 504 retries -> MODEL_PROVIDER_ERROR (dogfood 2026-09-27)', () => {
  const line = 'timestamp=2026-09-27T18:22:21Z level=ERROR message="stream error" providerID=openrouter error.error.code=504';
  const v = classify(facts({ timedOut: true, exitCode: 137, stderrTail: [line, line, line] }, { toolCalls: 0, steps: 3, finalText: undefined }));
  assert.equal(v.state, 'TIMED_OUT');
  assert.equal(v.diagnosis?.category, 'MODEL_PROVIDER_ERROR');
});
test('timeout with real tool work stays TIMEOUT even if a provider error happened once', () => {
  const v = classify(facts({ timedOut: true, exitCode: 137, stderrTail: ['error.error.code=504'] }, { toolCalls: 7 }));
  assert.equal(v.diagnosis?.category, 'TIMEOUT');
});
test('durations like 500ms are not provider errors', () =>
  assert.equal(cat(facts({ exitCode: 2, stderrTail: ['took 500ms'] })), 'AGENT_CRASHED'));
