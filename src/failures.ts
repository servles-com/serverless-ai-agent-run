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
      [`duration_ms=${room.durationMs}`, `steps=${stats.steps}`, `tool_calls=${stats.toolCalls}`], true,
      stats.steps > 30 ? ['Agent made many steps — probably looping; inspect repeated tool calls'] : ['Raise limits.timeout_s or split the task']);
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

  if (f.agent === 'opencode') {
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
