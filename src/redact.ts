// Secret redaction (plan task G3).
//
// Every value the server knows to be a secret — provider keys and anything a run
// may request from the secret store (`config.secrets`) — is replaced with `***`
// before it can reach events.jsonl, the room's stdout/stderr logs or a webhook.
//
// Values are registered once at startup (config.ts) so no call site has to thread
// them through. Blank and very short values are ignored: replacing a 1-char
// "secret" would shred every log line.

export const PLACEHOLDER = '***';
const MIN_LENGTH = 4;

let active: string[] = [];

export function setSecrets(values: Iterable<string>): void {
  const seen = new Set<string>();
  for (const v of values) if (typeof v === 'string' && v.length >= MIN_LENGTH) seen.add(v);
  // Longest first so a secret that contains another is fully masked.
  active = [...seen].sort((a, b) => b.length - a.length);
}

// Values learned at runtime (credentials resolved for a run, see src/creds/broker.ts)
// are added on top of the startup set.
export function addSecrets(values: Iterable<string>): void {
  setSecrets([...active, ...values]);
}

export function redact(text: string): string {
  if (!text || active.length === 0) return text;
  let out = text;
  for (const s of active) out = out.split(s).join(PLACEHOLDER);
  return out;
}

// Deep-redact strings inside an object graph (event data, run records, ...).
export function scrub<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(scrub) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out as T;
  }
  return value;
}
