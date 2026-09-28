import { resolve } from 'node:path';
import { setSecrets } from './redact.ts';

function num(name: string, def: number): number {
  const v = process.env[name];
  return v ? Number(v) : def;
}

export const config = {
  port: num('SAR_PORT', 8787),
  host: process.env.SAR_HOST ?? '127.0.0.1',
  apiToken: process.env.SAR_API_TOKEN ?? '',
  insecureDev: process.env.SAR_INSECURE_DEV === '1',
  dataDir: resolve(process.env.SAR_DATA_DIR ?? 'runtime-data'),
  // Runs in flight at once (each one is a task on trained-assist-agent).
  maxRooms: num('SAR_MAX_ROOMS', 2),

  // Execution backend: trained-assist-agent on the same machine (src/agent-proxy.ts).
  agentUrl: process.env.SAR_AGENT_URL ?? 'http://127.0.0.1:8080',
  // WEB_VERIFY_SECRET of trained-assist-agent (or its AGENT_SECRET when that is unset).
  agentSecret: process.env.SAR_AGENT_SECRET ?? '',
  // trained-assist profile (username) that SAR runs belong to; it picks engine and model.
  agentProfile: process.env.SAR_AGENT_PROFILE ?? 'sar-proxy',

  defaults: {
    timeoutS: num('SAR_DEFAULT_TIMEOUT_S', 900),
    idleTimeoutS: num('SAR_DEFAULT_IDLE_TIMEOUT_S', 300),
  },

  // How long finished run dirs are kept for debugging.
  retentionHours: num('SAR_RETENTION_HOURS', 72),
  // Per-attempt timeout of one webhook POST (src/webhooks.ts).
  webhookTimeoutMs: num('SAR_WEBHOOK_TIMEOUT', 10_000),
  // SSE keep-alive comment interval for /runs/:id/stream (src/stream.ts).
  streamHeartbeatS: num('SAR_STREAM_HEARTBEAT_S', 15),
};

// Register every known secret value for redaction before it can reach events,
// logs or webhooks. See src/redact.ts.
setSecrets([config.agentSecret, config.apiToken]);
