// G3: a secret echoed by the agent must come back redacted in every sink —
// events.jsonl, the room's raw stdout/stderr logs, run.json and webhooks.
//
// The shell agent requests a real secret from the server's secret store and
// prints it. The test never needs to know the value up front; it reads the same
// secrets file the server was started with, then asserts the value is absent
// everywhere and replaced by ***.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api, runAndWait, explain, webhookReceiver } from '../lib/client.ts';

const PLACEHOLDER = '***';

// Same parsing as src/config.ts loadSecrets(), so we get the exact server value.
function loadSecret(): { name: string; value: string } | undefined {
  const file = process.env.SAR_SECRETS_FILE ?? '/etc/sar/secrets.env';
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return undefined; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value.length >= 4) return { name: m[1], value };
  }
  return undefined;
}

const secret = loadSecret();

test('secret echoed by the agent is redacted in events, logs, run.json and webhooks',
  { skip: secret ? false : 'no non-empty secret in SAR_SECRETS_FILE' }, async () => {
    const s = secret!;
    const hook = await webhookReceiver('hook-secret');
    try {
      const run = await runAndWait({
        agent: 'shell',
        secrets: [s.name],
        task: `echo "stdout=$${s.name}"; echo "stderr=$${s.name}" >&2`,
        webhook: { url: hook.url, secret: 'hook-secret', agent_events: true },
      });
      assert.equal(run.state, 'SUCCEEDED', explain(run));

      // run.json result (what GET /runs/:id returns) must be redacted too.
      assert.equal(run.result.text, `stdout=${PLACEHOLDER}`, explain(run));
      assert.ok(!JSON.stringify(run).includes(s.value), 'secret leaked into run.json');

      // events.jsonl
      const events = (await api('GET', `/runs/${run.id}/events`)).body;
      assert.ok(!JSON.stringify(events).includes(s.value), 'secret leaked into events.jsonl');
      const stdout = events.filter((e: any) => e.type === 'agent.stdout').map((e: any) => e.data.line);
      assert.ok(stdout.includes(`stdout=${PLACEHOLDER}`), `stdout events: ${JSON.stringify(stdout)}`);
      const stderr = events.filter((e: any) => e.type === 'room.stderr').map((e: any) => e.data.line);
      assert.ok(stderr.some((l: string) => l === `stderr=${PLACEHOLDER}`), `stderr events: ${JSON.stringify(stderr)}`);

      // raw room stdout.log / stderr.log via the debug bundle
      const debug = (await api('GET', `/runs/${run.id}/debug`)).body;
      assert.ok(!JSON.stringify(debug).includes(s.value), 'secret leaked into debug bundle');
      assert.ok(debug.stdout_tail.includes(`stdout=${PLACEHOLDER}`), JSON.stringify(debug.stdout_tail));
      assert.ok(debug.stderr_tail.some((l: string) => l === `stderr=${PLACEHOLDER}`), JSON.stringify(debug.stderr_tail));

      // webhook payloads (agent_events on, so the echoed line was delivered)
      await new Promise(r => setTimeout(r, 1500));
      assert.equal(hook.bad(), 0, 'webhook signatures valid');
      assert.ok(!JSON.stringify(hook.events).includes(s.value), 'secret leaked into webhook payloads');
      assert.ok(hook.events.some((e: any) => e.type === 'agent.stdout' && e.data.line === `stdout=${PLACEHOLDER}`),
        `webhook events: ${hook.events.map((e: any) => e.type).join(',')}`);
    } finally { hook.close(); }
  });
