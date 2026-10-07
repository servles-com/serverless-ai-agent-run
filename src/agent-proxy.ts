// Agent proxy: selects the configured trusted backend; the request cannot choose it.
//
//   SAR request ──► POST {SAR_AGENT_URL}/web/run-bearer  {username, task, requestId}
//                   Authorization: Bearer SAR_AGENT_SECRET
//               ◄── SSE: session | progress | chunk | done | error  (+ ping every 15 s)
//
// In `SAR_BACKEND=runner-api` mode, SAR submits to POST {SAR_RUNNER_API_URL}/v1/runs,
// follows replayable /events SSE, then fetches /result and cancels by Runner runId.
//
// `/web/run-bearer` is trained-assist's server-to-server entry point: it runs a real
// task for one profile and streams the answer back on the same connection. (`/run`
// needs a Telegram chat and delivers only there; there is no task-result endpoint.)
// Isolation, the engine and the model are decided by the trained-assist profile
// (SAR_AGENT_PROFILE); the Docker/gVisor rooms are paused, see docs/docker-gvisor-pause.md.
import { config } from './config.ts';
import { validateExpect } from './failures.ts';
import type { RunRequest } from './store.ts';

export interface AgentProxyConfig {
  backend: 'trained-assist-agent' | 'runner-api';
  agentUrl: string;
  agentSecret: string;
  profile: string;            // trained-assist username the runs belong to
  runnerApiUrl: string;
  runnerApiToken: string;
}

// Everything the classifier needs to explain how a run ended (failures.ts).
export interface AgentOutcome {
  httpStatus?: number;        // agent answered the POST with a non-2xx status
  httpError?: string;
  transportError?: string;    // could not connect, or the stream broke
  agentError?: string;        // SSE {type:'error'}
  done: boolean;              // SSE {type:'done'} arrived
  sessionId?: string;         // trained-assist session that holds the conversation
  chunks: number;
  progress: number;
  finalText?: string;         // last answer block, like opencode's last text part
  timedOut: boolean;
  idleKilled: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface AgentEvent { type: 'session' | 'chunk' | 'progress' | 'done' | 'error'; data: Record<string, unknown> }

export interface AgentHandle { done: Promise<AgentOutcome>; cancel: () => void }

export interface AgentRunOptions {
  runId: string;
  req: RunRequest;
  timeoutS: number;
  idleTimeoutS: number;
  onEvent: (ev: AgentEvent) => void;
  onRawLine?: (line: string) => void;
}

const MAX_INLINE_FILES_BYTES = 1024 * 1024;

export const proxyConfig = (): AgentProxyConfig =>
  {
    if (config.backend !== 'trained-assist-agent' && config.backend !== 'runner-api') {
      throw new Error(`unsupported SAR_BACKEND "${config.backend}" (expected trained-assist-agent or runner-api)`);
    }
    const runnerUrl = new URL(config.runnerApiUrl);
    if (runnerUrl.protocol !== 'https:' && !(runnerUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(runnerUrl.hostname))) {
      throw new Error('SAR_RUNNER_API_URL must use HTTPS unless it points to loopback');
    }
    return { backend: config.backend, agentUrl: config.agentUrl.replace(/\/+$/, ''), agentSecret: config.agentSecret,
      profile: config.agentProfile, runnerApiUrl: config.runnerApiUrl, runnerApiToken: config.runnerApiToken };
  };

// Untrusted JSON body: fields are checked here before it is treated as a RunRequest.
// Anything the agent backend cannot honour is refused up front, not failed after minutes.
export function validateRequest(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return 'body must be a JSON object';
  const body = input as {
    agent?: unknown; task?: unknown; files?: unknown; repo?: { url?: string; pull_request?: unknown }; credentials?: unknown;
    live?: unknown; webhook?: { url?: string }; secrets?: unknown; expect?: { artifacts?: unknown; json?: unknown };
  };
  if ((body.agent ?? 'opencode') !== 'opencode') return `unknown agent "${body.agent}" (known: opencode; the trained-assist profile picks the engine)`;
  if (typeof body.task !== 'string' || !body.task.trim()) return 'task (string) is required';
  if (body.files !== undefined) {
    if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) return 'files must be an object {path: content}';
    let size = 0;
    for (const [p, c] of Object.entries(body.files as Record<string, unknown>)) {
      if (!p || p.includes('\0') || p.startsWith('/') || p.split('/').includes('..')) return `unsafe file path: ${p}`;
      if (typeof c !== 'string') return `files["${p}"] must be a string`;
      size += Buffer.byteLength(c);
    }
    if (size > MAX_INLINE_FILES_BYTES) return `files are inlined into the task: at most ${MAX_INLINE_FILES_BYTES} bytes in total`;
  }
  if (body.repo && !/^https:\/\//.test(body.repo.url ?? '')) return 'repo.url must be an https URL';
  if (body.repo?.pull_request) return 'repo.pull_request is not supported by the trained-assist backend yet (phase 2)';
  if (body.credentials !== undefined) return 'credentials are not supported by the trained-assist backend (the profile holds its own)';
  if (body.live !== undefined && typeof body.live !== 'boolean') return 'live must be a boolean';
  if (body.webhook && !/^https?:\/\//.test(body.webhook.url ?? '')) return 'webhook.url must be an http(s) URL';
  if (body.secrets !== undefined && (!Array.isArray(body.secrets) || body.secrets.some((s: unknown) => typeof s !== 'string'))) return 'secrets must be an array of names';
  const expectErr = validateExpect(body.expect, false);
  if (expectErr) return expectErr;
  if (body.expect?.artifacts || body.expect?.json) return 'expect.artifacts / expect.json: the trained-assist backend returns no artifacts yet (phase 2); use expect.text';
  if (config.backend === 'runner-api' && buildAgentTask(input as RunRequest).length > RUNNER_API_MAX_PROMPT_CHARS) {
    return `task and inline files exceed Runner API limit of ${RUNNER_API_MAX_PROMPT_CHARS} characters`;
  }
  return undefined;
}

// Request fields the backend accepts but cannot apply: reported as run warnings.
export function ignoredFields(req: RunRequest): string[] {
  const out: string[] = [];
  if (req.model) out.push(`model "${req.model}" ignored: the trained-assist profile decides the model`);
  if (req.secrets?.length) out.push(`secrets ${req.secrets.join(', ')} not forwarded: the trained-assist profile uses its own credentials`);
  const l = req.limits ?? {};
  const room = (['memory_mb', 'cpus', 'pids'] as const).filter(k => l[k] !== undefined);
  if (room.length) out.push(`limits ${room.join(', ')} ignored: no local room`);
  return out;
}

// SAR request -> the task text trained-assist runs. Files and repo travel inside it:
// the agent works in its own profile directory, not in a SAR workspace.
export function buildAgentTask(req: RunRequest): string {
  const parts = [req.task.trim()];
  if (req.repo) parts.push(`Repository: ${req.repo.url}${req.repo.ref ? ` (ref: ${req.repo.ref})` : ''}`);
  const files = Object.entries(req.files ?? {});
  if (files.length) {
    parts.push(['Input files:', ...files.map(([p, c]) => `--- ${p} ---\n${c}${c.endsWith('\n') ? '' : '\n'}--- end ${p} ---`)].join('\n'));
  }
  return parts.join('\n\n');
}

export function buildAgentRequest(runId: string, req: RunRequest, cfg: AgentProxyConfig) {
  // requestId = run id: trained-assist deduplicates on it (409 on a replay).
  return { username: cfg.profile, task: buildAgentTask(req), requestId: runId };
}

// Minimal SSE decoder for trained-assist's stream: `data: {json}` frames,
// `event: ping` keep-alives. Returns the frames complete so far and the rest.
export function parseSse(buffer: string): { frames: { event?: string; data: string }[]; rest: string } {
  const frames: { event?: string; data: string }[] = [];
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (event || data.length) frames.push({ event, data: data.join('\n') });
  }
  return { frames, rest };
}

export function runOnAgent(o: AgentRunOptions, cfg: AgentProxyConfig = proxyConfig()): AgentHandle {
  if (cfg.backend === 'runner-api') return runOnRunnerApi(o, cfg);
  const out: AgentOutcome = { done: false, chunks: 0, progress: 0, timedOut: false, idleKilled: false, cancelled: false, durationMs: 0 };
  const ctrl = new AbortController();
  const started = Date.now();
  let lastActivity = started;
  const stop = (why: 'timedOut' | 'idleKilled' | 'cancelled') => {
    if (out.done || out[why]) return;
    out[why] = true;
    ctrl.abort();
    if (out.sessionId) void stopOnAgent(out.sessionId, cfg);
  };
  const hardTimer = setTimeout(() => stop('timedOut'), o.timeoutS * 1000);
  const idleTimer = setInterval(() => { if (Date.now() - lastActivity > o.idleTimeoutS * 1000) stop('idleKilled'); }, 1000);

  const handle = (frame: { event?: string; data: string }) => {
    if (frame.event === 'ping') return;
    let ev: { type?: unknown; sessionId?: unknown; message?: unknown; text?: unknown; error?: unknown };
    try { ev = JSON.parse(frame.data); } catch { return; }
    lastActivity = Date.now();
    switch (ev?.type) {
      case 'session': out.sessionId = String(ev.sessionId ?? '') || undefined; o.onEvent({ type: 'session', data: { session_id: out.sessionId } }); break;
      case 'progress': out.progress++; o.onEvent({ type: 'progress', data: { message: String(ev.message ?? '') } }); break;
      case 'chunk': out.chunks++; out.finalText = String(ev.text ?? ''); o.onEvent({ type: 'chunk', data: { text: out.finalText } }); break;
      case 'done': out.done = true; if (ev.sessionId) out.sessionId = String(ev.sessionId); o.onEvent({ type: 'done', data: { session_id: out.sessionId } }); break;
      case 'error': out.agentError = String(ev.error ?? 'unknown error'); o.onEvent({ type: 'error', data: { error: out.agentError } }); break;
    }
  };

  const done = (async (): Promise<AgentOutcome> => {
    try {
      const res = await fetch(`${cfg.agentUrl}/web/run-bearer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${cfg.agentSecret}` },
        body: JSON.stringify(buildAgentRequest(o.runId, o.req, cfg)),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        out.httpStatus = res.status;
        out.httpError = (await res.text().catch(() => '')).slice(0, 2000);
        return out;
      }
      const decoder = new TextDecoder();
      let buf = '';
      for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(bytes, { stream: true });
        const { frames, rest } = parseSse(buf);
        buf = rest;
        for (const f of frames) {
          if (f.event !== 'ping') o.onRawLine?.(f.event ? `event: ${f.event} data: ${f.data}` : f.data);
          handle(f);
        }
        if (out.done || out.agentError) break;
      }
    } catch (e) {
      // Our own abort (timeout / idle / cancel) is recorded in its flag, not as a transport error.
      if (!out.timedOut && !out.idleKilled && !out.cancelled) out.transportError = errorText(e);
    } finally {
      clearTimeout(hardTimer);
      clearInterval(idleTimer);
      out.durationMs = Date.now() - started;
    }
    return out;
  })();

  return { done, cancel: () => stop('cancelled') };
}

// Best effort: the session id is known only when trained-assist announced it
// (`session` frame) or the run finished. Closing the SSE connection alone does not
// stop the task on the agent side.
export async function stopOnAgent(sessionId: string, cfg: AgentProxyConfig = proxyConfig()): Promise<boolean> {
  if (cfg.backend === 'runner-api') return runnerApiCancel(sessionId, cfg);
  try {
    const res = await fetch(`${cfg.agentUrl}/web/stop-bearer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.agentSecret}` },
      body: JSON.stringify({ username: cfg.profile, id: sessionId }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}

export async function agentHealth(cfg: AgentProxyConfig = proxyConfig()): Promise<{ ok: boolean; url: string; status?: number; error?: string }> {
  if (cfg.backend === 'runner-api') {
    if (!cfg.runnerApiToken) return { ok: false, url: cfg.runnerApiUrl, error: 'SAR_RUNNER_API_TOKEN is not set' };
    try {
      const res = await fetch(`${cfg.runnerApiUrl}/v1/capabilities`, {
        headers: { authorization: `Bearer ${cfg.runnerApiToken}` }, signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => ({})) as { contract?: { name?: string } };
      const ok = res.ok && body.contract?.name === 'ai-agent-runner/serverless-agent-api';
      return { ok, url: cfg.runnerApiUrl, status: res.status, ...(ok ? {} : { error: 'Runner API token or contract check failed' }) };
    } catch (e) {
      return { ok: false, url: cfg.runnerApiUrl, error: errorText(e) };
    }
  }
  if (!cfg.agentSecret) return { ok: false, url: cfg.agentUrl, error: 'SAR_AGENT_SECRET is not set' };
  try {
    const res = await fetch(`${cfg.agentUrl}/health`, { signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, url: cfg.agentUrl, status: res.status };
  } catch (e) {
    return { ok: false, url: cfg.agentUrl, error: errorText(e) };
  }
}

const RUNNER_API_MAX_PROMPT_CHARS = 100_000;
const RUNNER_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function runOnRunnerApi(o: AgentRunOptions, cfg: AgentProxyConfig): AgentHandle {
  const out: AgentOutcome = { done: false, chunks: 0, progress: 0, timedOut: false, idleKilled: false, cancelled: false, durationMs: 0 };
  const ctrl = new AbortController();
  const started = Date.now();
  let lastActivity = started;
  let runnerRunId: string | undefined;
  let cancelRequested = false;
  const stop = (why: 'timedOut' | 'idleKilled' | 'cancelled') => {
    if (out.done || out[why]) return;
    out[why] = true;
    ctrl.abort();
    if (runnerRunId) void runnerApiCancel(runnerRunId, cfg);
  };
  const hardTimer = setTimeout(() => stop('timedOut'), o.timeoutS * 1000);
  const idleTimer = setInterval(() => { if (Date.now() - lastActivity > o.idleTimeoutS * 1000) stop('idleKilled'); }, 1000);

  const done = (async (): Promise<AgentOutcome> => {
    try {
      if (!cfg.runnerApiToken) {
        out.httpError = 'SAR_RUNNER_API_TOKEN is not set';
        out.httpStatus = 503;
        return out;
      }
      const prompt = buildAgentTask(o.req);
      if (prompt.length > RUNNER_API_MAX_PROMPT_CHARS) {
        out.httpError = `task and inline files exceed Runner API limit of ${RUNNER_API_MAX_PROMPT_CHARS} characters`;
        out.httpStatus = 413;
        return out;
      }
      const request: Record<string, unknown> = {
        userTaskId: o.runId,
        conversationId: `sar:${o.runId}`,
        input: { inlinePrompt: prompt },
        envAllowlist: [],
        limits: { timeoutMs: Math.max(1000, o.timeoutS * 1000) },
      };
      const accepted = await fetch(`${cfg.runnerApiUrl}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.runnerApiToken}`, 'idempotency-key': o.runId },
        body: JSON.stringify(request), signal: ctrl.signal,
      });
      if (!accepted.ok) {
        out.httpStatus = accepted.status;
        out.httpError = (await accepted.text().catch(() => '')).slice(0, 2000);
        return out;
      }
      const receipt = await accepted.json() as { runId?: unknown };
      runnerRunId = typeof receipt.runId === 'string' ? receipt.runId : undefined;
      if (!runnerRunId) {
        out.transportError = 'Runner API accepted the request without a runId receipt';
        return out;
      }
      out.sessionId = runnerRunId;
      o.onEvent({ type: 'session', data: { session_id: runnerRunId } });
      if (cancelRequested) {
        out.cancelled = true;
        void runnerApiCancel(runnerRunId, cfg);
        ctrl.abort();
      }

      let cursor = 0;
      let terminal = false;
      while (!terminal && !ctrl.signal.aborted) {
        const stream = await fetch(`${cfg.runnerApiUrl}/v1/runs/${encodeURIComponent(runnerRunId)}/events?cursor=${cursor}`, {
          headers: { accept: 'text/event-stream', authorization: `Bearer ${cfg.runnerApiToken}` }, signal: ctrl.signal,
        });
        if (!stream.ok || !stream.body) {
          out.httpStatus = stream.status;
          out.httpError = (await stream.text().catch(() => '')).slice(0, 2000);
          break;
        }
        const decoder = new TextDecoder();
        let buf = '';
        for await (const bytes of stream.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(bytes, { stream: true });
          const parsed = parseSse(buf);
          buf = parsed.rest;
          for (const frame of parsed.frames) {
            if (frame.event === 'snapshot' || frame.event === undefined) continue;
            let event: { sequence?: unknown; type?: unknown; payload?: Record<string, unknown> };
            try { event = JSON.parse(frame.data); } catch { continue; }
            o.onRawLine?.(JSON.stringify(event));
            if (typeof event.sequence === 'number') cursor = Math.max(cursor, event.sequence);
            lastActivity = Date.now();
            if (event.type === 'log') {
              const message = String(event.payload?.message ?? '').trim();
              if (message) {
                out.progress++;
                o.onEvent({ type: 'progress', data: { message } });
              }
            } else if (event.type === 'succeeded' || event.type === 'failed' || event.type === 'cancelled') {
              terminal = true;
              if (event.type === 'failed') out.agentError = String(event.payload?.safeSummary ?? event.payload?.code ?? 'Runner run failed');
              if (event.type === 'cancelled') out.cancelled = true;
            }
          }
          if (terminal || ctrl.signal.aborted) break;
        }
        if (!terminal && !ctrl.signal.aborted) await runnerApiStatus(runnerRunId, cfg).then(state => { terminal = RUNNER_TERMINAL.has(state); }).catch(() => undefined);
        if (!terminal && !ctrl.signal.aborted) await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (terminal && !ctrl.signal.aborted) {
        let result: Response | undefined;
        for (let attempt = 0; attempt < 8 && !ctrl.signal.aborted; attempt++) {
          result = await fetch(`${cfg.runnerApiUrl}/v1/runs/${encodeURIComponent(runnerRunId)}/result`, {
            headers: { authorization: `Bearer ${cfg.runnerApiToken}` }, signal: ctrl.signal,
          });
          if (result.ok || result.status !== 409) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!result) return out;
        if (result.ok) {
          const value = await result.json() as { text?: unknown; outcome?: unknown; failure?: { safeSummary?: unknown } };
          if (typeof value.text === 'string' && value.text.length > 0) {
            out.finalText = value.text;
            out.chunks++;
            o.onEvent({ type: 'chunk', data: { text: value.text } });
          }
          if (value.outcome === 'failed') out.agentError ??= String(value.failure?.safeSummary ?? 'Runner run failed');
          if (value.outcome === 'cancelled') out.cancelled = true;
          out.done = value.outcome === 'succeeded';
          if (out.done) o.onEvent({ type: 'done', data: { session_id: runnerRunId } });
        } else {
          out.httpStatus = result.status;
          out.httpError = (await result.text().catch(() => '')).slice(0, 2000);
        }
      }
    } catch (e) {
      if (!out.timedOut && !out.idleKilled && !out.cancelled) out.transportError = errorText(e);
    } finally {
      clearTimeout(hardTimer);
      clearInterval(idleTimer);
      out.durationMs = Date.now() - started;
    }
    return out;
  })();

  return { done, cancel: () => { if (runnerRunId) stop('cancelled'); else cancelRequested = true; } };
}

async function runnerApiStatus(runId: string, cfg: AgentProxyConfig): Promise<string> {
  const res = await fetch(`${cfg.runnerApiUrl}/v1/runs/${encodeURIComponent(runId)}/status`, {
    headers: { authorization: `Bearer ${cfg.runnerApiToken}` }, signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Runner API status HTTP ${res.status}`);
  const status = await res.json() as { state?: unknown };
  return String(status.state ?? 'unknown');
}

async function runnerApiCancel(runId: string, cfg: AgentProxyConfig): Promise<boolean> {
  if (!cfg.runnerApiToken) return false;
  try {
    const res = await fetch(`${cfg.runnerApiUrl}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.runnerApiToken}` },
      body: JSON.stringify({ reason: 'cancelled_by_sar' }), signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}

// fetch() hides the useful part (ECONNREFUSED ...) in error.cause.
function errorText(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } } | undefined;
  return String(err?.cause?.message ?? err?.message ?? e);
}
