// Run registry on the local filesystem. One directory per run:
//
//   runs/<run_id>/run.json          current record (state, request, diagnosis)
//   runs/<run_id>/events.jsonl      every lifecycle + agent event, append-only
//   runs/<run_id>/workspace/        mounted at /workspace in the room
//   runs/<run_id>/artifacts/        mounted at /artifacts in the room
//   runs/<run_id>/room/             stdout.log, stderr.log, inspect.json
//
// Plain files on purpose: the whole point of V0 is that a broken run can be
// debugged with `ls`, `cat` and `jq` — or by another agent.
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.ts';

export type RunState =
  | 'QUEUED' | 'PREPARING' | 'RUNNING' | 'EXPORTING'
  | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

export const TERMINAL: RunState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

export interface RunRequest {
  agent: 'opencode' | 'shell';
  task: string;
  model?: string;
  files?: Record<string, string>;
  repo?: { url: string; ref?: string };
  secrets?: string[];
  webhook?: { url: string; secret?: string; agent_events?: boolean };
  limits?: { timeout_s?: number; idle_timeout_s?: number; memory_mb?: number; cpus?: number; pids?: number };
  metadata?: Record<string, unknown>;
}

export interface Diagnosis {
  category: string;      // machine-readable failure class, see failures.ts
  summary: string;       // one line for humans
  evidence: string[];    // log lines / facts that led to the classification
  retryable: boolean;
  hints: string[];
}

export interface RunRecord {
  id: string;
  state: RunState;
  request: RunRequest;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  room?: { container: string; runtime: string; exit_code?: number | null; oom_killed?: boolean };
  result?: {
    text?: string; artifacts: string[]; steps: number; tool_calls: number; tool_errors: number; tokens?: number;
    model_ms?: number; tool_ms?: number;
    step_timings?: { step: number; model_ms: number; tool_ms: number; total_ms: number }[];
  };
  diagnosis?: Diagnosis;
  warnings?: string[];
}

export interface RunEvent {
  seq: number;
  ts: string;
  run_id: string;
  type: string;                 // run.state, run.log, agent.<type>, webhook.*, room.*
  data: Record<string, unknown>;
}

export const bus = new EventEmitter();
bus.setMaxListeners(1000);

const seqs = new Map<string, number>();

export const runsDir = () => join(config.dataDir, 'runs');
export const runDir = (id: string) => join(runsDir(), id);

export function newRunId(): string {
  // Opaque, sortable-ish: time prefix for humans scanning the runs dir.
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `run_${t}_${randomBytes(6).toString('hex')}`;
}

export function createRun(req: RunRequest): RunRecord {
  const id = newRunId();
  const dir = runDir(id);
  for (const d of ['workspace', 'artifacts', 'room']) mkdirSync(join(dir, d), { recursive: true });
  const now = new Date().toISOString();
  const rec: RunRecord = { id, state: 'QUEUED', request: req, created_at: now, updated_at: now };
  saveRun(rec);
  writeFileSync(join(dir, 'events.jsonl'), '');
  seqs.set(id, 0);
  emit(id, 'run.state', { state: 'QUEUED' });
  return rec;
}

export function saveRun(rec: RunRecord): void {
  rec.updated_at = new Date().toISOString();
  const file = join(runDir(rec.id), 'run.json');
  writeFileSync(file + '.tmp', JSON.stringify(redactRequest(rec), null, 2));
  renameSync(file + '.tmp', file);
}

export function getRun(id: string): RunRecord | undefined {
  if (!/^run_[0-9a-z_]+$/.test(id)) return undefined;
  const file = join(runDir(id), 'run.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listRuns(limit = 50): RunRecord[] {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir()).filter(d => d.startsWith('run_')).sort().reverse().slice(0, limit)
    .map(id => getRun(id)).filter((r): r is RunRecord => !!r);
}

export function emit(runId: string, type: string, data: Record<string, unknown>): RunEvent {
  let seq = seqs.get(runId);
  if (seq === undefined) seq = readEvents(runId).length;
  seq += 1;
  seqs.set(runId, seq);
  const ev: RunEvent = { seq, ts: new Date().toISOString(), run_id: runId, type, data };
  appendFileSync(join(runDir(runId), 'events.jsonl'), JSON.stringify(ev) + '\n');
  bus.emit(runId, ev);
  bus.emit('*', ev);
  return ev;
}

export function readEvents(runId: string, afterSeq = 0): RunEvent[] {
  const file = join(runDir(runId), 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as RunEvent).filter(e => e.seq > afterSeq);
}

// Webhook secrets never land on disk in run.json.
function redactRequest(rec: RunRecord): RunRecord {
  if (!rec.request.webhook?.secret) return rec;
  return { ...rec, request: { ...rec.request, webhook: { ...rec.request.webhook, secret: '***' } } };
}
