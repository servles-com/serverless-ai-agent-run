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

// Waits for a terminal state. `maxS` counts from when the run leaves QUEUED —
// time spent waiting for a free room is not the run's fault. A run stuck in the
// queue longer than `maxQueueS` throws QueueTimeoutError (and is cancelled).
export class QueueTimeoutError extends Error {}
export async function runAndWait(req: Record<string, unknown>, maxS = 300, maxQueueS = 1800): Promise<any> {
  const created = await api('POST', '/runs', req);
  if (created.status !== 202) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  const t0 = Date.now();
  let startedAt: number | undefined;
  for (;;) {
    const r = await api('GET', `/runs/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(r.body.state)) return r.body;
    if (r.body.state !== 'QUEUED' && startedAt === undefined) startedAt = Date.now();
    if (startedAt === undefined && Date.now() - t0 > maxQueueS * 1000) {
      await api('POST', `/runs/${id}/cancel`);
      throw new QueueTimeoutError(`run ${id} waited in the queue for more than ${maxQueueS}s`);
    }
    if (startedAt !== undefined && Date.now() - startedAt > maxS * 1000) throw new Error(`run ${id} did not finish in ${maxS}s after start`);
    await new Promise(res => setTimeout(res, 1000));
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
