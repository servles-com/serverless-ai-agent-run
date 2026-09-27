// Step 8: 5 tasks -> 5 runs -> one report, never more than `concurrency` at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/client.ts';

interface Item { id: string; run_id: string; category?: string }
interface Summary { state: string; total: number; succeeded: number; items: Item[] }

test('batch: 5 items, concurrency 2 -> 5 runs, one report, partial success is PARTIAL', { timeout: 300_000 }, async () => {
  const health = await api('GET', '/healthz');
  const concurrency = Math.min(2, health.body.max_rooms ?? 1);
  const created = await api('POST', '/batches', {
    run: { agent: 'shell', task: 'sleep 3; echo {{n}} > /artifacts/out-{{n}}.txt; echo done-{{n}}', expect: { artifacts: ['out-*.txt'] } },
    items: [1, 2, 3, 4].map(n => ({ id: `item-${n}`, vars: { n } })).concat([{ id: 'item-bad', vars: { n: 5 }, task: 'echo no artifact' } as never]),
    concurrency,
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const id = created.body.id;
  let s: Summary = { state: 'RUNNING', total: 0, succeeded: 0, items: [] };
  for (let i = 0; i < 240; i++) {
    s = (await api('GET', `/batches/${id}`)).body;
    if (!['RUNNING', 'CANCELLING'].includes(s.state)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.equal(s.state, 'PARTIAL', JSON.stringify(s));
  assert.equal(s.total, 5);
  assert.equal(s.succeeded, 4);
  assert.equal(s.items.find((it: Item) => it.id === 'item-bad')?.category, 'EXPECTATION_NOT_MET');
  assert.equal(new Set(s.items.map((it: Item) => it.run_id)).size, 5, 'one run per item');

  // Concurrency: at no point were more than `concurrency` runs of this batch running.
  const spans: [number, number][] = [];
  for (const it of s.items) {
    const r = (await api('GET', `/runs/${it.run_id}`)).body;
    spans.push([Date.parse(r.started_at), Date.parse(r.finished_at)]);
  }
  const maxOverlap = Math.max(...spans.map(([a]) => spans.filter(([b, e]) => b <= a && a < e).length));
  assert.ok(maxOverlap <= concurrency, `overlap ${maxOverlap} > ${concurrency}`);

  const report = await fetch(`${process.env.SAR_URL ?? 'http://127.0.0.1:8787'}/batches/${id}/report`,
    { headers: { authorization: `Bearer ${process.env.SAR_API_TOKEN ?? ''}` } }).then(r => r.text());
  assert.match(report, new RegExp(`# Batch ${id}: PARTIAL`));
  assert.match(report, /4\/5 succeeded/);
  assert.ok((await api('GET', '/batches')).body.some((b: { id: string }) => b.id === id));
  assert.equal((await api('POST', '/batches', { items: [] })).status, 400);
});
