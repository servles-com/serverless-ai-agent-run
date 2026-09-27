// Credential handles and the `credentials` field of POST /runs (K9 #92).
// Pure functions only: a malformed request fails with 400 before any room starts.
// Design: docs/host-gateway-and-credential-refs-design.md
//
// A handle is not a secret: `cred:<owner>/<name>` or `cred:<name>` (the caller's
// own namespace). It may appear in prompts, logs and LLM context.

export type DeliveryMode = 'env' | 'proxy';

export interface CredentialSpec {
  ref: string;       // cred:<owner>/<name> | cred:<name>
  as: DeliveryMode;
  hosts?: string[];  // proxy: upstream hosts this credential may be sent to
  name?: string;     // env: variable with the value; proxy: variable with the run token (for base-URL tools)
}

export interface Handle { owner?: string; name: string }

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Env names a credential must never overwrite: the room's own plumbing and the
// provider keys the host injects.
const RESERVED_ENV = /^(PATH|HOME|USER|SHELL|PWD|LANG|TERM|HOSTNAME|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|OPENROUTER_API_KEY|SAR_.*)$/;
const RESERVED_HOST_SUFFIX = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;

export const MAX_CREDENTIALS = 16;
export const MAX_HOSTS = 8;
const MODES: DeliveryMode[] = ['env', 'proxy'];
const LATER_MODES = ['ssh', 'browser-fill'];

const validSegment = (s: string) => SEGMENT.test(s) && !s.includes('..');

// "cred:<owner>/<name>" | "cred:<name>" -> Handle, or undefined if malformed.
export function parseHandle(ref: unknown): Handle | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('cred:')) return undefined;
  const parts = ref.slice('cred:'.length).split('/');
  if (parts.length === 1 && validSegment(parts[0])) return { name: parts[0] };
  if (parts.length === 2 && validSegment(parts[0]) && validSegment(parts[1])) return { owner: parts[0], name: parts[1] };
  return undefined;
}

export function isValidOwner(owner: string): boolean {
  return validSegment(owner);
}

// Proxy hosts are public DNS names only: the gateway runs in the host's network,
// so an IP literal or an internal name would be a way around the room's egress policy.
export function validateHost(h: unknown): string | undefined {
  if (typeof h !== 'string' || !h) return 'must be a non-empty string';
  if (h !== h.toLowerCase()) return 'must be lower-case';
  if (/[/:@?#\s*]/.test(h)) return 'must be a bare host name (no scheme, port, path or wildcard)';
  if (/^[0-9.]+$/.test(h)) return 'IP literals are not allowed, use a DNS name';
  if (RESERVED_HOST_SUFFIX.test(h)) return 'internal host names are not allowed';
  if (!HOSTNAME.test(h)) return 'is not a valid public host name';
  return undefined;
}

export type Validation = { ok: true; specs: CredentialSpec[] } | { ok: false; error: string };

export function validateCredentials(input: unknown): Validation {
  const err = (error: string): Validation => ({ ok: false, error });
  if (input === undefined) return { ok: true, specs: [] };
  if (!Array.isArray(input)) return err('credentials must be an array');
  if (input.length > MAX_CREDENTIALS) return err(`credentials: at most ${MAX_CREDENTIALS} entries`);
  const specs: CredentialSpec[] = [];
  const envNames = new Set<string>();
  const hostOwner = new Map<string, number>();
  for (const [i, raw] of input.entries()) {
    const at = `credentials[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return err(`${at} must be an object`);
    const x = raw as Record<string, unknown>;
    const extra = Object.keys(x).filter(k => !['ref', 'as', 'hosts', 'name'].includes(k));
    if (extra.length) return err(`${at}: unknown field(s): ${extra.join(', ')} (known: ref, as, hosts, name)`);
    if (!parseHandle(x.ref)) return err(`${at}.ref must be cred:<owner>/<name> or cred:<name> ([a-z0-9._-], max 64)`);
    if (typeof x.as === 'string' && LATER_MODES.includes(x.as)) return err(`${at}.as="${x.as}" is not supported yet (supported: ${MODES.join(', ')})`);
    if (!MODES.includes(x.as as DeliveryMode)) return err(`${at}.as must be one of: ${MODES.join(', ')}`);
    const as = x.as as DeliveryMode;
    if (x.name !== undefined) {
      if (typeof x.name !== 'string' || !ENV_NAME.test(x.name)) return err(`${at}.name must be an env variable name ([A-Z_][A-Z0-9_]*)`);
      if (RESERVED_ENV.test(x.name)) return err(`${at}.name "${x.name}" is reserved`);
      if (envNames.has(x.name)) return err(`${at}.name "${x.name}" is used twice`);
      envNames.add(x.name);
    }
    const spec: CredentialSpec = { ref: x.ref as string, as };
    if (x.name !== undefined) spec.name = x.name as string;
    if (as === 'env') {
      if (x.name === undefined) return err(`${at}: as=env needs name (the variable to put the value in)`);
      if (x.hosts !== undefined) return err(`${at}: hosts only applies to as=proxy`);
    } else {
      if (!Array.isArray(x.hosts) || x.hosts.length === 0) return err(`${at}: as=proxy needs a non-empty hosts list`);
      if (x.hosts.length > MAX_HOSTS) return err(`${at}.hosts: at most ${MAX_HOSTS} hosts`);
      for (const h of x.hosts) {
        const bad = validateHost(h);
        if (bad) return err(`${at}.hosts: ${JSON.stringify(h)} ${bad}`);
        const prev = hostOwner.get(h as string);
        if (prev !== undefined) return err(`${at}.hosts: "${h}" is already granted by credentials[${prev}] — one credential per host`);
        hostOwner.set(h as string, i);
      }
      spec.hosts = [...x.hosts as string[]];
    }
    specs.push(spec);
  }
  return { ok: true, specs };
}
