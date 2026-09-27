// Reference consumer of the run stream (G11 #97, step 1b): one Telegram message that
// updates live while a run works, and keeps updating the SAME message after this
// process restarts. What a bot (trained-assist T2) needs, in ~100 lines, no deps.
//
//   SAR_URL=http://127.0.0.1:8787 SAR_STREAM_TOKEN=<stream_token from POST /runs> \
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/telegram-live.ts <run_id>
//
// State file (default ./telegram-live-<run_id>.json): message id + last seq + view.
// On restart the stream resumes from Last-Event-ID, replayed events are ignored and
// the existing message is edited, never re-sent. Edits: at most one per EDIT_EVERY_MS
// (Telegram rate limits), always one right after run.completed. Plain text only.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { newView, reduceView, renderView, sseParser, type LiveView } from './telegram-live-lib.ts';

const runId = process.argv[2];
if (!runId) { console.error('usage: telegram-live.ts <run_id>'); process.exit(2); }
const SAR = process.env.SAR_URL ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.SAR_STREAM_TOKEN ?? process.env.SAR_TOKEN ?? '';
const TG = `${process.env.TELEGRAM_API ?? 'https://api.telegram.org'}/bot${process.env.TELEGRAM_BOT_TOKEN ?? ''}`;
const CHAT = process.env.TELEGRAM_CHAT_ID ?? '';
const STATE = process.env.STATE_FILE ?? `telegram-live-${runId}.json`;
const EDIT_EVERY_MS = Number(process.env.EDIT_EVERY_MS ?? 2000);

interface State { messageId?: number; view: LiveView; shown: string }
const st: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { view: newView(runId), shown: '' };
const save = () => { writeFileSync(STATE + '.tmp', JSON.stringify(st)); renameSync(STATE + '.tmp', STATE); };

async function tg(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${TG}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json() as { ok: boolean; result?: Record<string, unknown>; description?: string; parameters?: { retry_after?: number } };
  if (j.ok) return j.result ?? {};
  if (j.parameters?.retry_after) { await new Promise(res => setTimeout(res, j.parameters!.retry_after! * 1000)); return tg(method, body); }
  if (/message is not modified/.test(j.description ?? '')) return {};
  throw new Error(`telegram ${method}: ${j.description}`);
}

let lastEdit = 0;
async function show(force = false): Promise<void> {
  const text = renderView(st.view);
  if (text === st.shown || (!force && Date.now() - lastEdit < EDIT_EVERY_MS)) return;
  if (st.messageId === undefined) st.messageId = Number((await tg('sendMessage', { chat_id: CHAT, text, disable_web_page_preview: true })).message_id);
  else await tg('editMessageText', { chat_id: CHAT, message_id: st.messageId, text, disable_web_page_preview: true });
  lastEdit = Date.now();
  st.shown = text;
  save();
}

async function follow(): Promise<void> {
  for (let backoff = 1000; ; backoff = Math.min(backoff * 2, 30_000)) {
    try {
      const res = await fetch(`${SAR}/runs/${runId}/stream?types=text,tool,state,stdout`, {
        headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': String(st.view.lastSeq), accept: 'text/event-stream' } });
      if (res.status === 401 || res.status === 403 || res.status === 404) throw Object.assign(new Error(`stream: HTTP ${res.status}`), { fatal: true });
      if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);
      backoff = 1000;
      const parse = sseParser();
      const tick = setInterval(() => { void show().catch(e => console.error(String(e))); }, EDIT_EVERY_MS);
      try {
        for await (const chunk of res.body) {
          for (const ev of parse(Buffer.from(chunk).toString('utf8'))) {
            st.view = reduceView(st.view, ev);
            if (ev.type === 'run.completed') { await show(true); return; }
          }
          save();
        }
      } finally { clearInterval(tick); }
      if (st.view.finishedAt) { await show(true); return; }
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) throw e;
      console.error(`${String((e as Error).message ?? e)}; reconnecting in ${backoff} ms`);
    }
    await new Promise(r => setTimeout(r, backoff));
  }
}

await show(true);
await follow();
console.log(`run ${runId} ${st.view.state}; message ${st.messageId}`);
