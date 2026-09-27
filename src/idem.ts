// Idempotency-Key (SB11) for POST /runs and /batches (later: trigger delivery ids).
// One file per key: <dir>/<sha256(scope, key)> holding the id it created and a
// fingerprint of the request body. Created via write-to-temp + link(): link fails
// with EEXIST if the key is already claimed (also across processes) and a reader
// never sees a half-written record. Records live as long as runs (SAR_RETENTION_HOURS).
//
// Calls are synchronous on purpose: within one Node process a claim cannot
// interleave with another request's claim for the same key.
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IdemRecord {
  scope: string;
  id: string;
  fingerprint: string;
  created_at: string;
}

export type Claim =
  | { status: 'created'; record: IdemRecord }   // first use: go ahead and create `id`
  | { status: 'replay'; record: IdemRecord }    // same key, same body: return record.id
  | { status: 'conflict'; record: IdemRecord }; // same key, different body: 422

export const MAX_KEY_LENGTH = 255;

// Visible ASCII only, so a key is safe in logs and headers.
export function validateKey(key: unknown): string | undefined {
  if (typeof key !== 'string' || !key.length) return 'Idempotency-Key must be a non-empty string';
  if (key.length > MAX_KEY_LENGTH) return `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`;
  if (!/^[\x21-\x7e]+$/.test(key)) return 'Idempotency-Key must be visible ASCII (no spaces or control characters)';
  return undefined;
}

// Key order does not matter: {"a":1,"b":2} and {"b":2,"a":1} are the same request.
export function fingerprint(body: unknown): string {
  return createHash('sha256').update(canonical(body)).digest('hex');
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const idemFile = (dir: string, scope: string, key: string): string =>
  join(dir, createHash('sha256').update(`${scope}\0${key}`).digest('hex'));

export interface ClaimInput { scope: string; key: string; id: string; fingerprint: string }

export function claim(dir: string, input: ClaimInput, ttlMs: number, now = Date.now()): Claim {
  mkdirSync(dir, { recursive: true });
  const file = idemFile(dir, input.scope, input.key);
  const record: IdemRecord = { scope: input.scope, id: input.id, fingerprint: input.fingerprint, created_at: new Date(now).toISOString() };
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify(record) + '\n');
  try {
    // Second attempt only after dropping an expired or unreadable record.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, file);
        return { status: 'created', record };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const existing = read(file);
      if (existing && !expired(existing, ttlMs, now)) {
        return { status: existing.fingerprint === input.fingerprint ? 'replay' : 'conflict', record: existing };
      }
      unlinkQuiet(file);
    }
    throw new Error(`idempotency record ${file} keeps reappearing`);
  } finally {
    unlinkQuiet(tmp);
  }
}

// Drop records older than ttl and temp files left by a crash; returns how many were removed.
export function gcIdem(dir: string, ttlMs: number, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const file = join(dir, name);
    const rec = name.startsWith('.tmp-') ? undefined : read(file);
    const old = rec ? expired(rec, ttlMs, now) : mtimeOf(file) < now - ttlMs;
    if (old && unlinkQuiet(file)) removed++;
  }
  return removed;
}

function read(file: string): IdemRecord | undefined {
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    return typeof rec?.id === 'string' && typeof rec?.fingerprint === 'string' && typeof rec?.created_at === 'string' ? rec : undefined;
  } catch {
    return undefined;
  }
}

const expired = (rec: IdemRecord, ttlMs: number, now: number): boolean => {
  const t = Date.parse(rec.created_at);
  return !Number.isFinite(t) || t <= now - ttlMs;
};

function mtimeOf(file: string): number {
  try { return statSync(file).mtimeMs; } catch { return Infinity; }
}

function unlinkQuiet(file: string): boolean {
  try { unlinkSync(file); return true; } catch { return false; }
}
