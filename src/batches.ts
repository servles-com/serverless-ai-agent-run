// Batches (M1 step 8, #73 T4 minimal): "run these N tasks, at most K at a time, give
// me one report". A thin layer over runs: every item is an ordinary run (own id,
// /debug, expect), created lazily when the batch has a free slot. State lives in
// batches/<id>/batch.json (items + their run ids), so a restart resumes submitting;
// runs that were in flight end as ORPHANED_BY_RESTART like any other run.
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { bus, createRun, getRun, TERMINAL, type RunRecord, type RunRequest } from './store.ts';
import { enqueue, cancel, validateRequest } from './runner.ts';

export const MAX_ITEMS = 200;

export interface BatchItem { id: string; request: RunRequest; run_id?: string }
export interface Batch { id: string; created_at: string; concurrency: number; cancelled?: boolean; items: BatchItem[] }

interface ItemInput { id?: unknown; task?: unknown; files?: unknown; model?: unknown; vars?: unknown; expect?: unknown }

// Pure: request body -> items, or an error for a 400 before anything is created.
export function expandBatch(body: unknown, maxRooms: number): { items: BatchItem[]; concurrency: number } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const b = body as { run?: Record<string, unknown>; items?: unknown; concurrency?: unknown };
  const template = b.run ?? {};
  if (typeof template !== 'object' || Array.isArray(template)) return { error: 'run must be an object (the request template)' };
  if (!Array.isArray(b.items) || b.items.length === 0) return { error: 'items must be a non-empty array' };
  if (b.items.length > MAX_ITEMS) return { error: `at most ${MAX_ITEMS} items per batch` };
  const concurrency = b.concurrency ?? Math.min(3, maxRooms);
  if (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > maxRooms) {
    return { error: `concurrency must be an integer 1..${maxRooms} (SAR_MAX_ROOMS)` };
  }
  const items: BatchItem[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of (b.items as ItemInput[]).entries()) {
    if (!raw || typeof raw !== 'object') return { error: `items[${i}] must be an object` };
    const id = raw.id === undefined ? String(i + 1) : String(raw.id);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || seen.has(id)) return { error: `items[${i}].id must be unique [A-Za-z0-9._-]{1,64}` };
    seen.add(id);
    const vars = (raw.vars ?? {}) as Record<string, unknown>;
    if (typeof vars !== 'object' || Array.isArray(vars)) return { error: `items[${i}].vars must be an object` };
    const task = String(raw.task ?? template.task ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k) => k in vars ? String(vars[k]) : m);
    const request = {
      ...template, agent: (template.agent as string) ?? 'opencode', task,
      ...(raw.files !== undefined ? { files: { ...(template.files as object ?? {}), ...(raw.files as object) } } : {}),
      ...(raw.model !== undefined ? { model: raw.model } : {}),
      ...(raw.expect !== undefined ? { expect: raw.expect } : {}),
      metadata: { ...(template.metadata as object ?? {}), batch_item: id },
    } as RunRequest;
    const err = validateRequest(request);
    if (err) return { error: `items[${i}] (${id}): ${err}` };
    items.push({ id, request });
  }
  return { items, concurrency: concurrency as number };
}

export interface ItemView { id: string; run_id?: string; state: string; category?: string; summary?: string; artifacts?: string[]; pull_request?: string }

export function itemView(item: BatchItem, rec: RunRecord | undefined): ItemView {
  if (!item.run_id) return { id: item.id, state: 'PENDING' };
  if (!rec) return { id: item.id, run_id: item.run_id, state: 'UNKNOWN' };
  return { id: item.id, run_id: item.run_id, state: rec.state, category: rec.diagnosis?.category,
    summary: rec.diagnosis?.summary, artifacts: rec.result?.artifacts, pull_request: rec.result?.pull_request?.url };
}

// Pure: the one report. A batch is SUCCEEDED only if every item is; partial success
// is PARTIAL, not success.
export function summarize(b: Pick<Batch, 'id' | 'cancelled'>, items: ItemView[]) {
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.category ?? it.state] = (counts[it.category ?? it.state] ?? 0) + 1;
  const done = items.filter(it => (TERMINAL as string[]).includes(it.state)).length;
  const ok = items.filter(it => it.state === 'SUCCEEDED').length;
  const finished = done === items.length || (!!b.cancelled && items.every(it => it.state === 'PENDING' || (TERMINAL as string[]).includes(it.state)));
  const state = !finished ? (b.cancelled ? 'CANCELLING' : 'RUNNING')
    : b.cancelled ? 'CANCELLED' : ok === items.length ? 'SUCCEEDED' : ok === 0 ? 'FAILED' : 'PARTIAL';
  return { id: b.id, state, total: items.length, done, succeeded: ok, counts, items };
}

export function reportMarkdown(s: ReturnType<typeof summarize>): string {
  const rows = s.items.map(it => `| ${it.id} | ${it.state} | ${it.category ?? ''} | ${it.run_id ?? ''} | ${(it.summary ?? (it.artifacts ?? []).join(', ')).replace(/\|/g, '\\|').slice(0, 120)} |`);
  return [`# Batch ${s.id}: ${s.state}`, '', `${s.succeeded}/${s.total} succeeded, ${s.done} finished.`, '',
    Object.entries(s.counts).map(([k, v]) => `- ${k}: ${v}`).join('\n'), '',
    '| item | state | category | run | summary / artifacts |', '|---|---|---|---|---|', ...rows, ''].join('\n');
}

// --- files + submission
const batchesDir = () => join(config.dataDir, 'batches');
const batchFile = (id: string) => join(batchesDir(), id, 'batch.json');

function save(b: Batch): void {
  mkdirSync(join(batchesDir(), b.id), { recursive: true });
  writeFileSync(batchFile(b.id) + '.tmp', JSON.stringify(b, null, 2));
  renameSync(batchFile(b.id) + '.tmp', batchFile(b.id));
}

export function getBatch(id: string): Batch | undefined {
  if (!/^batch_[0-9a-z_]+$/.test(id) || !existsSync(batchFile(id))) return undefined;
  return JSON.parse(readFileSync(batchFile(id), 'utf8'));
}

export function listBatches(limit = 50): Batch[] {
  if (!existsSync(batchesDir())) return [];
  return readdirSync(batchesDir()).filter(d => d.startsWith('batch_')).sort().reverse().slice(0, limit)
    .map(getBatch).filter((b): b is Batch => !!b);
}

export function batchSummary(b: Batch) {
  return summarize(b, b.items.map(it => itemView(it, it.run_id ? getRun(it.run_id) : undefined)));
}

// Submit pending items while the batch has fewer than `concurrency` runs in flight.
export function pumpBatch(id: string): void {
  const b = getBatch(id);
  if (!b || b.cancelled) return;
  let inFlight = b.items.filter(it => it.run_id && !TERMINAL.includes(getRun(it.run_id)?.state ?? 'FAILED')).length;
  let changed = false;
  for (const it of b.items) {
    if (inFlight >= b.concurrency) break;
    if (it.run_id) continue;
    const rec = createRun({ ...it.request, metadata: { ...it.request.metadata, batch_id: b.id } });
    it.run_id = rec.id;
    changed = true;
    save(b);                                   // persisted before the run can start
    enqueue(rec, rec.request);
    inFlight++;
  }
  if (changed) save(b);
}

export function createBatch(items: BatchItem[], concurrency: number): Batch {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const b: Batch = { id: `batch_${t}_${randomBytes(5).toString('hex')}`, created_at: new Date().toISOString(), concurrency, items };
  save(b);
  pumpBatch(b.id);
  return getBatch(b.id)!;
}

export function cancelBatch(id: string): Batch | undefined {
  const b = getBatch(id);
  if (!b) return undefined;
  b.cancelled = true;
  save(b);
  for (const it of b.items) if (it.run_id) cancel(it.run_id);
  return b;
}

// A finished run frees a slot in its batch.
bus.on('*', ev => {
  if (ev.type !== 'run.completed') return;
  const batchId = getRun(ev.run_id)?.request.metadata?.batch_id;
  if (typeof batchId === 'string') setImmediate(() => pumpBatch(batchId));
});

// After a restart: keep submitting what is left.
export function resumeBatches(): number {
  let n = 0;
  for (const b of listBatches(1000)) if (!b.cancelled && b.items.some(it => !it.run_id)) { pumpBatch(b.id); n++; }
  return n;
}
