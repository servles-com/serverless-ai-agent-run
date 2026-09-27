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
check no_host_api        '! curl -s -m 4 http://172.30.0.1:8787/healthz'
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

// Checklist 2.5: two rooms at the same time (SAR_MAX_ROOMS >= 2). The victim serves
// a marker over HTTP and proves it is reachable from inside itself (paired check);
// the attacker, running concurrently, must reach neither the port nor the file.
const NEIGHBOUR_PROBES = String.raw`
check() { if eval "$2" >/dev/null 2>&1; then echo "CHECK $1 PASS"; else echo "CHECK $1 FAIL"; fi; }
check neighbour_http_blocked   '! curl -s -m 4 http://$VICTIM_IP:8080/marker.txt'
check neighbour_marker_hidden  '! grep -rsl "$MARKER" /workspace /artifacts /tmp /home /var /opt /proc/[0-9]*/cwd/'
check neighbour_not_in_proc    '! grep -sl "http.server" /proc/[0-9]*/cmdline'
check internet_still_works     'curl -s -m 10 -o /dev/null https://api.github.com'
`;

test('two concurrent rooms cannot see or reach each other (checklist 2.5)', { timeout: 300_000 }, async t => {
  const { api } = await import('../lib/client.ts');
  const health = await api('GET', '/healthz');
  if ((health.body.max_rooms ?? 1) < 2) return t.skip('SAR_MAX_ROOMS < 2 on this server');
  const marker = 'NEIGHBOUR_MARKER_' + Math.random().toString(36).slice(2);
  const victim = await api('POST', '/runs', { agent: 'shell', limits: { timeout_s: 200, idle_timeout_s: 200 }, task: [
    `echo ${marker} > /workspace/marker.txt`,
    'cd /workspace && (python3 -m http.server 8080 >/dev/null 2>&1 &)',
    'sleep 2; curl -s -m 3 http://127.0.0.1:8080/marker.txt | grep -q NEIGHBOUR_MARKER_ && echo SELF_OK',
    'echo "VICTIM_IP $(hostname -i | cut -d" " -f1)"',
    'sleep 180',
  ].join('\n') });
  assert.equal(victim.status, 202);
  const vid = victim.body.id;
  try {
    let ip = '', selfOk = false;
    for (let i = 0; i < 120 && !ip; i++) {
      for (const ev of (await api('GET', `/runs/${vid}/events`)).body) {
        if (ev.type !== 'agent.stdout') continue;
        if (ev.data.line === 'SELF_OK') selfOk = true;
        const m = /^VICTIM_IP (\S+)/.exec(ev.data.line);
        if (m) ip = m[1];
      }
      if (!ip) await new Promise(r => setTimeout(r, 1000));
    }
    assert.ok(ip, 'victim never reported its IP');
    assert.ok(selfOk, 'paired check: the victim serves the marker to itself');
    const attacker = await runAndWait({ agent: 'shell', limits: { timeout_s: 120 },
      task: `export MARKER='${marker}' VICTIM_IP='${ip}'\n${NEIGHBOUR_PROBES}` });
    const lines = (await api('GET', `/runs/${attacker.id}/events`)).body
      .filter((e: { type: string; data: { line: string } }) => e.type === 'agent.stdout' && e.data.line.startsWith('CHECK '))
      .map((e: { data: { line: string } }) => e.data.line);
    console.log(`victim ${ip}\n${lines.join('\n')}`);
    assert.equal(lines.length, 4, `probes did not run: ${explain(attacker)}`);
    assert.deepEqual(lines.filter((l: string) => l.endsWith('FAIL')), []);
    assert.equal((await api('GET', `/runs/${vid}`)).body.state, 'RUNNING', 'the victim really ran at the same time');
  } finally {
    await api('POST', `/runs/${vid}/cancel`);
  }
});
