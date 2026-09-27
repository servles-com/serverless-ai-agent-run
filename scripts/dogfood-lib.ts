// Pure helpers of the dogfood loop (unit-tested in tests/unit/dogfood.test.ts).
import { describeError, QueueTimeoutError } from '../tests/lib/client.ts';

export interface RunView {
  id: string; state: string;
  result?: { text?: string; artifacts?: string[]; pull_request?: unknown };
  diagnosis?: { category: string; summary?: string };
}

// A client-side failure: the harness lost the run, not the runtime. Keeps the run id
// when it is known, so the issue gets a /debug bundle instead of `null` (#86).
// A run that never got a room in time is QUEUE_TIMEOUT: the queue, not the runtime.
export function harnessErrorRun(e: unknown): RunView {
  const cat = e instanceof QueueTimeoutError ? 'QUEUE_TIMEOUT' : 'HARNESS_ERROR';
  return { id: (e as { runId?: string })?.runId ?? '-', state: cat, diagnosis: { category: cat, summary: describeError(e) } };
}

// Since SB1 the runtime itself fails "done, but delivered nothing" (NO_DELIVERABLE /
// EXPECTATION_NOT_MET). SILENT_FAILURE is now only the case that check missed:
// SUCCEEDED with no final text, no artifact and no PR. A text-only answer to a task
// without `expect` (e.g. "vague") is a legitimate deliverable, not a silent failure (#7).
export function dogfoodCategory(run: RunView): string {
  const r = run.result;
  if (run.state === 'SUCCEEDED' && !r?.text?.trim() && !r?.artifacts?.length && !r?.pull_request) return 'SILENT_FAILURE';
  return run.diagnosis?.category ?? 'OK';
}
