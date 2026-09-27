// Run Manager: lifecycle  hydrate -> execute -> export -> sterilize, plus crash
// recovery and GC. Queue: queue.ts; room inputs: run-env.ts; PR/expect: deliverables.ts.
import { writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { adapters, emptyStats } from './adapters/index.ts';
import { closeOpenStep } from './step-timing.ts';
import { classify, credentialVerdict, newFailFast, observeFailFast } from './failures.ts';
import { startRoom, destroyRoom, listRoomContainers, containerName } from './rooms.ts';
import { emit, getRun, saveRun, runDir, runsDir, TERMINAL, type RunRecord, type RunState } from './store.ts';
import { attachRoom, isCancelRequested, release, requestOf, startQueue, type Completion } from './queue.ts';
import { hydrate, roomSpec, resolveCredentialEnv, CredentialError } from './run-env.ts';
import { listFiles, settleDeliverables } from './deliverables.ts';
import { scrub } from './redact.ts';

export { enqueue, cancel, stats } from './queue.ts';
export { validateRequest } from './run-env.ts';
export { listFiles } from './deliverables.ts';

const exec = promisify(execFile);

startQueue({ execute, finish });

function setState(rec: RunRecord, state: RunState, extra: Record<string, unknown> = {}) {
  rec.state = state;
  saveRun(rec);
  emit(rec.id, 'run.state', { state, ...extra });
}

async function execute(id: string): Promise<void> {
  const rec = getRun(id)!;
  const req = requestOf(id) ?? rec.request;
  const dir = runDir(id);
  const model = req.model ?? config.defaults.model;

  // --- hydrate
  setState(rec, 'PREPARING');
  rec.started_at = new Date().toISOString();
  try {
    await hydrate(id, req);
  } catch (e: any) {
    return finish(rec, { state: 'FAILED', warnings: [], diagnosis: { category: 'HYDRATE_FAILED',
      summary: 'Could not prepare run inputs (repo clone / files)', evidence: [String(e.stderr || e.message).slice(0, 2000)],
      retryable: true, hints: ['Check repo URL/ref and that a GITHUB_TOKEN secret was requested for private repos'] } });
  }
  if (isCancelRequested(id)) return finish(rec, { state: 'CANCELLED', warnings: [] });
  let credEnv: Record<string, string>;
  try {
    credEnv = resolveCredentialEnv(id, req);
  } catch (e) {
    if (e instanceof CredentialError) return finish(rec, credentialVerdict([{ code: e.code, ref: e.ref }]));
    throw e;
  }

  // --- execute
  const adapter = adapters[req.agent ?? 'opencode'];
  const agentStats = emptyStats();
  const failFast = newFailFast(config.failFastProviderErrors);
  const stopEarly = () => {
    emit(id, 'run.log', { msg: `fail-fast: ${failFast.errors} provider errors in a row, stopping the room` });
    void exec(config.docker, ['kill', containerName(id)]).catch(() => {});
  };
  const spec = roomSpec(id, req, model, {
    onStdoutLine: line => {
      const parsed = adapter.parse(line, agentStats);
      if (parsed) emit(id, `agent.${parsed.type}`, parsed.data);
      // Provider errors are counted from stderr only (opencode logs each one there once).
      if (parsed?.type === 'tool' || parsed?.type === 'text' || parsed?.type === 'step_finish') observeFailFast(failFast, { progress: true });
    },
    onStderrLine: line => {
      if (line.trim()) emit(id, 'room.stderr', { line: line.slice(0, 2000) });
      if (observeFailFast(failFast, { stderr: line })) stopEarly();
    },
  }, credEnv);
  rec.room = { container: containerName(id), runtime: config.roomRuntime || 'runc' };
  setState(rec, 'RUNNING', { model: req.agent === 'shell' ? undefined : model, limits: spec.limits });
  console.log(`run ${id} RUNNING agent=${req.agent} ${req.agent === 'shell' ? '' : `model=${model} `}task=${JSON.stringify(req.task.slice(0, 80))}`);

  const room = startRoom(spec);
  attachRoom(id, room);
  const outcome = await room.done;
  // A step still open when the room stopped (timeout/crash/cancel) never got a
  // step_finish: close it at kill time so TIMEOUT evidence still splits model
  // wait from tool execution.
  closeOpenStep(agentStats.timing, Date.now());
  rec.room = { container: outcome.container, runtime: outcome.runtime, exit_code: outcome.exitCode, oom_killed: outcome.oomKilled };

  // --- export (V0: artifacts already live in the run dir via bind mount; we just index them)
  setState(rec, 'EXPORTING');
  let artifacts: string[] = [];
  let exportError: string | undefined;
  try { artifacts = listFiles(join(dir, 'artifacts')); } catch (e: any) { exportError = e.message; }

  // --- sterilize
  await destroyRoom(outcome.container);
  emit(id, 'room.destroyed', { container: outcome.container, duration_ms: outcome.durationMs });

  const result = rec.result = { text: agentStats.finalText, artifacts, steps: agentStats.steps, tool_calls: agentStats.toolCalls,
    tool_errors: agentStats.toolErrors, tokens: agentStats.tokens,
    model_ms: agentStats.timing.modelMs, tool_ms: agentStats.timing.toolMs, open_ms: agentStats.timing.openMs, step_timings: agentStats.timing.stepTimings };
  const verdict = classify({ agent: req.agent ?? 'opencode', room: outcome, stats: agentStats, artifacts, exportError, failFast });
  await settleDeliverables({ id, result, req, model, stats: agentStats, artifacts, verdict });
  finish(rec, verdict);
}

function finish(rec: RunRecord, v: Completion) {
  rec.diagnosis = v.diagnosis;
  rec.warnings = v.warnings.length ? v.warnings : undefined;
  rec.finished_at = new Date().toISOString();
  if (v.diagnosis) writeFileSync(join(runDir(rec.id), 'diagnosis.json'), JSON.stringify(scrub(v.diagnosis), null, 2));
  setState(rec, v.state, { diagnosis: v.diagnosis, warnings: rec.warnings, result: rec.result });
  emit(rec.id, 'run.completed', { state: v.state, category: v.diagnosis?.category ?? 'OK' });
  // One line per finished run in `journalctl -u sar` — the operator's first place to look.
  const secs = rec.started_at ? Math.round((Date.parse(rec.finished_at) - Date.parse(rec.started_at)) / 1000) : 0;
  console.log(`run ${rec.id} ${v.state} category=${v.diagnosis?.category ?? 'OK'} ${secs}s steps=${rec.result?.steps ?? 0} tools=${rec.result?.tool_calls ?? 0}` +
    (v.diagnosis ? ` — ${v.diagnosis.summary}` : ''));
  release(rec.id);
}

// Crash recovery: runs left non-terminal by a previous process are failed
// with an explicit category, and their orphaned rooms are destroyed.
export async function reconcileOnStartup(): Promise<string[]> {
  const fixed: string[] = [];
  for (const c of await listRoomContainers()) await destroyRoom(c.name);
  if (!existsSync(runsDir())) return fixed;
  for (const id of readdirSync(runsDir())) {
    const rec = getRun(id);
    if (!rec || TERMINAL.includes(rec.state)) continue;
    finish(rec, { state: 'FAILED', warnings: [], diagnosis: { category: 'ORPHANED_BY_RESTART',
      summary: `Service restarted while run was ${rec.state}`, evidence: [`last_state=${rec.state}`, `updated_at=${rec.updated_at}`],
      retryable: true, hints: ['Resubmit the run; check service logs (journalctl -u sar) for why it restarted'] } });
    fixed.push(id);
  }
  return fixed;
}

export function gcOldRuns(): number {
  if (!existsSync(runsDir())) return 0;
  const cutoff = Date.now() - config.retentionHours * 3600_000;
  let n = 0;
  for (const id of readdirSync(runsDir())) {
    const rec = getRun(id);
    if (rec && TERMINAL.includes(rec.state) && Date.parse(rec.updated_at) < cutoff) {
      rmSync(runDir(id), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}
