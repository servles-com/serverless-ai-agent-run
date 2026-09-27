// OpenCode adapter: `opencode run --format json` prints one JSON event per line:
//   step_start | tool_use | text | step_finish | error
import { readFileSync } from 'node:fs';
import type { AgentAdapter, ParsedLine } from './index.ts';
import { onStepStart, onStepFinish, onTool } from '../step-timing.ts';

// Live mode (`live: true`, G11): the room runs this wrapper instead of plain
// `opencode run`; it adds `sar_live` lines (text deltas, tool start and output as it
// happens). Passed via `node -e`, so the room image needs no change.
const LIVE_WRAPPER = readFileSync(new URL('./opencode-live.mjs', import.meta.url), 'utf8');
const LIVE_PORT = '4096';

const SYSTEM_HINT = [
  'You are running unattended inside an isolated, disposable sandbox.',
  'Your working directory is /workspace. Put final deliverables into /artifacts.',
  'Nobody will answer questions: make reasonable assumptions and finish the task.',
].join(' ');

export const opencodeAdapter: AgentAdapter = {
  name: 'opencode',
  command: (req, model) => {
    const args = ['--auto', '--format', 'json', '--print-logs', '--log-level', 'WARN', '-m', model, `${SYSTEM_HINT}\n\nTASK:\n${req.task}`];
    return req.live
      ? ['node', '--input-type=module', '-e', LIVE_WRAPPER, LIVE_PORT, ...args]
      : ['opencode', 'run', '--pure', ...args];
  },
  env: () => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled' }),
  }),
  parse(line, stats) {
    let ev: any;
    try { ev = JSON.parse(line); } catch {
      stats.unparsedLines++;
      return { type: 'stdout', data: { line: line.slice(0, 4000) } };
    }
    stats.parsedLines++;
    const part = ev.part ?? {};
    switch (ev.type) {
      case 'sar_live': return parseLive(ev);
      case 'step_start':
        stats.steps++;
        onStepStart(stats.timing, ev.timestamp);
        return { type: 'step_start', data: { step: stats.steps } };
      case 'step_finish':
        stats.lastStepReason = part.reason;
        stats.tokens += part.tokens?.total ?? 0;
        onStepFinish(stats.timing, ev.timestamp);
        return { type: 'step_finish', data: { reason: part.reason, tokens: part.tokens?.total, cost: part.cost } };
      case 'text':
        if (part.text) stats.finalText = part.text;
        return { type: 'text', data: { text: String(part.text ?? '').slice(0, 8000) } };
      case 'tool_use': {
        stats.toolCalls++;
        const status = part.state?.status;
        if (status === 'error') stats.toolErrors++;
        onTool(stats.timing, part.state?.time);
        return { type: 'tool', data: {
          tool: part.tool, status,
          input: truncateJson(part.state?.input, 1500),
          output: String(part.state?.output ?? part.state?.error ?? '').slice(0, 1500),
        } };
      }
      case 'error': {
        const msg = JSON.stringify(ev.error ?? ev).slice(0, 2000);
        stats.agentErrors.push(msg);
        return { type: 'error', data: { error: ev.error ?? ev } };
      }
      default:
        return { type: String(ev.type ?? 'unknown'), data: { raw: truncateJson(ev, 2000) } };
    }
  },
};

function parseLive(ev: Record<string, unknown>): ParsedLine | undefined {
  switch (ev.ev) {
    case 'text_delta': return { type: 'text.delta', data: { part: ev.part, kind: ev.kind, delta: String(ev.delta ?? '').slice(0, 8000) } };
    case 'tool_start': return { type: 'tool.start', data: { call: ev.call, tool: ev.tool, input: truncateJson(ev.input, 1500) } };
    case 'tool_output': return { type: 'tool.output', data: { call: ev.call, output: String(ev.output ?? '').slice(-2000) } };
    default: return undefined;
  }
}

function truncateJson(v: unknown, max: number): unknown {
  const s = JSON.stringify(v);
  return s && s.length > max ? s.slice(0, max) + '…' : v;
}
