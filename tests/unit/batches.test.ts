import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandBatch, summarize, reportMarkdown, itemView, type ItemView } from '../../src/batches.ts';
import type { RunRecord } from '../../src/store.ts';

test('expandBatch: template + items + vars -> validated run requests', () => {
  const x = expandBatch({ run: { agent: 'opencode', task: 'echo {{name}} > /artifacts/{{name}}.txt', expect: { text: 'alpha|beta' } },
    items: [{ id: 'a', vars: { name: 'alpha' } }, { vars: { name: 'beta' }, files: { 'in.txt': 'x' } }, { task: 'echo custom' }], concurrency: 2 }, 3);
  assert.ok(!('error' in x), JSON.stringify(x));
  if ('error' in x) return;
  assert.equal(x.concurrency, 2);
  assert.deepEqual(x.items.map(i => i.id), ['a', '2', '3']);
  assert.equal(x.items[0].request.task, 'echo alpha > /artifacts/alpha.txt');
  assert.deepEqual(x.items[1].request.files, { 'in.txt': 'x' });
  assert.equal(x.items[2].request.task, 'echo custom');
  assert.deepEqual(x.items[0].request.expect, { text: 'alpha|beta' }, 'expect from the template');
  assert.equal(x.items[0].request.metadata?.batch_item, 'a');
});

test('expandBatch: everything is validated before a batch exists', () => {
  const err = (b: unknown, max = 3) => { const x = expandBatch(b, max); return 'error' in x ? x.error : ''; };
  assert.match(err(null), /object/);
  assert.match(err({ items: [] }), /non-empty/);
  assert.match(err({ items: Array(201).fill({ task: 'x' }) }), /at most 200/);
  assert.match(err({ items: [{ task: 'x' }], concurrency: 4 }), /1\.\.3/);
  assert.match(err({ items: [{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }] }), /unique/);
  assert.match(err({ run: { agent: 'opencode' }, items: [{ id: 'k' }] }), /items\[0\] \(k\): task/);
  assert.match(err({ run: { agent: 'opencode' }, items: [{ task: 'x', files: { '../x': 'y' } }] }), /unsafe file path/);
  assert.match(err({ run: { agent: 'nope' }, items: [{ task: 'x' }] }), /unknown agent/);
  const d = expandBatch({ run: { agent: 'opencode' }, items: [{ task: 'x' }] }, 1);
  assert.ok(!('error' in d) && d.concurrency === 1, 'default concurrency is capped by SAR_MAX_ROOMS');
});

test('summarize: SUCCEEDED only if all succeed; partial is PARTIAL, not success', () => {
  const v = (state: string, category?: string): ItemView => ({ id: state + (category ?? ''), run_id: 'r', state, category });
  assert.equal(summarize({ id: 'b' }, [v('SUCCEEDED'), v('RUNNING'), { id: 'p', state: 'PENDING' }]).state, 'RUNNING');
  assert.equal(summarize({ id: 'b' }, [v('SUCCEEDED'), v('SUCCEEDED')]).state, 'SUCCEEDED');
  const p = summarize({ id: 'b' }, [v('SUCCEEDED'), v('FAILED', 'EXPECTATION_NOT_MET')]);
  assert.equal(p.state, 'PARTIAL');
  assert.deepEqual(p.counts, { SUCCEEDED: 1, EXPECTATION_NOT_MET: 1 });
  assert.equal(summarize({ id: 'b' }, [v('FAILED', 'X'), v('TIMED_OUT', 'TIMEOUT')]).state, 'FAILED');
  assert.equal(summarize({ id: 'b', cancelled: true }, [v('CANCELLED', 'CANCELLED'), { id: 'p', state: 'PENDING' }]).state, 'CANCELLED');
  assert.equal(summarize({ id: 'b', cancelled: true }, [v('RUNNING')]).state, 'CANCELLING');
  assert.match(reportMarkdown(p), /# Batch b: PARTIAL[\s\S]*1\/2 succeeded[\s\S]*\| item \| state/);
});

test('itemView: pending, unknown run, finished run', () => {
  const req = { agent: 'opencode' as const, task: 't' };
  assert.equal(itemView({ id: 'a', request: req }, undefined).state, 'PENDING');
  assert.equal(itemView({ id: 'a', request: req, run_id: 'run_x' }, undefined).state, 'UNKNOWN');
  const rec = { id: 'run_x', state: 'SUCCEEDED', request: req, created_at: '', updated_at: '',
    result: { artifacts: ['a.txt'], steps: 0, tool_calls: 0, tool_errors: 0 } } as RunRecord;
  assert.deepEqual(itemView({ id: 'a', request: req, run_id: 'run_x' }, rec).artifacts, ['a.txt']);
});
