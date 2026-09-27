// What a run gets before its room starts: request validation, inputs written
// into the workspace (repo clone, files), and the room spec (env, secrets, limits).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, providerEnvValues } from './config.ts';
import { adapters } from './adapters/index.ts';
import { validateExpect } from './failures.ts';
import type { RoomSpec } from './rooms.ts';
import { emit, runDir, type RunRequest } from './store.ts';
import { hostClone, repoAllowed } from './pullrequest.ts';
import { symlinkOnPath } from './safe-files.ts';
import { validateDiskLimit } from './volume.ts';
import { validateCredentials } from './creds/handle.ts';
import { Broker, CredentialError, FileBackend, fileAudit } from './creds/broker.ts';

// One operator for now (config.owner); the broker still checks every handle against it.
let broker: Broker | undefined;
const getBroker = () => broker ??= new Broker(new FileBackend(config.credsDir), fileAudit(config.credentialAuditFile));

// Env-mode credentials of a run (level L2: the value is in the room's process env,
// never in the request, run.json or logs; it is registered for redaction). Throws
// CredentialError -> the run fails in PREPARING with CREDENTIAL_MISSING/REVOKED.
export function resolveCredentialEnv(id: string, req: RunRequest): Record<string, string> {
  if (!req.credentials?.length) return {};
  const env = getBroker().resolveEnv({ id, owner: config.owner }, req.credentials);
  emit(id, 'run.log', { msg: `credentials delivered as env: ${req.credentials.filter(c => c.as === 'env').map(c => `${c.ref} -> ${c.name}`).join(', ')}` });
  return env;
}
export { CredentialError };

const exec = promisify(execFile);

// Untrusted JSON body: fields are checked here before it is treated as a RunRequest.
interface RequestBody {
  agent?: string; task?: unknown; files?: Record<string, string>; secrets?: string[]; expect?: unknown;
  repo?: { url?: string; pull_request?: unknown }; webhook?: { url?: string }; live?: unknown; credentials?: unknown;
  limits?: { disk_mb?: unknown };
}

export function validateRequest(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return 'body must be a JSON object';
  const body = input as RequestBody;
  if (!adapters[body.agent ?? 'opencode']) return `unknown agent "${body.agent}" (known: ${Object.keys(adapters).join(', ')})`;
  if (typeof body.task !== 'string' || !body.task.trim()) return 'task (string) is required';
  if (body.files && typeof body.files !== 'object') return 'files must be an object {path: content}';
  for (const p of Object.keys(body.files ?? {})) if (!safeRelPath(p)) return `unsafe file path: ${p}`;
  if (body.repo && !/^https:\/\//.test(body.repo.url ?? '')) return 'repo.url must be an https URL';
  if (body.repo?.pull_request) {
    if (!config.githubPushToken) return 'pull_request is not enabled on this server (no SAR_GITHUB_PUSH_TOKEN)';
    if (!repoAllowed(body.repo.url!, config.prRepos)) return `pull_request not allowed for ${body.repo.url} (allowed: ${config.prRepos.join(', ') || 'none'})`;
  }
  if (body.credentials !== undefined) {
    const v = validateCredentials(body.credentials);
    if (!v.ok) return v.error;
    if (v.specs.some(s => s.as === 'proxy') && !config.gateway.host) {
      return 'credentials: as "proxy" needs the host gateway, which is not enabled on this server yet (use as "env")';
    }
  }
  if (body.live !== undefined && typeof body.live !== 'boolean') return 'live must be a boolean';
  if (body.webhook && !/^https?:\/\//.test(body.webhook.url ?? '')) return 'webhook.url must be an http(s) URL';
  for (const s of body.secrets ?? []) if (!(s in config.secrets)) return `unknown secret "${s}" (not in server secrets file)`;
  const diskErr = validateDiskLimit(body.limits?.disk_mb, config.defaults.diskMb > 0, config.maxDiskMb);
  if (diskErr) return diskErr;
  return validateExpect(body.expect, !!body.repo?.pull_request);
}

function safeRelPath(p: string): boolean {
  if (!p || isAbsolute(p) || p.includes('\0')) return false;
  const r = relative('/w', resolve('/w', p));
  return !!r && !r.startsWith('..');
}

export async function hydrate(id: string, req: RunRequest) {
  const ws = join(runDir(id), 'workspace');
  if (req.repo) {
    const token = req.secrets?.includes('GITHUB_TOKEN') ? config.secrets.GITHUB_TOKEN : undefined;
    const args = ['clone', '--depth', '50'];
    if (req.repo.ref) args.push('--branch', req.repo.ref);
    // Token goes in a header, not the URL, so it is not written to .git/config.
    const auth = token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
    await exec('git', [...auth, ...args, req.repo.url, ws], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    emit(id, 'run.log', { msg: `cloned ${req.repo.url}${req.repo.ref ? '@' + req.repo.ref : ''}` });
    if (req.repo.pull_request) {
      await hostClone(req.repo.url, req.repo.ref, join(runDir(id), 'host-repo'), config.githubPushToken);
      emit(id, 'run.log', { msg: 'host clone ready for pull request' });
    }
  }
  for (const [p, content] of Object.entries(req.files ?? {})) {
    const link = symlinkOnPath(ws, p);
    if (link) throw new Error(`input file ${p}: ${link} in the workspace is a symlink; refusing to write through it`);
    const full = join(ws, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  if (req.files) emit(id, 'run.log', { msg: `wrote ${Object.keys(req.files).length} input files` });
}

// Room spec for a run: adapter command, env (provider keys only for model agents,
// only the secrets the request named), limits with server defaults.
export function roomSpec(id: string, req: RunRequest, model: string, io: Pick<RoomSpec, 'onStdoutLine' | 'onStderrLine'>, credEnv: Record<string, string> = {}): RoomSpec {
  const adapter = adapters[req.agent ?? 'opencode'];
  const dir = runDir(id);
  const env: Record<string, string> = { ...adapter.env(req, model) };
  if (req.agent !== 'shell') Object.assign(env, providerEnvValues());
  for (const s of req.secrets ?? []) env[s] = config.secrets[s];
  Object.assign(env, credEnv);
  const limits = {
    timeoutS: req.limits?.timeout_s ?? config.defaults.timeoutS,
    idleTimeoutS: req.limits?.idle_timeout_s ?? config.defaults.idleTimeoutS,
    memoryMb: req.limits?.memory_mb ?? config.defaults.memoryMb,
    cpus: req.limits?.cpus ?? config.defaults.cpus,
    pids: req.limits?.pids ?? config.defaults.pids,
  };
  return {
    runId: id,
    workspaceDir: join(dir, 'workspace'),
    artifactsDir: join(dir, 'artifacts'),
    logDir: join(dir, 'room'),
    command: adapter.command(req, model),
    env, limits,
    ...io,
  };
}
