// Host gateway: the one door from rooms to the host (K9 #92, base for K4 #48,
// T1 #99, SB7). One listener on the sar0 address; every request carries the
// run's token; routes are /<service>/…
// Design: docs/host-gateway-and-credential-refs-design.md
//
// Built-in service `proxy`: /proxy/<host>/<path> -> https://<host>/<path> with the
// run's credential for that host put into a header. The room holds only its run
// token; the value lives on the host and is cut out of responses and logs.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { PLACEHOLDER, redact } from './redact.ts';
import { CredentialError, type Broker, type CredentialErrorCode } from './creds/broker.ts';
import type { CredentialSpec } from './creds/handle.ts';

export interface RunGrant { runId: string; owner: string; credentials: CredentialSpec[] }

// Run tokens live only in this process, keyed by their sha256: nothing on disk,
// and a map lookup by hash does not leak token bytes through timing.
export class RunTokens {
  private byHash = new Map<string, RunGrant>();
  private hashByRun = new Map<string, string>();

  issue(grant: RunGrant): string {
    this.revoke(grant.runId);
    const token = randomBytes(32).toString('base64url');
    const h = sha256(token);
    this.byHash.set(h, grant);
    this.hashByRun.set(grant.runId, h);
    return token;
  }

  revoke(runId: string): void {
    const h = this.hashByRun.get(runId);
    if (h) this.byHash.delete(h);
    this.hashByRun.delete(runId);
  }

  lookup(token: string | undefined): RunGrant | undefined {
    return token ? this.byHash.get(sha256(token)) : undefined;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Bearer (most CLIs with a base URL), Basic password (git over HTTPS) or an explicit header.
export function extractRunToken(headers: IncomingMessage['headers']): string | undefined {
  const explicit = headers['x-sar-run-token'];
  if (typeof explicit === 'string' && explicit) return explicit;
  const auth = headers.authorization ?? '';
  const bearer = auth.match(/^Bearer\s+(\S+)$/i);
  if (bearer) return bearer[1];
  const basic = auth.match(/^Basic\s+(\S+)$/i);
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return i >= 0 ? decoded.slice(i + 1) || undefined : undefined;
  }
  return undefined;
}

// The gateway runs in the host's network namespace, so it has to enforce what the
// room's egress policy would: no loopback, private, link-local (metadata), CGNAT,
// multicast or reserved destinations.
export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && ip.startsWith('192.0.0.'))))
      || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('::ffff:');
  }
  return true;
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0);
    const bad = addresses.find(a => isBlockedAddress(a.address));
    if (bad || !addresses.length) return callback(Object.assign(new Error(`blocked address for ${hostname}`), { code: 'UPSTREAM_BLOCKED' }), '', 0);
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

// Streaming replace of one secret, safe across chunk boundaries.
export function redactingStream(secret: string): Transform {
  const needle = Buffer.from(secret);
  const rep = Buffer.from(PLACEHOLDER);
  let carry = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      let buf = Buffer.concat([carry, chunk]);
      const out: Buffer[] = [];
      for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle)) {
        out.push(buf.subarray(0, i), rep);
        buf = buf.subarray(i + needle.length);
      }
      const keep = Math.min(buf.length, needle.length - 1);
      out.push(buf.subarray(0, buf.length - keep));
      carry = Buffer.from(buf.subarray(buf.length - keep));
      cb(null, Buffer.concat(out));
    },
    flush(cb) { cb(null, carry); },
  });
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-sar-run-token', 'accept-encoding']);

export interface ServiceContext { runId: string; owner: string; grant: RunGrant; rest: string }
export type Service = (req: IncomingMessage, res: ServerResponse, ctx: ServiceContext) => void | Promise<void>;

export interface GatewayOptions {
  tokens: RunTokens;
  broker: Broker;
  services?: Record<string, Service>;   // T1 (`ta`), SB7 (`llm`) register here
  log?: (line: string) => void;          // every line goes through redact()
  // Tests only: where to connect for a granted host, and whether private
  // destinations are allowed (a local fake upstream is on 127.0.0.1).
  connect?: (host: string) => { protocol: 'http:' | 'https:'; hostname: string; port?: number };
  allowPrivateUpstream?: boolean;
  upstreamTimeoutMs?: number;
}

export interface Gateway {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  // Credential errors seen during a run, for Facts.credentialErrors. Clears them.
  takeErrors: (runId: string) => { code: CredentialErrorCode; ref: string }[];
}

export function createGateway(opts: GatewayOptions): Gateway {
  const log = (line: string) => (opts.log ?? console.log)(redact(line));
  const errors = new Map<string, { code: CredentialErrorCode; ref: string }[]>();

  const reply = (res: ServerResponse, status: number, error: string, message: string) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error, message: redact(message) }));
  };

  const proxy: Service = (req, res, ctx) => {
    const slash = ctx.rest.indexOf('/');
    const host = (slash === -1 ? ctx.rest : ctx.rest.slice(0, slash)).split('?')[0];
    const path = slash === -1 ? '/' : ctx.rest.slice(slash);
    const spec = ctx.grant.credentials.find(c => c.as === 'proxy' && c.hosts?.includes(host));
    if (!spec) return reply(res, 403, 'host_not_granted', `host "${host}" is not in this run's proxy credentials`);

    let cred;
    try { cred = opts.broker.resolve({ id: ctx.runId, owner: ctx.owner }, spec, host); } catch (e) {
      if (!(e instanceof CredentialError)) throw e;
      const list = errors.get(ctx.runId) ?? [];
      if (!list.some(x => x.code === e.code && x.ref === e.ref)) list.push({ code: e.code, ref: e.ref });
      errors.set(ctx.runId, list);
      return reply(res, e.code === 'CREDENTIAL_REVOKED' ? 403 : 404, e.code.toLowerCase(), e.message);
    }

    const target = opts.connect?.(host) ?? { protocol: 'https:' as const, hostname: host };
    if (!opts.allowPrivateUpstream && isIP(target.hostname) && isBlockedAddress(target.hostname)) {
      return reply(res, 502, 'upstream_blocked', `upstream for "${host}" resolves to a blocked address`);
    }
    const headers: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
    headers[cred.header] = cred.scheme ? `${cred.scheme} ${cred.value}` : cred.value;
    headers['accept-encoding'] = 'identity';   // the body must stay readable for redaction
    headers.host = host;

    const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const up = send({
      protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path, headers,
      servername: target.protocol === 'https:' ? host : undefined,
      lookup: opts.allowPrivateUpstream ? undefined : guardedLookup,
      timeout: opts.upstreamTimeoutMs ?? 300_000,
    }, upRes => {
      const out: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (HOP_BY_HOP.has(k) || k === 'content-length' || v === undefined) continue;
        out[k] = Array.isArray(v) ? v.map(s => s.split(cred.value).join(PLACEHOLDER)) : v.split(cred.value).join(PLACEHOLDER);
      }
      res.writeHead(upRes.statusCode ?? 502, out);   // 3xx passed through: never follow a redirect with the header
      upRes.pipe(redactingStream(cred.value)).pipe(res);
      log(`gateway run=${ctx.runId} service=proxy host=${host} ${req.method} status=${upRes.statusCode}`);
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', (e: NodeJS.ErrnoException) => {
      const blocked = e.code === 'UPSTREAM_BLOCKED';
      log(`gateway run=${ctx.runId} service=proxy host=${host} error=${blocked ? 'upstream_blocked' : e.message}`);
      reply(res, 502, blocked ? 'upstream_blocked' : 'upstream_error', blocked ? `upstream for "${host}" resolves to a blocked address` : e.message);
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  };

  const services: Record<string, Service> = { proxy, ...opts.services };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const grant = opts.tokens.lookup(extractRunToken(req.headers));
    if (!grant) return reply(res, 401, 'unauthorized', 'a valid run token is required');
    const url = req.url ?? '/';
    const m = url.match(/^\/([a-z0-9-]+)(?:\/(.*))?$/s);
    const service = m ? services[m[1]] : undefined;
    if (!m || !service || !Object.hasOwn(services, m[1])) return reply(res, 404, 'unknown_service', `no gateway service at ${url.split('?')[0].slice(0, 100)}`);
    Promise.resolve(service(req, res, { runId: grant.runId, owner: grant.owner, grant, rest: m[2] ?? '' }))
      .catch((e: Error) => {
        log(`gateway run=${grant.runId} service=${m[1]} error=${e.message}`);
        reply(res, 500, 'gateway_error', 'internal gateway error');
      });
  };

  return {
    handle: (req, res) => {
      try { handle(req, res); } catch (e) {
        log(`gateway error=${(e as Error).message}`);
        reply(res, 500, 'gateway_error', 'internal gateway error');
      }
    },
    takeErrors: runId => { const l = errors.get(runId) ?? []; errors.delete(runId); return l; },
  };
}

export function startGateway(opts: GatewayOptions & { host: string; port: number }): Promise<{ server: Server; gateway: Gateway }> {
  const gateway = createGateway(opts);
  const server = createServer(gateway.handle);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve({ server, gateway }));
  });
}
