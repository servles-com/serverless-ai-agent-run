// Dogfood harness: #86 (HARNESS_ERROR "fetch failed") and #7 (SILENT_FAILURE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, isTransientFetchError, withRetry, runAndWait } from '../lib/client.ts';
import { dogfoodCategory, harnessErrorRun, type RunView } from '../../scripts/dogfood-lib.ts';

const fetchFailed = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code} 127.0.0.1:8787`), { code }) });
const noSleep = async () => {};

test('describeError surfaces the undici cause', () => {
  assert.equal(describeError(fetchFailed('ECONNREFUSED')), 'fetch failed (ECONNREFUSED connect ECONNREFUSED 127.0.0.1:8787)');
  assert.equal(describeError(new Error('boom')), 'boom');
});

test('transient: GET retries any network error, POST only ECONNREFUSED', () => {
  assert.equal(isTransientFetchError(fetchFailed('ECONNRESET'), 'GET'), true);
  assert.equal(isTransientFetchError(fetchFailed('ECONNRESET'), 'POST'), false);
  assert.equal(isTransientFetchError(fetchFailed('ECONNREFUSED'), 'POST'), true);
  assert.equal(isTransientFetchError(new Error('fetch failed'), 'GET'), false);
});

test('withRetry rides out a restart, gives up after the grace period', async () => {
  let n = 0;
  assert.equal(await withRetry(async () => { if (n++ < 3) throw fetchFailed('ECONNREFUSED'); return 'ok'; }, 'GET', 60_000, noSleep), 'ok');
  await assert.rejects(withRetry(async () => { throw fetchFailed('ECONNREFUSED'); }, 'GET', 0, noSleep), /fetch failed/);
  await assert.rejects(withRetry(async () => { throw new Error('bug'); }, 'GET', 60_000, noSleep), /bug/);
});

test('runAndWait: API down mid-run -> error keeps the run id', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ id: 'run_x' }), { status: 202 });
    throw fetchFailed('ECONNREFUSED');
  }) as typeof fetch;
  const err = await runAndWait({ task: 't' }, 5, 0).catch((e: unknown) => e) as { runId?: string };
  assert.equal(err.runId, 'run_x');
  const row = harnessErrorRun(err);
  assert.equal(row.id, 'run_x');
  assert.match(row.diagnosis?.summary ?? '', /poll run_x: fetch failed \(ECONNREFUSED/);
});

test('runAndWait: brief outage while polling is tolerated', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  let polls = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    if (init.method === 'POST') return new Response(JSON.stringify({ id: 'run_y' }), { status: 202 });
    if (++polls <= 2) throw fetchFailed('ECONNREFUSED');
    return new Response(JSON.stringify({ id: 'run_y', state: 'FAILED', diagnosis: { category: 'ORPHANED_BY_RESTART' } }));
  }) as typeof fetch;
  const run: RunView = await runAndWait({ task: 't' }, 30, 60_000);
  assert.equal(dogfoodCategory(run), 'ORPHANED_BY_RESTART');
});

test('harnessErrorRun without a run id', () => assert.equal(harnessErrorRun(new Error('create failed: {}')).id, '-'));

test('SILENT_FAILURE only when SUCCEEDED delivered nothing at all (#7)', () => {
  assert.equal(dogfoodCategory({ id: 'r', state: 'SUCCEEDED', result: { text: 'answer', artifacts: [] } }), 'OK');
  assert.equal(dogfoodCategory({ id: 'r', state: 'SUCCEEDED', result: { text: '', artifacts: ['a.txt'] } }), 'OK');
  assert.equal(dogfoodCategory({ id: 'r', state: 'SUCCEEDED', result: { text: ' ', artifacts: [] } }), 'SILENT_FAILURE');
  assert.equal(dogfoodCategory({ id: 'r', state: 'FAILED', diagnosis: { category: 'EXPECTATION_NOT_MET' } }), 'EXPECTATION_NOT_MET');
});
