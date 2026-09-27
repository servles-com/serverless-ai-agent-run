// Step 4 (env mode): credentials in POST /runs are references; the broker resolves
// them in PREPARING. Config is read at import, so the env is set up first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'sar-creds-'));
process.env.SAR_DATA_DIR = data;
process.env.SAR_CREDS_DIR = join(data, 'creds');
process.env.SAR_CREDENTIAL_AUDIT = join(data, 'credential-access.jsonl');
mkdirSync(join(data, 'creds', 'users', 'operator'), { recursive: true });
writeFileSync(join(data, 'creds', 'users', 'operator', 'cloudflare.json'), JSON.stringify({ value: 'cf-secret-value-123' }));
writeFileSync(join(data, 'creds', 'users', 'operator', 'old.json'), JSON.stringify({ value: 'old-value-456', revoked: true }));

const { validateRequest, resolveCredentialEnv, CredentialError } = await import('../../src/run-env.ts');
const { createRun } = await import('../../src/store.ts');
const { redact } = await import('../../src/redact.ts');

const env = (ref: string, name = 'CF_TOKEN') => ({ agent: 'shell' as const, task: 'x', credentials: [{ ref, as: 'env' as const, name }] });

test('validateRequest: env credentials accepted, proxy refused while the gateway is off, garbage refused', () => {
  assert.equal(validateRequest(env('cred:cloudflare')), undefined);
  assert.match(validateRequest({ agent: 'shell', task: 'x', credentials: [{ ref: 'cred:cloudflare', as: 'proxy', hosts: ['api.cloudflare.com'] }] })!, /gateway/);
  assert.ok(validateRequest({ agent: 'shell', task: 'x', credentials: [{ ref: 'nope', as: 'env', name: 'X' }] }));
  assert.ok(validateRequest(env('cred:cloudflare', 'PATH')), 'reserved env names');
});

test('resolveCredentialEnv: value in env, registered for redaction, audited without the value', () => {
  const rec = createRun(env('cred:cloudflare'));
  const out = resolveCredentialEnv(rec.id, rec.request);
  assert.deepEqual(out, { CF_TOKEN: 'cf-secret-value-123' });
  assert.equal(redact('leak cf-secret-value-123 here'), 'leak *** here');
  const audit = readFileSync(join(data, 'credential-access.jsonl'), 'utf8');
  assert.match(audit, /"outcome":"granted"/);
  assert.ok(!audit.includes('cf-secret-value-123'));
  assert.ok(!readFileSync(join(data, 'runs', rec.id, 'run.json'), 'utf8').includes('cf-secret-value-123'), 'run.json holds the reference only');
});

test('resolveCredentialEnv: missing, foreign owner and revoked -> CredentialError with the right code', () => {
  const code = (ref: string) => {
    const rec = createRun(env(ref));
    try { resolveCredentialEnv(rec.id, rec.request); return 'none'; } catch (e) { return e instanceof CredentialError ? e.code : String(e); }
  };
  assert.equal(code('cred:nope'), 'CREDENTIAL_MISSING');
  assert.equal(code('cred:someone-else/cloudflare'), 'CREDENTIAL_MISSING', 'another owner looks exactly like missing');
  assert.equal(code('cred:old'), 'CREDENTIAL_REVOKED');
});

test('no credentials -> nothing resolved, nothing audited', () => {
  const rec = createRun({ agent: 'shell', task: 'x' });
  assert.deepEqual(resolveCredentialEnv(rec.id, rec.request), {});
});
