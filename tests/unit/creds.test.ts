import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHandle, validateCredentials, validateHost } from '../../src/creds/handle.ts';
import { Broker, CredentialError, FileBackend, fileAudit, type AccessRecord } from '../../src/creds/broker.ts';
import { redact } from '../../src/redact.ts';

const VALUE = 'cf-fake-token-0123456789abcdef'; // gitleaks:allow (fake fixture)

function store() {
  const root = mkdtempSync(join(tmpdir(), 'sar-creds-'));
  const put = (owner: string, name: string, body: unknown) => {
    mkdirSync(join(root, 'users', owner), { recursive: true });
    writeFileSync(join(root, 'users', owner, `${name}.json`), JSON.stringify(body));
  };
  put('alice', 'cloudflare', { value: VALUE });
  put('alice', 'old', { value: 'old-fake-value-9999', revoked: true });
  put('bob', 'secret', { value: 'bob-fake-value-7777' });
  const audit: AccessRecord[] = [];
  return { root, put, audit, broker: new Broker(new FileBackend(root), r => audit.push(r)) };
}
const run = { id: 'r1', owner: 'alice' };

test('parseHandle: own and owner-qualified handles, malformed rejected', () => {
  assert.deepEqual(parseHandle('cred:cloudflare'), { name: 'cloudflare' });
  assert.deepEqual(parseHandle('cred:alice/cloudflare'), { owner: 'alice', name: 'cloudflare' });
  for (const bad of ['cloudflare', 'cred:', 'cred:a/b/c', 'cred:../x', 'cred:a/..', 'cred:A', 'cred:a b', 'cred:/x', 42, undefined]) {
    assert.equal(parseHandle(bad), undefined, String(bad));
  }
});

test('validateCredentials: a proxy and an env grant pass', () => {
  const v = validateCredentials([
    { ref: 'cred:cloudflare', as: 'proxy', hosts: ['api.cloudflare.com'], name: 'CLOUDFLARE_API_TOKEN' },
    { ref: 'cred:alice/npm', as: 'env', name: 'NPM_TOKEN' },
  ]);
  assert.ok(v.ok);
  assert.equal(v.specs.length, 2);
  assert.deepEqual(validateCredentials(undefined), { ok: true, specs: [] });
});

test('validateCredentials: rejects what the gateway or room must never get', () => {
  const bad: [unknown, RegExp][] = [
    ['x', /array/],
    [[{ ref: 'cloudflare', as: 'env', name: 'X' }], /ref/],
    [[{ ref: 'cred:x', as: 'ssh', hosts: ['a.com'] }], /not supported yet/],
    [[{ ref: 'cred:x', as: 'file' }], /as must be/],
    [[{ ref: 'cred:x', as: 'env' }], /needs name/],
    [[{ ref: 'cred:x', as: 'env', name: 'X', hosts: ['a.com'] }], /hosts only applies/],
    [[{ ref: 'cred:x', as: 'env', name: 'PATH' }], /reserved/],
    [[{ ref: 'cred:x', as: 'env', name: 'SAR_RUN_TOKEN' }], /reserved/],
    [[{ ref: 'cred:x', as: 'env', name: 'OPENROUTER_API_KEY' }], /reserved/],
    [[{ ref: 'cred:x', as: 'env', name: 'lower' }], /env variable name/],
    [[{ ref: 'cred:x', as: 'env', name: 'X' }, { ref: 'cred:y', as: 'env', name: 'X' }], /used twice/],
    [[{ ref: 'cred:x', as: 'proxy' }], /non-empty hosts/],
    [[{ ref: 'cred:x', as: 'proxy', hosts: ['169.254.169.254'] }], /IP literals/],
    [[{ ref: 'cred:x', as: 'proxy', hosts: ['::1'] }], /bare host/],
    [[{ ref: 'cred:x', as: 'proxy', hosts: ['https://a.com'] }], /bare host/],
    [[{ ref: 'cred:x', as: 'proxy', hosts: ['a.com:8080'] }], /bare host/],
    [[{ ref: 'cred:x', as: 'proxy', hosts: ['*.a.com'] }], /wildcard/],
    [[{ ref: 'cred:x', as: 'proxy', hosts: ['localhost'] }], /public host|internal/],
    [[{ ref: 'cred:x', as: 'proxy', hosts: ['metadata.google.internal'] }], /internal/],
    [[{ ref: 'cred:x', as: 'proxy', hosts: ['a.com'] }, { ref: 'cred:y', as: 'proxy', hosts: ['a.com'] }], /one credential per host/],
    [[{ ref: 'cred:x', as: 'proxy', hosts: ['a.com'], extra: 1 }], /unknown field/],
    [Array.from({ length: 17 }, (_, i) => ({ ref: `cred:x${i}`, as: 'env', name: `X${i}` })), /at most 16/],
  ];
  for (const [input, re] of bad) {
    const v = validateCredentials(input);
    assert.equal(v.ok, false, JSON.stringify(input));
    if (!v.ok) assert.match(v.error, re, JSON.stringify(input));
  }
  assert.equal(validateHost('api.github.com'), undefined);
  assert.match(validateHost('API.github.com') ?? '', /lower-case/);
});

test('broker resolves only in the run owner namespace; foreign owner = not found, backend untouched', () => {
  const { root, audit } = store();
  const reads: string[] = [];
  const fb = new FileBackend(root);
  const broker = new Broker({ read: (o, n) => { reads.push(`${o}/${n}`); return fb.read(o, n); } }, r => audit.push(r));
  assert.equal(broker.resolve(run, { ref: 'cred:cloudflare', as: 'env' }).value, VALUE);
  assert.equal(broker.resolve(run, { ref: 'cred:alice/cloudflare', as: 'env' }).value, VALUE);
  const foreign = () => broker.resolve(run, { ref: 'cred:bob/secret', as: 'env' });
  assert.throws(foreign, (e: unknown) => e instanceof CredentialError && e.code === 'CREDENTIAL_MISSING');
  assert.deepEqual(reads, ['alice/cloudflare', 'alice/cloudflare'], 'bob\'s namespace was never read');
  // Same answer as a credential that does not exist at all.
  let a = '', b = '';
  try { foreign(); } catch (e) { a = (e as Error).message.replace('bob/secret', ''); }
  try { broker.resolve(run, { ref: 'cred:alice/nope', as: 'env' }); } catch (e) { b = (e as Error).message.replace('alice/nope', ''); }
  assert.equal(a, b);
});

test('revoked credential -> CREDENTIAL_REVOKED; every attempt is audited without the value', () => {
  const { broker, audit } = store();
  assert.throws(() => broker.resolve(run, { ref: 'cred:old', as: 'env' }), (e: unknown) => (e as CredentialError).code === 'CREDENTIAL_REVOKED');
  broker.resolve(run, { ref: 'cred:cloudflare', as: 'proxy' }, 'api.cloudflare.com');
  assert.throws(() => broker.resolve(run, { ref: 'cred:missing', as: 'env' }));
  assert.deepEqual(audit.map(r => [r.ref, r.outcome, r.host]), [
    ['cred:old', 'revoked', undefined], ['cred:cloudflare', 'granted', 'api.cloudflare.com'], ['cred:missing', 'missing', undefined]]);
  assert.ok(audit.every(r => r.run_id === 'r1' && r.owner === 'alice'));
  assert.ok(!JSON.stringify(audit).includes(VALUE));
});

test('resolved values are registered for redaction', () => {
  const { broker } = store();
  broker.resolve(run, { ref: 'cred:cloudflare', as: 'env' });
  assert.equal(redact(`token=${VALUE}`), 'token=***');
});

test('resolveEnv maps env grants to variables and fails on the first missing one', () => {
  const { broker } = store();
  assert.deepEqual(broker.resolveEnv(run, [
    { ref: 'cred:cloudflare', as: 'env', name: 'CF' },
    { ref: 'cred:cloudflare', as: 'proxy', hosts: ['api.cloudflare.com'] },
  ]), { CF: VALUE });
  assert.throws(() => broker.resolveEnv(run, [{ ref: 'cred:nope', as: 'env', name: 'X' }]), /CREDENTIAL_MISSING/);
});

test('file backend: symlink out of the owner dir, bad JSON and bad header read as not found', () => {
  const { root, put } = store();
  symlinkSync(join(root, 'users', 'bob', 'secret.json'), join(root, 'users', 'alice', 'stolen.json'));
  writeFileSync(join(root, 'users', 'alice', 'broken.json'), '{nope');
  put('alice', 'badheader', { value: 'x-fake-value-1', header: 'Host' });
  put('alice', 'crlf', { value: 'a\r\nX-Evil: 1' });
  put('alice', 'custom', { value: 'k-fake-value-2', header: 'X-API-Key', scheme: '' });
  const fb = new FileBackend(root);
  for (const n of ['stolen', 'broken', 'badheader', 'crlf', 'missing']) assert.equal(fb.read('alice', n), undefined, n);
  assert.deepEqual(fb.read('alice', 'custom'), { value: 'k-fake-value-2', header: 'x-api-key', scheme: '', revoked: false });
});

test('fileAudit appends one JSON line per record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sar-audit-'));
  const file = join(dir, 'sub', 'credential-access.jsonl');
  const sink = fileAudit(file);
  const r: AccessRecord = { ts: 't', run_id: 'r', owner: 'o', ref: 'cred:x', as: 'env', outcome: 'granted' };
  sink(r); sink({ ...r, outcome: 'missing' });
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).outcome), ['granted', 'missing']);
});
