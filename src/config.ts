import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
    cpus: num('SAR_DEFAULT_CPUS', 1),
    pids: num('SAR_DEFAULT_PIDS', 512),
    model: process.env.SAR_DEFAULT_MODEL ?? 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  },

  // Env vars always passed to opencode rooms (model provider keys).
  providerEnv: ['OPENROUTER_API_KEY'],
  secrets: loadSecrets(process.env.SAR_SECRETS_FILE),

  // How long finished run dirs are kept for debugging.
  retentionHours: num('SAR_RETENTION_HOURS', 72),
};

export function providerEnvValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of config.providerEnv) {
    const v = config.secrets[k] ?? process.env[k];
    if (v) out[k] = v;
  }
  return out;
}
