// SAR -> trained-assist-agent proxy, against a fake agent that speaks the real
// wire format of POST /web/run-bearer (SSE) and POST /web/stop-bearer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildAgentRequest, buildAgentTask, ignoredFields, parseSse, runOnAgent, validateRequest, type AgentProxyConfig } from '../../src/agent-proxy.ts';
import type { RunRequest } from '../../src/store.ts';

const SECRET = 'agent-secret-for-tests';
type Json = Record<string, unknown>;
const received: { path: string; auth?: string; body: Json }[] = [];
let agent: Server;
let cfg: AgentProxyConfig;

const body = async (req: IncomingMessage): Promise<Json> => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const frame = (res: ServerResponse, data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

// Behaviour is picked by the first word of the task.
async function fakeAgent(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/health') return res.end('{"status":"alive"}');
  const b = await body(req);
  received.push({ path: req.url!, auth: req.headers.authorization, body: b });
  if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
  if (req.url === '/web/stop-bearer') return res.end('{"ok":true}');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const mode = String(b.task).split(/\s/)[0];
  frame(res, { type: 'session', sessionId: `sess-${b.requestId}` });
  if (mode === 'ok') {
    frame(res, { type: 'progress', message: '🔧 Bash ls' });
    res.write('event: ping\ndata: {}\n\n');
    // One frame split across two writes: the parser must reassemble it.
    const f = `data: ${JSON.stringify({ type: 'chunk', text: 'first block' })}\n\n`;
    res.write(f.slice(0, 10)); res.write(f.slice(10));
    frame(res, { type: 'chunk', text: 'final answer: ok' });
    frame(res, { type: 'done', sessionId: `sess-${b.requestId}` });
    return res.end();
  }
  if (mode === 'fail') { frame(res, { type: 'error', error: 'Задача завершилась без ответа' }); return res.end(); }
  if (mode === 'drop') return res.destroy();
  // 'hang': only keep-alives until the client goes away.
  const t = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 100);
  req.on('close', () => clearInterval(t));
}

before(async () => {
  agent = createServer((req, res) => { void fakeAgent(req, res); });
  await new Promise<void>(r => agent.listen(0, '127.0.0.1', r));
  cfg = { agentUrl: `http://127.0.0.1:${(agent.address() as AddressInfo).port}`, agentSecret: SECRET, profile: 'sar-proxy' };
});
after(() => { agent.closeAllConnections(); agent.close(); });

const req = (task: string, over: Partial<RunRequest> = {}): RunRequest => ({ agent: 'opencode', task, ...over });
const run = (task: string, o: { timeoutS?: number; idleTimeoutS?: number } = {}, c = cfg) => {
  const events: string[] = [];
  const h = runOnAgent({ runId: `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`, req: req(task),
    timeoutS: o.timeoutS ?? 10, idleTimeoutS: o.idleTimeoutS ?? 10, onEvent: ev => events.push(ev.type) }, c);
  return { h, events };
};

test('SAR request -> agent request: files and repo inlined, run id as requestId', () => {
  const r = req('Fix calc.py', { files: { 'calc.py': 'x = 1' }, repo: { url: 'https://github.com/o/r', ref: 'main' } });
  const task = buildAgentTask(r);
  assert.match(task, /^Fix calc\.py\n\nRepository: https:\/\/github\.com\/o\/r \(ref: main\)/);
  assert.match(task, /--- calc\.py ---\nx = 1\n--- end calc\.py ---/);
  assert.deepEqual(buildAgentRequest('run_1', r, cfg), { username: 'sar-proxy', task, requestId: 'run_1' });
});

test('validateRequest: SAR contract accepted, what the backend cannot do is refused up front', () => {
  assert.equal(validateRequest({ task: 'x', model: 'm', secrets: ['GITHUB_TOKEN'], webhook: { url: 'https://h' }, expect: { text: 'ok' },
    limits: { timeout_s: 60, idle_timeout_s: 30, memory_mb: 512 }, repo: { url: 'https://github.com/o/r' }, files: { 'a/b.py': '' } }), undefined);
  assert.match(validateRequest({ task: 'x', agent: 'shell' })!, /unknown agent/);
  assert.match(validateRequest({ task: ' ' })!, /task/);
  assert.match(validateRequest({ task: 'x', files: { '../etc/passwd': '' } })!, /unsafe/);
  assert.match(validateRequest({ task: 'x', files: { 'a': 'x'.repeat(1024 * 1024 + 1) } })!, /at most/);
  assert.match(validateRequest({ task: 'x', repo: { url: 'https://github.com/o/r', pull_request: {} } })!, /pull_request/);
  assert.match(validateRequest({ task: 'x', credentials: [] })!, /credentials/);
  assert.match(validateRequest({ task: 'x', expect: { artifacts: ['a.md'] } })!, /artifacts/);
  assert.match(validateRequest({ task: 'x', expect: { text: '(' } })!, /regex/);
});

test('ignored request fields become run warnings', () => {
  const w = ignoredFields(req('x', { model: 'm', secrets: ['S'], limits: { memory_mb: 1, timeout_s: 5 } }));
  assert.equal(w.length, 3);
  assert.deepEqual(ignoredFields(req('x', { limits: { timeout_s: 5 } })), []);
});

test('parseSse keeps an incomplete frame for the next read', () => {
  const { frames, rest } = parseSse('event: ping\ndata: {}\n\ndata: {"type":"chunk"}\n\ndata: {"ty');
  assert.deepEqual(frames, [{ event: 'ping', data: '{}' }, { event: undefined, data: '{"type":"chunk"}' }]);
  assert.equal(rest, 'data: {"ty');
});

test('successful run: bearer auth, last chunk is the answer, session remembered', async () => {
  const { h, events } = run('ok please');
  const o = await h.done;
  assert.equal(o.done, true);
  assert.equal(o.finalText, 'final answer: ok');
  assert.equal(o.chunks, 2);
  assert.equal(o.progress, 1);
  assert.match(o.sessionId!, /^sess-run_/);
  assert.deepEqual(events, ['session', 'progress', 'chunk', 'chunk', 'done']);
  const call = received.findLast(r => r.path === '/web/run-bearer')!;
  assert.equal(call.auth, `Bearer ${SECRET}`);
  assert.equal(call.body.username, 'sar-proxy');
});

test('agent error frame, dropped connection, wrong secret', async () => {
  assert.equal((await run('fail').h.done).agentError, 'Задача завершилась без ответа');
  const dropped = await run('drop').h.done;
  assert.equal(dropped.done, false);
  const denied = await run('ok', {}, { ...cfg, agentSecret: 'wrong' }).h.done;
  assert.equal(denied.httpStatus, 401);
  const down = await run('ok', {}, { ...cfg, agentUrl: 'http://127.0.0.1:1' }).h.done;
  assert.ok(down.transportError);
});

test('idle watchdog ignores keep-alive pings; timeout and cancel stop the agent session', async () => {
  const idle = await run('hang', { idleTimeoutS: 1 }).h.done;
  assert.equal(idle.idleKilled, true);
  assert.equal(idle.transportError, undefined);
  const timed = await run('hang', { timeoutS: 1 }).h.done;
  assert.equal(timed.timedOut, true);

  const { h } = run('hang');
  await new Promise(r => setTimeout(r, 300));
  h.cancel();
  const o = await h.done;
  assert.equal(o.cancelled, true);
  await new Promise(r => setTimeout(r, 100));
  const stops = received.filter(r => r.path === '/web/stop-bearer').map(r => r.body.id);
  assert.ok(stops.includes(o.sessionId), `stop-bearer called for ${o.sessionId}: ${stops}`);
});

// --- The whole SAR API in front of the fake agent: POST /runs -> webhook -> GET /runs/:id.
test('SAR API end to end through the proxy', async (t) => {
  const port = await new Promise<number>(r => { const s = createServer().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
  const hooks: { sig?: string; raw: string }[] = [];
  const hookSrv = createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; hooks.push({ sig: req.headers['x-sar-signature'] as string, raw }); res.end(); });
  await new Promise<void>(r => hookSrv.listen(0, '127.0.0.1', r));
  const sar: ChildProcess = spawn(process.execPath, ['src/server.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    SAR_PORT: String(port), SAR_API_TOKEN: 'api-token', SAR_DATA_DIR: mkdtempSync(join(tmpdir(), 'sar-proxy-')),
    SAR_AGENT_URL: cfg.agentUrl, SAR_AGENT_SECRET: SECRET } });
  t.after(() => { sar.kill(); hookSrv.closeAllConnections(); hookSrv.close(); });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method: string, path: string, b?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: 'Bearer api-token', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads arbitrary API JSON
    return { status: res.status, json: await res.json() as any };
  };
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    if (i > 100) throw new Error('SAR did not start');
    await new Promise(r => setTimeout(r, 50));
  }
  const health = await (await fetch(`${base}/healthz`)).json() as Json;
  assert.equal(health.backend, 'trained-assist-agent');

  const hookUrl = `http://127.0.0.1:${(hookSrv.address() as AddressInfo).port}/hook`;
  const created = await api('POST', '/runs', { task: 'ok fix it', model: 'x/y', expect: { text: 'ok' }, webhook: { url: hookUrl, secret: 'hmac' } });
  assert.equal(created.status, 202);
  let rec = (await api('GET', `/runs/${created.json.id}`)).json;
  for (let i = 0; i < 100; i++) {
    rec = (await api('GET', `/runs/${created.json.id}`)).json;
    if (['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(rec.state)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(rec.state, 'SUCCEEDED', JSON.stringify(rec.diagnosis));
  assert.equal(rec.result.text, 'final answer: ok');
  assert.equal(rec.agent_backend.profile, 'sar-proxy');
  assert.match(rec.warnings.join(), /model "x\/y" ignored/);
  const events = (await api('GET', `/runs/${created.json.id}/events`)).json.map((e: { type: string }) => e.type);
  for (const t of ['run.state', 'agent.tool', 'agent.text', 'run.completed']) assert.ok(events.includes(t), `${t} in ${events}`);

  for (let i = 0; i < 100 && !hooks.some(h => h.raw.includes('run.completed')); i++) await new Promise(r => setTimeout(r, 50));
  const last = hooks.find(h => h.raw.includes('run.completed'))!;
  assert.equal(last.sig, `sha256=${createHmac('sha256', 'hmac').update(last.raw).digest('hex')}`);
  assert.ok(!JSON.stringify(rec).includes(SECRET), 'agent secret never lands in the run record');

  const failed = await api('POST', '/runs', { task: 'fail now' });
  for (let i = 0; i < 100; i++) {
    rec = (await api('GET', `/runs/${failed.json.id}`)).json;
    if (rec.state === 'FAILED') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(rec.diagnosis?.category, 'AGENT_CRASHED');
  assert.equal((await api('POST', '/runs', { task: 'x', repo: { url: 'https://github.com/o/r', pull_request: {} } })).status, 400);
});
