// Step 4, env mode: a run names a credential by reference; the value reaches the room's
// env, is masked in every output, and a missing or foreign credential fails the run
// in PREPARING (no room). Needs write access to the server's creds dir (same machine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { api, runAndWait, explain } from '../lib/client.ts';

const credsDir = process.env.SAR_CREDS_DIR ?? (process.env.SAR_DATA_DIR ? join(process.env.SAR_DATA_DIR, 'creds') : '');
const owner = process.env.SAR_OWNER ?? 'operator';

test('credentials by reference: value in the room env, masked everywhere; missing/foreign -> CREDENTIAL_MISSING before any room',
  { skip: credsDir ? false : 'SAR_CREDS_DIR / SAR_DATA_DIR not set' }, async () => {
    const name = `e2e-${randomBytes(4).toString('hex')}`;
    const value = `e2e-secret-${randomBytes(12).toString('hex')}`;
    const file = join(credsDir, 'users', owner, `${name}.json`);
    mkdirSync(join(credsDir, 'users', owner), { recursive: true });
    writeFileSync(file, JSON.stringify({ value }), { mode: 0o600 });
    try {
      const run = await runAndWait({ agent: 'shell', credentials: [{ ref: `cred:${name}`, as: 'env', name: 'E2E_TOKEN' }],
        task: 'echo "len=${#E2E_TOKEN}"; echo "tok=$E2E_TOKEN"; echo "$E2E_TOKEN" > /artifacts/tok.txt' });
      assert.equal(run.state, 'SUCCEEDED', explain(run));
      const events = (await api('GET', `/runs/${run.id}/events`)).body;
      const lines = events.filter((e: { type: string }) => e.type === 'agent.stdout').map((e: { data: { line: string } }) => e.data.line);
      assert.ok(lines.includes(`len=${value.length}`), `the room got the value: ${lines.join(' | ')}`);
      assert.ok(lines.includes('tok=***'), 'echoed value is masked');
      assert.ok(!JSON.stringify(events).includes(value) && !JSON.stringify(run).includes(value), 'value never in events or run.json');
      assert.deepEqual(run.request.credentials, [{ ref: `cred:${name}`, as: 'env', name: 'E2E_TOKEN' }], 'run.json keeps the reference');

      for (const ref of ['cred:does-not-exist', `cred:someone-else/${name}`]) {
        const bad = await runAndWait({ agent: 'shell', credentials: [{ ref, as: 'env', name: 'E2E_TOKEN' }], task: 'echo should-not-run' });
        assert.equal(bad.state, 'FAILED', explain(bad));
        assert.equal(bad.diagnosis.category, 'CREDENTIAL_MISSING', explain(bad));
        const types = (await api('GET', `/runs/${bad.id}/events`)).body.map((e: { type: string }) => e.type);
        assert.ok(!types.includes('room.destroyed') && !types.includes('agent.stdout'), `no room for ${ref}: ${types.join(',')}`);
      }
      assert.equal((await api('POST', '/runs', { agent: 'shell', task: 'x', credentials: [{ ref: 'cred:x', as: 'proxy', hosts: ['api.cloudflare.com'] }] })).status, 400,
        'proxy mode is refused while the gateway is off');
    } finally { rmSync(file, { force: true }); }
  });
