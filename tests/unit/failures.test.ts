import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, providerErrorCategory } from '../../src/failures.ts';
import type { AgentOutcome } from '../../src/agent-proxy.ts';

function outcome(over: Partial<AgentOutcome> = {}): AgentOutcome {
  return { done: true, chunks: 2, progress: 3, finalText: 'done', sessionId: 's1',
    timedOut: false, idleKilled: false, cancelled: false, durationMs: 1000, ...over };
}

const cat = (o: AgentOutcome) => classify(o).diagnosis?.category ?? classify(o).state;

test('clean agent run succeeds', () => assert.equal(cat(outcome()), 'SUCCEEDED'));
test('cancel wins over everything', () =>
  assert.equal(classify(outcome({ cancelled: true, timedOut: true, done: false })).diagnosis?.category, 'CANCELLED'));
test('wrong SAR_AGENT_SECRET -> AGENT_AUTH_FAILED, not retryable', () => {
  const v = classify(outcome({ httpStatus: 401, httpError: '{"error":"unauthorized"}', done: false, chunks: 0 }));
  assert.equal(v.diagnosis?.category, 'AGENT_AUTH_FAILED');
  assert.equal(v.diagnosis?.retryable, false);
  assert.match(v.diagnosis!.hints.join(), /WEB_VERIFY_SECRET/);
});
test('4xx from the agent -> AGENT_REJECTED; 409 duplicate is retryable', () => {
  assert.equal(cat(outcome({ httpStatus: 400, httpError: 'invalid username', done: false })), 'AGENT_REJECTED');
  assert.equal(classify(outcome({ httpStatus: 400, done: false })).diagnosis?.retryable, false);
  assert.equal(classify(outcome({ httpStatus: 409, done: false })).diagnosis?.retryable, true);
});
test('5xx or connection refused before any event -> AGENT_UNAVAILABLE', () => {
  assert.equal(cat(outcome({ httpStatus: 503, done: false })), 'AGENT_UNAVAILABLE');
  const v = classify(outcome({ transportError: 'connect ECONNREFUSED 127.0.0.1:8080', done: false, chunks: 0, progress: 0, sessionId: undefined }));
  assert.equal(v.diagnosis?.category, 'AGENT_UNAVAILABLE');
  assert.match(v.diagnosis!.evidence.join(), /ECONNREFUSED/);
});
test('connection lost mid-run -> AGENT_STREAM_LOST, not AGENT_UNAVAILABLE', () =>
  assert.equal(cat(outcome({ transportError: 'terminated', done: false, chunks: 1 })), 'AGENT_STREAM_LOST'));
test('stream closed without done -> AGENT_STREAM_LOST', () => assert.equal(cat(outcome({ done: false })), 'AGENT_STREAM_LOST'));
test('timeout', () => {
  const v = classify(outcome({ timedOut: true, done: false }));
  assert.equal(v.state, 'TIMED_OUT');
  assert.equal(v.diagnosis?.category, 'TIMEOUT');
});
test('idle stall', () => assert.equal(cat(outcome({ idleKilled: true, done: false })), 'IDLE_STALL'));
test('agent error that is a provider error keeps the MODEL_* category', () => {
  assert.equal(cat(outcome({ agentError: '429 Too Many Requests', done: false })), 'MODEL_RATE_LIMITED');
  assert.equal(cat(outcome({ agentError: 'ProviderModelNotFoundError: x', done: false })), 'MODEL_NOT_FOUND');
  assert.equal(cat(outcome({ agentError: 'Error: 401 invalid api key', done: false })), 'MODEL_AUTH_FAILED');
  assert.equal(cat(outcome({ agentError: 'maximum context length exceeded', done: false })), 'MODEL_CONTEXT_OVERFLOW');
  assert.equal(cat(outcome({ agentError: 'upstream 504', done: false })), 'MODEL_PROVIDER_ERROR');
  assert.equal(classify(outcome({ agentError: 'invalid model', done: false })).diagnosis?.retryable, false);
});
test('any other agent error -> AGENT_CRASHED', () =>
  assert.equal(cat(outcome({ agentError: 'Задача завершилась без ответа', done: false })), 'AGENT_CRASHED'));
test('done but no answer -> AGENT_EMPTY_RESULT', () => assert.equal(cat(outcome({ finalText: '  ' })), 'AGENT_EMPTY_RESULT'));
test('durations like 500ms are not provider errors', () => assert.equal(providerErrorCategory('took 500ms'), undefined));

// Every category the classifier can emit must be asserted by some test above:
// a new category added to failures.ts without a test fails CI.
test('every category in failures.ts is covered by a test', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../src/failures.ts', import.meta.url), 'utf8');
  const self = await readFile(new URL(import.meta.url), 'utf8');
  const categories = new Set(src.match(/'[A-Z][A-Z_]{3,}'/g)!.map(s => s.slice(1, -1)));
  categories.delete('SUCCEEDED'); categories.delete('FAILED'); categories.delete('TIMED_OUT');
  const missing = [...categories].filter(c => !self.includes(`'${c}'`));
  assert.deepEqual(missing, [], `categories without a unit test: ${missing.join(', ')}`);
});
test('result contract categories (details in expect.test.ts)', async () => {
  const { checkDeliverable } = await import('../../src/failures.ts');
  const d = { agent: 'opencode', text: '', artifacts: [], pullRequest: false, parsesAsJson: () => true };
  assert.equal(checkDeliverable(undefined, d, [])?.diagnosis?.category, 'NO_DELIVERABLE');
  assert.equal(checkDeliverable({ artifacts: ['x'] }, d, [])?.diagnosis?.category, 'EXPECTATION_NOT_MET');
});
