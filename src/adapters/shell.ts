// Deterministic "agent": runs `task` as a shell script. Used by the failure-mode
// and isolation tests, where we need exact control over what happens in the room.
import type { AgentAdapter } from './index.ts';

export const shellAdapter: AgentAdapter = {
  name: 'shell',
  command: req => ['sh', '-c', req.task],
  env: () => ({}),
  parse(line, stats) {
    stats.parsedLines++;
    stats.finalText = line;          // last stdout line counts as the result
    return { type: 'stdout', data: { line: line.slice(0, 4000) } };
  },
};
