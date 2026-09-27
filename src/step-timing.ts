// Per-step timing from opencode JSON events.
//
// opencode brackets each model step with `step_start` / `step_finish` and emits
// a `tool_use` (with state.time.start/end) for every finished tool call. The
// difference between the two step timestamps is the step's wall time; tool
// execution is the sum of the tool durations inside it; the remainder is time
// spent waiting on the model. That decomposition is what tells a slow model
// apart from a slow command when a run times out.
//
// Pure and streaming-friendly: the adapter feeds events as they arrive, the
// runner closes a step left open by a timeout. Unit-tested against a recorded
// opencode stream.
export interface StepTiming {
  step: number;
  model_ms: number;
  tool_ms: number;
  total_ms: number;
}

export interface StepTimingState {
  modelMs: number;
  toolMs: number;
  stepTimings: StepTiming[];
  stepStart?: number;   // opencode timestamp of the step_start still open
  stepToolMs: number;   // tool time accumulated inside the open step
}

export function newStepTimingState(): StepTimingState {
  return { modelMs: 0, toolMs: 0, stepTimings: [], stepToolMs: 0 };
}

export function onStepStart(s: StepTimingState, timestamp: unknown): void {
  s.stepStart = num(timestamp);
  s.stepToolMs = 0;
}

export function onTool(s: StepTimingState, time: { start?: unknown; end?: unknown } | undefined): void {
  const start = num(time?.start);
  const end = num(time?.end);
  if (start !== undefined && end !== undefined) s.stepToolMs += Math.max(0, end - start);
}

export function onStepFinish(s: StepTimingState, timestamp: unknown): StepTiming | undefined {
  const end = num(timestamp);
  if (s.stepStart === undefined || end === undefined) {
    s.stepStart = undefined;
    s.stepToolMs = 0;
    return undefined;
  }
  return close(s, end);
}

// A step that never got its `step_finish` (timeout / crash / cancel): close it
// at the moment the room actually stopped, so even a TIMEOUT says whether the
// wall time went to the model or to a tool.
export function closeOpenStep(s: StepTimingState, endMs: number): StepTiming | undefined {
  if (s.stepStart === undefined) return undefined;
  return close(s, endMs);
}

function close(s: StepTimingState, end: number): StepTiming {
  const start = s.stepStart!;
  const total = Math.max(0, end - start);
  const toolMs = s.stepToolMs;
  const modelMs = Math.max(0, total - toolMs);
  const timing: StepTiming = { step: s.stepTimings.length + 1, model_ms: modelMs, tool_ms: toolMs, total_ms: total };
  s.stepTimings.push(timing);
  s.modelMs += modelMs;
  s.toolMs += toolMs;
  s.stepStart = undefined;
  s.stepToolMs = 0;
  return timing;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
