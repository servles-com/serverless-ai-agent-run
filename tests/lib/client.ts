// Tiny client for the e2e suites. Talks to a running server:
//   SAR_URL (default http://127.0.0.1:8787), SAR_API_TOKEN
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

export const BASE = process.env.SAR_URL ?? 'http://127.0.0.1:8787';
const headers = () => ({ 'content-type': 'application/json', authorization: `Bearer ${process.env.SAR_API_TOKEN ?? ''}` });

export async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// Undici's `fetch failed` hides the real reason in `cause` (ECONNREFUSED while the
// service restarts, ECONNRESET, ...). Issue #86: two dogfood rows were lost as bare
// "fetch failed" because a single failed poll aborted the whole wait.
export function describeError(e: any): string {
  const c = e?.cause;
  const why = c ? [c.code, c.message].filter(Boolean).join(' ') : '';
  return why && !String(e?.message).includes(why) ? `${e?.message} (${why})` : String(e?.message ?? e);
}

// Network-level failure (no HTTP response). ECONNREFUSED means the request never
// reached the server, so even a non-idempotent POST is safe to repeat.
export function isTransientFetchError(e: any, method = 'GET'): boolean {
  if (!(e instanceof TypeError) || e.message !== 'fetch failed') return false;
  return method === 'GET' || (e.cause as { code?: string } | undefined)?.code === 'ECONNREFUSED';
}

// Retries transient network errors until `graceMs` of continuous failure has passed.
export async function withRetry<T>(fn: () => Promise<T>, method: string, graceMs: number, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<T> {
  const start = Date.now();
  for (let delay = 500; ; delay = Math.min(delay * 2, 5000)) {
    try { return await fn(); } catch (e) {
      if (!isTransientFetchError(e, method) || Date.now() - start >= graceMs) throw e;
      await sleep(delay);
    }
  }
}

export class RunWaitError extends Error {
  runId?: string;
  constructor(message: string, runId?: string) { super(message); this.runId = runId; }
}

// Waits for a terminal state. `maxS` counts from when the run leaves QUEUED: time
// spent waiting for a free room is not the run's fault. A run stuck in the queue
// longer than `maxQueueS` is cancelled and throws QueueTimeoutError. `graceMs`: how
// long the API may be unreachable (e.g. `sar` restarting on deploy) before giving up;
// the run itself survives or ends as ORPHANED_BY_RESTART.
export class QueueTimeoutError extends RunWaitError {}
export async function runAndWait(req: Record<string, unknown>, maxS = 300, graceMs = 90_000, maxQueueS = 1800): Promise<any> {
  let created: any;
  try { created = await withRetry(() => api('POST', '/runs', req), 'POST', graceMs); } catch (e) { throw new RunWaitError(`create: ${describeError(e)}`); }
  if (created.status !== 202) throw new RunWaitError(`create failed: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  const t0 = Date.now();
  let startedAt: number | undefined;
  for (;;) {
    let r: any;
    try { r = await withRetry(() => api('GET', `/runs/${id}`), 'GET', graceMs); } catch (e) { throw new RunWaitError(`poll ${id}: ${describeError(e)}`, id); }
    const state = r.body?.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(state)) return r.body;
    if (state !== 'QUEUED' && startedAt === undefined) startedAt = Date.now();
    if (startedAt === undefined && Date.now() - t0 > maxQueueS * 1000) {
      await api('POST', `/runs/${id}/cancel`).catch(() => {});
      throw new QueueTimeoutError(`run ${id} waited in the queue for more than ${maxQueueS}s`, id);
    }
    if (startedAt !== undefined && Date.now() - startedAt > maxS * 1000) throw new RunWaitError(`run ${id} did not finish in ${maxS}s after start`, id);
    await new Promise(res => setTimeout(res, 500));
  }
}

export function explain(run: any): string {
  return `${run.id} state=${run.state} category=${run.diagnosis?.category} result=${JSON.stringify(run.result?.text)?.slice(0, 300)} evidence=${JSON.stringify(run.diagnosis?.evidence)?.slice(0, 600)}`;
}

// Local webhook receiver; the room network cannot reach it, but the control
// plane (on the host) can — which is exactly the real topology.
export async function webhookReceiver(secret: string) {
  const events: any[] = [];
  let badSignatures = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const want = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
      if (req.headers['x-sar-signature'] !== want) badSignatures++;
      events.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/hook`, events, bad: () => badSignatures, close: () => server.close() };
}
