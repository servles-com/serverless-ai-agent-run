// Live run streaming, phase 1 (G11, #97). Line-level: what the adapters already
// emit as events is fanned out as it arrives; token deltas come in phase 2.
//
//   GET /runs/:id/stream       SSE; ?types=text,tool,state,…  ?format=events|transcript
//                              heartbeat, Last-Event-ID / ?after resume, ends on run.completed
//   GET /runs/:id/transcript   the whole session as markdown (?format=text for plain)
//
// Per-run stream token: POST /runs returns `stream_token`, a bearer token that can
// only GET events/stream/transcript/artifacts of that one run. Only its sha256 is
// stored (run.json), it dies with the run dir (retention). Browsers that cannot set
// headers (EventSource) may pass it as ?access_token= — the master key never can.
//
// Redaction: store.emit() scrubs every event before it is persisted or put on the
// bus, so all fan-out (SSE, webhooks) starts from redacted data. Everything that
// leaves this module is scrubbed once more, so a stale/older events.jsonl can't leak.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { scrub } from './redact.ts';
import { bus, readEvents, saveRun, TERMINAL, type RunEvent, type RunRecord } from './store.ts';

// ---------- per-run stream token

export const STREAM_TOKEN_PREFIX = 'sar_st_';
const READ_ROUTES = ['events', 'stream', 'transcript', 'artifacts'];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Call before enqueue(): the runner re-reads run.json, so the hash must be on disk first.
export function issueStreamToken(rec: RunRecord): string {
  const token = STREAM_TOKEN_PREFIX + randomBytes(24).toString('base64url');
  rec.stream_token_sha256 = sha256(token);
  saveRun(rec);
  return token;
}

export function presentedToken(req: IncomingMessage, url: URL): string {
  const header = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (header) return header;
  const q = url.searchParams.get('access_token') ?? '';
  return q.startsWith(STREAM_TOKEN_PREFIX) ? q : '';
}

export const isStreamToken = (token: string) => token.startsWith(STREAM_TOKEN_PREFIX);

// Pure: may this stream token do this request? `rec` is the run named in the path.
export function streamTokenAllows(token: string, method: string, parts: string[], rec: RunRecord | undefined, now = Date.now()): boolean {
  if (method !== 'GET' || parts[0] !== 'runs' || parts.length < 3 || !READ_ROUTES.includes(parts[2])) return false;
  if (!rec?.stream_token_sha256 || rec.id !== parts[1]) return false;
  if (now - Date.parse(rec.created_at) > config.retentionHours * 3600_000) return false;
  const got = Buffer.from(sha256(token), 'hex');
  const want = Buffer.from(rec.stream_token_sha256, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---------- event classes for ?types=

const CLASSES: Record<string, (t: string) => boolean> = {
  text: t => t === 'agent.text' || t.startsWith('agent.text.'),
  tool: t => t === 'agent.tool' || t.startsWith('agent.tool.'),
  step: t => t.startsWith('agent.step'),
  state: t => t === 'run.state' || t === 'run.completed',
  stdout: t => t === 'agent.stdout',
  stderr: t => t === 'room.stderr',
  error: t => t === 'agent.error',
  log: t => t === 'run.log' || t === 'run.pull_request' || (t.startsWith('room.') && t !== 'room.stderr'),
  webhook: t => t.startsWith('webhook.'),
};

export function parseTypes(param: string | null): { match: (t: string) => boolean } | { error: string } {
  if (!param) return { match: () => true };
  const wanted = param.split(',').map(s => s.trim()).filter(Boolean);
  const unknown = wanted.filter(w => !CLASSES[w] && !w.includes('.'));
  if (unknown.length) return { error: `unknown types: ${unknown.join(', ')} (known: ${Object.keys(CLASSES).join(', ')} or an exact event type)` };
  // run.completed always passes: it is what tells the client the stream is over.
  return { match: t => t === 'run.completed' || wanted.some(w => (CLASSES[w] ? CLASSES[w](t) : w === t)) };
}

// ---------- transcript

const clock = (ts: string) => ts.slice(11, 19);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const fence = (s: string) => '```\n' + s.replace(/```/g, "'''") + '\n```';

// One event → markdown lines (empty = not part of the transcript).
export function renderEvent(ev: RunEvent): string {
  const d = ev.data as Record<string, unknown>;
  const at = `\`${clock(ev.ts)}\``;
  const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
  switch (ev.type) {
    case 'run.state': return `${at} **${str(d.state)}**`;
    case 'run.completed': return `${at} **completed: ${str(d.state)}** (${str(d.category)})`;
    case 'run.log': return `${at} · ${str(d.msg)}`;
    case 'run.pull_request': return `${at} pull request: ${str(d.url)}`;
    case 'agent.text': return `${at} 💬\n\n${str(d.text)}`;
    case 'agent.tool': {
      const out = str(d.output);
      return `${at} 🔧 **${str(d.tool)}** ${str(d.status)} \`${cut(str(d.input), 300)}\`` + (out ? '\n' + fence(cut(out, 1500)) : '');
    }
    case 'agent.step_start': return `${at} — step ${str(d.step)}`;
    case 'agent.stdout': return `${at} > ${str(d.line)}`;
    case 'agent.error': return `${at} ✖ ${cut(str(d.error), 1000)}`;
    default: return '';
  }
}

export function renderTranscript(rec: RunRecord, events: RunEvent[], format: 'markdown' | 'text' = 'markdown'): string {
  const head = [`# Run ${rec.id}`, '', `agent: ${rec.request.agent} · state: ${rec.state}` +
    (rec.diagnosis ? ` · ${rec.diagnosis.category}: ${rec.diagnosis.summary}` : ''), '', `task: ${cut(rec.request.task, 2000)}`, ''];
  const body = events.map(renderEvent).filter(Boolean);
  const md = scrub([...head, ...body].join('\n')) + '\n';
  return format === 'text' ? md.replace(/\*\*|`{1,3}/g, '') : md;
}

// ---------- SSE

export function streamRun(req: IncomingMessage, res: ServerResponse, rec: RunRecord, url: URL): void {
  const types = parseTypes(url.searchParams.get('types'));
  if ('error' in types) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ error: types.error }));
  }
  const transcript = url.searchParams.get('format') === 'transcript';
  const id = rec.id;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  let last = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0) || 0;
  let closed = false;
  const end = () => { if (!closed) { closed = true; bus.off(id, onEv); clearInterval(ping); res.end(); } };
  const onEv = (raw: RunEvent) => {
    if (closed || raw.seq <= last) return;
    last = raw.seq;
    const ev = scrub(raw);
    if (types.match(ev.type)) {
      const payload = transcript ? JSON.stringify({ seq: ev.seq, type: ev.type, line: renderEvent(ev) }) : JSON.stringify(ev);
      res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${payload}\n\n`);
    }
    if (ev.type === 'run.completed') setTimeout(end, 50);
  };
  bus.on(id, onEv);
  const ping = setInterval(() => res.write(`: ping ${new Date().toISOString()}\n\n`), config.streamHeartbeatS * 1000);
  req.on('close', end);
  res.write('retry: 3000\n\n');
  for (const ev of readEvents(id, last)) onEv(ev);
  if (TERMINAL.includes(rec.state) && !closed && readEvents(id).some(e => e.type === 'run.completed')) end();
}

// ---------- coalesced agent events for webhooks (≤ 1 delivery / intervalMs)

export interface CoalescedBatch {
  from_seq: number; to_seq: number; count: number;
  counts: Record<string, number>;
  last_text?: string;
  last_tool?: { tool: unknown; status: unknown };
  events: RunEvent[];          // newest `maxEvents` of the window
  dropped: number;             // older events of the window not included
}

export function summarize(events: RunEvent[], maxEvents = 50): CoalescedBatch {
  const counts: Record<string, number> = {};
  let lastText: string | undefined;
  let lastTool: CoalescedBatch['last_tool'];
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'agent.text') lastText = String(e.data.text ?? '');
    if (e.type === 'agent.stdout') lastText = String(e.data.line ?? '');
    if (e.type === 'agent.tool') lastTool = { tool: e.data.tool, status: e.data.status };
  }
  const kept = events.slice(-maxEvents);
  return scrub({ from_seq: events[0].seq, to_seq: events[events.length - 1].seq, count: events.length, counts,
    last_text: lastText, last_tool: lastTool, events: kept, dropped: events.length - kept.length });
}

export interface CoalescerOptions {
  intervalMs?: number;
  now?: () => number;
  send: (ev: RunEvent) => void;   // receives a synthetic `agent.coalesced` event
}

// Throttle with trailing flush: the first agent event after a quiet period goes out
// at once, later ones are batched until intervalMs has passed since the last send.
// flush() is called before every lifecycle event so the receiver keeps seq order.
export class Coalescer {
  private buf: RunEvent[] = [];
  private lastSent = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly send: (ev: RunEvent) => void;

  constructor(opts: CoalescerOptions) {
    this.intervalMs = opts.intervalMs ?? 2000;
    this.now = opts.now ?? Date.now;
    this.send = opts.send;
  }

  push(ev: RunEvent): void {
    this.buf.push(ev);
    if (this.timer) return;
    const wait = this.lastSent + this.intervalMs - this.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.buf.length) return;
    const batch = summarize(this.buf);
    const lastEv = this.buf[this.buf.length - 1];
    this.buf = [];
    this.lastSent = this.now();
    this.send({ seq: lastEv.seq, ts: lastEv.ts, run_id: lastEv.run_id, type: 'agent.coalesced',
      data: { ...batch, flushed_at: new Date(this.lastSent).toISOString() } });
  }
}
