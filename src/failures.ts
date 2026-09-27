// Failure classifier. The environment is only as good as its ability to say
// *why* a run failed, so every non-success ends with exactly one category,
// the evidence behind it and a hint what to try next.
//
// Pure function over facts collected by the runner -> easy to unit test and
// to extend whenever dogfooding finds an "UNKNOWN" failure.
import type { RoomOutcome } from './rooms.ts';
import type { AgentStats } from './adapters/index.ts';
import type { Diagnosis, RunState } from './store.ts';

export interface Facts {
  agent: string;
  room: RoomOutcome;
  stats: AgentStats;
  artifacts: string[];
  exportError?: string;
}

export interface Verdict { state: RunState; diagnosis?: Diagnosis; warnings: string[] }

const MODEL_ERROR_PATTERNS: [RegExp, string, boolean][] = [
  [/\b429\b|rate.?limit|too many requests|quota/i, 'MODEL_RATE_LIMITED', true],
  [/model.?not.?found|ProviderModelNotFound|no endpoints found|invalid model/i, 'MODEL_NOT_FOUND', false],
  [/\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication/i, 'MODEL_AUTH_FAILED', false],
  [/context.?length|maximum context|too many tokens|context window/i, 'MODEL_CONTEXT_OVERFLOW', false],
  [/code[=:" ]+5\d\d\b|status(Code)?[=:" ]+5\d\d\b|\b50[234]\b|overloaded|upstream|provider returned error|stream error|timeout.*(provider|model)|ECONNRESET|ETIMEDOUT|fetch failed/i, 'MODEL_PROVIDER_ERROR', true],
];

function providerHits(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split('\n')) {
    const m = MODEL_ERROR_PATTERNS.find(([re]) => re.test(line));
    if (m) out.push([m[1], line]);
  }
  return out;
}

export function classify(f: Facts): Verdict {
  const { room, stats } = f;
  const warnings: string[] = [];
  const logText = [...stats.agentErrors, ...room.stderrTail].join('\n');
  const tail = (n = 8) => room.stderrTail.slice(-n);

  if (stats.toolErrors > 0) warnings.push(`${stats.toolErrors}/${stats.toolCalls} tool calls failed`);
  if (stats.unparsedLines > 0 && f.agent === 'opencode') warnings.push(`${stats.unparsedLines} stdout lines were not JSON events`);

  const fail = (state: RunState, category: string, summary: string, evidence: string[], retryable: boolean, hints: string[]): Verdict =>
    ({ state, diagnosis: { category, summary, evidence, retryable, hints }, warnings });

  if (room.startError) {
    return fail('FAILED', 'ROOM_START_FAILED', 'The container runtime could not start the room',
      [room.startError], false,
      ['Check `GET /healthz`: image built? runtime (runsc) registered in docker?', 'See room/docker-args.json for the exact docker command']);
  }
  if (room.cancelled) return fail('CANCELLED', 'CANCELLED', 'Run was cancelled by the caller', [], true, []);
  if (room.oomKilled) {
    return fail('FAILED', 'OOM_KILLED', 'Room exceeded its memory limit and was killed by the kernel',
      [`exit_code=${room.exitCode}`, ...tail(4)], false,
      ['Raise limits.memory_mb', 'Check what the agent was running in the last tool events']);
  }
  // Timeout/stall while the provider kept erroring and the agent never got a
  // single tool call through: the model side is the cause, not the agent.
  // (Seen in dogfood: OpenRouter 504 "stream error" + opencode retries every ~2 min.)
  if ((room.timedOut || room.idleKilled) && stats.toolCalls === 0) {
    const hits = providerHits(logText);
    if (hits.length) {
      const [category, sample] = hits[0];
      return fail(room.timedOut ? 'TIMED_OUT' : 'FAILED', category,
        `Model provider kept failing (${hits.length} errors); agent retried until ${room.timedOut ? 'timeout' : 'idle stall'} without a single tool call`,
        [`provider_errors=${hits.length}`, sample.slice(0, 500)], true,
        ['Switch model — this one is unavailable/overloaded right now', 'Failing fast on repeated provider errors is a runtime TODO']);
    }
  }
  if (room.timedOut) {
    return fail('TIMED_OUT', 'TIMEOUT', 'Run exceeded limits.timeout_s',
      [`duration_ms=${room.durationMs}`, `steps=${stats.steps}`, `tool_calls=${stats.toolCalls}`,
       `model_ms=${stats.timing.modelMs}`, `tool_ms=${stats.timing.toolMs}`, `open_step_ms=${stats.timing.openMs}`], true,
      [
        ...(stats.steps > 30 ? ['Agent made many steps — probably looping; inspect repeated tool calls'] : ['Raise limits.timeout_s or split the task']),
        ...(stats.timing.openMs > 0 ? ['open_step_ms: the last step never finished — a model call or a still-running command; check the last agent.tool and room.stderr'] : []),
      ]);
  }
  if (room.idleKilled) {
    return fail('FAILED', 'IDLE_STALL', 'No output from the agent for limits.idle_timeout_s — it hung',
      [`steps=${stats.steps}`, `last_step_reason=${stats.lastStepReason ?? '-'}`, ...tail(4)], true,
      ['Often a model call that never returns, or an interactive command waiting for stdin',
       'Look at the last agent.tool event: was it a long-running or interactive command?']);
  }

  // The agent CLI itself exited — look for provider/model errors first: with
  // free models these dominate and are not the agent's fault.
  for (const [re, category, retryable] of MODEL_ERROR_PATTERNS) {
    const hit = logText.split('\n').find(l => re.test(l));
    if (hit && (room.exitCode !== 0 || stats.steps === 0 || !stats.finalText)) {
      return fail('FAILED', category, `Model provider error (${category.toLowerCase().replace(/_/g, ' ')})`,
        [hit.slice(0, 500)], retryable,
        retryable ? ['Retry later or switch model'] : ['Fix model id / credentials in the request or secrets file']);
    }
  }

  if (room.exitCode !== 0) {
    const cmdMissing = room.exitCode === 126 || room.exitCode === 127;
    return fail('FAILED', cmdMissing ? 'AGENT_BINARY_MISSING' : 'AGENT_CRASHED',
      cmdMissing ? 'Agent command not found / not executable in the room image'
        : `Agent process exited with code ${room.exitCode}`,
      [`exit_code=${room.exitCode}`, ...tail()], !cmdMissing,
      cmdMissing ? ['Rebuild the room image'] : ['Read room/stderr.log for the stack trace']);
  }

  // "Nothing to hand over" checks apply to every real agent; only the deterministic
  // shell agent (tests) is exempt.
  if (f.agent !== 'shell') {
    if (stats.parsedLines === 0) {
      return fail('FAILED', 'AGENT_NO_OUTPUT', 'Agent exited cleanly but emitted no events',
        tail(), true, ['Usually a silent provider/config failure; rerun with --log-level DEBUG']);
    }
    if (!stats.finalText && stats.toolCalls === 0) {
      return fail('FAILED', 'AGENT_EMPTY_RESULT', 'Agent finished without a single tool call or answer',
        [`steps=${stats.steps}`, `last_step_reason=${stats.lastStepReason ?? '-'}`], true,
        ['Weak model or prompt misunderstanding — try a stronger model']);
    }
    if (stats.lastStepReason && stats.lastStepReason !== 'stop') {
      warnings.push(`last step ended with reason=${stats.lastStepReason}, not "stop" — the answer may be truncated`);
    }
  }

  if (f.exportError) {
    return fail('FAILED', 'EXPORT_FAILED', 'Agent succeeded but artifacts could not be exported', [f.exportError], true, []);
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
