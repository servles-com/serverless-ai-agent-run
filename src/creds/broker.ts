// Credential broker (K2 #46, K9 #92): resolves handles for a run, only inside the
// run owner's namespace, and writes one audit line per attempt. Values never go
// to the audit log, errors or return paths other than the explicit `value`.
// Design: docs/host-gateway-and-credential-refs-design.md
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { addSecrets } from '../redact.ts';
import { isValidOwner, parseHandle, type CredentialSpec, type DeliveryMode } from './handle.ts';

export interface Credential {
  value: string;
  header: string;    // lower-case header name the gateway sets, default "authorization"
  scheme: string;    // prefix before the value, default "Bearer"; "" = raw value
}

export type CredentialErrorCode = 'CREDENTIAL_MISSING' | 'CREDENTIAL_REVOKED';

export class CredentialError extends Error {
  code: CredentialErrorCode;
  ref: string;
  constructor(code: CredentialErrorCode, ref: string, detail: string) {
    super(`${code}: ${ref}: ${detail}`);
    this.code = code;
    this.ref = ref;
  }
}

// A backend reads one credential from one owner's namespace. `undefined` = not found.
export interface CredentialBackend {
  read(owner: string, name: string): (Credential & { revoked?: boolean }) | undefined;
}

// File backend: <root>/users/<owner>/<name>.json =
//   {"value": "...", "header"?: "authorization", "scheme"?: "Bearer", "revoked"?: true}
// Owner and name are validated segments; the real path must stay inside the
// owner's directory, so a symlink out of it reads as "not found".
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export class FileBackend implements CredentialBackend {
  root: string;
  constructor(root: string) { this.root = root; }

  read(owner: string, name: string): (Credential & { revoked?: boolean }) | undefined {
    const dir = join(this.root, 'users', owner);
    let real: string;
    try {
      real = realpathSync(join(dir, `${name}.json`));
      if (!real.startsWith(realpathSync(dir) + sep)) return undefined;
    } catch { return undefined; }
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(real, 'utf8')); } catch { return undefined; }
    if (!raw || typeof raw !== 'object') return undefined;
    const x = raw as Record<string, unknown>;
    if (typeof x.value !== 'string' || !x.value || /[\r\n]/.test(x.value)) return undefined;
    if (x.header !== undefined && (typeof x.header !== 'string' || !HEADER_NAME.test(x.header) || /^(host|content-length|transfer-encoding|connection)$/i.test(x.header))) return undefined;
    return {
      value: x.value,
      header: typeof x.header === 'string' ? x.header.toLowerCase() : 'authorization',
      scheme: typeof x.scheme === 'string' ? x.scheme : 'Bearer',
      revoked: x.revoked === true,
    };
  }
}

export interface AccessRecord {
  ts: string;
  run_id: string;
  owner: string;
  ref: string;
  as: DeliveryMode;
  host?: string;
  outcome: 'granted' | 'missing' | 'revoked';
}

export type AuditSink = (r: AccessRecord) => void;

// credential-access.jsonl: one line per delivery attempt, never the value.
export function fileAudit(path: string): AuditSink {
  mkdirSync(dirname(path), { recursive: true });
  return r => appendFileSync(path, JSON.stringify(r) + '\n', { mode: 0o600 });
}

export class Broker {
  backend: CredentialBackend;
  audit: AuditSink;
  constructor(backend: CredentialBackend, audit: AuditSink) {
    this.backend = backend;
    this.audit = audit;
  }

  // Resolve one handle for a run. A handle naming another owner is answered
  // exactly like a missing credential, without touching the backend: the caller
  // must not learn whether someone else's credential exists.
  resolve(run: { id: string; owner: string }, spec: Pick<CredentialSpec, 'ref' | 'as'>, host?: string): Credential {
    const h = parseHandle(spec.ref);
    const record = (outcome: AccessRecord['outcome']) => this.audit({
      ts: new Date().toISOString(), run_id: run.id, owner: run.owner, ref: spec.ref, as: spec.as,
      ...(host ? { host } : {}), outcome,
    });
    const found = h && isValidOwner(run.owner) && (h.owner ?? run.owner) === run.owner
      ? this.backend.read(run.owner, h.name) : undefined;
    if (!found) {
      record('missing');
      throw new CredentialError('CREDENTIAL_MISSING', spec.ref, 'not found in the run owner\'s namespace');
    }
    if (found.revoked) {
      record('revoked');
      throw new CredentialError('CREDENTIAL_REVOKED', spec.ref, 'revoked by its owner');
    }
    // Registered before anything can log it: gateway errors, room output, webhooks.
    addSecrets([found.value]);
    record('granted');
    return { value: found.value, header: found.header, scheme: found.scheme };
  }

  // All env-mode grants of a run -> variables for the room. Throws on the first
  // missing/revoked credential (the run fails in PREPARING, see credentialVerdict).
  resolveEnv(run: { id: string; owner: string }, specs: CredentialSpec[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const s of specs) if (s.as === 'env' && s.name) env[s.name] = this.resolve(run, s).value;
    return env;
  }
}
