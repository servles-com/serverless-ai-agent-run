// Scheduler (SB10): which queued run gets the next free room. Pure — no I/O,
// no config import; queue.ts owns the state and calls pickNext() from pump().
//
// Order of precedence:
//   1. rooms: nothing starts while active.length >= maxRooms;
//   2. eligibility: a batch never exceeds its `concurrency`; runs sharing a
//      `serial_key` start one at a time and in queue order;
//   3. lanes: any eligible interactive run (no batch) beats every batch item;
//   4. fairness inside a lane: round-robin over owners, then (batch lane)
//      round-robin over that owner's batches; FIFO inside an owner/batch.
// The round-robin cursor is passed in and returned, never mutated.

export type Lane = 'interactive' | 'batch';

export interface Job {
  id: string;
  owner?: string;
  batch?: { id: string; concurrency?: number };
  serial_key?: string;
}

export interface SchedulerConfig {
  maxRooms: number;
  // Global cap on queued runs (SAR_MAX_QUEUE); 0 = unlimited.
  maxQueue: number;
}

// Last served owner per lane and last served batch per owner.
export interface RoundRobin {
  owners: Partial<Record<Lane, string>>;
  batches: Record<string, string>;
}

export interface Pick { index: number; job: Job; rr: RoundRobin }

export const DEFAULT_OWNER = 'default';
export const emptyRoundRobin = (): RoundRobin => ({ owners: {}, batches: {} });

export const laneOf = (job: Job): Lane => job.batch ? 'batch' : 'interactive';
const ownerOf = (job: Job): string => job.owner ?? DEFAULT_OWNER;

export function pickNext(queue: readonly Job[], active: readonly Job[], cfg: SchedulerConfig,
  rr: RoundRobin = emptyRoundRobin()): Pick | undefined {
  if (active.length >= cfg.maxRooms) return undefined;

  const runningPerBatch = new Map<string, number>();
  const busySerial = new Set<string>();
  for (const j of active) {
    if (j.batch) runningPerBatch.set(j.batch.id, (runningPerBatch.get(j.batch.id) ?? 0) + 1);
    if (j.serial_key !== undefined) busySerial.add(j.serial_key);
  }

  const eligible: Record<Lane, { index: number; job: Job }[]> = { interactive: [], batch: [] };
  queue.forEach((job, index) => {
    // Only the first queued run of a serial_key may start, and only when none is running.
    const serialBlocked = job.serial_key !== undefined && busySerial.has(job.serial_key);
    if (job.serial_key !== undefined) busySerial.add(job.serial_key);
    if (serialBlocked) return;
    if (job.batch && (runningPerBatch.get(job.batch.id) ?? 0) >= (job.batch.concurrency ?? Infinity)) return;
    eligible[laneOf(job)].push({ index, job });
  });

  const lane: Lane = eligible.interactive.length ? 'interactive' : 'batch';
  const candidates = eligible[lane];
  if (!candidates.length) return undefined;

  const owner = nextInRing(candidates.map(c => ownerOf(c.job)), rr.owners[lane]);
  const mine = candidates.filter(c => ownerOf(c.job) === owner);
  let chosen = mine[0];
  const next: RoundRobin = { owners: { ...rr.owners, [lane]: owner }, batches: rr.batches };
  if (lane === 'batch') {
    const batch = nextInRing(mine.map(c => c.job.batch!.id), rr.batches[owner]);
    chosen = mine.find(c => c.job.batch!.id === batch)!;
    next.batches = { ...rr.batches, [owner]: batch };
  }
  return { index: chosen.index, job: chosen.job, rr: next };
}

// The smallest key after `last` in sorted order, wrapping around.
function nextInRing(keys: string[], last: string | undefined): string {
  const ring = [...new Set(keys)].sort();
  return ring.find(k => last === undefined || k > last) ?? ring[0];
}

export type Admission = { ok: true } | { ok: false; status: 429; error: string };

// Checked on POST /runs before a run is created: `queued` = runs waiting for a room.
export function admit(queued: number, cfg: SchedulerConfig): Admission {
  if (cfg.maxQueue > 0 && queued >= cfg.maxQueue) {
    return { ok: false, status: 429, error: `queue is full (${queued}/${cfg.maxQueue} runs waiting); retry later` };
  }
  return { ok: true };
}
