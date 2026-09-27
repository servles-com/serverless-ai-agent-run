import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setSecrets } from './redact.ts';

function num(name: string, def: number): number {
  const v = process.env[name];
  return v ? Number(v) : def;
}

// Server-side secret store for V0: a dotenv-style file. A run may request
// secrets by name; only requested names are injected into its room.
function loadSecrets(file: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!file || !existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export const config = {
  port: num('SAR_PORT', 8787),
  host: process.env.SAR_HOST ?? '127.0.0.1',
  apiToken: process.env.SAR_API_TOKEN ?? '',
  insecureDev: process.env.SAR_INSECURE_DEV === '1',
  dataDir: resolve(process.env.SAR_DATA_DIR ?? 'runtime-data'),
  maxRooms: num('SAR_MAX_ROOMS', 1),
  // Rooms are labelled with the instance that owns them, so a second instance on the
  // same machine (the CI candidate, C3) never reaps or counts the main service's rooms.
  instance: process.env.SAR_INSTANCE ?? 'main',

  // Room runtime
  docker: process.env.SAR_DOCKER_BIN ?? 'docker',
  roomImage: process.env.SAR_ROOM_IMAGE ?? 'sar-room-opencode:latest',
  // "runsc" on the lab VM (gVisor); empty = default runc (e.g. local Docker Desktop).
  roomRuntime: process.env.SAR_ROOM_RUNTIME ?? '',
  roomNetwork: process.env.SAR_ROOM_NETWORK ?? 'sar-rooms',
  // Resolvers written into the room's /etc/resolv.conf (see rooms.ts).
  roomDns: (process.env.SAR_ROOM_DNS ?? '1.1.1.1,8.8.8.8').split(',').filter(Boolean),
  // Rooms run as the service uid by default so bind-mounted workspaces stay writable.
  roomUser: process.env.SAR_ROOM_USER ?? `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,

  defaults: {
    timeoutS: num('SAR_DEFAULT_TIMEOUT_S', 900),
    idleTimeoutS: num('SAR_DEFAULT_IDLE_TIMEOUT_S', 240),
    memoryMb: num('SAR_DEFAULT_MEMORY_MB', 1024),
    // Per-run disk quota for /workspace + /artifacts (src/volume.ts). 0 = off (local dev).
    diskMb: num('SAR_DEFAULT_DISK_MB', 0),
    cpus: num('SAR_DEFAULT_CPUS', 1),
    pids: num('SAR_DEFAULT_PIDS', 512),
    // The owner's LLM ladder (Go → Zen/OpenRouter free → cheap paid); see adapters/opencode.ts.
    model: process.env.SAR_DEFAULT_MODEL ?? 'ladder/free',
  },

  // Env vars always passed to opencode rooms (model provider keys).
  providerEnv: ['LLM_LADDER_TOKEN', 'OPENROUTER_API_KEY'],
  secrets: loadSecrets(process.env.SAR_SECRETS_FILE),

  // Fail fast after this many provider errors in a row without agent progress (0 = off).
  failFastProviderErrors: num('SAR_FAILFAST_PROVIDER_ERRORS', 3),

  // Host-side PRs: token used only by the host (never passed to rooms) and the
  // repos it may push to ("owner/repo", comma-separated).
  githubPushToken: process.env.SAR_GITHUB_PUSH_TOKEN ?? '',
  prRepos: (process.env.SAR_PR_REPOS ?? '').split(',').map(s => s.trim()).filter(Boolean),

  // Credential references and the host gateway (K9 #92). Not wired into runs yet:
  // see docs/host-gateway-and-credential-refs-design.md. One operator for now,
  // so every run belongs to SAR_OWNER.
  owner: process.env.SAR_OWNER ?? 'operator',
  credsDir: resolve(process.env.SAR_CREDS_DIR ?? join(process.env.SAR_DATA_DIR ?? 'runtime-data', 'creds')),
  credentialAuditFile: resolve(process.env.SAR_CREDENTIAL_AUDIT ?? join(process.env.SAR_DATA_DIR ?? 'runtime-data', 'credential-access.jsonl')),
  // Empty host = gateway off. On the machine: the sar0 bridge address.
  gateway: { host: process.env.SAR_GATEWAY_HOST ?? '', port: num('SAR_GATEWAY_PORT', 8788) },

  // How long finished run dirs are kept for debugging.
  retentionHours: num('SAR_RETENTION_HOURS', 72),
  // SSE keep-alive comment interval for /runs/:id/stream (src/stream.ts).
  streamHeartbeatS: num('SAR_STREAM_HEARTBEAT_S', 15),

  maxDiskMb: num('SAR_MAX_DISK_MB', 8192),
  volumeHelper: process.env.SAR_VOLUME_HELPER ?? '/usr/local/sbin/sar-run-volume',
  // Cap on each room log file (stdout.log, stderr.log) and on streamed output events per run.
  roomLogMaxBytes: num('SAR_ROOM_LOG_MAX_MB', 20) * 1024 * 1024,
};

// Register every known secret value for redaction before it can reach events,
// logs or webhooks. Covers the secret store and provider keys (which may come
// from process.env rather than the secrets file). See src/redact.ts.
setSecrets([
  ...Object.values(config.secrets),
  ...config.providerEnv.map(k => config.secrets[k] ?? process.env[k] ?? ''),
]);

export function providerEnvValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of config.providerEnv) {
    const v = config.secrets[k] ?? process.env[k];
    if (v) out[k] = v;
  }
  return out;
}
