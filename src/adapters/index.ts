// Agent adapters: how a specific agent CLI is invoked inside a prepared room
// and how its output stream is turned into structured events.
import type { RunRequest } from '../store.ts';
import { newStepTimingState, type StepTimingState } from '../step-timing.ts';
import { opencodeAdapter } from './opencode.ts';
import { shellAdapter } from './shell.ts';

export interface AgentStats {
  steps: number;
  toolCalls: number;
  toolErrors: number;
  tokens: number;
  finalText?: string;
  lastStepReason?: string;
  agentErrors: string[];   // errors the agent CLI itself reported (model/provider/tool infra)
  parsedLines: number;
  unparsedLines: number;
  timing: StepTimingState; // model wait vs tool execution, see src/step-timing.ts
}

export interface ParsedLine {
  type: string;                        // becomes `agent.<type>` event
  data: Record<string, unknown>;
}

export interface AgentAdapter {
  name: string;
  command(req: RunRequest, model: string): string[];
  env(req: RunRequest, model: string): Record<string, string>;
  parse(line: string, stats: AgentStats): ParsedLine | undefined;
}

export const adapters: Record<string, AgentAdapter> = {
  opencode: opencodeAdapter,
  shell: shellAdapter,
};

export function emptyStats(): AgentStats {
  return { steps: 0, toolCalls: 0, toolErrors: 0, tokens: 0, agentErrors: [], parsedLines: 0, unparsedLines: 0, timing: newStepTimingState() };
}
