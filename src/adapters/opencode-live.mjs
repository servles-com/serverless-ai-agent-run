// Runs INSIDE the room (passed via `node -e`, so the room image needs no change).
// Starts `opencode serve` on a room-local port, subscribes to its event stream and
// submits the task with `opencode run --attach`. Prints, one JSON object per line:
//   - the same events `opencode run --format json` prints (step_start, text, tool_use,
//     step_finish, error), rebuilt from the server stream: in opencode 1.18.32
//     `run --attach --format json` drops the last step's events, so its stdout is ignored;
//   - live events `{"type":"sar_live", ev, ...}`:
//       text_delta {part, kind: text|reasoning, delta}   coalesced, <= 5 per second per part
//       tool_start {call, tool, input}                   a tool began running
//       tool_output {call, output}                       output so far of a running tool (tail)
import { spawn } from 'node:child_process';

const [port, ...runArgs] = process.argv.slice(1);
const base = `http://127.0.0.1:${port}`;
const print = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const live = obj => print({ type: 'sar_live', ...obj });

const serve = spawn('opencode', ['serve', '--pure', '--port', port, '--print-logs', '--log-level', 'WARN'],
  { stdio: ['ignore', 'ignore', 'inherit'] });

const pending = new Map();                     // part id -> { kind, text } not yet flushed
const flush = () => {
  for (const [part, p] of pending) if (p.text) live({ ev: 'text_delta', part, kind: p.kind, delta: p.text });
  pending.clear();
};
const timer = setInterval(flush, 200);
const kinds = new Map();                       // part id -> text|reasoning
const userMessages = new Set();                // the prompt is a text part too; never echo it
const done = new Set();                        // parts already printed as final events
const running = new Map();                     // tool call id -> output length already sent

function onEvent(ev) {
  const p = ev.properties ?? {};
  const timestamp = p.time ?? Date.now();
  if (ev.type === 'message.updated' && p.info?.role === 'user') userMessages.add(p.info.id);
  if (ev.type === 'session.error') { flush(); print({ type: 'error', timestamp, sessionID: p.sessionID, error: p.error }); }
  if (ev.type === 'message.part.delta' && p.field === 'text' && p.delta && !userMessages.has(p.messageID)) {
    const cur = pending.get(p.partID) ?? { kind: kinds.get(p.partID) ?? 'text', text: '' };
    cur.text += p.delta;
    pending.set(p.partID, cur);
  }
  if (ev.type !== 'message.part.updated' || !p.part || userMessages.has(p.part.messageID)) return;
  const part = p.part;
  const once = (key, obj) => { if (!done.has(key)) { done.add(key); flush(); print({ ...obj, timestamp, sessionID: part.sessionID, part }); } };
  if (part.type === 'text' || part.type === 'reasoning') kinds.set(part.id, part.type);
  if (part.type === 'step-start') once(part.id, { type: 'step_start' });
  else if (part.type === 'step-finish') once(part.id, { type: 'step_finish' });
  else if (part.type === 'text' && part.time?.end) once(part.id, { type: 'text' });
  else if (part.type === 'tool') {
    const st = part.state ?? {};
    if (st.status === 'running') {
      if (!running.has(part.callID)) { running.set(part.callID, 0); live({ ev: 'tool_start', call: part.callID, tool: part.tool, input: st.input }); }
      const o = String(st.metadata?.output ?? '');
      if (o.length > running.get(part.callID)) { running.set(part.callID, o.length); live({ ev: 'tool_output', call: part.callID, output: o.slice(-4000) }); }
    } else if (st.status === 'completed' || st.status === 'error') once(part.callID, { type: 'tool_use' });
  }
}

let connected;
const isConnected = new Promise(r => { connected = r; });
async function subscribe() {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      // A request to a server that is still booting can hang: time out the connect only.
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2000);
      const res = await fetch(`${base}/event`, { signal: ac.signal });
      clearTimeout(t);
      if (!res.ok || !res.body) throw new Error(String(res.status));
      connected();
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.startsWith('data:')) { try { onEvent(JSON.parse(line.slice(5))); } catch { /* not JSON */ } }
        }
      }
      return;
    } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  console.error('sar-live: could not subscribe to the opencode event stream');
  serve.kill();
  process.exit(1);
}

void subscribe();
await isConnected;
const run = spawn('opencode', ['run', '--attach', base, '--dir', process.cwd(), ...runArgs], { stdio: ['ignore', 'ignore', 'inherit'] });
run.on('close', code => {
  // Give the last server events a moment to arrive before closing.
  setTimeout(() => { flush(); clearInterval(timer); serve.kill(); process.exit(code ?? 1); }, 1000);
});
