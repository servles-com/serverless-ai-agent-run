// Room Manager: owns isolation and lifecycle of one Operating Room (a container).
// Agent adapters only decide *what command* runs inside an already prepared room.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { config } from './config.ts';
import { redact } from './redact.ts';

const exec = promisify(execFile);

export interface RoomSpec {
  runId: string;
  workspaceDir: string;
  artifactsDir: string;
  logDir: string;
  command: string[];               // argv inside the room
  env: Record<string, string>;
  limits: { timeoutS: number; idleTimeoutS: number; memoryMb: number; cpus: number; pids: number };
  onStdoutLine: (line: string) => void;
  onStderrLine: (line: string) => void;
}

export interface RoomOutcome {
  container: string;
  runtime: string;
  exitCode: number | null;
  oomKilled: boolean;
  timedOut: boolean;
  idleKilled: boolean;
  cancelled: boolean;
  startError?: string;             // docker itself failed (image missing, runtime missing, ...)
  durationMs: number;
  stderrTail: string[];
}

export interface RoomHandle {
  container: string;
  done: Promise<RoomOutcome>;
  cancel: () => void;
}

function resolvConf(): string {
  const file = join(config.dataDir, 'room-resolv.conf');
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file, config.roomDns.map(d => `nameserver ${d}`).join('\n') + '\n');
  return file;
}

export const containerName = (runId: string) => `sar-${runId.replace(/_/g, '-')}`;

export function startRoom(spec: RoomSpec): RoomHandle {
  const name = containerName(spec.runId);
  const runtime = config.roomRuntime || 'runc';
  const args = [
    'run', '--name', name,
    '--label', 'sar.room=1', '--label', `sar.run=${spec.runId}`, '--label', `sar.instance=${config.instance}`,
    '--init',                                   // reap zombies, forward signals
    '--user', config.roomUser,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', `${spec.limits.memoryMb}m`, '--memory-swap', `${spec.limits.memoryMb}m`,
    '--cpus', String(spec.limits.cpus),
    '--pids-limit', String(spec.limits.pids),
    '--tmpfs', '/tmp:rw,size=512m',
    '-v', `${spec.workspaceDir}:/workspace`,
    '-v', `${spec.artifactsDir}:/artifacts`,
    '-w', '/workspace',
    '-e', 'HOME=/home/agent',
    '-e', `SAR_RUN_ID=${spec.runId}`,
  ];
  if (config.roomRuntime) args.push('--runtime', config.roomRuntime);
  if (config.roomNetwork) args.push('--network', config.roomNetwork);
  // Docker writes `nameserver 127.0.0.11` (its embedded DNS) for user-defined networks
  // even with --dns, and gVisor's netstack cannot reach it -> mount our own resolv.conf.
  if (config.roomDns.length) args.push('-v', `${resolvConf()}:/etc/resolv.conf:ro`);
  // Values are passed via the child's environment (`-e NAME` without =value),
  // so secrets never appear in `ps` output on the host.
  for (const k of Object.keys(spec.env)) args.push('-e', k);
  args.push(config.roomImage, ...spec.command);

  writeFileSync(join(spec.logDir, 'docker-args.json'), JSON.stringify(
    { docker: config.docker, args, env_names: Object.keys(spec.env) }, null, 2));

  const started = Date.now();
  const child = spawn(config.docker, args, {
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLog = createWriteStream(join(spec.logDir, 'stdout.log'));
  const stderrLog = createWriteStream(join(spec.logDir, 'stderr.log'));
  const stderrTail: string[] = [];
  let lastActivity = Date.now();
  let timedOut = false, idleKilled = false, cancelled = false;

  createInterface({ input: child.stdout }).on('line', line => {
    lastActivity = Date.now();
    line = redact(line);
    stdoutLog.write(line + '\n');
    spec.onStdoutLine(line);
  });
  createInterface({ input: child.stderr }).on('line', line => {
    lastActivity = Date.now();
    line = redact(line);
    stderrLog.write(line + '\n');
    stderrTail.push(line);
    if (stderrTail.length > 80) stderrTail.shift();
    spec.onStderrLine(line);
  });

  const kill = () => { void exec(config.docker, ['kill', name]).catch(() => {}); };
  const hardTimer = setTimeout(() => { timedOut = true; kill(); }, spec.limits.timeoutS * 1000);
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > spec.limits.idleTimeoutS * 1000) { idleKilled = true; kill(); }
  }, 1000);

  const done = new Promise<RoomOutcome>(resolveDone => {
    let spawnError: string | undefined;
    child.on('error', err => { spawnError = `cannot spawn ${config.docker}: ${err.message}`; });
    child.on('close', async code => {
      clearTimeout(hardTimer); clearInterval(idleTimer);
      stdoutLog.end(); stderrLog.end();
      const inspect = await inspectRoom(name);
      if (inspect) writeFileSync(join(spec.logDir, 'inspect.json'), JSON.stringify(inspect, null, 2));
      // docker run exits 125 when the daemon could not create/start the container.
      const startError = spawnError ?? (!inspect?.State?.StartedAt || inspect.State.StartedAt.startsWith('0001')
        ? stderrTail.slice(-5).join('\n') || `docker run exited ${code} before the room started`
        : undefined);
      resolveDone({
        container: name, runtime,
        exitCode: inspect?.State?.ExitCode ?? code,
        oomKilled: !!inspect?.State?.OOMKilled,
        timedOut, idleKilled, cancelled,
        startError,
        durationMs: Date.now() - started,
        stderrTail: [...stderrTail],
      });
    });
  });

  return { container: name, done, cancel: () => { cancelled = true; kill(); } };
}

async function inspectRoom(name: string): Promise<any | undefined> {
  try {
    const { stdout } = await exec(config.docker, ['inspect', name]);
    return JSON.parse(stdout)[0];
  } catch { return undefined; }
}

// Sterilize: remove the container and anything it left running.
export async function destroyRoom(name: string): Promise<void> {
  await exec(config.docker, ['rm', '-f', '-v', name]).catch(() => {});
}

// Rooms from before instance labels existed belong to the main service.
export function ownsRoom(roomInstance: string, instance: string): boolean {
  return (roomInstance || 'main') === instance;
}

// On service start: any room of this instance still present belongs to a run whose manager died.
export async function listRoomContainers(): Promise<{ name: string; runId: string }[]> {
  try {
    const { stdout } = await exec(config.docker, ['ps', '-a', '--filter', 'label=sar.room=1',
      '--format', '{{.Names}}\t{{.Label "sar.run"}}\t{{.Label "sar.instance"}}']);
    return stdout.split('\n').filter(Boolean).map(l => l.split('\t'))
      .filter(([, , inst]) => ownsRoom(inst ?? '', config.instance))
      .map(([name, runId]) => ({ name, runId }));
  } catch { return []; }
}

export async function dockerHealth(): Promise<{ ok: boolean; runtimes: string[]; image: boolean; error?: string }> {
  try {
    const { stdout } = await exec(config.docker, ['info', '--format', '{{json .Runtimes}}']);
    const runtimes = Object.keys(JSON.parse(stdout));
    const image = await exec(config.docker, ['image', 'inspect', config.roomImage]).then(() => true, () => false);
    const ok = image && (!config.roomRuntime || runtimes.includes(config.roomRuntime));
    return { ok, runtimes, image };
  } catch (e: any) {
    return { ok: false, runtimes: [], image: false, error: String(e.stderr || e.message).trim() };
  }
}
