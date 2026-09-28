// Failure classifier. The environment is only as good as its ability to say
// *why* a run failed, so every non-success ends with exactly one category,
// the evidence behind it and a hint what to try next.
//
// Pure function over what the agent proxy observed (src/agent-proxy.ts) -> easy
// to unit test and to extend whenever a new kind of failure shows up.
import type { AgentOutcome } from './agent-proxy.ts';
import type { Diagnosis, RunState } from './store.ts';

export interface Verdict { state: RunState; diagnosis?: Diagnosis; warnings: string[] }

const MODEL_ERROR_PATTERNS: [RegExp, string, boolean][] = [
  [/\b429\b|rate.?limit|too many requests|quota/i, 'MODEL_RATE_LIMITED', true],
  [/model.?not.?found|ProviderModelNotFound|no endpoints found|invalid model/i, 'MODEL_NOT_FOUND', false],
  [/\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication/i, 'MODEL_AUTH_FAILED', false],
  [/context.?length|maximum context|too many tokens|context window/i, 'MODEL_CONTEXT_OVERFLOW', false],
  [/code[=:" ]+5\d\d\b|status(Code)?[=:" ]+5\d\d\b|\b50[234]\b|overloaded|upstream|provider returned error|stream error|timeout.*(provider|model)|ECONNRESET|ETIMEDOUT|fetch failed/i, 'MODEL_PROVIDER_ERROR', true],
];

export function providerErrorCategory(line: string): string | undefined {
  return MODEL_ERROR_PATTERNS.find(([re]) => re.test(line))?.[1];
}

// The run was executed by trained-assist-agent (POST /web/run-bearer, SSE).
// Order matters: the transport and our own watchdogs explain a failure before
// whatever the agent said last.
export function classify(o: AgentOutcome): Verdict {
  const warnings: string[] = [];
  const fail = (state: RunState, category: string, summary: string, evidence: string[], retryable: boolean, hints: string[]): Verdict =>
    ({ state, diagnosis: { category, summary, evidence, retryable, hints }, warnings });
  const facts = [`duration_ms=${o.durationMs}`, `chunks=${o.chunks}`, `progress=${o.progress}`, `agent_session=${o.sessionId ?? '-'}`];

  if (o.cancelled) return fail('CANCELLED', 'CANCELLED', 'Run was cancelled by the caller', facts, true, []);
  if (o.httpStatus === 401 || o.httpStatus === 403) {
    return fail('FAILED', 'AGENT_AUTH_FAILED', `trained-assist-agent refused SAR's credentials (HTTP ${o.httpStatus})`,
      [String(o.httpError ?? '').slice(0, 500)], false,
      ['SAR_AGENT_SECRET must equal WEB_VERIFY_SECRET (or AGENT_SECRET when that is unset) on trained-assist-agent']);
  }
  if (o.httpStatus !== undefined && o.httpStatus < 500) {
    return fail('FAILED', 'AGENT_REJECTED', `trained-assist-agent rejected the run (HTTP ${o.httpStatus})`,
      [String(o.httpError ?? '').slice(0, 500)], o.httpStatus === 409,
      o.httpStatus === 409 ? ['The agent already accepted this run id (duplicate request); resubmit as a new run']
        : ['Check SAR_AGENT_PROFILE and the task/files sent (see agent/request.json in the run dir)']);
  }
  if (o.httpStatus !== undefined || (o.transportError && !o.chunks && !o.progress && !o.sessionId)) {
    return fail('FAILED', 'AGENT_UNAVAILABLE', 'trained-assist-agent is not reachable or failed to start the run',
      [o.httpStatus !== undefined ? `http_status=${o.httpStatus} ${String(o.httpError ?? '').slice(0, 300)}` : String(o.transportError)], true,
      ['Check `GET /healthz` and `systemctl status` of trained-assist-agent', 'SAR_AGENT_URL must point at it (default http://127.0.0.1:8080)']);
  }
  if (o.timedOut) {
    return fail('TIMED_OUT', 'TIMEOUT', 'Run exceeded limits.timeout_s', facts, true,
      ['Raise limits.timeout_s or split the task', 'The agent may still finish in its own session (agent_session)']);
  }
  if (o.idleKilled) {
    return fail('FAILED', 'IDLE_STALL', 'No progress from the agent for limits.idle_timeout_s — it hung', facts, true,
      ['Often a model call that never returns, or a long command without progress events', 'Raise limits.idle_timeout_s for long builds']);
  }
  if (o.transportError) {
    return fail('FAILED', 'AGENT_STREAM_LOST', 'Connection to trained-assist-agent broke mid-run', [String(o.transportError), ...facts], true,
      ['Usually trained-assist-agent restarted; the answer may still land in its session (agent_session)', 'Resubmit the run']);
  }
  if (o.agentError) {
    const category = providerErrorCategory(o.agentError);
    if (category) {
      return fail('FAILED', category, `Model provider error (${category.toLowerCase().replace(/_/g, ' ')})`, [o.agentError.slice(0, 500)],
        MODEL_ERROR_PATTERNS.find(([, c]) => c === category)![2], ['Retry later; the trained-assist profile decides which model runs']);
    }
    return fail('FAILED', 'AGENT_CRASHED', 'trained-assist-agent reported an error', [o.agentError.slice(0, 1000), ...facts], true,
      ['See trained-assist-agent logs (journalctl) for this session']);
  }
  if (!o.done) {
    return fail('FAILED', 'AGENT_STREAM_LOST', 'Stream from trained-assist-agent ended without a result', facts, true,
      ['trained-assist-agent closed the connection early — check its logs', 'Resubmit the run']);
  }
  if (!o.finalText?.trim()) {
    return fail('FAILED', 'AGENT_EMPTY_RESULT', 'Agent finished without an answer', facts, true,
      ['Weak model or prompt misunderstanding — make the task ask for a concrete answer']);
  }
  return { state: 'SUCCEEDED', warnings };
}

// --- Result contract (SB1). A run that "succeeded" but did not deliver what the
// caller asked for is a failure, not a quiet success: the user's worst case is an
// agent that did nothing and said "done".

export interface Expect {
  text?: boolean | string;   // true: non-empty final answer; string: case-insensitive regex it must match
  artifacts?: string[];      // each pattern (`*`, `**`, `?`) must match at least one non-empty file in /artifacts
  json?: string[];           // these artifacts must exist and parse as JSON
  non_empty?: boolean;       // at least one deliverable: final text or a non-empty artifact
  github_pr?: boolean;       // a pull request was opened (needs repo.pull_request)
}

export interface Deliverable {
  agent: string;
  text?: string;
  artifacts: { path: string; size: number }[];
  pullRequest: boolean;
  parsesAsJson: (path: string) => boolean;
}

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Request-time validation, so a malformed contract fails with 400 before any room starts.
export function validateExpect(e: unknown, hasPullRequest: boolean): string | undefined {
  if (e === undefined) return undefined;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'expect must be an object';
  const x = e as Record<string, unknown>;
  const known = ['text', 'artifacts', 'json', 'non_empty', 'github_pr'];
  const extra = Object.keys(x).filter(k => !known.includes(k));
  if (extra.length) return `unknown expect field(s): ${extra.join(', ')} (known: ${known.join(', ')})`;
  if (x.text !== undefined && typeof x.text !== 'boolean' && typeof x.text !== 'string') return 'expect.text must be a boolean or a regex string';
  if (typeof x.text === 'string') { try { new RegExp(x.text, 'i'); } catch { return `expect.text is not a valid regex: ${x.text}`; } }
  for (const k of ['artifacts', 'json']) {
    const v = x[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').includes('..'))) {
      return `expect.${k} must be an array of relative paths inside /artifacts`;
    }
  }
  for (const k of ['non_empty', 'github_pr']) if (x[k] !== undefined && typeof x[k] !== 'boolean') return `expect.${k} must be a boolean`;
  if (x.github_pr && !hasPullRequest) return 'expect.github_pr needs repo.pull_request';
  return undefined;
}

// Returns a failing verdict, or undefined when the run delivered what it promised.
export function checkDeliverable(expect: Expect | undefined, d: Deliverable, warnings: string[]): Verdict | undefined {
  const text = d.text?.trim() ?? '';
  const files = d.artifacts.filter(a => a.size > 0);
  if (!expect) {
    if (d.agent === 'shell' || text || files.length || d.pullRequest) return undefined;
    return { state: 'FAILED', warnings, diagnosis: { category: 'NO_DELIVERABLE',
      summary: 'Agent finished without a final answer, a non-empty artifact or a pull request',
      evidence: [`artifacts=${d.artifacts.length}`, `empty_artifacts=${d.artifacts.length - files.length}`], retryable: true,
      hints: ['Ask for a concrete deliverable (a file in /artifacts) and declare it in `expect`', 'Try a stronger model'] } };
  }
  const unmet: string[] = [];
  if (expect.text === true && !text) unmet.push('text: the agent gave no final answer');
  if (typeof expect.text === 'string' && !new RegExp(expect.text, 'i').test(text)) {
    unmet.push(`text: final answer does not match /${expect.text}/i: ${JSON.stringify(text.slice(0, 200))}`);
  }
  for (const p of expect.artifacts ?? []) {
    const re = globToRegExp(p);
    const hits = d.artifacts.filter(a => re.test(a.path));
    if (!hits.length) unmet.push(`artifact missing: ${p}`);
    else if (!hits.some(a => a.size > 0)) unmet.push(`artifact empty: ${p}`);
  }
  for (const p of expect.json ?? []) {
    if (!d.artifacts.some(a => a.path === p)) unmet.push(`json missing: ${p}`);
    else if (!d.parsesAsJson(p)) unmet.push(`json invalid: ${p}`);
  }
  if (expect.non_empty && !text && !files.length) unmet.push('non_empty: no final answer and no non-empty artifact');
  if (expect.github_pr && !d.pullRequest) unmet.push('github_pr: no pull request was opened');
  if (!unmet.length) return undefined;
  return { state: 'FAILED', warnings, diagnosis: { category: 'EXPECTATION_NOT_MET',
    summary: `Run finished but did not deliver what \`expect\` promised (${unmet.length} unmet)`,
    evidence: [...unmet, `artifacts=${JSON.stringify(d.artifacts.map(a => a.path).slice(0, 20))}`], retryable: true,
    hints: ['Check the agent\'s final text (result.text) — it may have written elsewhere, e.g. /workspace instead of /artifacts',
      'Make the task name the exact output path'] } };
}
