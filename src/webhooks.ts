// Outbound webhooks: every lifecycle event (and, opt-in, every agent event) is
// POSTed to the run's webhook URL, signed with HMAC-SHA256 when a secret is given:
//   X-SAR-Signature: sha256=<hex hmac of the raw body>
// Deliveries are serialized per run so the receiver sees events in order.
// Delivery results are themselves recorded as webhook.* events — a broken
// receiver is visible in the run's own event log.
import { createHmac } from 'node:crypto';
import type { RunEvent } from './store.ts';

export interface WebhookTarget { url: string; secret?: string; agent_events?: boolean }

const queues = new Map<string, Promise<void>>();

export function shouldDeliver(target: WebhookTarget, ev: RunEvent): boolean {
  if (ev.type.startsWith('webhook.')) return false;
  if (ev.type.startsWith('agent.')) return !!target.agent_events;
  return true;
}

export function deliver(target: WebhookTarget, ev: RunEvent, record: (type: string, data: Record<string, unknown>) => void): Promise<void> {
  const prev = queues.get(ev.run_id) ?? Promise.resolve();
  const next = prev.then(() => send(target, ev, record));
  queues.set(ev.run_id, next);
  return next;
}

export function flush(runId: string): Promise<void> {
  return queues.get(runId) ?? Promise.resolve();
}

async function send(target: WebhookTarget, ev: RunEvent, record: (type: string, data: Record<string, unknown>) => void) {
  const body = JSON.stringify(ev);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-sar-event': ev.type, 'x-sar-run-id': ev.run_id };
  if (target.secret) headers['x-sar-signature'] = 'sha256=' + createHmac('sha256', target.secret).update(body).digest('hex');
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(target.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (e: any) {
      lastErr = e.cause?.code ?? e.message;
    }
    await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
  }
  record('webhook.failed', { event_seq: ev.seq, event_type: ev.type, error: lastErr, url: target.url });
}
