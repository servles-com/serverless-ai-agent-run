// Deterministic isolation checks, executed *inside* a room by the shell agent.
// Tenant B (victim) leaves a marker; tenant A (attacker) tries to see it and
// to reach things a room must never reach. Authoritative over the LLM adversary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAndWait, explain } from '../lib/client.ts';

const MARKER = 'NEVER_VISIBLE_TO_TENANT_A_' + Math.random().toString(36).slice(2);

const PROBES = String.raw`
check() { if eval "$2" >/dev/null 2>&1; then echo "CHECK $1 PASS"; else echo "CHECK $1 FAIL"; fi; }
check not_root           '[ "$(id -u)" != "0" ]'
check no_docker_socket   '! ls /var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock'
check no_marker_in_fs    '! grep -rsl "$MARKER" /workspace /artifacts /tmp /home /mnt /media /srv /var /root /opt'
check no_other_runs      '! ls / /workspace/.. | grep -q "^run_"'
check few_processes      '[ "$(ls -d /proc/[0-9]* | wc -l)" -lt 30 ]'
check no_metadata        '! curl -s -m 4 -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/'
check no_host_api        '! curl -s -m 4 http://$(ip route 2>/dev/null | awk "/default/{print \$3}" || echo 172.30.0.1):8787/healthz'
check no_private_net     '! curl -s -m 4 http://10.128.0.1/'
check no_provider_key    '[ -z "$OPENROUTER_API_KEY" ]'
check internet_works     'curl -s -m 10 -o /dev/null https://api.github.com'
check caps_dropped       'grep -q "CapEff:\s*0000000000000000" /proc/self/status'
`;

test('isolation probes from tenant A cannot see tenant B', async () => {
  const victim = await runAndWait({ agent: 'shell', files: { 'secret.txt': MARKER }, task: 'cp secret.txt /artifacts/; echo stored' });
  assert.equal(victim.state, 'SUCCEEDED', explain(victim));

  const attacker = await runAndWait({ agent: 'shell', limits: { timeout_s: 180 },
    task: `export MARKER='${MARKER}'\n${PROBES}` });
  const lines: string[] = [];
  // The run's result only keeps the last line; the per-line events are the source of truth.
  const { api } = await import('../lib/client.ts');
  for (const ev of (await api('GET', `/runs/${attacker.id}/events`)).body) {
    if (ev.type === 'agent.stdout' && String(ev.data.line).startsWith('CHECK ')) lines.push(ev.data.line);
  }
  console.log(lines.join('\n'));
  assert.ok(lines.length >= 10, `probes did not run: ${explain(attacker)}`);
  const failed = lines.filter(l => l.endsWith('FAIL'));
  assert.deepEqual(failed, [], `isolation violations:\n${failed.join('\n')}`);
});
