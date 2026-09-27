// Execution API.
//
//   POST /runs                       create a run -> 202 {id, state, links}
//   GET  /runs                       recent runs
//   GET  /runs/:id                   run record (state, result, diagnosis)
//   GET  /runs/:id/events            JSON array; ?after=<seq>; SSE with Accept: text/event-stream or ?follow=1
//   GET  /runs/:id/debug             everything needed to understand a failure in one response
//   GET  /runs/:id/artifacts         list
//   GET  /runs/:id/artifacts/<path>  download
//   POST /runs/:id/cancel
//   GET  /healthz                    docker/runtime/image checks (no auth)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { bus, createRun, getRun, listRuns, readEvents, runDir, TERMINAL, type RunEvent } from './store.ts';
import { cancel, enqueue, gcOldRuns, reconcileOnStartup, stats, validateRequest, listFiles } from './runner.ts';
import { dockerHealth } from './rooms.ts';
import { openInside } from './safe-files.ts';

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

function authorized(req: IncomingMessage): boolean {
  if (!config.apiToken) return config.insecureDev;
  const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(config.apiToken);
  return got.length === want.length && timingSafeEqual(got, want);
}

function tail(file: string, lines: number): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines);
}

function streamEvents(req: IncomingMessage, res: ServerResponse, id: string, after: number) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const write = (ev: RunEvent) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  let last = after;
  const onEv = (ev: RunEvent) => {
    if (ev.seq <= last) return;
    last = ev.seq;
    write(ev);
    if (ev.type === 'run.completed') setTimeout(() => res.end(), 50);
  };
  bus.on(id, onEv);
  for (const ev of readEvents(id, after)) onEv(ev);
  const rec = getRun(id);
  if (rec && TERMINAL.includes(rec.state) && readEvents(id).some(e => e.type === 'run.completed')) res.end();
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => { bus.off(id, onEv); clearInterval(ping); });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const docker = await dockerHealth();
    return send(res, docker.ok ? 200 : 503, { ok: docker.ok, docker, runtime: config.roomRuntime || 'runc', image: config.roomImage, ...stats() });
  }
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

  if (parts[0] !== 'runs') return send(res, 404, { error: 'not found' });

  if (parts.length === 1) {
    if (req.method === 'GET') {
      return send(res, 200, listRuns(Number(url.searchParams.get('limit') ?? 50)).map(r => ({
        id: r.id, state: r.state, agent: r.request.agent, category: r.diagnosis?.category, created_at: r.created_at,
        task: r.request.task.slice(0, 120) })));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      body.agent ??= 'opencode';
      const err = validateRequest(body);
      if (err) return send(res, 400, { error: err });
      const rec = createRun(body);
      enqueue(rec, body);
      return send(res, 202, { id: rec.id, state: rec.state, links: {
        self: `/runs/${rec.id}`, events: `/runs/${rec.id}/events`, debug: `/runs/${rec.id}/debug`, artifacts: `/runs/${rec.id}/artifacts` } });
    }
  }

  const id = parts[1];
  const rec = getRun(id);
  if (!rec) return send(res, 404, { error: 'run not found' });
  const dir = runDir(id);

  if (req.method === 'GET' && parts.length === 2) return send(res, 200, rec);

  if (req.method === 'POST' && parts[2] === 'cancel') return send(res, cancel(id) ? 202 : 409, { id, cancel_requested: true });

  if (req.method === 'GET' && parts[2] === 'events') {
    const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0);
    if (url.searchParams.get('follow') === '1' || (req.headers.accept ?? '').includes('text/event-stream')) {
      return streamEvents(req, res, id, after);
    }
    return send(res, 200, readEvents(id, after));
  }

  if (req.method === 'GET' && parts[2] === 'debug') {
    const events = readEvents(id);
    return send(res, 200, {
      run: rec,
      diagnosis: rec.diagnosis ?? null,
      counts: events.reduce<Record<string, number>>((a, e) => (a[e.type] = (a[e.type] ?? 0) + 1, a), {}),
      last_events: events.filter(e => e.type !== 'room.stderr').slice(-40),
      stderr_tail: tail(join(dir, 'room', 'stderr.log'), 60),
      stdout_tail: tail(join(dir, 'room', 'stdout.log'), 20),
      docker: existsSync(join(dir, 'room', 'docker-args.json')) ? JSON.parse(readFileSync(join(dir, 'room', 'docker-args.json'), 'utf8')) : null,
      room_state: existsSync(join(dir, 'room', 'inspect.json')) ? JSON.parse(readFileSync(join(dir, 'room', 'inspect.json'), 'utf8')).State : null,
      workspace_files: listFiles(join(dir, 'workspace')).filter(f => !f.startsWith('.git/')).slice(0, 200),
      run_dir: dir,
    });
  }

  if (req.method === 'GET' && parts[2] === 'artifacts') {
    const root = join(dir, 'artifacts');
    if (parts.length === 3) return send(res, 200, listFiles(root));
    const fd = openInside(root, decodeURIComponent(parts.slice(3).join('/')));
    if (fd === undefined) return send(res, 404, { error: 'artifact not found' });
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return void createReadStream('', { fd }).pipe(res);
  }

  send(res, 404, { error: 'not found' });
}

async function main() {
  if (!config.apiToken && !config.insecureDev) {
    console.error('SAR_API_TOKEN is not set (set SAR_INSECURE_DEV=1 to run without auth locally)');
    process.exit(1);
  }
  const orphaned = await reconcileOnStartup();
  if (orphaned.length) console.log(`reconciled ${orphaned.length} orphaned runs: ${orphaned.join(', ')}`);
  setInterval(() => { const n = gcOldRuns(); if (n) console.log(`gc: removed ${n} old runs`); }, 3600_000).unref();

  createServer((req, res) => {
    handle(req, res).catch(e => send(res, e.status ?? 500, { error: e.message }));
  }).listen(config.port, config.host, () => {
    console.log(`serverless-ai-agent-run listening on http://${config.host}:${config.port} data=${config.dataDir} runtime=${config.roomRuntime || 'runc'}`);
  });
}

main();
