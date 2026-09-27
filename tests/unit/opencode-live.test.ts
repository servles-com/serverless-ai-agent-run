// The live wrapper (src/adapters/opencode-live.mjs) runs inside the room. Here it
// runs against a fake `opencode` that serves a scripted event stream, so the
// translation to run-format events and live events is pinned without docker or a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeAdapter } from '../../src/adapters/opencode.ts';
import { emptyStats } from '../../src/adapters/index.ts';

const S = 'ses_1';
const EVENTS = [
  { type: 'message.updated', properties: { info: { id: 'msg_u', role: 'user' } } },
  { type: 'message.part.updated', properties: { part: { id: 'p_prompt', messageID: 'msg_u', sessionID: S, type: 'text', text: 'the prompt', time: { start: 1, end: 1 } } } },
  { type: 'message.part.updated', properties: { part: { id: 'p_s1', messageID: 'msg_a', sessionID: S, type: 'step-start' }, time: 100 } },
  { type: 'message.part.updated', properties: { part: { id: 'p_r', messageID: 'msg_a', sessionID: S, type: 'reasoning', text: '' } } },
  { type: 'message.part.delta', properties: { messageID: 'msg_a', partID: 'p_r', field: 'text', delta: 'think' } },
  { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', callID: 'c1', messageID: 'msg_a', sessionID: S, state: { status: 'running', input: { command: 'loop' }, metadata: { output: 'tick\n' } } } } },
  { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', callID: 'c1', messageID: 'msg_a', sessionID: S, state: { status: 'running', input: { command: 'loop' }, metadata: { output: 'tick\ntick\n' } } } } },
  { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', callID: 'c1', messageID: 'msg_a', sessionID: S, state: { status: 'completed', input: { command: 'loop' }, output: 'tick\ntick\n', time: { start: 101, end: 102 } } } } },
  { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', callID: 'c1', messageID: 'msg_a', sessionID: S, state: { status: 'completed', input: { command: 'loop' }, output: 'tick\ntick\n', time: { start: 101, end: 102 } } } } },
  { type: 'message.part.updated', properties: { part: { id: 'p_t', messageID: 'msg_a', sessionID: S, type: 'text', text: '' } } },
  { type: 'message.part.delta', properties: { messageID: 'msg_a', partID: 'p_t', field: 'text', delta: 'do' } },
  { type: 'message.part.delta', properties: { messageID: 'msg_a', partID: 'p_t', field: 'text', delta: 'ne' } },
  { type: 'message.part.updated', properties: { part: { id: 'p_t', messageID: 'msg_a', sessionID: S, type: 'text', text: 'done', time: { start: 103, end: 104 } } } },
  { type: 'message.part.updated', properties: { part: { id: 'p_f', messageID: 'msg_a', sessionID: S, type: 'step-finish', reason: 'stop', tokens: { total: 7 } }, time: 105 } },
  { type: 'session.error', properties: { sessionID: S, error: { name: 'APIError', data: { statusCode: 429 } } } },
];

// Fake `opencode`: `serve --port P` streams EVENTS once a client subscribes;
// `run --attach ...` records its argv and exits after the stream had time to flow.
const FAKE = String.raw`#!/usr/bin/env node
const { createServer } = require('node:http');
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'serve') {
  const port = Number(rest[rest.indexOf('--port') + 1]);
  createServer((req, res) => {
    if (req.url !== '/event') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"server.connected","properties":{}}\n\n');
    setTimeout(() => { for (const e of JSON.parse(process.env.FAKE_EVENTS)) res.write('data: ' + JSON.stringify(e) + '\n\n'); }, 300);
  }).listen(port, '127.0.0.1');
} else if (cmd === 'run') {
  require('node:fs').writeFileSync(process.env.FAKE_ARGV, JSON.stringify(rest));
  setTimeout(() => process.exit(0), 900);
}
`;

test('live wrapper: run-format events rebuilt from the server stream, plus live events', { timeout: 20_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sar-live-')));
  writeFileSync(join(dir, 'opencode'), FAKE);
  chmodSync(join(dir, 'opencode'), 0o755);
  const wrapper = readFileSync(new URL('../../src/adapters/opencode-live.mjs', import.meta.url), 'utf8');
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper, port, '--format', 'json', '-m', 'x/y', 'TASK'], {
    cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_EVENTS: JSON.stringify(EVENTS), FAKE_ARGV: join(dir, 'argv.json') },
  });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 0);
  const lines = stdout.trim().split('\n').map(l => JSON.parse(l));
  const kinds = lines.map(l => l.type === 'sar_live' ? `live:${l.ev}` : l.type);
  assert.deepEqual(kinds.filter(k => !k.startsWith('live:text_delta')),
    ['step_start', 'live:tool_start', 'live:tool_output', 'live:tool_output', 'tool_use', 'text', 'step_finish', 'error']);
  assert.ok(!stdout.includes('the prompt'), 'the user prompt is never echoed');
  assert.equal(lines.filter(l => l.type === 'tool_use').length, 1, 'repeated completed updates print once');
  const deltas = lines.filter(l => l.ev === 'text_delta');
  assert.ok(deltas.some(d => d.kind === 'reasoning' && d.delta === 'think'), JSON.stringify(deltas));
  assert.equal(deltas.filter(d => d.part === 'p_t').map(d => d.delta).join(''), 'done', 'deltas coalesced, nothing lost');
  assert.equal(lines.find(l => l.type === 'text').part.text, 'done');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')).slice(0, 4), ['--attach', `http://127.0.0.1:${port}`, '--dir', dir]);

  // And the host adapter turns them into agent.* events and the usual stats.
  const stats = emptyStats();
  const parsed = lines.map(l => opencodeAdapter.parse(JSON.stringify(l), stats)).filter(Boolean).map(p => p!.type);
  assert.ok(parsed.includes('tool.start') && parsed.includes('tool.output') && parsed.includes('text.delta'), parsed.join());
  assert.equal(stats.steps, 1);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.finalText, 'done');
  assert.equal(stats.agentErrors.length, 1);
});

test('adapter: live mode swaps the command, default stays plain opencode run', () => {
  const plain = opencodeAdapter.command({ agent: 'opencode', task: 't' }, 'm');
  assert.deepEqual(plain.slice(0, 3), ['opencode', 'run', '--pure']);
  const live = opencodeAdapter.command({ agent: 'opencode', task: 't', live: true }, 'm');
  assert.deepEqual(live.slice(0, 3), ['node', '--input-type=module', '-e']);
  assert.ok(live.includes('--auto') && live.includes('m'));
});
