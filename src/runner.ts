// Run Manager: queue + lifecycle  hydrate -> execute -> export -> sterilize.
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync, lstatSync, closeSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, providerEnvValues } from './config.ts';
import { adapters, emptyStats } from './adapters/index.ts';
import { closeOpenStep } from './step-timing.ts';
import { classify, checkDeliverable, validateExpect, newFailFast, observeFailFast } from './failures.ts';
import { startRoom, destroyRoom, listRoomContainers, containerName, type RoomHandle } from './rooms.ts';
import { bus, emit, getRun, saveRun, runDir, runsDir, TERMINAL, type RunRecord, type RunRequest, type RunState } from './store.ts';
import { deliver, flush, shouldDeliver, type WebhookTarget } from './webhooks.ts';
import { hostClone, openPullRequest, repoAllowed, PullRequestError } from './pullrequest.ts';
import { scrub } from './redact.ts';
import { createVolume, releaseVolume, validateDiskLimit, volumeFull } from './volume.ts';
import { listFiles, openInside, symlinkOnPath } from './safe-files.ts';

const exec = promisify(execFile);

const queue: string[] = [];
const active = new Map<string, RoomHandle | null>();
const cancelRequested = new Set<string>();
// Webhook secrets live only in memory (run.json has them redacted).
const webhooks = new Map<string, WebhookTarget>();
const requests = new Map<string, RunRequest>();

bus.on('*', ev => {
  const target = webhooks.get(ev.run_id);
  if (target && shouldDeliver(target, ev)) {
    void deliver(target, ev, (type, data) => emit(ev.run_id, type, data));
  }
});

export function validateRequest(body: any): string | undefined {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (!adapters[body.agent ?? 'opencode']) return `unknown agent "${body.agent}" (known: ${Object.keys(adapters).join(', ')})`;
  if (typeof body.task !== 'string' || !body.task.trim()) return 'task (string) is required';
  if (body.files && typeof body.files !== 'object') return 'files must be an object {path: content}';
  for (const p of Object.keys(body.files ?? {})) if (!safeRelPath(p)) return `unsafe file path: ${p}`;
  if (body.repo && !/^https:\/\//.test(body.repo.url ?? '')) return 'repo.url must be an https URL';
  if (body.repo?.pull_request) {
    if (!config.githubPushToken) return 'pull_request is not enabled on this server (no SAR_GITHUB_PUSH_TOKEN)';
    if (!repoAllowed(body.repo.url, config.prRepos)) return `pull_request not allowed for ${body.repo.url} (allowed: ${config.prRepos.join(', ') || 'none'})`;
  }
  if (body.webhook && !/^https?:\/\//.test(body.webhook.url ?? '')) return 'webhook.url must be an http(s) URL';
  for (const s of body.secrets ?? []) if (!(s in config.secrets)) return `unknown secret "${s}" (not in server secrets file)`;
  const diskErr = validateDiskLimit(body.limits?.disk_mb, config.defaults.diskMb > 0, config.maxDiskMb);
  if (diskErr) return diskErr;
  return validateExpect(body.expect, !!body.repo?.pull_request);
}

export function enqueue(rec: RunRecord, req: RunRequest): void {
  requests.set(rec.id, req);
  if (req.webhook) webhooks.set(rec.id, req.webhook);
  queue.push(rec.id);
  pump();
}

export function cancel(id: string): boolean {
  const rec = getRun(id);
  if (!rec || TERMINAL.includes(rec.state)) return false;
  cancelRequested.add(id);
  const qi = queue.indexOf(id);
  if (qi >= 0) {
    queue.splice(qi, 1);
    finish(rec, { state: 'CANCELLED', diagnosis: { category: 'CANCELLED', summary: 'Cancelled while queued', evidence: [], retryable: true, hints: [] }, warnings: [] });
    return true;
  }
  active.get(id)?.cancel();
  return true;
}

export function stats() {
  return { queued: queue.length, active: [...active.keys()], max_rooms: config.maxRooms };
}

function pump(): void {
  while (active.size < config.maxRooms && queue.length) {
    const id = queue.shift()!;
    active.set(id, null);
    execute(id).catch(err => {
      const rec = getRun(id);
      if (rec && !TERMINAL.includes(rec.state)) {
        finish(rec, { state: 'FAILED', diagnosis: { category: 'RUNTIME_BUG', summary: 'Unhandled error in the run manager',
          evidence: [String(err?.stack ?? err)], retryable: true, hints: ['This is a bug in serverless-ai-agent-run itself'] }, warnings: [] });
      }
    }).finally(() => { active.delete(id); pump(); });
  }
}

function setState(rec: RunRecord, state: RunState, extra: Record<string, unknown> = {}) {
  rec.state = state;
  saveRun(rec);
  emit(rec.id, 'run.state', { state, ...extra });
}

async function execute(id: string): Promise<void> {
  const rec = getRun(id)!;
  const req = requests.get(id) ?? rec.request;
  const dir = runDir(id);
  const adapter = adapters[req.agent ?? 'opencode'];
  const model = req.model ?? config.defaults.model;

  // --- hydrate
  setState(rec, 'PREPARING');
  rec.started_at = new Date().toISOString();
  const diskMb = req.limits?.disk_mb ?? config.defaults.diskMb;
  if (diskMb > 0) {
    try {
      await createVolume(dir, diskMb);
      emit(id, 'run.log', { msg: `workspace volume: ${diskMb} MB` });
    } catch (e: any) {
      return finish(rec, { state: 'FAILED', warnings: [], diagnosis: { category: 'ROOM_START_FAILED',
        summary: 'Could not create the run\'s disk volume (quota)', evidence: [String(e.stderr || e.message).slice(0, 1000)],
        retryable: true, hints: ['Check the sudoers rule for sar-run-volume and free disk space on the host (vm-bootstrap.sh)'] } });
    }
  }
  try {
    await hydrate(id, req);
  } catch (e: any) {
    return finish(rec, { state: 'FAILED', warnings: [], diagnosis: { category: 'HYDRATE_FAILED',
      summary: 'Could not prepare run inputs (repo clone / files)', evidence: [String(e.stderr || e.message).slice(0, 2000)],
      retryable: true, hints: ['Check repo URL/ref and that a GITHUB_TOKEN secret was requested for private repos'] } });
  }
  if (cancelRequested.has(id)) return finish(rec, { state: 'CANCELLED', warnings: [] });

  // --- execute
  const env: Record<string, string> = { ...adapter.env(req, model) };
  if (req.agent !== 'shell') Object.assign(env, providerEnvValues());
  for (const s of req.secrets ?? []) env[s] = config.secrets[s];
  const limits = {
    timeoutS: req.limits?.timeout_s ?? config.defaults.timeoutS,
    idleTimeoutS: req.limits?.idle_timeout_s ?? config.defaults.idleTimeoutS,
    memoryMb: req.limits?.memory_mb ?? config.defaults.memoryMb,
    cpus: req.limits?.cpus ?? config.defaults.cpus,
    pids: req.limits?.pids ?? config.defaults.pids,
  };
  const agentStats = emptyStats();
  rec.room = { container: containerName(id), runtime: config.roomRuntime || 'runc' };
  setState(rec, 'RUNNING', { model: req.agent === 'shell' ? undefined : model, limits });
  console.log(`run ${id} RUNNING agent=${req.agent} ${req.agent === 'shell' ? '' : `model=${model} `}task=${JSON.stringify(req.task.slice(0, 80))}`);

  // Raw output lines become events too; cap them like the log files (checklist 1.13).
  let outputBytes = 0;
  const withinOutputCap = (line: string): boolean => {
    if (outputBytes > config.roomLogMaxBytes) return false;
    outputBytes += line.length + 1;
    if (outputBytes <= config.roomLogMaxBytes) return true;
    emit(id, 'run.log', { msg: `output events truncated at ${config.roomLogMaxBytes} bytes; the run continues` });
    return false;
  };
  const failFast = newFailFast(config.failFastProviderErrors);
  const stopEarly = () => {
    emit(id, 'run.log', { msg: `fail-fast: ${failFast.errors} provider errors in a row, stopping the room` });
    void exec(config.docker, ['kill', containerName(id)]).catch(() => {});
  };
  const room = startRoom({
    runId: id,
    workspaceDir: join(dir, 'workspace'),
    artifactsDir: join(dir, 'artifacts'),
    logDir: join(dir, 'room'),
    command: adapter.command(req, model),
    env, limits,
    onStdoutLine: line => {
      const parsed = adapter.parse(line, agentStats);
      if (parsed && (parsed.type !== 'stdout' || withinOutputCap(line))) emit(id, `agent.${parsed.type}`, parsed.data);
      // Provider errors are counted from stderr only (opencode logs each one there once).
      if (parsed?.type === 'tool' || parsed?.type === 'text' || parsed?.type === 'step_finish') observeFailFast(failFast, { progress: true });
    },
    onStderrLine: line => {
      if (line.trim() && withinOutputCap(line)) emit(id, 'room.stderr', { line: line.slice(0, 2000) });
      if (observeFailFast(failFast, { stderr: line })) stopEarly();
    },
  });
  active.set(id, room);
  if (cancelRequested.has(id)) room.cancel();
  const outcome = await room.done;
  const diskFull = volumeFull(dir);
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

  rec.result = { text: agentStats.finalText, artifacts, steps: agentStats.steps, tool_calls: agentStats.toolCalls,
    tool_errors: agentStats.toolErrors, tokens: agentStats.tokens,
    model_ms: agentStats.timing.modelMs, tool_ms: agentStats.timing.toolMs, open_ms: agentStats.timing.openMs, step_timings: agentStats.timing.stepTimings };
  const verdict = classify({ agent: req.agent ?? 'opencode', room: outcome, stats: agentStats, artifacts, exportError, diskFull, failFast });

  // Host-side PR, only for a run that otherwise succeeded. "Nothing changed" is a
  // failure, not a quiet success — the user's worst case is an agent that did nothing.
  if (verdict.state === 'SUCCEEDED' && req.repo?.pull_request) {
    const spec = req.repo.pull_request;
    const title = spec.title ?? `[agent] ${req.task.split('\n')[0].slice(0, 80)}`;
    const body = [spec.body ?? '', '', '---', `Run \`${id}\` · model \`${model}\` · ${agentStats.steps} steps, ${agentStats.toolCalls} tool calls`, '',
      '<details><summary>Agent summary</summary>', '', (agentStats.finalText ?? '(none)').slice(0, 6000), '', '</details>'].join('\n');
    try {
      rec.result.pull_request = await openPullRequest({ runId: id, repoUrl: req.repo.url, hostRepo: join(dir, 'host-repo'),
        workspace: join(dir, 'workspace'), spec, defaultBase: req.repo.ref, token: config.githubPushToken, title, body });
      emit(id, 'run.pull_request', { ...rec.result.pull_request });
    } catch (e: any) {
      const pe = e instanceof PullRequestError ? e : new PullRequestError('PR_FAILED', String(e?.message ?? e), true);
      verdict.state = 'FAILED';
      verdict.diagnosis = { category: pe.category, summary: pe.message, evidence: [String(e?.stderr ?? '').slice(0, 500)].filter(Boolean),
        retryable: pe.retryable, hints: pe.category === 'NO_CHANGES'
          ? ['The agent reported success but did not modify the repository — see its final text in result.text']
          : ['See run.log events and host-repo/ in the run dir'] };
    }
  }
  if (verdict.state === 'SUCCEEDED') {
    const artDir = join(dir, 'artifacts');
    const failed = checkDeliverable(req.expect, {
      agent: req.agent ?? 'opencode', text: agentStats.finalText, pullRequest: !!rec.result.pull_request,
      artifacts: artifacts.map(p => ({ path: p, size: lstatSync(join(artDir, p)).size })),
      parsesAsJson: p => {
        const fd = openInside(artDir, p);
        if (fd === undefined) return false;
        try { JSON.parse(readFileSync(fd, 'utf8')); return true; } catch { return false; } finally { closeSync(fd); }
      },
    }, verdict.warnings);
    if (failed) Object.assign(verdict, failed);
  }
  finish(rec, verdict);
}

function finish(rec: RunRecord, v: { state: RunState; diagnosis?: RunRecord['diagnosis']; warnings: string[] }) {
  // Artifacts go back to the plain run dir before anyone hears the run is done.
  const volumeError = releaseVolume(runDir(rec.id));
  if (volumeError) v.warnings.push(`disk volume release failed: ${volumeError}`);
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
  cancelRequested.delete(rec.id);
  requests.delete(rec.id);
  void flush(rec.id).then(() => webhooks.delete(rec.id));
}

async function hydrate(id: string, req: RunRequest) {
  const ws = join(runDir(id), 'workspace');
  if (req.repo) {
    const token = req.secrets?.includes('GITHUB_TOKEN') ? config.secrets.GITHUB_TOKEN : undefined;
    const args = ['clone', '--depth', '50'];
    if (req.repo.ref) args.push('--branch', req.repo.ref);
    // Token goes in a header, not the URL, so it is not written to .git/config.
    const auth = token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
    await exec('git', [...auth, ...args, req.repo.url, ws], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    emit(id, 'run.log', { msg: `cloned ${req.repo.url}${req.repo.ref ? '@' + req.repo.ref : ''}` });
    if (req.repo.pull_request) {
      await hostClone(req.repo.url, req.repo.ref, join(runDir(id), 'host-repo'), config.githubPushToken);
      emit(id, 'run.log', { msg: 'host clone ready for pull request' });
    }
  }
  for (const [p, content] of Object.entries(req.files ?? {})) {
    const link = symlinkOnPath(ws, p);
    if (link) throw new Error(`input file ${p}: ${link} in the workspace is a symlink; refusing to write through it`);
    const full = join(ws, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  if (req.files) emit(id, 'run.log', { msg: `wrote ${Object.keys(req.files).length} input files` });
}

function safeRelPath(p: string): boolean {
  if (!p || isAbsolute(p) || p.includes('\0')) return false;
  const r = relative('/w', resolve('/w', p));
  return !!r && !r.startsWith('..');
}

export { listFiles };

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
      if (releaseVolume(runDir(id))) continue;   // still mounted: never rm -r through a mount
      rmSync(runDir(id), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}
