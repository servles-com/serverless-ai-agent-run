// Outbound webhooks: every lifecycle event (and, opt-in, every agent event) is
// POSTed to the run's webhook URL, signed with HMAC-SHA256 when a secret is given:
//   X-SAR-Signature: sha256=<hex hmac of the raw body>
// Deliveries are serialized per run so the receiver sees events in order.
// Delivery results are themselves recorded as webhook.* events — a broken
// receiver is visible in the run's own event log.
// agent_events: 'coalesced' batches agent events into one `agent.coalesced`
// delivery at most every 2 s (Telegram edit-message friendly), see src/stream.ts.
import { createHmac } from 'node:crypto';
import type { RunEvent } from './store.ts';
import { Coalescer } from './stream.ts';
import { config } from './config.ts';

export interface WebhookTarget { url: string; secret?: string; agent_events?: boolean | 'coalesced' }

const queues = new Map<string, Promise<void>>();
const coalescers = new Map<string, Coalescer>();

export function shouldDeliver(target: WebhookTarget, ev: RunEvent): boolean {
  if (ev.type.startsWith('webhook.')) return false;
  if (ev.type.startsWith('agent.')) return !!target.agent_events;
  return true;
}

export function deliver(target: WebhookTarget, ev: RunEvent, record: (type: string, data: Record<string, unknown>) => void): Promise<void> {
  if (target.agent_events === 'coalesced') {
    let c = coalescers.get(ev.run_id);
    if (ev.type.startsWith('agent.')) {
      if (!c) coalescers.set(ev.run_id, c = new Coalescer({ send: batch => void enqueue(target, batch, record) }));
      c.push(ev);
      return queues.get(ev.run_id) ?? Promise.resolve();
    }
    c?.flush();   // pending agent batch goes out before the lifecycle event
    if (ev.type === 'run.completed') coalescers.delete(ev.run_id);
  }
  return enqueue(target, ev, record);
}

function enqueue(target: WebhookTarget, ev: RunEvent, record: (type: string, data: Record<string, unknown>) => void): Promise<void> {
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
      const res = await fetch(target.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(config.webhookTimeoutMs) });
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
