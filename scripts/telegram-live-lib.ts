// Pure part of the reference stream consumer (scripts/telegram-live.ts, G11 #97 1b):
// SSE parsing and "run events -> one live status message". No I/O here.

export interface LiveEvent { seq: number; type: string; ts: string; data: Record<string, unknown> }

export interface LiveView {
  runId: string;
  state: string;
  startedAt?: string;
  finishedAt?: string;
  category?: string;
  tool?: { name: string; input: string; output: string; running: boolean };
  toolCalls: number;
  text: string;          // assistant text so far (deltas, replaced by the final part text)
  lastSeq: number;
}

export function newView(runId: string): LiveView {
  return { runId, state: 'QUEUED', toolCalls: 0, text: '', lastSeq: 0 };
}

const inputOf = (v: unknown): string => {
  const o = (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v) as Record<string, unknown> | string;
  if (o && typeof o === 'object') return String(o.command ?? o.filePath ?? o.path ?? o.url ?? JSON.stringify(o));
  return String(o ?? '');
};

// Folds one event into the view. Idempotent per seq: replayed events (resume after a
// restart with Last-Event-ID) are ignored, so the message never shows text twice.
export function reduceView(v: LiveView, ev: LiveEvent): LiveView {
  if (ev.seq <= v.lastSeq) return v;
  const d = ev.data;
  const next: LiveView = { ...v, lastSeq: ev.seq };
  switch (ev.type) {
    case 'run.state':
      next.state = String(d.state);
      if (d.state === 'RUNNING') next.startedAt ??= ev.ts;
      break;
    case 'run.completed':
      next.state = String(d.state); next.category = String(d.category ?? ''); next.finishedAt = ev.ts;
      if (next.tool) next.tool = { ...next.tool, running: false };
      break;
    case 'agent.tool.start':
      next.tool = { name: String(d.tool), input: inputOf(d.input), output: '', running: true };
      break;
    case 'agent.tool.output':
      if (next.tool) next.tool = { ...next.tool, output: String(d.output ?? '') };
      break;
    case 'agent.tool':
      next.toolCalls++;
      next.tool = { name: String(d.tool), input: inputOf(d.input), output: String(d.output ?? ''), running: false };
      break;
    case 'agent.text.delta':
      if (d.kind !== 'reasoning') next.text += String(d.delta ?? '');
      break;
    case 'agent.text':
      next.text = String(d.text ?? '');
      break;
    case 'agent.stdout':                 // shell/custom agents: plain output lines
      next.text += String(d.line ?? '') + '\n';
      break;
  }
  return next;
}

const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const tailLines = (s: string, lines: number, chars: number) => s.split('\n').filter(Boolean).slice(-lines).join('\n').slice(-chars);

// Plain text (no parse_mode): nothing from the agent can break Telegram markup.
// Telegram's limit is 4096 chars; we stay well under.
export function renderView(v: LiveView, now = Date.now()): string {
  const icon = v.finishedAt ? (v.state === 'SUCCEEDED' ? '✅' : '❌') : v.state === 'RUNNING' ? '⏳' : '🕓';
  const end = v.finishedAt ? Date.parse(v.finishedAt) : now;
  const head = `${icon} ${v.runId} — ${v.state}${v.category && v.category !== 'OK' ? ` (${v.category})` : ''}` +
    (v.startedAt ? ` · ${clock(end - Date.parse(v.startedAt))}` : '') + (v.toolCalls ? ` · ${v.toolCalls} tools` : '');
  const out = [head];
  if (v.tool) {
    out.push('', `${v.tool.running ? '▶' : '✔'} ${v.tool.name}: ${v.tool.input.slice(0, 200)}`);
    const o = tailLines(v.tool.output, 6, 600);
    if (o) out.push(o);
  }
  if (v.text.trim()) out.push('', v.text.trim().slice(-1500));
  return out.join('\n').slice(0, 3900);
}

// Incremental SSE parser: feed chunks, get complete events (`id:` + `data:` JSON).
export function sseParser(): (chunk: string) => LiveEvent[] {
  let buf = '';
  return chunk => {
    buf += chunk.replace(/\r\n/g, '\n');
    const out: LiveEvent[] = [];
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) continue;              // heartbeat comment
      try { out.push(JSON.parse(data)); } catch { /* not an event */ }
    }
    return out;
  };
}
