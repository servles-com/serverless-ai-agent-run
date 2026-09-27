// Step 1b "done when", SAR side: a live Telegram message that keeps updating the same
// message across a restart of the consumer. Real service + stream token; fake Telegram API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, BASE } from '../lib/client.ts';

test('telegram-live: one message, edited live, same message after the consumer restarts', { timeout: 240_000 }, async () => {
  const calls: { method: string; at: number; body: { message_id?: number; text: string } }[] = [];
  const tg = createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      const method = String(req.url).split('/').pop()!;
      calls.push({ method, at: Date.now(), body: JSON.parse(b) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { message_id: 777 } }));
    });
  });
  await new Promise<void>(r => tg.listen(0, '127.0.0.1', r));
  const tgUrl = `http://127.0.0.1:${(tg.address() as { port: number }).port}`;
  try {
    const created = await api('POST', '/runs', { agent: 'shell', task: 'for i in 1 2 3 4 5 6 7 8; do echo "step $i"; sleep 1; done' });
    assert.equal(created.status, 202);
    const { id, stream_token } = created.body;
    const env = { ...process.env, SAR_URL: BASE, SAR_STREAM_TOKEN: stream_token, SAR_TOKEN: '', TELEGRAM_API: tgUrl, TELEGRAM_BOT_TOKEN: 'x',
      TELEGRAM_CHAT_ID: '42', EDIT_EVERY_MS: '400', STATE_FILE: join(mkdtempSync(join(tmpdir(), 'tg-live-')), 'state.json') };
    const start = () => spawn(process.execPath, ['scripts/telegram-live.ts', id], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    // First consumer: wait until the run is visibly in progress, then kill it hard.
    const first = start();
    for (let i = 0; i < 120 && !calls.some(c => /step 2/.test(c.body.text)); i++) await new Promise(r => setTimeout(r, 250));
    first.kill('SIGKILL');
    const killedAt = Date.now();
    await new Promise(r => setTimeout(r, 1500));

    const second = start();
    const code = await new Promise(r => second.on('close', r));
    assert.equal(code, 0);
    const run = (await api('GET', `/runs/${id}`)).body;
    assert.equal(run.state, 'SUCCEEDED');

    assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1, 'exactly one message, never re-sent after the restart');
    const edits = calls.filter(c => c.method === 'editMessageText');
    assert.ok(edits.every(e => e.body.message_id === 777));
    assert.ok(edits.some(e => e.at < killedAt), 'edited live before the restart');
    assert.ok(edits.some(e => e.at > killedAt), 'kept editing the same message after the restart');
    const last = calls.at(-1)!.body.text;
    assert.match(last, /✅ .* — SUCCEEDED/);
    assert.match(last, /step 8/);
    assert.equal(last.match(/step 1\n/g)?.length, 1, `no replayed duplicates:\n${last}`);
  } finally { tg.close(); }
});
