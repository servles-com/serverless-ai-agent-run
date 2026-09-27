// OpenCode adapter: `opencode run --format json` prints one JSON event per line:
//   step_start | tool_use | text | step_finish | error
import type { AgentAdapter } from './index.ts';
import { onStepStart, onStepFinish, onTool } from '../step-timing.ts';

const SYSTEM_HINT = [
  'You are running unattended inside an isolated, disposable sandbox.',
  'Your working directory is /workspace. Put final deliverables into /artifacts.',
  'Nobody will answer questions: make reasonable assumptions and finish the task.',
].join(' ');

export const opencodeAdapter: AgentAdapter = {
  name: 'opencode',
  command: (req, model) => [
    'opencode', 'run', '--pure', '--auto', '--format', 'json', '--print-logs', '--log-level', 'WARN',
    '-m', model, `${SYSTEM_HINT}\n\nTASK:\n${req.task}`,
  ],
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

function truncateJson(v: unknown, max: number): unknown {
  const s = JSON.stringify(v);
  return s && s.length > max ? s.slice(0, max) + '…' : v;
}
