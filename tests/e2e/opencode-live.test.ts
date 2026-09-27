// Live OpenCode run against the default (free) model. Free models are flaky on
// purpose here: the assertion is that the run ends in a *diagnosed* state,
// not that the model is good. Set SAR_LIVE_STRICT=1 to require success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAndWait, explain } from '../lib/client.ts';

test('opencode: small file task on the default free model', { timeout: 900_000 }, async () => {
  const run = await runAndWait({
    agent: 'opencode',
    task: 'Create /artifacts/fib.py that prints the first 10 Fibonacci numbers, run it with python3, and reply with its output.',
    limits: { timeout_s: 600, idle_timeout_s: 240 },
  }, 700);
  console.log(explain(run));
  if (run.state === 'SUCCEEDED') {
    assert.ok(run.result.artifacts.includes('fib.py'), 'fib.py exported');
  } else {
    assert.ok(run.diagnosis?.category && run.diagnosis.category !== 'RUNTIME_BUG', explain(run));
    if (process.env.SAR_LIVE_STRICT === '1') assert.fail(explain(run));
  }
});

// G11 phase 2: with live: true the tool start and its output arrive while the tool
// is still running, not only when it finished. Lenient like the test above: a
// provider failure is fine as long as it is diagnosed.
test('opencode live: tool start and output stream before the tool finishes', { timeout: 900_000 }, async () => {
  const { api } = await import('../lib/client.ts');
  const run = await runAndWait({
    agent: 'opencode', live: true,
    task: 'Run exactly this shell command and nothing else: for i in 1 2 3 4; do echo tick $i; sleep 3; done. Then reply with the word done.',
    limits: { timeout_s: 600, idle_timeout_s: 240 },
  }, 700);
  console.log(explain(run));
  if (run.state !== 'SUCCEEDED') {
    assert.ok(run.diagnosis?.category && run.diagnosis.category !== 'RUNTIME_BUG', explain(run));
    return;
  }
  const events = (await api('GET', `/runs/${run.id}/events`)).body as { type: string; ts: string }[];
  const start = events.find(e => e.type === 'agent.tool.start');
  const done = events.find(e => e.type === 'agent.tool');
  assert.ok(start && done, `tool events: ${events.map(e => e.type).join(',')}`);
  assert.ok(Date.parse(done!.ts) - Date.parse(start!.ts) >= 5000, 'tool.start arrived well before the tool finished');
  assert.ok(events.some(e => e.type === 'agent.tool.output'), 'running output streamed');
  assert.equal(run.result.text?.trim().toLowerCase().includes('done'), true, explain(run));
});
