// Run Manager: lifecycle  queued -> preparing -> running on trained-assist-agent -> verdict,
// plus crash recovery and GC. Queue: queue.ts; the backend call: agent-proxy.ts.
import { writeFileSync, readdirSync, existsSync, rmSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { classify, checkDeliverable } from './failures.ts';
import { buildAgentRequest, ignoredFields, proxyConfig, runOnAgent } from './agent-proxy.ts';
import { emit, getRun, saveRun, runDir, runsDir, TERMINAL, type RunRecord, type RunState } from './store.ts';
import { attachHandle, isCancelRequested, release, requestOf, startQueue, type Completion } from './queue.ts';
import { listFiles } from './safe-files.ts';
import { redact, scrub } from './redact.ts';

export { enqueue, cancel, stats } from './queue.ts';
export { validateRequest } from './agent-proxy.ts';
export { listFiles };

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
  const cfg = proxyConfig();

  setState(rec, 'PREPARING');
  rec.started_at = new Date().toISOString();
  const ignored = ignoredFields(req);
  for (const msg of ignored) emit(id, 'run.log', { msg });
  // Exactly what went to the agent (minus auth), for /debug and `cat`.
  writeFileSync(join(dir, 'agent', 'request.json'), JSON.stringify(scrub({ url: `${cfg.agentUrl}/web/run-bearer`, body: buildAgentRequest(id, req, cfg) }), null, 2));
  if (isCancelRequested(id)) return finish(rec, { state: 'CANCELLED', warnings: [] });

  const limits = {
    timeout_s: req.limits?.timeout_s ?? config.defaults.timeoutS,
    idle_timeout_s: req.limits?.idle_timeout_s ?? config.defaults.idleTimeoutS,
  };
  rec.agent_backend = { url: cfg.agentUrl, profile: cfg.profile };
  setState(rec, 'RUNNING', { backend: 'trained-assist-agent', limits });
  console.log(`run ${id} RUNNING profile=${cfg.profile} task=${JSON.stringify(req.task.slice(0, 80))}`);

  const log = createWriteStream(join(dir, 'agent', 'stream.log'));
  const run = runOnAgent({
    runId: id, req, timeoutS: limits.timeout_s, idleTimeoutS: limits.idle_timeout_s,
    onRawLine: line => log.write(redact(line) + '\n'),
    onEvent: ev => {
      switch (ev.type) {
        case 'session': emit(id, 'run.log', { msg: `agent session ${ev.data.session_id}` }); break;
        // trained-assist progress labels are tool activity ("🔧 Bash …"): same event as opencode tool calls.
        case 'progress': emit(id, 'agent.tool', { tool: ev.data.message, status: 'running' }); break;
        case 'chunk': emit(id, 'agent.text', ev.data); break;
        case 'error': emit(id, 'agent.error', ev.data); break;
        case 'done': break;
      }
    },
  }, cfg);
  attachHandle(id, run);
  const outcome = await run.done;
  log.end();
  rec.agent_backend = { ...rec.agent_backend, session_id: outcome.sessionId, http_status: outcome.httpStatus, duration_ms: outcome.durationMs };

  let artifacts: string[] = [];
  try { artifacts = listFiles(join(dir, 'artifacts')); } catch { /* none: the backend returns no files yet */ }
  rec.result = { text: outcome.finalText, artifacts, steps: outcome.chunks, tool_calls: outcome.progress, tool_errors: 0 };
  const verdict = classify(outcome);
  verdict.warnings.push(...ignored);
  if (verdict.state === 'SUCCEEDED') {
    const failed = checkDeliverable(req.expect, { agent: req.agent ?? 'opencode', text: outcome.finalText, artifacts: [],
      pullRequest: false, parsesAsJson: () => false }, verdict.warnings);
    if (failed) Object.assign(verdict, failed);
  }
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
  console.log(`run ${rec.id} ${v.state} category=${v.diagnosis?.category ?? 'OK'} ${secs}s chunks=${rec.result?.steps ?? 0}` +
    (v.diagnosis ? ` — ${v.diagnosis.summary}` : ''));
  release(rec.id);
}

// Crash recovery: runs left non-terminal by a previous process are failed with an
// explicit category. Their task may still be running on trained-assist-agent.
export async function reconcileOnStartup(): Promise<string[]> {
  const fixed: string[] = [];
  if (!existsSync(runsDir())) return fixed;
  for (const id of readdirSync(runsDir())) {
    const rec = getRun(id);
    if (!rec || TERMINAL.includes(rec.state)) continue;
    finish(rec, { state: 'FAILED', warnings: [], diagnosis: { category: 'ORPHANED_BY_RESTART',
      summary: `Service restarted while run was ${rec.state}`,
      evidence: [`last_state=${rec.state}`, `updated_at=${rec.updated_at}`, `agent_session=${rec.agent_backend?.session_id ?? '-'}`],
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
