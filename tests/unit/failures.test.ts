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
test('auth failure', () =>
  assert.equal(cat(facts({ exitCode: 1, stderrTail: ['Error: 401 invalid api key'] })), 'MODEL_AUTH_FAILED'));
test('context overflow', () =>
  assert.equal(cat(facts({ exitCode: 1, stderrTail: ['maximum context length exceeded'] })), 'MODEL_CONTEXT_OVERFLOW'));
test('export failure after a successful agent run', () => {
  const v = classify({ ...facts(), exportError: 'EACCES' });
  assert.equal(v.diagnosis?.category, 'EXPORT_FAILED');
});
test('idle stall caused by provider errors -> FAILED with provider category', () => {
  const v = classify(facts({ idleKilled: true, exitCode: 137, stderrTail: ['429 too many requests'] }, { toolCalls: 0 }));
  assert.equal(v.state, 'FAILED');
  assert.equal(v.diagnosis?.category, 'MODEL_RATE_LIMITED');
});
test('timeout after many steps hints at looping', () =>
  assert.match(classify(facts({ timedOut: true, exitCode: 137 }, { steps: 40 })).diagnosis!.hints.join(), /looping/));
test('tool errors and non-JSON lines become warnings', () => {
  const v = classify(facts({}, { toolErrors: 2, toolCalls: 3, unparsedLines: 4 }));
  assert.equal(v.state, 'SUCCEEDED');
  assert.match(v.warnings.join('\n'), /2\/3 tool calls failed/);
  assert.match(v.warnings.join('\n'), /4 stdout lines/);
});

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
test('no-output checks apply to any non-shell agent, not only opencode', () =>
  assert.equal(cat(facts({}, { parsedLines: 0, steps: 0, finalText: undefined }, 'claude-code')), 'AGENT_NO_OUTPUT'));
test('result contract categories (details in expect.test.ts)', async () => {
  const { checkDeliverable } = await import('../../src/failures.ts');
  const d = { agent: 'opencode', text: '', artifacts: [], pullRequest: false, parsesAsJson: () => true };
  assert.equal(checkDeliverable(undefined, d, [])?.diagnosis?.category, 'NO_DELIVERABLE');
  assert.equal(checkDeliverable({ artifacts: ['x'] }, d, [])?.diagnosis?.category, 'EXPECTATION_NOT_MET');
});
test('full disk quota + failing command -> DISK_QUOTA_EXCEEDED; full but fine -> warning', () => {
  const v = classify({ ...facts({ exitCode: 1, stderrTail: ['dd: error writing: No space left on device'] }), diskFull: true });
  assert.equal(v.diagnosis?.category, 'DISK_QUOTA_EXCEEDED');
  assert.equal(v.diagnosis?.retryable, false);
  const ok = classify({ ...facts(), diskFull: true });
  assert.equal(ok.state, 'SUCCEEDED');
  assert.match(ok.warnings.join(), /disk quota is full/);
});
test('credential missing / revoked reported by the gateway fail the run with that cause', () => {
  const miss = { ...facts({ exitCode: 1 }), credentialErrors: [{ code: 'CREDENTIAL_MISSING' as const, ref: 'cred:x' }] };
  assert.equal(cat(miss), 'CREDENTIAL_MISSING');
  const both = { ...facts({ exitCode: 1 }), credentialErrors: [
    { code: 'CREDENTIAL_MISSING' as const, ref: 'cred:x' }, { code: 'CREDENTIAL_REVOKED' as const, ref: 'cred:y' }] };
  assert.equal(cat(both), 'CREDENTIAL_REVOKED');
  assert.equal(classify(both).diagnosis?.retryable, false);
  // The agent recovered and finished cleanly: the credential error is not the verdict.
  assert.equal(cat({ ...facts(), credentialErrors: miss.credentialErrors }), 'SUCCEEDED');
});
test('credentialVerdict: failure at PREPARING, before any room starts', async () => {
  const { credentialVerdict } = await import('../../src/failures.ts');
  const v = credentialVerdict([{ code: 'CREDENTIAL_MISSING', ref: 'cred:bob/api' }]);
  assert.equal(v.state, 'FAILED');
  assert.equal(v.diagnosis?.category, 'CREDENTIAL_MISSING');
  assert.match(v.diagnosis!.summary, /cred:bob\/api/);
});

// SB3: fail-fast on provider errors.
test('fail-fast trips on the Nth provider error in a row, once', async () => {
  const { newFailFast, observeFailFast } = await import('../../src/failures.ts');
  const s = newFailFast(3);
  const line = 'level=ERROR message="stream error" providerID=openrouter error.error.code=504';
  assert.equal(observeFailFast(s, { stderr: line }), false);
  assert.equal(observeFailFast(s, { stderr: 'INFO unrelated log line' }), false);
  assert.equal(observeFailFast(s, { stderr: line }), false);
  assert.equal(observeFailFast(s, { stderr: line }), true);
  assert.equal(observeFailFast(s, { stderr: line }), false, 'trips only once');
  assert.equal(s.errors, 3);
  assert.equal(s.samples.length, 3);
});
test('fail-fast: agent progress resets the count; 0 disables', async () => {
  const { newFailFast, observeFailFast } = await import('../../src/failures.ts');
  const s = newFailFast(2);
  observeFailFast(s, { stderr: '429 too many requests' });
  observeFailFast(s, { progress: true });
  assert.equal(observeFailFast(s, { stderr: '429 too many requests' }), false);
  assert.equal(observeFailFast(s, { stderr: '429 too many requests' }), true);
  assert.equal(s.category, 'MODEL_RATE_LIMITED');
  const off = newFailFast(0);
  for (let i = 0; i < 10; i++) assert.equal(observeFailFast(off, { stderr: '504 upstream' }), false);
});
test('fail-fast verdict: FAILED with the provider category, before timeout/crash checks', async () => {
  const { newFailFast, observeFailFast } = await import('../../src/failures.ts');
  const ff = newFailFast(1);
  observeFailFast(ff, { stderr: 'error.error.code=504 stream error' });
  const v = classify({ ...facts({ exitCode: 137 }, { toolCalls: 0, finalText: undefined }), failFast: ff });
  assert.equal(v.state, 'FAILED');
  assert.equal(v.diagnosis?.category, 'MODEL_PROVIDER_ERROR');
  assert.match(v.diagnosis!.summary, /Stopped early/);
  assert.equal(v.diagnosis?.retryable, true);
});
