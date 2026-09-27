import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { startGateway, RunTokens, extractRunToken, isBlockedAddress, redactingStream, type Gateway } from '../../src/gateway.ts';
import { Broker, FileBackend, type AccessRecord } from '../../src/creds/broker.ts';

const VALUE = 'gw-fake-secret-value-abcdef0123'; // gitleaks:allow (fake fixture)

// Fake upstream: records what it received and echoes the request headers back —
// the worst case, an API that reflects the Authorization header.
const seen: { host?: string; url?: string; method?: string; body: string; headers: IncomingHttpHeaders }[] = [];
const audit: AccessRecord[] = [];
const logs: string[] = [];
const tokens = new RunTokens();
const servers: Server[] = [];
let upstream: Server, gateway: Gateway, base = '', guardedBase = '', aliceToken = '';

async function listen(s: Server): Promise<string> {
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

before(async () => {
  upstream = createServer(async (req, res) => {
    seen.push({ host: req.headers.host, url: req.url, method: req.method, body: await text(req), headers: req.headers });
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://elsewhere.example/' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', 'x-echo-auth': String(req.headers.authorization ?? '') });
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  const up = new URL(await listen(upstream));

  const root = mkdtempSync(join(tmpdir(), 'sar-gw-'));
  const put = (owner: string, name: string, body: unknown) => {
    mkdirSync(join(root, 'users', owner), { recursive: true });
    writeFileSync(join(root, 'users', owner, `${name}.json`), JSON.stringify(body));
  };
  put('alice', 'api', { value: VALUE });
  put('alice', 'old', { value: 'old-fake-value-000', revoked: true });
  put('alice', 'keyed', { value: 'keyed-fake-value-222', header: 'x-api-key', scheme: '' });
  put('bob', 'api', { value: 'bob-fake-value-111' });

  const broker = new Broker(new FileBackend(root), r => audit.push(r));
  aliceToken = tokens.issue({ runId: 'run-a', owner: 'alice', credentials: [
    { ref: 'cred:api', as: 'proxy', hosts: ['api.example.com', 'dns.example.com'] },
    { ref: 'cred:bob/api', as: 'proxy', hosts: ['bob.example.com'] },
    { ref: 'cred:old', as: 'proxy', hosts: ['old.example.com'] },
    { ref: 'cred:keyed', as: 'proxy', hosts: ['keyed.example.com'] },
  ] });
  const common = { tokens, broker, log: (l: string) => { logs.push(l); },
    connect: (host: string) => ({ protocol: 'http:' as const, hostname: host === 'dns.example.com' ? 'localhost' : up.hostname, port: Number(up.port) }) };

  // Fake upstream on loopback: the test opts in to private destinations.
  const g1 = await startGateway({ ...common, host: '127.0.0.1', port: 0, allowPrivateUpstream: true,
    services: { echo: (_req, res, ctx) => { res.end(JSON.stringify({ run: ctx.runId, owner: ctx.owner, rest: ctx.rest })); } } });
  gateway = g1.gateway;
  servers.push(g1.server);
  base = `http://127.0.0.1:${(g1.server.address() as AddressInfo).port}`;
  // Same config with the production guard on.
  const g2 = await startGateway({ ...common, host: '127.0.0.1', port: 0 });
  servers.push(g2.server);
  guardedBase = `http://127.0.0.1:${(g2.server.address() as AddressInfo).port}`;
});
after(() => { for (const s of servers) s.close(); });

const bearer = () => ({ authorization: `Bearer ${aliceToken}` });
const call = (path: string, init: RequestInit = {}, at = base) =>
  fetch(at + path, { redirect: 'manual', ...init, headers: { ...bearer(), ...init.headers as Record<string, string> } });

test('no token or a wrong token -> 401, upstream never called', async () => {
  const n = seen.length;
  assert.equal((await fetch(base + '/proxy/api.example.com/x')).status, 401);
  assert.equal((await fetch(base + '/proxy/api.example.com/x', { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal(seen.length, n);
});

test('granted host: credential header injected, room token not forwarded, value cut from the response', async () => {
  const res = await call('/proxy/api.example.com/v4/zones?page=2', { headers: { 'x-custom': 'kept' } });
  const body = await res.text();
  const got = seen.at(-1)!;
  assert.equal(res.status, 200);
  assert.equal(got.url, '/v4/zones?page=2');
  assert.equal(got.host, 'api.example.com');
  assert.equal(got.headers.authorization, `Bearer ${VALUE}`);
  assert.equal(got.headers['x-custom'], 'kept');
  assert.equal(got.headers['accept-encoding'], 'identity');
  assert.ok(!JSON.stringify(got.headers).includes(aliceToken), 'run token must not reach the upstream');
  assert.ok(body.includes('Bearer ***'), 'echoed header is visible but masked');
  assert.ok(!body.includes(VALUE), 'value must not be echoed back to the room');
  assert.equal(res.headers.get('x-echo-auth'), 'Bearer ***');
});

test('POST body is streamed through; custom header and raw scheme from the credential', async () => {
  const res = await call('/proxy/keyed.example.com/items', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 200);
  await res.text();
  const got = seen.at(-1)!;
  assert.equal(got.method, 'POST');
  assert.equal(got.body, '{"a":1}');
  assert.equal(got.headers['x-api-key'], 'keyed-fake-value-222');
  assert.equal(got.headers.authorization, undefined);
});

test('host not in the run grants -> 403, nothing sent', async () => {
  const n = seen.length;
  const res = await call('/proxy/other.example.com/x');
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: string }).error, 'host_not_granted');
  assert.equal(seen.length, n);
});

test('another owner\'s handle -> not found; revoked -> 403; both reported for the classifier', async () => {
  const n = seen.length;
  const foreign = await call('/proxy/bob.example.com/x');
  assert.equal(foreign.status, 404);
  const fb = await foreign.text();
  assert.match(fb, /credential_missing/);
  assert.ok(!fb.includes('bob-fake-value-111'));
  const revoked = await call('/proxy/old.example.com/x');
  assert.equal(revoked.status, 403);
  assert.match(await revoked.text(), /credential_revoked/);
  assert.equal(seen.length, n, 'no upstream call without a credential');
  assert.deepEqual(gateway.takeErrors('run-a'), [
    { code: 'CREDENTIAL_MISSING', ref: 'cred:bob/api' }, { code: 'CREDENTIAL_REVOKED', ref: 'cred:old' }]);
  assert.deepEqual(gateway.takeErrors('run-a'), []);
});

test('every delivery is audited (per request, with host), never with the value', async () => {
  const before = audit.length;
  await (await call('/proxy/api.example.com/1')).text();
  await (await call('/proxy/api.example.com/2')).text();
  const lines = audit.slice(before);
  assert.deepEqual(lines.map(r => [r.run_id, r.owner, r.ref, r.host, r.outcome]), [
    ['run-a', 'alice', 'cred:api', 'api.example.com', 'granted'], ['run-a', 'alice', 'cred:api', 'api.example.com', 'granted']]);
  assert.ok(!JSON.stringify(audit).includes(VALUE));
});

test('redirects are passed back, not followed with the credential', async () => {
  const n = seen.length;
  const res = await call('/proxy/api.example.com/redirect');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://elsewhere.example/');
  assert.equal(seen.length, n + 1);
});

test('loopback upstream is refused with the production guard on', async () => {
  const n = seen.length;
  const res = await call('/proxy/api.example.com/x', {}, guardedBase);
  assert.equal(res.status, 502);
  assert.equal((await res.json() as { error: string }).error, 'upstream_blocked');
  assert.equal(seen.length, n);
});

test('a name that resolves to loopback is refused at connect time (DNS path of the guard)', async () => {
  const n = seen.length;
  const res = await call('/proxy/dns.example.com/x', {}, guardedBase);
  assert.equal(res.status, 502);
  assert.equal((await res.json() as { error: string }).error, 'upstream_blocked');
  assert.equal(seen.length, n);
});

test('Basic auth (git) and X-SAR-Run-Token are accepted; revoked run token -> 401', async () => {
  const basic = Buffer.from(`x-access-token:${aliceToken}`).toString('base64');
  assert.equal((await fetch(base + '/echo/a/b', { headers: { authorization: `Basic ${basic}` } })).status, 200);
  const r = await fetch(base + '/echo/a/b?q=1', { headers: { 'x-sar-run-token': aliceToken } });
  assert.deepEqual(await r.json(), { run: 'run-a', owner: 'alice', rest: 'a/b?q=1' });
  const t = tokens.issue({ runId: 'run-b', owner: 'alice', credentials: [] });
  tokens.revoke('run-b');
  assert.equal((await fetch(base + '/echo/x', { headers: { authorization: `Bearer ${t}` } })).status, 401);
});

test('unknown service -> 404 (prototype names included)', async () => {
  for (const p of ['/nope/x', '/constructor/x', '/', '/../etc']) assert.equal((await call(p)).status, 404, p);
});

test('the value never shows up in gateway logs', () => {
  assert.ok(logs.length > 0);
  assert.ok(logs.some(l => l.includes('host=api.example.com')));
  assert.ok(!logs.join('\n').includes(VALUE));
  assert.ok(!logs.join('\n').includes(aliceToken));
});

test('extractRunToken', () => {
  assert.equal(extractRunToken({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(extractRunToken({ authorization: `Basic ${Buffer.from('u:p').toString('base64')}` }), 'p');
  assert.equal(extractRunToken({ authorization: `Basic ${Buffer.from('nopass').toString('base64')}` }), undefined);
  assert.equal(extractRunToken({ 'x-sar-run-token': 't' }), 't');
  assert.equal(extractRunToken({}), undefined);
});

test('isBlockedAddress: loopback, private, link-local, CGNAT, v6 local and mapped are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.0.8', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '140.82.112.3', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('redactingStream masks a secret split across chunks', async () => {
  const s = 'abc-SECRET-VALUE-xyz';
  const chunks = ['..a', 'bc-SEC', 'RET-VAL', 'UE-xyz..abc-SECRET-VALUE-xyz', 'abc-SECRET-VA'];
  const out = await text(Readable.from(chunks.map(c => Buffer.from(c))).pipe(redactingStream(s)));
  assert.equal(out, '..***..***abc-SECRET-VA');
});
