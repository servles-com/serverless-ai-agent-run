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
