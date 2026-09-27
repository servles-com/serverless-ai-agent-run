#!/usr/bin/env node
// `sar` — command-line client for the execution API. Zero dependencies; talks
// only to the public HTTP API (never imports src/).
//
//   SAR_URL    API base (default http://127.0.0.1:8787)
//   SAR_TOKEN  bearer token (SAR_API_TOKEN is accepted as a fallback)
//
//   sar run --task TEXT [--agent A] [--model M] [--file PATH[=NAME]]... [--repo URL[@REF]]
//           [--expect-artifact GLOB]... [--timeout S] [--follow]
//   sar status <id> [--json]
//   sar logs <id> [--follow]
//   sar artifacts <id> [--get PATH [--out FILE|-]]
//   sar cred put|request ...   not implemented yet (#92, Zerocreds-com/zerocreds-server#63)
//
// Exit codes: 0 ok / run SUCCEEDED, 1 error / run did not succeed, 2 usage.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE = `usage:
  sar run --task TEXT [--agent A] [--model M] [--file PATH[=NAME]]... [--repo URL[@REF]]
          [--expect-artifact GLOB]... [--timeout S] [--follow]
  sar status <id> [--json]
  sar logs <id> [--follow]
  sar artifacts <id> [--get PATH [--out FILE|-]]
  sar cred put|request ...   (not implemented yet)

env: SAR_URL (default http://127.0.0.1:8787), SAR_TOKEN`;

export const CRED_NOT_IMPLEMENTED =
  'sar cred: not implemented yet — waits for servles-com/serverless-ai-agent-run#92 (credential handles) ' +
  'and Zerocreds-com/zerocreds-server#63 (ZeroCreds API forms)';

export type Command =
  | { cmd: 'help' }
  | { cmd: 'run'; task: string; agent?: string; model?: string; files: { path: string; name: string }[];
      repo?: { url: string; ref?: string }; expectArtifacts: string[]; timeoutS?: number; follow: boolean }
  | { cmd: 'status'; id: string; json: boolean }
  | { cmd: 'logs'; id: string; follow: boolean }
  | { cmd: 'artifacts'; id: string; get?: string; out?: string }
  | { cmd: 'cred'; sub: string };

export type Parsed = Command | { error: string };

const VALUE_FLAGS: Record<string, string[]> = {
  run: ['--task', '--agent', '--model', '--file', '--repo', '--expect-artifact', '--timeout'],
  status: [], logs: [], artifacts: ['--get', '--out'],
};
const BOOL_FLAGS: Record<string, string[]> = {
  run: ['--follow'], status: ['--json'], logs: ['--follow'], artifacts: [],
};

// Splits argv into flags (repeatable, `--x v` or `--x=v`) and positionals.
function split(cmd: string, argv: string[]): { flags: Map<string, string[]>; bools: Set<string>; pos: string[] } | { error: string } {
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (BOOL_FLAGS[cmd].includes(name)) {
      if (eq > 0) return { error: `${name} takes no value` };
      bools.add(name);
    } else if (VALUE_FLAGS[cmd].includes(name)) {
      let v: string | undefined;
      if (eq > 0) v = a.slice(eq + 1);
      else { v = argv[i + 1]; i++; }
      if (v === undefined) return { error: `${name} needs a value` };
      flags.set(name, [...(flags.get(name) ?? []), v]);
    } else {
      return { error: `unknown option for 'sar ${cmd}': ${name}` };
    }
  }
  return { flags, bools, pos };
}

const one = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.at(-1);

export function parseArgs(argv: string[]): Parsed {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return { cmd: 'help' };
  if (cmd === 'cred') return { cmd: 'cred', sub: rest[0] ?? '' };
  if (!(cmd in VALUE_FLAGS)) return { error: `unknown command: ${cmd}` };
  if (rest.includes('--help') || rest.includes('-h')) return { cmd: 'help' };

  const s = split(cmd, rest);
  if ('error' in s) return s;
  const { flags, bools, pos } = s;

  if (cmd === 'run') {
    if (pos.length) return { error: `unexpected argument: ${pos[0]} (use --task)` };
    const task = one(flags, '--task');
    if (!task?.trim()) return { error: '--task is required' };
    const files = (flags.get('--file') ?? []).map(f => {
      const eq = f.indexOf('=');
      return eq > 0 ? { path: f.slice(0, eq), name: f.slice(eq + 1) } : { path: f, name: basename(f) };
    });
    if (files.some(f => !f.name)) return { error: '--file needs PATH or PATH=NAME' };
    let repo: { url: string; ref?: string } | undefined;
    const r = one(flags, '--repo');
    if (r !== undefined) {
      // A trailing @ref after the last path segment; `git@host:...` URLs keep their '@'.
      const m = r.match(/^(.*[^/@])@([^/@:]+)$/);
      repo = m && !/^[^/]*$/.test(m[1]) ? { url: m[1], ref: m[2] } : { url: r };
    }
    let timeoutS: number | undefined;
    const t = one(flags, '--timeout');
    if (t !== undefined) {
      timeoutS = Number(t);
      if (!Number.isInteger(timeoutS) || timeoutS <= 0) return { error: '--timeout must be a positive integer (seconds)' };
    }
    return { cmd: 'run', task, agent: one(flags, '--agent'), model: one(flags, '--model'), files, repo,
      expectArtifacts: flags.get('--expect-artifact') ?? [], timeoutS, follow: bools.has('--follow') };
  }

  if (pos.length !== 1) return { error: `sar ${cmd} needs exactly one run id` };
  const id = pos[0];
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return { error: `bad run id: ${id}` };
  if (cmd === 'status') return { cmd, id, json: bools.has('--json') };
  if (cmd === 'logs') return { cmd, id, follow: bools.has('--follow') };
  const get = one(flags, '--get');
  const out = one(flags, '--out');
  if (out !== undefined && get === undefined) return { error: '--out needs --get' };
  return { cmd: 'artifacts', id, get, out };
}

// Request body for POST /runs. File contents are read by the caller.
export function buildRunRequest(c: Extract<Command, { cmd: 'run' }>, read: (p: string) => string): Record<string, unknown> {
  const body: Record<string, unknown> = { task: c.task };
  if (c.agent) body.agent = c.agent;
  if (c.model) body.model = c.model;
  if (c.files.length) body.files = Object.fromEntries(c.files.map(f => [f.name, read(f.path)]));
  if (c.repo) body.repo = c.repo;
  if (c.expectArtifacts.length) body.expect = { artifacts: c.expectArtifacts };
  if (c.timeoutS) body.limits = { timeout_s: c.timeoutS };
  return body;
}

export interface Event { seq: number; ts: string; type: string; data: Record<string, unknown> }

export function formatEvent(ev: Event): string {
  const d = ev.data ?? {};
  const pick = d.state ?? d.msg ?? d.line ?? d.text ?? d.tool ?? d.url;
  const extra = ev.type === 'run.completed' ? ` ${String(d.category ?? '')}` : '';
  const summary = pick !== undefined ? String(pick) + extra : JSON.stringify(d);
  const time = typeof ev.ts === 'string' ? ev.ts.slice(11, 19) : '';
  return `${String(ev.seq).padStart(4)} ${time} ${ev.type.padEnd(16)} ${summary.replace(/\s+/g, ' ').slice(0, 300)}`;
}

// Incremental SSE parser: feed chunks, get complete `data:` payloads.
export function sseParser(onData: (data: string) => void): (chunk: string) => void {
  let buf = '';
  return chunk => {
    buf += chunk.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) onData(data);
    }
  };
}

interface RunRecord {
  id: string; state: string; created_at?: string;
  result?: { text?: string; artifacts?: string[]; pull_request?: { url?: string } };
  diagnosis?: { category?: string; summary?: string; hints?: string[] };
}

export function formatStatus(r: RunRecord): string {
  const lines = [`${r.id}  ${r.state}${r.diagnosis?.category ? `  ${r.diagnosis.category}` : ''}`];
  if (r.diagnosis?.summary) lines.push(`  why: ${r.diagnosis.summary}`);
  for (const h of r.diagnosis?.hints ?? []) lines.push(`  hint: ${h}`);
  if (r.result?.text) lines.push(`  result: ${r.result.text.replace(/\s+/g, ' ').slice(0, 500)}`);
  if (r.result?.artifacts?.length) lines.push(`  artifacts: ${r.result.artifacts.join(', ')}`);
  if (r.result?.pull_request?.url) lines.push(`  pull request: ${r.result.pull_request.url}`);
  return lines.join('\n');
}

// ---- I/O ------------------------------------------------------------------

class ApiError extends Error {}

function client(env: NodeJS.ProcessEnv) {
  const base = (env.SAR_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const token = env.SAR_TOKEN ?? env.SAR_API_TOKEN ?? '';
  const headers = (extra: Record<string, string> = {}) =>
    ({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
  async function req(method: string, path: string, body?: unknown, accept?: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: headers({ ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(accept ? { accept } : {}) }) });
    } catch (e) {
      throw new ApiError(`cannot reach ${base}: ${(e as Error).cause ?? (e as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).error ?? text; } catch { /* plain text */ }
      throw new ApiError(`${method} ${path} -> ${res.status}: ${msg}${res.status === 401 ? ' (set SAR_TOKEN)' : ''}`);
    }
    return res;
  }
  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => (await req(method, path, body)).json() as Promise<T>;
  return { req, json };
}

type Client = ReturnType<typeof client>;

// Streams events until run.completed (or the server closes the stream).
async function follow(api: Client, id: string, print: (s: string) => void): Promise<void> {
  const res = await api.req('GET', `/runs/${id}/events?follow=1`, undefined, 'text/event-stream');
  if (!res.body) return;
  const decoder = new TextDecoder();
  let done = false;
  const feed = sseParser(data => {
    const ev = JSON.parse(data) as Event;
    print(formatEvent(ev));
    if (ev.type === 'run.completed') done = true;
  });
  const reader = res.body.getReader();
  while (!done) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    feed(decoder.decode(value, { stream: true }));
  }
  await reader.cancel().catch(() => {});
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const out = (s: string) => process.stdout.write(s + '\n');
  const err = (s: string) => process.stderr.write(s + '\n');
  const p = parseArgs(argv);
  if ('error' in p) { err(`sar: ${p.error}\n\n${USAGE}`); return 2; }
  if (p.cmd === 'help') { out(USAGE); return 0; }
  if (p.cmd === 'cred') { err(CRED_NOT_IMPLEMENTED); return 1; }

  const api = client(env);
  try {
    if (p.cmd === 'run') {
      const body = buildRunRequest(p, path => readFileSync(path, 'utf8'));
      const created = await api.json<{ id: string; state: string }>('POST', '/runs', body);
      if (!p.follow) { out(created.id); return 0; }
      err(`run ${created.id} ${created.state}`);
      await follow(api, created.id, err);
      const rec = await api.json<RunRecord>('GET', `/runs/${created.id}`);
      out(formatStatus(rec));
      return rec.state === 'SUCCEEDED' ? 0 : 1;
    }
    if (p.cmd === 'status') {
      const rec = await api.json<RunRecord>('GET', `/runs/${p.id}`);
      out(p.json ? JSON.stringify(rec, null, 2) : formatStatus(rec));
      return 0;
    }
    if (p.cmd === 'logs') {
      if (p.follow) { await follow(api, p.id, out); return 0; }
      for (const ev of await api.json<Event[]>('GET', `/runs/${p.id}/events`)) out(formatEvent(ev));
      return 0;
    }
    if (!p.get) {
      for (const f of await api.json<string[]>('GET', `/runs/${p.id}/artifacts`)) out(f);
      return 0;
    }
    const path = p.get.split('/').map(encodeURIComponent).join('/');
    const data = Buffer.from(await (await api.req('GET', `/runs/${p.id}/artifacts/${path}`)).arrayBuffer());
    if (p.out === '-') { process.stdout.write(data); return 0; }
    const dest = p.out ?? basename(p.get);
    writeFileSync(dest, data);
    err(`saved ${p.get} -> ${dest} (${data.length} bytes)`);
    return 0;
  } catch (e) {
    err(`sar: ${e instanceof ApiError ? e.message : (e as Error).stack ?? e}`);
    return 1;
  }
}

const invokedPath = (): string => { try { return realpathSync(process.argv[1] ?? ''); } catch { return ''; } };
if (fileURLToPath(import.meta.url) === invokedPath()) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
