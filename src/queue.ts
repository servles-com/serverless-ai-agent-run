// Run queue: admission (FIFO up to SAR_MAX_ROOMS), rooms in flight, cancel
// requests and per-run in-memory state (full request incl. secrets, webhook
// target). What a run does lives in runner.ts, plugged in via startQueue().
import { config } from './config.ts';
import type { RoomHandle } from './rooms.ts';
import { bus, emit, getRun, TERMINAL, type Diagnosis, type RunRecord, type RunRequest, type RunState } from './store.ts';
import { deliver, flush, shouldDeliver, type WebhookTarget } from './webhooks.ts';

export interface Completion { state: RunState; diagnosis?: Diagnosis; warnings: string[] }

export interface Lifecycle {
  execute(id: string): Promise<void>;
  finish(rec: RunRecord, v: Completion): void;
}

const queue: string[] = [];
const active = new Map<string, RoomHandle | null>();
const cancelRequested = new Set<string>();
// Webhook secrets live only in memory (run.json has them redacted).
const webhooks = new Map<string, WebhookTarget>();
const requests = new Map<string, RunRequest>();
let lifecycle: Lifecycle | undefined;

bus.on('*', ev => {
  const target = webhooks.get(ev.run_id);
  if (target && shouldDeliver(target, ev)) {
    void deliver(target, ev, (type, data) => emit(ev.run_id, type, data));
  }
});

export function startQueue(l: Lifecycle): void {
  lifecycle = l;
  pump();
}

export function enqueue(rec: RunRecord, req: RunRequest): void {
  requests.set(rec.id, req);
  if (req.webhook) webhooks.set(rec.id, req.webhook);
  queue.push(rec.id);
  pump();
}

export function cancel(id: string): boolean {
  const rec = getRun(id);
  if (!rec || TERMINAL.includes(rec.state)) return false;
  cancelRequested.add(id);
  const qi = queue.indexOf(id);
  if (qi >= 0) {
    queue.splice(qi, 1);
    lifecycle!.finish(rec, { state: 'CANCELLED', diagnosis: { category: 'CANCELLED', summary: 'Cancelled while queued', evidence: [], retryable: true, hints: [] }, warnings: [] });
    return true;
  }
  active.get(id)?.cancel();
  return true;
}

export function stats() {
  return { queued: queue.length, active: [...active.keys()], max_rooms: config.maxRooms };
}

export const requestOf = (id: string): RunRequest | undefined => requests.get(id);
export const isCancelRequested = (id: string): boolean => cancelRequested.has(id);

// The room is known only once started; a cancel that arrived while preparing applies now.
export function attachRoom(id: string, room: RoomHandle): void {
  active.set(id, room);
  if (cancelRequested.has(id)) room.cancel();
}

// Drop per-run in-memory state once the run is terminal (webhook target after the last delivery).
export function release(id: string): void {
  cancelRequested.delete(id);
  requests.delete(id);
  void flush(id).then(() => webhooks.delete(id));
}

function pump(): void {
  if (!lifecycle) return;
  const { execute, finish } = lifecycle;
  while (active.size < config.maxRooms && queue.length) {
    const id = queue.shift()!;
    active.set(id, null);
    execute(id).catch(err => {
      const rec = getRun(id);
      if (rec && !TERMINAL.includes(rec.state)) {
        finish(rec, { state: 'FAILED', diagnosis: { category: 'RUNTIME_BUG', summary: 'Unhandled error in the run manager',
          evidence: [String(err?.stack ?? err)], retryable: true, hints: ['This is a bug in serverless-ai-agent-run itself'] }, warnings: [] });
      }
    }).finally(() => { active.delete(id); pump(); });
  }
}
