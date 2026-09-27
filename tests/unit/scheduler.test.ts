import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admit, emptyRoundRobin, pickNext, type Job, type RoundRobin, type SchedulerConfig } from '../../src/scheduler.ts';

const cfg = (maxRooms = 1, maxQueue = 0): SchedulerConfig => ({ maxRooms, maxQueue });
const item = (id: string, batch: string, owner = 'o', concurrency?: number): Job => ({ id, owner, batch: { id: batch, concurrency } });

// Drive pickNext like queue.ts would: start picks until no room, finishing the
// oldest active run when all rooms are busy. Returns ids in start order.
function drain(queue: Job[], maxRooms = 1): string[] {
  const q = [...queue];
  const active: Job[] = [];
  const order: string[] = [];
  let rr: RoundRobin = emptyRoundRobin();
  while (q.length) {
    const p = pickNext(q, active, cfg(maxRooms), rr);
    if (!p) {
      assert.ok(active.length, 'nothing runs, yet nothing can start: deadlock');
      active.shift();
      continue;
    }
    rr = p.rr;
    order.push(p.job.id);
    active.push(q.splice(p.index, 1)[0]);
  }
  return order;
}

test('nothing starts while every room is busy', () => {
  assert.equal(pickNext([{ id: 'a' }], [{ id: 'x' }], cfg(1)), undefined);
  assert.equal(pickNext([{ id: 'a' }], [{ id: 'x' }], cfg(2))?.job.id, 'a');
  assert.equal(pickNext([], [], cfg(1)), undefined);
});

test('a lone owner with single runs is plain FIFO', () => {
  assert.deepEqual(drain([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), ['a', 'b', 'c']);
});

test('interactive runs overtake batch items queued earlier', () => {
  const q: Job[] = [item('b1', 'B'), item('b2', 'B'), { id: 'i1' }];
  const p = pickNext(q, [], cfg());
  assert.equal(p?.job.id, 'i1');
  assert.equal(p?.index, 2);
  assert.deepEqual(drain(q), ['i1', 'b1', 'b2']);
});

test('batches of one owner are served round-robin, not batch by batch', () => {
  const q = [item('a1', 'A'), item('a2', 'A'), item('a3', 'A'), item('b1', 'B'), item('b2', 'B')];
  assert.deepEqual(drain(q), ['a1', 'b1', 'a2', 'b2', 'a3']);
});

test('owners are served round-robin in both lanes', () => {
  const single: Job[] = [{ id: 'x1', owner: 'x' }, { id: 'x2', owner: 'x' }, { id: 'x3', owner: 'x' }, { id: 'y1', owner: 'y' }];
  assert.deepEqual(drain(single), ['x1', 'y1', 'x2', 'x3']);

  // Owner x has two batches, y one: y still gets every other slot.
  const batch = [item('xa1', 'XA', 'x'), item('xa2', 'XA', 'x'), item('xb1', 'XB', 'x'), item('y1', 'Y', 'y'), item('y2', 'Y', 'y')];
  assert.deepEqual(drain(batch), ['xa1', 'y1', 'xb1', 'y2', 'xa2']);
});

test('a batch never runs more than its concurrency at once', () => {
  const active = [item('a1', 'A', 'o', 2), item('a2', 'A', 'o', 2)];
  const q = [item('a3', 'A', 'o', 2), item('b1', 'B', 'o', 2)];
  assert.equal(pickNext(q, active, cfg(4))?.job.id, 'b1');
  assert.equal(pickNext([item('a3', 'A', 'o', 2)], active, cfg(4)), undefined);
  assert.equal(pickNext([item('a3', 'A', 'o', 2)], active.slice(1), cfg(4))?.job.id, 'a3');
});

// T3 in #73: 6 runs at concurrency 3 → exactly 3 at once.
test('six items at concurrency 3 on six rooms: three start, the rest wait', () => {
  const q = Array.from({ length: 6 }, (_, i) => item(`r${i}`, 'B', 'o', 3));
  const active: Job[] = [];
  let rr = emptyRoundRobin();
  for (let p = pickNext(q, active, cfg(6), rr); p; p = pickNext(q, active, cfg(6), rr)) {
    rr = p.rr;
    active.push(q.splice(p.index, 1)[0]);
  }
  assert.deepEqual(active.map(j => j.id), ['r0', 'r1', 'r2']);
});

test('serial_key: one at a time, in queue order, across lanes', () => {
  const active: Job[] = [{ id: 'r0', serial_key: 'repo-x' }];
  const q: Job[] = [{ id: 'r1', serial_key: 'repo-x' }, { id: 'r2' }];
  assert.equal(pickNext(q, active, cfg(4))?.job.id, 'r2');
  assert.equal(pickNext(q.slice(0, 1), active, cfg(4)), undefined);

  // A batch item with the key queued first blocks a later interactive run with the same key.
  const blocked: Job[] = [{ ...item('b1', 'B'), serial_key: 'k' }, { id: 'i1', serial_key: 'k' }];
  assert.equal(pickNext(blocked, [], cfg(4))?.job.id, 'b1');
});

test('serial_key order holds even when the first holder waits on batch concurrency', () => {
  const active = [item('a1', 'A', 'o', 1)];
  const q: Job[] = [{ ...item('a2', 'A', 'o', 1), serial_key: 'k' }, { id: 'i1', serial_key: 'k' }, { id: 'i2' }];
  assert.equal(pickNext(q, active, cfg(4))?.job.id, 'i2');
});

test('a blocked interactive run does not hold up the batch lane', () => {
  const active: Job[] = [{ id: 'r0', serial_key: 'k' }];
  const q: Job[] = [{ id: 'i1', serial_key: 'k' }, item('b1', 'B')];
  assert.equal(pickNext(q, active, cfg(2))?.job.id, 'b1');
});

test('pickNext does not mutate its inputs', () => {
  const q = [item('a1', 'A'), item('b1', 'B')];
  const rr = emptyRoundRobin();
  const snapshot = JSON.stringify({ q, rr });
  const p = pickNext(q, [], cfg(), rr);
  assert.equal(JSON.stringify({ q, rr }), snapshot);
  assert.deepEqual(p?.rr, { owners: { batch: 'o' }, batches: { o: 'A' } });
});

test('admit rejects with 429 once SAR_MAX_QUEUE runs are waiting; 0 = unlimited', () => {
  assert.deepEqual(admit(2, cfg(1, 3)), { ok: true });
  const full = admit(3, cfg(1, 3));
  assert.equal(full.ok, false);
  assert.equal(!full.ok && full.status, 429);
  assert.match(!full.ok ? full.error : '', /3\/3/);
  assert.deepEqual(admit(10_000, cfg(1, 0)), { ok: true });
});
